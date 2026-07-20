/**
 * Proxy health: what every exit IP is doing, and whether it still works.
 *
 * Two views, because "health" means two different things:
 *
 *  - **Live stats** come from the egress pools of runs in progress — successes,
 *    failures, benched IPs, session warmth. This is the real answer while a
 *    scrape is running: an IP that Google is actively answering is healthy by
 *    definition, no synthetic test needed.
 *  - **The connectivity test** is for when nothing is running: it pushes one
 *    tiny request (Google's own 204 endpoint) through each proxy and reports
 *    reachable-or-not with latency. That catches the common failure — expired
 *    or rotated-out Webshare IPs — before an overnight run trips over them.
 */

import { fetch as undiciFetch } from 'undici';

import { loadProxies } from '../../../packages/engine/src/search/proxy-config.ts';
import { USER_AGENT } from '../../../packages/engine/src/search/client.ts';
import type { EgressPool, EgressStats } from '../../../packages/engine/src/search/egress.ts';

// --- Live pool registry --------------------------------------------------------

interface RegisteredPool {
  pool: EgressPool;
  /** What the pool is serving, e.g. "extraction: construction — BC". */
  context: string;
}

const activePools = new Set<RegisteredPool>();

/** Register a pool for the run's lifetime; call the returned function when done. */
export function registerPool(pool: EgressPool, context: string): () => void {
  const entry: RegisteredPool = { pool, context };
  activePools.add(entry);
  return () => activePools.delete(entry);
}

export function livePools(): { context: string; size: number; backoff: number; benched: number; stats: EgressStats[] }[] {
  return [...activePools].map(({ pool, context }) => ({
    context,
    size: pool.size,
    backoff: pool.backoff,
    benched: pool.benched,
    stats: pool.stats(),
  }));
}

// --- On-demand connectivity test -----------------------------------------------

export interface ProxyTestResult {
  label: string;
  ok: boolean;
  /** Round-trip latency in ms, when reachable. */
  ms?: number;
  error?: string;
}

export interface ProxyCheck {
  status: 'running' | 'done';
  startedAt: number;
  finishedAt?: number;
  done: number;
  total: number;
  results: ProxyTestResult[];
}

let lastCheck: ProxyCheck | null = null;

export const getProxyCheck = (): ProxyCheck | null => lastCheck;

/** A tiny, fast target that answers from anywhere and returns no body. */
const PROBE_URL = 'https://www.google.com/generate_204';
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_CONCURRENCY = 20;

export function startProxyCheck(onUpdate: (check: ProxyCheck) => void): ProxyCheck {
  if (lastCheck?.status === 'running') return lastCheck;

  const check: ProxyCheck = { status: 'running', startedAt: Date.now(), done: 0, total: 0, results: [] };
  lastCheck = check;
  void execute(check, onUpdate);
  return check;
}

async function execute(check: ProxyCheck, onUpdate: (check: ProxyCheck) => void): Promise<void> {
  // loadProxies builds a fresh pool of dispatchers; this one is ours to close.
  const { pool } = await loadProxies();
  try {
    const targets = pool ? pool.entries() : [];
    check.total = targets.length;
    check.results = targets.map(({ label }) => ({ label, ok: false }));
    onUpdate(check);

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < targets.length) {
        const index = cursor++;
        const { dispatcher, label } = targets[index]!;
        const started = performance.now();
        try {
          const res = await undiciFetch(PROBE_URL, {
            dispatcher,
            headers: { 'user-agent': USER_AGENT },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
          const ms = Math.round(performance.now() - started);
          check.results[index] = res.ok || res.status === 204
            ? { label, ok: true, ms }
            : { label, ok: false, ms, error: `HTTP ${res.status}` };
        } catch (error) {
          const cause = (error as { cause?: { message?: string } }).cause;
          const message = (error as Error).name === 'TimeoutError'
            ? `no answer in ${PROBE_TIMEOUT_MS / 1000}s`
            : cause?.message ?? (error as Error).message;
          check.results[index] = { label, ok: false, error: message };
        }
        check.done += 1;
        onUpdate(check);
      }
    };

    await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, Math.max(1, targets.length)) }, worker));
    check.status = 'done';
    check.finishedAt = Date.now();
    onUpdate(check);
  } finally {
    await pool?.close().catch(() => undefined);
  }
}
