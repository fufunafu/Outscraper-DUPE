/**
 * The email finder: always on, never asked.
 *
 * Emails live on business websites, not on Google Maps, so every place needs a
 * follow-up visit to its site. Making that a button someone must remember to
 * press means the database is permanently behind; instead this worker starts
 * with the app and quietly keeps up. Whenever places exist whose websites
 * haven't been checked, it crawls a batch, writes back what it finds, and marks
 * them checked — found or not — so each site is visited exactly once. When the
 * queue is empty it naps and re-checks, picking up whatever a running
 * extraction has discovered since.
 *
 * Crawling runs from the user's own IP (not the scraping proxies): each site
 * sees only a couple of requests, so there is nothing to hide, and the proxy
 * pool stays dedicated to the work that actually needs it. Pause exists for
 * the times that IP shouldn't be busy — a hotspot, a metered connection.
 */

import { enrichPlaces, type CrawlOutcome } from '../../../packages/engine/src/enrich/enrich.ts';
import { domainOf } from '../../../packages/engine/src/enrich/emails.ts';
import { loadProxies } from '../../../packages/engine/src/search/proxy-config.ts';
import type { ProxyPool } from '../../../packages/engine/src/search/proxy.ts';
import { PlaceDatabase } from '../../../packages/engine/src/store/database.ts';
import type { EnrichedPlace } from '../../../packages/engine/src/schema.ts';
import { DATABASE_PATH, listExtractions } from './extraction.ts';

export interface EnrichmentState {
  status: 'running' | 'paused' | 'idle';
  /** Places with an unchecked website still waiting. */
  pending: number;
  /** Sites checked since the app started. */
  checked: number;
  /** Emails found since the app started. */
  found: number;
  startedAt: number;
}

const BATCH = 300;
const IDLE_POLL_MS = 60_000;
const PAUSE_POLL_MS = 3_000;

// Concurrency. Crawling through the proxy pool spreads the work across hundreds
// of exit IPs, so we can run far wider than one home IP allows — benchmarked at
// ~750 sites/min at concurrency 300 vs ~480 direct. (This needs undici >= 8.8.0:
// 8.7 threw an *uncaught* exception in ProxyAgent's connection-cleanup whenever a
// site failed through it, which email crawling — hitting dead sites constantly —
// triggered nonstop and crashed the whole app. 8.8 fixed that cleanup.)
//
// Two things bound how wide we can safely go, and both are handled adaptively:
//   1. Proxy count — more IPs, more parallelism. The cap scales with pool size.
//   2. The home connection — ALL proxy traffic still flows through it, so a weak
//      or flaky connection chokes. Rising timeouts are the signal; when they
//      climb we back off, when they're low we grow back (see the loop).
const CONCURRENCY_MIN = 12;
const CONCURRENCY_STEP = 24;
/** Cap when crawling through proxies: wide, but not beyond what one uplink feeds. */
const proxiedCap = (poolSize: number): number => Math.min(300, Math.max(40, poolSize));
/** Without proxies we're on the home IP alone — modest, and yield to extractions. */
const DIRECT_CAP_IDLE = 40;
const DIRECT_CAP_BUSY = 24;

/** Session memory of domains whose crawls keep failing; see the skip logic below. */
const domainFails = new Map<string, number>();
const DOMAIN_GIVE_UP = 3;

const state: EnrichmentState = { status: 'idle', pending: 0, checked: 0, found: 0, startedAt: Date.now() };
let paused = false;
let started = false;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const getEnrichment = (): EnrichmentState => state;

export function pauseEnrichment(): EnrichmentState {
  paused = true;
  state.status = 'paused';
  return state;
}

export function resumeEnrichment(): EnrichmentState {
  paused = false;
  if (state.status === 'paused') state.status = 'running';
  return state;
}

/** Start the perpetual worker. Idempotent: the app calls this once at boot. */
export function startAutoEnrichment(onUpdate: (state: EnrichmentState) => void): EnrichmentState {
  if (started) return state;
  started = true;
  state.startedAt = Date.now();
  void loop(onUpdate);
  return state;
}

