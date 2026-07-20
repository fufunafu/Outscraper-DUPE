/**
 * Vertical extraction: build a durable, queryable database of one vertical
 * (construction, medical) across a whole province.
 *
 * This is the "scrape once, query forever" job. It sweeps every term in the
 * vertical across the region's population-seeded boxes, writing each place into
 * the shared SQLite database as it goes. The unit of work is one (term × box);
 * every completed unit is recorded, so a run that is interrupted — a crash, a
 * closed laptop, a killed process — resumes exactly where it left off instead of
 * starting over. That is what makes an hours-long province build safe to run on
 * a spare always-on machine.
 *
 * It shares the hardened engine with the city CSV jobs: one warmed egress pool
 * for the whole run, paced and self-throttling, so a long sweep does not hammer
 * itself into a block.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { scrape } from '../../../packages/engine/src/scrape.ts';
import { geocodeOne } from '../../../packages/engine/src/geo/geocode.ts';
import { loadProxies } from '../../../packages/engine/src/search/proxy-config.ts';
import { EgressPool } from '../../../packages/engine/src/search/egress.ts';
import { USER_AGENT } from '../../../packages/engine/src/search/client.ts';
import { seedBoxes } from '../../../packages/engine/src/geo/seeds.ts';
import { PlaceDatabase } from '../../../packages/engine/src/store/database.ts';
import { verticalTerms } from '../../../packages/engine/src/verticals.ts';
import { findRegion, toQuery, type LocationSelection } from '../../../packages/engine/src/locations.ts';
import { OUTPUT_DIR } from './jobs.ts';

export const DATABASE_PATH = join(OUTPUT_DIR, 'places.db');

export interface ExtractionRequest {
  vertical: string;
  /** A whole province/state — no city; extraction is a region-scale operation. */
  location: LocationSelection;
  language?: string;
}

export type ExtractionStatus = 'starting' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ExtractionProgress {
  unitsTotal: number;
  unitsDone: number;
  /** Total places in the database (all verticals, all regions). */
  placesInDb: number;
  /** Places written by this run. */
  newThisRun: number;
  currentTerm?: string;
  termsDone: number;
  termsTotal: number;
  /** Which accumulation pass this is, and whether it resumed an interrupted one. */
  pass: number;
  resuming: boolean;
  cellsSearched: number;
  /** Adaptive backoff multiplier and benched IP count, for a health readout. */
  backoff: number;
  benched: number;
}

export interface Extraction {
  id: string;
  request: ExtractionRequest;
  status: ExtractionStatus;
  startedAt: number;
  finishedAt?: number;
  progress: ExtractionProgress;
  /** True when this run skipped units a previous run already completed. */
  resumed: boolean;
  error?: string;
}

const extractions = new Map<string, Extraction>();
const cancellers = new Map<string, AbortController>();

/** Read-only handle to the database, for the query UI and exports. */
export function openDatabase(): PlaceDatabase {
  return new PlaceDatabase(DATABASE_PATH);
}

export const getExtraction = (id: string): Extraction | undefined => extractions.get(id);
export const listExtractions = (): Extraction[] =>
  [...extractions.values()].sort((a, b) => b.startedAt - a.startedAt);

