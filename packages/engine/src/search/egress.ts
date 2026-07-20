/**
 * The egress pool: exit identities, pacing, health, and adaptive backoff.
 *
 * An egress is one exit identity — a proxy dispatcher paired with its own warmed
 * Google session cookie. The pairing matters: Google issues a session cookie
 * (`NID`) to a specific IP, and a full (not field-stripped) response depends on
 * the cookie matching the IP it arrives from. One cookie sent through a rotating
 * pool works at ten proxies and breaks at a hundred; binding each proxy to its
 * own session keeps identity coherent as the pool grows.
 *
 * Beyond identity, this pool is where a long run is kept alive rather than
 * hammering itself to death:
 *
 *  - **Pacing.** Each egress waits a minimum interval between its own requests,
 *    with jitter, so no single IP is fired at a bot-like rate. Requests are
 *    handed to the least-recently-used egress, spreading load evenly.
 *  - **Health.** An egress that fails repeatedly is put in cooldown and skipped,
 *    so one dead proxy can't stall the run — the classic failure where a single
 *    hung IP froze everything.
 *  - **Adaptive backoff.** When Google pushes back (rate limits, degraded
 *    payloads), the pool widens every egress's interval; sustained success
 *    narrows it again. The run speeds up when it's allowed to and slows down
 *    when it isn't, instead of charging ahead into a block.
 */

import { directDispatcher } from './client.ts';
import { GoogleSession } from './session.ts';
import type { ProxyPool } from './proxy.ts';
import type { Dispatcher } from 'undici';

export interface Egress {
  dispatcher: Dispatcher;
  session: GoogleSession;
  /** Display identity of the exit, e.g. "1.2.3.4:8080" or "direct". */
  label: string;
}

interface EgressState extends Egress {
  /** Earliest wall-clock time this egress may be used again (pacing reservation). */
  readyAt: number;
  /** Failures in a row; resets on any success. */
  consecutiveFailures: number;
  /** While set in the future, the egress is unhealthy and skipped. */
  cooldownUntil: number;
  /** Lifetime counters, for the health readout. */
  successes: number;
  failures: number;
}

/** One egress's health, as shown on the health page. */
export interface EgressStats {
  label: string;
  /** Whether its Google session cookie is warmed. */
  warm: boolean;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  /** Milliseconds of bench time remaining; 0 when healthy. */
  benchedForMs: number;
}

export interface PacingOptions {
  /** Baseline gap between two requests from the same egress, before backoff. */
  baseIntervalMs?: number;
  /** Consecutive failures before an egress is put in cooldown. */
  failureThreshold?: number;
  /** How long a cooled-down egress stays benched. */
  cooldownMs?: number;
  /** Ceiling on the adaptive backoff multiplier. */
  maxBackoff?: number;
}

const DEFAULTS = {
  baseIntervalMs: 350,
  failureThreshold: 4,
  cooldownMs: 60_000,
  maxBackoff: 8,
} satisfies Required<PacingOptions>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wall clock. Wrapped so tests could substitute it, and to centralise `Date.now`. */
const now = () => Date.now();

export class EgressPool {
  readonly #egresses: EgressState[];
  readonly #opts: Required<PacingOptions>;
  /** Multiplier on the pacing interval, 1..maxBackoff, moved by push-back. */
  #backoff = 1;