async function loop(onUpdate: (state: EnrichmentState) => void): Promise<void> {
  const publish = () => onUpdate(state);
  // One long-lived handle; WAL lets extraction writes interleave freely.
  const db = new PlaceDatabase(DATABASE_PATH);

  // The proxy fleet unlocks the real throughput. Email crawling doesn't need
  // Google's per-IP pacing (it hits arbitrary sites), so a plain round-robin
  // ProxyPool — not the extraction's paced EgressPool — is right. Loaded once;
  // proxies rarely change, and a change is a restart anyway.
  let proxies: ProxyPool | null = null;
  try {
    proxies = (await loadProxies()).pool;
  } catch {
    // No proxies configured — crawl direct from the home IP.
  }

  // Adaptive concurrency, carried across batches. Starts moderate and climbs
  // while the connection is healthy; when timeouts rise (a weak or busy uplink)
  // it backs off, so a bad-internet spell throttles itself instead of piling on
  // requests that all time out. The cap depends on proxy count.
  let concurrency = proxies ? Math.min(80, proxiedCap(proxies.size)) : DIRECT_CAP_IDLE;

  for (;;) {
    try {
      if (paused) {
        await sleep(PAUSE_POLL_MS);
        continue;
      }

      const ids = db.nextEmailTargets(BATCH);
      state.pending = db.pendingEmailChecks();

      if (ids.length === 0) {
        // Queue drained. An extraction may refill it any minute; nap and look again.
        state.status = 'idle';
        publish();
        await sleep(IDLE_POLL_MS);
        continue;
      }

      state.status = 'running';
      publish();

      // Keep each id paired with its row so crawl outcomes can't misalign with
      // ids when a row fails to load (filtering them separately used to shift
      // every index after a missing row).
      const pairs = ids
        .map((id) => ({ id, row: db.byId(id) }))
        .filter((p): p is { id: string; row: NonNullable<ReturnType<typeof db.byId>> } => p.row != null);

      // Domains that keep failing this session — big-box chains whose WAF 403s
      // every branch (Rona, London Drugs…), dead site-builders. After 3 failed
      // crawls on a domain, stop burning requests on its remaining branches;
      // the skipped rows still defer through the normal backoff, so a future
      // session (fresh memory) gives the domain another chance.
      const skippedIds: string[] = [];
      const work: typeof pairs = [];
      for (const p of pairs) {
        const domain = domainOf(p.row.site);
        if (domain && (domainFails.get(domain) ?? 0) >= DOMAIN_GIVE_UP) skippedIds.push(p.id);
        else work.push(p);
      }

      const places: EnrichedPlace[] = work.map(
        ({ row: { id: _id, first_seen: _f, last_seen: _l, ...place } }) => place,
      );

      const checkedBefore = state.checked;
      const foundBefore = state.found;

      // Cap depends on whether we have proxies, and (direct only) whether an
      // extraction is sharing the home uplink. The adaptive `concurrency` climbs
      // toward this cap when healthy and is clamped to it here.
      const extracting = listExtractions().some((x) => x.status === 'running' || x.status === 'starting');
      const cap = proxies ? proxiedCap(proxies.size) : extracting ? DIRECT_CAP_BUSY : DIRECT_CAP_IDLE;
      concurrency = Math.min(concurrency, cap);
      const outcomes: CrawlOutcome[] = [];
      const enriched = await enrichPlaces(
        places,
        {
          proxies,
          concurrency,
          perSiteTimeoutMs: 15_000,
          outcomes,
        },
        (p) => {
          state.checked = checkedBefore + p.done;
          state.found = foundBefore + p.withEmail;
          publish();
        },
      );

      db.upsertMany(enriched);
      // Reached sites are settled — an email was there or it wasn't. A dead site
      // (unreachable) or a slow one (timeout) defers and retries with backoff;
      // neither is "no email".
      const reachedIds = work.filter((_, i) => outcomes[i] === 'ok' || outcomes[i] === 'no_site').map((p) => p.id);
      const deferIds = work.filter((_, i) => outcomes[i] === 'unreachable' || outcomes[i] === 'timeout').map((p) => p.id);
      db.markEmailChecked(reachedIds);
      db.markEmailDeferred([...deferIds, ...skippedIds]);

      // Per-domain failure memory: only a genuine dead-site failure counts. A
      // timeout is our connection, not the domain's fault — don't blacklist a
      // whole chain because the uplink hiccuped.
      for (let i = 0; i < work.length; i++) {
        const domain = domainOf(work[i]!.row.site);
        if (!domain) continue;
        if (outcomes[i] === 'unreachable') domainFails.set(domain, (domainFails.get(domain) ?? 0) + 1);
        else if (outcomes[i] === 'ok') domainFails.delete(domain);
      }

      // Adapt for the next batch from this one's timeout rate — the live
      // read on whether the connection can take more.
      const timeouts = outcomes.filter((o) => o === 'timeout').length;
      const timeoutRate = work.length ? timeouts / work.length : 0;
      if (timeoutRate > 0.25) {
        concurrency = Math.max(CONCURRENCY_MIN, Math.floor(concurrency * 0.6));
      } else if (timeoutRate < 0.08 && concurrency < cap) {
        concurrency = Math.min(cap, concurrency + CONCURRENCY_STEP);
      }

      state.checked = checkedBefore + ids.length;
      state.found = foundBefore + enriched.filter((p) => p.email_1).length;
      state.pending = Math.max(0, state.pending - ids.length);
      publish();
    } catch {
      // A bad batch (dead sites, a transient DB hiccup) must not kill the
      // worker; wait out the weather and carry on.
      await sleep(10_000);
    }
  }
}
