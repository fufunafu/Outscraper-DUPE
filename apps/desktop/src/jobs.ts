/**
 * Job registry: running scrapes, their progress, and their results.
 *
 * Everything is in-process and on-disk under the user's home directory. There
 * is no server, no account, and no network egress except to Google — a job is
 * just an async function with a progress callback and a cancel token.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { scrape } from '../../../packages/engine/src/scrape.ts';
import { geocodeOne, areaSquareKm } from '../../../packages/engine/src/geo/geocode.ts';
import { toCsv } from '../../../packages/engine/src/export/csv.ts';
import { loadProxies } from '../../../packages/engine/src/search/proxy-config.ts';
import { Deduper } from '../../../packages/engine/src/store/dedupe.ts';
import { toLabel, toQuery, type LocationSelection } from '../../../packages/engine/src/locations.ts';
import type { Place } from '../../../packages/engine/src/schema.ts';
import { applyFilters, type Filters } from './filters.ts';

export const OUTPUT_DIR = join(homedir(), 'Documents', 'Places Scraper');

export type JobStatus = 'starting' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobRequest {
  /** One or more categories; each is swept across every location. */
  queries: string[];
  locations: LocationSelection[];
  /** Stop once this many unique places have been found, across everything. */
  limit?: number;
  filters?: Filters;
  language?: string;
}

/** One (category × location) pair — the unit of work the UI reports on. */
export interface Leg {
  label: string;
  query: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  found: number;
  error?: string;
}

export interface JobProgress {
  found: number;
  duplicates: number;
  cellsSearched: number;
  cellsPending: number;
  legsDone: number;
  legsTotal: number;
}

export interface Job {
  id: string;
  request: JobRequest;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  legs: Leg[];
  progress: JobProgress;
  places: Place[];
  /** Rows dropped by the filters, so the UI can explain the gap. */
  filtered: number;
  error?: string;
  csvPath?: string;
}

const jobs = new Map<string, Job>();
const cancellers = new Map<string, AbortController>();

export const getJob = (id: string): Job | undefined => jobs.get(id);
export const listJobs = (): Job[] => [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);

export function cancelJob(id: string): boolean {
  const controller = cancellers.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function fileNameFor(job: Job): string {
  const category = slug(job.request.queries[0] ?? 'places');
  const where =
    job.request.locations.length === 1
      ? slug(toLabel(job.request.locations[0]!))
      : `${job.request.locations.length}-areas`;
  const date = new Date(job.startedAt).toISOString().slice(0, 10);
  const time = new Date(job.startedAt).toTimeString().slice(0, 5).replace(':', '');
  return `${category}-${where}-${date}-${time}.csv`;
}

export function startJob(request: JobRequest, onUpdate: (job: Job) => void): Job {
  const id = randomUUID();
  const controller = new AbortController();
  cancellers.set(id, controller);

  const legs: Leg[] = request.queries.flatMap((query) =>
    request.locations.map((location) => ({
      label: `${query} — ${toLabel(location)}`,
      query: toQuery(location),
      status: 'pending' as const,
      found: 0,
    })),
  );

  const job: Job = {
    id,
    request,
    status: 'starting',
    startedAt: Date.now(),
    legs,
    progress: {
      found: 0,
      duplicates: 0,
      cellsSearched: 0,
      cellsPending: 0,
      legsDone: 0,
      legsTotal: legs.length,
    },
    places: [],
    filtered: 0,
  };
  jobs.set(id, job);

  void run(job, controller, onUpdate);
  return job;
}

async function run(job: Job, controller: AbortController, onUpdate: (job: Job) => void): Promise<void> {
  const publish = () => onUpdate(job);
  const { pool: proxies } = await loadProxies();

  // Dedupe spans the whole job, not each leg: adjacent provinces share border
  // towns, and the same business must not appear twice in one export.
  const deduper = new Deduper();
  const limit = job.request.limit ?? Infinity;

  try {
    job.status = 'running';
    publish();

    let legIndex = 0;
    for (const query of job.request.queries) {
      for (const location of job.request.locations) {
        const leg = job.legs[legIndex++]!;
        if (controller.signal.aborted) break;
        if (job.places.length >= limit) {
          leg.status = 'done';
          continue;
        }

        leg.status = 'running';
        publish();

        try {
          const place = await geocodeOne(toQuery(location));
          if (!place) throw new Error(`Couldn't find "${toQuery(location)}" on the map.`);

          const before = job.places.length;
          const baseCells = job.progress.cellsSearched;

          const result = await scrape(
            {
              query,
              region: place.box,
              limit: limit === Infinity ? undefined : limit - job.places.length,
              language: job.request.language ?? 'en',
              concurrency: proxies ? 8 : 4,
              proxies,
              signal: controller.signal,
            },
            (progress) => {
              job.progress.cellsSearched = baseCells + progress.cellsSearched;
              job.progress.cellsPending = progress.cellsPending;
              publish();
            },
          );

          // scrape() dedupes within its own region; this collapses across legs.
          for (const found of result.places) {
            if (job.places.length >= limit) break;
            if (deduper.add(found)) job.places.push(found);
          }

          leg.found = job.places.length - before;
          leg.status = 'done';
          job.progress.duplicates = deduper.stats.duplicates;
        } catch (error) {
          if (controller.signal.aborted) throw error;
          // One bad region shouldn't lose the other twelve.
          leg.status = 'failed';
          leg.error = (error as Error).message;
        }

        job.progress.found = job.places.length;
        job.progress.legsDone = job.legs.filter((l) => l.status === 'done' || l.status === 'failed').length;
        publish();
      }
    }

    const kept = applyFilters(job.places, job.request.filters ?? {});
    job.filtered = job.places.length - kept.length;
    job.places = kept;

    await mkdir(OUTPUT_DIR, { recursive: true });
    const path = join(OUTPUT_DIR, fileNameFor(job));
    await writeFile(path, toCsv(kept), 'utf8');
    job.csvPath = path;

    job.status = 'done';
    job.finishedAt = Date.now();
  } catch (error) {
    job.status = controller.signal.aborted ? 'cancelled' : 'failed';
    if (!controller.signal.aborted) job.error = (error as Error).message;
    job.finishedAt = Date.now();

    // A cancelled run still has real data in it; write what we got rather than
    // throwing away however many hours of scraping the user just stopped.
    if (job.places.length > 0 && !job.csvPath) {
      try {
        await mkdir(OUTPUT_DIR, { recursive: true });
        const path = join(OUTPUT_DIR, fileNameFor(job));
        await writeFile(path, toCsv(applyFilters(job.places, job.request.filters ?? {})), 'utf8');
        job.csvPath = path;
      } catch {
        // Nothing more to do; the error above is what matters.
      }
    }
  } finally {
    cancellers.delete(job.id);
    publish();
  }
}

export { areaSquareKm };
