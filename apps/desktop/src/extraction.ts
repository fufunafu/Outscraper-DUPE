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

/** Stable key for one unit of work, so resuming can tell what is already done. */
function unitKey(region: string, term: string, boxIndex: number): string {
  return `${region}|${term}|box${boxIndex}`;
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
    extraction.progress.unitsTotal = terms.length * boxes.length;
    extraction.progress.placesInDb = db.count;
    extraction.status = 'running';
    publish();

    // Warm the pool once for the whole run.
    await egress.warmAll(controller.signal);

    let cellsBase = 0;
    for (let ti = 0; ti < terms.length; ti++) {
      const term = terms[ti]!;
      extraction.progress.currentTerm = term;

      for (let bi = 0; bi < boxes.length; bi++) {
        controller.signal.throwIfAborted();
        const key = unitKey(regionKey, term, bi);

        if (db.isUnitDone(key)) {
          // Already extracted on a previous run — skip, but still count it done.
          extraction.resumed = true;
          extraction.progress.unitsDone += 1;
          publish();
          continue;
        }

        const result = await scrape(
          {
            query: term,
            region: boxes[bi]!.box,
            language: extraction.request.language ?? 'en',
            egress,
            signal: controller.signal,
          },
          (p) => {
            extraction.progress.cellsSearched = cellsBase + p.cellsSearched;
            extraction.progress.backoff = egress.backoff;
            extraction.progress.benched = egress.benched;
            publish();
          },
        );
        cellsBase = extraction.progress.cellsSearched;

        // Persist this box's places; count only genuinely new ones.
        const { inserted } = db.upsertMany(result.places);
        extraction.progress.newThisRun += inserted;
        extraction.progress.placesInDb = db.count;

        db.markUnitDone(key, result.places.length);
        extraction.progress.unitsDone += 1;
        publish();
      }

      extraction.progress.termsDone = ti + 1;
      publish();
    }

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