  private constructor(egresses: Egress[], opts: Required<PacingOptions>) {
    this.#opts = opts;
    this.#egresses = egresses.map((e) => ({
      ...e,
      readyAt: 0,
      consecutiveFailures: 0,
      cooldownUntil: 0,
      successes: 0,
      failures: 0,
    }));
  }

  static create(
    proxies: ProxyPool | null,
    hl: string,
    userAgent: string,
    pacing: PacingOptions = {},
  ): EgressPool {
    const opts = { ...DEFAULTS, ...pacing };
    if (!proxies || proxies.size === 0) {
      const dispatcher = directDispatcher();
      // Direct egress is a single IP (the operator's own); pace it much more
      // gently, since there is no pool to spread load across.
      return new EgressPool(
        [{ dispatcher, label: 'direct', session: new GoogleSession({ hl, userAgent, dispatcher }) }],
        { ...opts, baseIntervalMs: Math.max(opts.baseIntervalMs, 1_200) },
      );
    }
    const egresses: Egress[] = proxies.entries().map(({ dispatcher, label }) => ({
      dispatcher,
      label,
      session: new GoogleSession({ hl, userAgent, dispatcher }),
    }));
    return new EgressPool(egresses, opts);
  }

  get size(): number {
    return this.#egresses.length;
  }

  /** Current pacing multiplier, for progress/telemetry. */
  get backoff(): number {
    return this.#backoff;
  }

  /** Egresses not currently benched in cooldown. */
  #healthy(at: number): EgressState[] {
    return this.#egresses.filter((e) => e.cooldownUntil <= at);
  }

  /**
   * Reserve the least-recently-used healthy egress and wait until it is polite
   * to use it. Returns the egress; the caller must report the outcome so health
   * and backoff can adapt.
   *
   * If every egress is cooling down, waits for the soonest to recover rather
   * than failing — a transient wave of blocks should pause the run, not end it.
   */
  async acquire(signal?: AbortSignal): Promise<Egress> {
    for (;;) {
      signal?.throwIfAborted();
      const at = now();
      const healthy = this.#healthy(at);

      if (healthy.length === 0) {
        // All benched: wait for the earliest cooldown to lift.
        const soonest = Math.min(...this.#egresses.map((e) => e.cooldownUntil));
        await sleep(Math.max(50, Math.min(soonest - at, this.#opts.cooldownMs)));
        continue;
      }

      // Least-recently-used: the egress free the soonest spreads load evenly.
      const egress = healthy.reduce((best, e) => (e.readyAt < best.readyAt ? e : best));
      const interval = this.#opts.baseIntervalMs * this.#backoff;
      const jitter = interval * (0.5 + Math.random()); // 0.5x–1.5x, desynchronises workers
      const startAt = Math.max(at, egress.readyAt);

      // Reserve immediately so concurrent callers don't grab the same egress.
      egress.readyAt = startAt + jitter;

      const wait = startAt - at;
      if (wait > 0) await sleep(wait);
      return egress;
    }
  }

  /** A request through `egress` succeeded: clear its failures, ease global backoff. */
  reportSuccess(egress: Egress): void {
    const state = egress as EgressState;
    state.consecutiveFailures = 0;
    state.successes += 1;
    // Ease off slowly, so one good response after a block doesn't undo caution.
    this.#backoff = Math.max(1, this.#backoff * 0.97);
  }

  /**
   * A request through `egress` failed. Rate-limits and blocks widen the global
   * backoff (Google is pushing back on everyone); repeated failures on one
   * egress bench it, in case that specific IP is burned.
   */
  reportFailure(egress: Egress, options: { pushback: boolean } = { pushback: false }): void {
    const state = egress as EgressState;
    state.consecutiveFailures += 1;
    state.failures += 1;
    if (state.consecutiveFailures >= this.#opts.failureThreshold) {
      state.cooldownUntil = now() + this.#opts.cooldownMs;
      state.consecutiveFailures = 0;
    }
    if (options.pushback) {
      this.#backoff = Math.min(this.#opts.maxBackoff, this.#backoff * 1.5);
    }
  }

  /** Egresses currently benched, for telemetry. */
  get benched(): number {
    const at = now();
    return this.#egresses.filter((e) => e.cooldownUntil > at).length;
  }

  /** Per-egress health snapshot, for the health page. */
  stats(): EgressStats[] {
    const at = now();
    return this.#egresses.map((e) => ({
      label: e.label,
      warm: e.session.isWarm,
      successes: e.successes,
      failures: e.failures,
      consecutiveFailures: e.consecutiveFailures,
      benchedForMs: Math.max(0, e.cooldownUntil - at),
    }));
  }

  /**
   * Warm every session up front, in parallel and bounded, so the first wave of
   * searches doesn't race a burst of cookie warm-ups. Failures are swallowed —
   * a session warms lazily on first use anyway.
   */
  async warmAll(signal?: AbortSignal): Promise<void> {
    await Promise.all(
      this.#egresses.map((e) => e.session.cookie().catch(() => undefined)),
    );
    signal?.throwIfAborted();
  }
}

/**
 * How many cells to search at once, given the egress pool size.
 *
 * Concurrency is bounded by exit IPs — each concurrent request should leave from
 * a different IP so no single one is hammered — and by the local machine, which
 * caps out processing a few hundred simultaneous requests. More proxies mean
 * more parallelism up to that ceiling.
 */
export function concurrencyFor(egressCount: number): number {
  if (egressCount <= 1) return 3; // direct: gentle on the one IP
  // ~1.5 concurrent per IP stays well under any per-IP limit; capped where the
  // local machine, not Google, becomes the bottleneck.
  return Math.min(256, Math.max(8, Math.round(egressCount * 1.5)));
}
