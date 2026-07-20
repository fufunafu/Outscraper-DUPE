/**
 * Database email enrichment: fill in the email column for places already stored.
 *
 * A vertical extraction collects what Google Maps knows, and Google Maps does
 * not know emails — those live on each business's own website. This job walks
 * every stored place that has a website but no email yet, crawls the site, and
 * writes what it finds (emails plus social links) back into the same row. It is
 * the second half of what makes the database a lead list rather than a map dump.
 *
 * Like the quick-scrape enrichment, it fetches sites directly (not through the
 * scraping proxies): each site sees only a couple of requests, so there is
 * nothing to hide, and business sites fail in enough creative ways without a
 * proxy layer in between. The work list is snapshotted up front as row ids, so
 * rows updated mid-run can't shift the iteration under our feet, and every
 * batch is committed as it completes — a cancelled run keeps everything it
 * found and the next run picks up only what's still missing.
 */

import { randomUUID } from 'node:crypto';

import { enrichPlaces } from '../../../packages/engine/src/enrich/enrich.ts';
import { PlaceDatabase } from '../../../packages/engine/src/store/database.ts';
import type { EnrichedPlace } from '../../../packages/engine/src/schema.ts';
import { DATABASE_PATH } from './extraction.ts';

export type EnrichmentStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface EnrichmentRun {
  id: string;
  status: EnrichmentStatus;
  startedAt: number;
  finishedAt?: number;
  progress: {
    /** Sites to visit — places with a website and no email yet. */
    total: number;
    done: number;
    /** How many of the visited sites yielded an email. */
    withEmail: number;
  };
  error?: string;
}

const BATCH = 200;

let current: EnrichmentRun | null = null;
let controller: AbortController | null = null;

export const getEnrichment = (): EnrichmentRun | null => current;

export function cancelEnrichment(): boolean {
  if (!controller) return false;
  controller.abort();
  return true;
}

export function startEnrichment(onUpdate: (run: EnrichmentRun) => void): EnrichmentRun {
  if (current?.status === 'running') return current;

  const run: EnrichmentRun = {
    id: randomUUID(),
    status: 'running',
    startedAt: Date.now(),
    progress: { total: 0, done: 0, withEmail: 0 },
  };
  current = run;
  controller = new AbortController();
  void execute(run, controller, onUpdate);
  return run;
}

async function execute(
  run: EnrichmentRun,
  abort: AbortController,
  onUpdate: (run: EnrichmentRun) => void,
): Promise<void> {
  const publish = () => onUpdate(run);
  const db = new PlaceDatabase(DATABASE_PATH);

  try {
    // Snapshot the work list; enriching a row removes it from this filter, so
    // iterating the filter directly would skip rows as the ground shifted.
    const ids = db.ids({ hasWebsite: true, missingEmail: true });
    run.progress.total = ids.length;
    publish();

    for (let start = 0; start < ids.length; start += BATCH) {
      abort.signal.throwIfAborted();
      const batchIds = ids.slice(start, start + BATCH);

      // Reload each row fresh: another job may have updated it since snapshot.
      const stored = batchIds
        .map((id) => db.byId(id))
        .filter((p): p is NonNullable<typeof p> => p != null);
      const places: EnrichedPlace[] = stored.map(({ id: _id, first_seen: _f, last_seen: _l, ...place }) => place);

      const emailsBefore = run.progress.withEmail;
      const enriched = await enrichPlaces(
        places,
        { concurrency: 16, signal: abort.signal },
        (p) => {
          run.progress.done = start + p.done;
          run.progress.withEmail = emailsBefore + p.withEmail;
          publish();
        },
      );

      db.upsertMany(enriched);
      run.progress.done = Math.min(start + batchIds.length, ids.length);
      run.progress.withEmail = emailsBefore + enriched.filter((p) => p.email_1).length;
      publish();
    }

    run.status = 'done';
    run.finishedAt = Date.now();
  } catch (error) {
    run.status = abort.signal.aborted ? 'cancelled' : 'failed';
    if (!abort.signal.aborted) run.error = (error as Error).message;
    run.finishedAt = Date.now();
  } finally {
    db.close();
    controller = null;
    publish();
  }
}
