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

import { scrape, type ScrapeProgress } from '../../../packages/engine/src/scrape.ts';
import { geocodeOne, areaSquareKm } from '../../../packages/engine/src/geo/geocode.ts';
import { toCsv } from '../../../packages/engine/src/export/csv.ts';
import { proxyPoolFromEnv } from '../../../packages/engine/src/search/proxy.ts';
import type { Place } from '../../../packages/engine/src/schema.ts';
import { applyFilters, type Filters } from './filters.ts';

export const OUTPUT_DIR = join(homedir(), 'Documents', 'Places Scraper');

export type JobStatus = 'geocoding' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobRequest {
  /** Category or free-text query, e.g. "restaurants". */
  query: string;
  /** Place name to sweep, e.g. "Brooklyn, NY". */
  location: string;
  limit?: number;
  filters?: Filters;
  language?: string;
}

export interface Job {
  id: string;
  request: JobRequest;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  /** Resolved region, once geocoding succeeds. */
  region?: { displayName: string; areaKm2: number };
  progress: ScrapeProgress;
  /** Places kept after filtering. */
  places: Place[];
  /** Rows dropped by the filters, so the UI can explain the gap. */
  filtered: number;
  error?: string;
  csvPath?: string;
}

const jobs = new Map<string, Job>();
const cancellers = new Map<string, AbortController>();

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function cancelJob(id: string): boolean {
  const controller = cancellers.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Filesystem-safe, human-readable name: "restaurants-brooklyn-ny-2026-07-16". */
function fileNameFor(job: Job): string {
  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const date = new Date(job.startedAt).toISOString().slice(0, 10);
  return `${slug(job.request.query)}-${slug(job.request.location)}-${date}.csv`;
}

export function startJob(request: JobRequest, onUpdate: (job: Job) => void): Job {
  const id = randomUUID();
  const controller = new AbortController();
  cancellers.set(id, controller);

  const job: Job = {
    id,
    request,
    status: 'geocoding',
    startedAt: Date.now(),
    progress: { found: 0, duplicates: 0, cellsSearched: 0, cellsPending: 0, cellsFailed: 0 },
    places: [],
    filtered: 0,
  };
  jobs.set(id, job);

  void run(job, controller, onUpdate);
  return job;
}

async function run(job: Job, controller: AbortController, onUpdate: (job: Job) => void): Promise<void> {
  const publish = () => onUpdate(job);

  try {
    const place = await geocodeOne(job.request.location);
    if (!place) {
      throw new Error(`Couldn't find "${job.request.location}" on the map. Try adding a state or country.`);
    }
    job.region = { displayName: place.displayName, areaKm2: Math.round(areaSquareKm(place.box)) };
    job.status = 'running';
    publish();

    const proxies = proxyPoolFromEnv();
    const result = await scrape(
      {
        query: job.request.query,
        region: place.box,
        limit: job.request.limit,
        language: job.request.language ?? 'en',
        concurrency: proxies ? 8 : 4,
        proxies,
        signal: controller.signal,
      },
      (progress) => {
        job.progress = progress;
        publish();
      },
    );

    const kept = applyFilters(result.places, job.request.filters ?? {});
    job.filtered = result.places.length - kept.length;
    job.places = kept;

    await mkdir(OUTPUT_DIR, { recursive: true });
    const path = join(OUTPUT_DIR, fileNameFor(job));
    await writeFile(path, toCsv(kept), 'utf8');
    job.csvPath = path;

    job.status = 'done';
    job.finishedAt = Date.now();
  } catch (error) {
    const aborted = controller.signal.aborted;
    job.status = aborted ? 'cancelled' : 'failed';
    job.error = aborted ? undefined : (error as Error).message;
    job.finishedAt = Date.now();
  } finally {
    cancellers.delete(job.id);
    publish();
  }
}