export function cancelExtraction(id: string): boolean {
  const controller = cancellers.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Stable key for one unit of work in a given pass, for resume tracking. */
function unitKey(region: string, pass: number, term: string, boxIndex: number): string {
  return `${region}|p${pass}|${term}|box${boxIndex}`;
}

export function startExtraction(request: ExtractionRequest, onUpdate: (e: Extraction) => void): Extraction {
  const id = randomUUID();
  const controller = new AbortController();
  cancellers.set(id, controller);

  const terms = verticalTerms(request.vertical);
  const extraction: Extraction = {
    id,
    request,
    status: 'starting',
    startedAt: Date.now(),
    resumed: false,
    progress: {
      unitsTotal: 0,
      unitsDone: 0,
      placesInDb: 0,
      newThisRun: 0,
      termsDone: 0,
      termsTotal: terms.length,
      pass: 0,
      resuming: false,
      cellsSearched: 0,
      backoff: 1,
      benched: 0,
    },
  };
  extractions.set(id, extraction);
  void run(extraction, controller, onUpdate);
  return extraction;
}

async function run(
  extraction: Extraction,
  controller: AbortController,
  onUpdate: (e: Extraction) => void,
): Promise<void> {
  const publish = () => onUpdate(extraction);
  const db = new PlaceDatabase(DATABASE_PATH);
  const { pool: proxies } = await loadProxies();
  const egress = EgressPool.create(proxies, extraction.request.language ?? 'en', USER_AGENT);

  try {
    const { location } = extraction.request;
    const terms = verticalTerms(extraction.request.vertical);
    if (terms.length === 0) throw new Error(`Unknown vertical "${extraction.request.vertical}".`);

    // Seed the region into population boxes (skips the empty wilderness).
    const region = findRegion(location.country, location.region);
    const geo = await geocodeOne(toQuery(location));
    if (!geo) throw new Error(`Couldn't find "${toQuery(location)}" on the map.`);
    const boxes =
      region && region.cities.length > 0
        ? seedBoxes(region.cities.map((c) => ({ name: c.n, lat: c.lat, lng: c.lng, population: c.p })), geo.box)
        : [{ box: geo.box, seeds: [location.region] }];

    const regionKey = `${location.country}/${location.region}`;
    // Resume an interrupted pass, or start the next one — each pass accumulates
    // the ~40–50% of businesses the previous passes' samples missed.
    const { pass, resuming } = db.resolvePass(regionKey, extraction.request.vertical);
    extraction.progress.pass = pass;
    extraction.progress.resuming = resuming;
    extraction.progress.unitsTotal = terms.length * boxes.length;
    extraction.progress.placesInDb = db.count;
    extraction.status = 'running';
    publish();

    // Warm the pool once for the whole run.
    await egress.warmAll(controller.signal);

    // The unit list: every (term × box). Ordered term-major so progress reads as
    // "term N of 79", but processed by a worker pool so the proxies stay busy.
    interface Unit { term: string; termIndex: number; boxIndex: number; }
    const units: Unit[] = [];
    for (let ti = 0; ti < terms.length; ti++) {
      for (let bi = 0; bi < boxes.length; bi++) units.push({ term: terms[ti]!, termIndex: ti, boxIndex: bi });
    }

    // Run many boxes at once so the 100-proxy pool is saturated rather than idle
    // between small rural boxes. The egress pool's pacing is the real throttle —
    // it keeps every IP safe no matter how many units are in flight — so unit
    // concurrency is bounded by the pool size, not by politeness. Each scrape
    // then uses a modest internal concurrency, since the parallel units already
    // fill the pool.
    const unitConcurrency = Math.max(4, Math.min(24, Math.round(egress.size / 6)));
    const perScrapeConcurrency = Math.max(3, Math.round((egress.size * 1.5) / unitConcurrency));

    let cellsTotal = 0;
    let cursor = 0;
    const maxTermDone = () => {
      // termsDone advances only once every box of a term is finished.
      let done = 0;
      for (let ti = 0; ti < terms.length; ti++) {
        if (boxes.every((_, bi) => db.isUnitDone(unitKey(regionKey, pass, terms[ti]!, bi)))) done = ti + 1;
        else break;
      }
      return done;
    };

    const worker = async (): Promise<void> => {
      while (cursor < units.length) {
        controller.signal.throwIfAborted();
        const unit = units[cursor++]!;
        const key = unitKey(regionKey, pass, unit.term, unit.boxIndex);

        if (db.isUnitDone(key)) {
          extraction.resumed = true;
          extraction.progress.unitsDone += 1;
          continue;
        }
        extraction.progress.currentTerm = unit.term;

        const result = await scrape({
          query: unit.term,
          region: boxes[unit.boxIndex]!.box,
          language: extraction.request.language ?? 'en',
          concurrency: perScrapeConcurrency,
          egress,
          signal: controller.signal,
        }, (p) => {
          extraction.progress.cellsSearched = cellsTotal + p.cellsSearched;
        });
        cellsTotal = extraction.progress.cellsSearched;

        // Persist this box's places; count only genuinely new ones.
        const { inserted } = db.upsertMany(result.places);
        extraction.progress.newThisRun += inserted;
        extraction.progress.placesInDb = db.count;

        db.markUnitDone(key, result.places.length);
        extraction.progress.unitsDone += 1;
        extraction.progress.termsDone = maxTermDone();
        extraction.progress.backoff = egress.backoff;
        extraction.progress.benched = egress.benched;
        publish();
      }
    };

    await Promise.all(Array.from({ length: unitConcurrency }, worker));

    db.completePass(regionKey, extraction.request.vertical, pass, extraction.progress.newThisRun);
    extraction.status = 'done';
    extraction.finishedAt = Date.now();
  } catch (error) {
    extraction.status = controller.signal.aborted ? 'cancelled' : 'failed';
    if (!controller.signal.aborted) extraction.error = (error as Error).message;
    extraction.finishedAt = Date.now();
  } finally {
    // Progress is durable in the DB; the run can be resumed even after a crash.
    db.close();
    cancellers.delete(extraction.id);
    publish();
  }
}

/**
 * Export a slice of the database to a CSV, returning its path. Streams from the
 * DB so a 60k-row export never holds the whole dataset in memory at once.
 */
export async function exportDatabase(
  filter: import('../../../packages/engine/src/store/database.ts').PlaceQuery,
  label: string,
): Promise<{ path: string; rows: number }> {
  const { toCsv } = await import('../../../packages/engine/src/export/csv.ts');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const db = openDatabase();
  try {
    const rows = [...db.iterate(filter)];
    await mkdir(OUTPUT_DIR, { recursive: true });
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'export';
    const date = new Date().toISOString().slice(0, 10);
    const path = join(OUTPUT_DIR, `${slug}-${date}.csv`);
    await writeFile(path, toCsv(rows), 'utf8');
    return { path, rows: rows.length };
  } finally {
    db.close();
  }
}
