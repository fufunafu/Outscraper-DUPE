/**
 * The coverage queue: full Canada + USA, one region at a time.
 *
 * "Full coverage" of a vertical means every province and state has at least one
 * completed extraction pass — 64 regions in all. Nobody should have to start 64
 * runs by hand, so this queue does it: it orders regions least-covered first
 * (a region with no passes yet always beats deepening one that has some), runs
 * a normal extraction for each, and moves on when it finishes. One region at a
 * time, because every extraction already saturates the whole proxy pool —
 * running two would just split the same throughput and double the risk.
 *
 * Cancelling stops after aborting the current region's extraction, and loses
 * nothing: the extraction itself checkpoints every unit, so the next queue run
 * resumes the interrupted pass and continues down the same least-covered order.
 */

import { randomUUID } from 'node:crypto';

import { COUNTRIES } from '../../../packages/engine/src/locations.ts';
import {
  awaitExtraction, cancelExtraction, getExtraction, openDatabase, startExtraction,
  type Extraction,
} from './extraction.ts';

export interface CoverageRun {
  id: string;
  vertical: string;
  language: string;
  status: 'running' | 'done' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  regionsTotal: number;
  regionsDone: number;
  /** Regions whose extraction failed (kept going; they stay least-covered for next time). */
  failures: number;
  current?: { country: string; region: string };
  currentExtractionId?: string;
}

let active: CoverageRun | null = null;
let stopped = false;

export const getCoverageRun = (): CoverageRun | null => active;

/** Every region we aim to cover, in stable country-then-list order. */
export function allRegions(): { country: string; region: string }[] {
  const out: { country: string; region: string }[] = [];
  for (const [country, data] of Object.entries(COUNTRIES)) {
    for (const region of data.regions) out.push({ country, region: region.code });
  }
  return out;
}

export function cancelCoverage(): boolean {
  if (!active || active.status !== 'running') return false;
  stopped = true;
  if (active.currentExtractionId) cancelExtraction(active.currentExtractionId);
  return true;
}

export function startCoverage(
  vertical: string,
  language: string,
  onExtraction: (e: Extraction) => void,
  onUpdate: (run: CoverageRun) => void,
): CoverageRun {
  if (active?.status === 'running') {
    throw new Error(`An auto-build (${active.vertical}) is already running. Stop it first.`);
  }

  const run: CoverageRun = {
    id: randomUUID(),
    vertical,
    language,
    status: 'running',
    startedAt: Date.now(),
    regionsTotal: allRegions().length,
    regionsDone: 0,
    failures: 0,
  };
  active = run;
  stopped = false;
  void execute(run, onExtraction, onUpdate);
  return run;
}

async function execute(
  run: CoverageRun,
  onExtraction: (e: Extraction) => void,
  onUpdate: (run: CoverageRun) => void,
): Promise<void> {
  const publish = () => onUpdate(run);

  // Least-covered first: a region with zero completed passes always outranks
  // one with any, so a fresh queue run spreads coverage before deepening it.
  const db = openDatabase();
  let passesByRegion = new Map<string, number>();
  try {
    passesByRegion = new Map(
      db.coverage()
        .filter((c) => c.vertical === run.vertical)
        .map((c) => [c.region, c.passes]),
    );
  } finally {
    db.close();
  }
  const queue = allRegions()
    .map((r, order) => ({ ...r, order, passes: passesByRegion.get(`${r.country}/${r.region}`) ?? 0 }))
    .sort((a, b) => a.passes - b.passes || a.order - b.order);

  publish();

  for (const target of queue) {
    if (stopped) break;
    run.current = { country: target.country, region: target.region };
    const extraction = startExtraction(
      { vertical: run.vertical, location: { country: target.country, region: target.region }, language: run.language },
      onExtraction,
    );
    run.currentExtractionId = extraction.id;
    publish();

    await awaitExtraction(extraction.id);
    if (getExtraction(extraction.id)?.status === 'failed') run.failures += 1;
    run.regionsDone += 1;
    publish();
  }

  run.status = stopped ? 'cancelled' : 'done';
  run.finishedAt = Date.now();
  run.current = undefined;
  run.currentExtractionId = undefined;
  publish();
}
