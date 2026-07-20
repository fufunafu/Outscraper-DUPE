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

import { enrichPlaces } from '../../../packages/engine/src/enrich/enrich.ts';
import { PlaceDatabase } from '../../../packages/engine/src/store/database.ts';
import type { EnrichedPlace } from '../../../packages/engine/src/schema.ts';
import { DATABASE_PATH } from './extraction.ts';

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

const BATCH = 150;
const IDLE_POLL_MS = 60_000;
const PAUSE_POLL_MS = 3_000;

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

      const stored = ids
        .map((id) => db.byId(id))
        .filter((p): p is NonNullable<typeof p> => p != null);
      const places: EnrichedPlace[] = stored.map(
        ({ id: _id, first_seen: _f, last_seen: _l, ...place }) => place,
      );

      const checkedBefore = state.checked;
      const foundBefore = state.found;
      const enriched = await enrichPlaces(places, { concurrency: 14 }, (p) => {
        state.checked = checkedBefore + p.done;
        state.found = foundBefore + p.withEmail;
        publish();
      });

      db.upsertMany(enriched);
      db.markEmailChecked(ids);
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
