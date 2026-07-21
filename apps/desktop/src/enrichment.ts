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

// Concurrency. The old ceiling was one home IP: crawling flat-out from it
// starved the connection (and the Google Maps extraction sharing it), so it was
// throttled to 4 while extracting — which capped throughput at ~125 sites/min
// and made a 200k backlog a 27-hour wait. With a proxy pool, each site fetch
// exits a different one of hundreds of IPs, so we can run far wider without
// hammering anyone: the bound becomes the pool size, not politeness.
const PROXIED_CONCURRENCY = 80;
const DIRECT_CONCURRENCY_IDLE = 14;
const DIRECT_CONCURRENCY_BUSY = 4;

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

  // The proxy fleet is what unlocks real throughput. Email crawling doesn't need
  // Google's per-IP pacing (it hits arbitrary business sites), so a plain
  // round-robin ProxyPool — not the extraction's paced EgressPool — is right.
  // Loaded once: proxies rarely change, and a change is a restart anyway.
  let proxies: ProxyPool | null = null;
  try {
    proxies = (await loadProxies()).pool;
  } catch {
    // No proxies configured — fall back to direct crawling from the home IP.
  }

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

      // With a proxy pool, crawl wide — each fetch exits a different IP, so it
      // neither congests the home connection nor competes with the Google Maps
      // extraction. Without proxies we fall back to the home IP, where flat-out
      // crawling alongside an extraction starves both: keep the old
      // congestion-aware throttle (4 while extracting, 14 idle) for that case.
      const extracting = listExtractions().some((x) => x.status === 'running' || x.status === 'starting');
      const concurrency = proxies
        ? PROXIED_CONCURRENCY
        : extracting ? DIRECT_CONCURRENCY_BUSY : DIRECT_CONCURRENCY_IDLE;
      const outcomes: CrawlOutcome[] = [];
      const enriched = await enrichPlaces(
        places,
        {
          proxies,
          concurrency,
          perSiteTimeoutMs: proxies ? 15_000 : extracting ? 20_000 : 12_000,
          outcomes,
        },
        (p) => {
          state.checked = checkedBefore + p.done;
          state.found = foundBefore + p.withEmail;
          publish();
        },
      );

      db.upsertMany(enriched);
      // Reached sites are settled — an email was there or it wasn't. Unreachable
      // ones defer and retry with backoff; a timeout is not "no email".
      const reachedIds = work.filter((_, i) => outcomes[i] !== 'unreachable').map((p) => p.id);
      const unreachableIds = work.filter((_, i) => outcomes[i] === 'unreachable').map((p) => p.id);
      db.markEmailChecked(reachedIds);
      db.markEmailDeferred([...unreachableIds, ...skippedIds]);

      // Update the per-domain failure memory from what actually happened.
      for (let i = 0; i < work.length; i++) {
        const domain = domainOf(work[i]!.row.site);
        if (!domain) continue;
        if (outcomes[i] === 'unreachable') domainFails.set(domain, (domainFails.get(domain) ?? 0) + 1);
        else domainFails.delete(domain);
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
