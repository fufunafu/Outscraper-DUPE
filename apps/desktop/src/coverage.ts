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
import { notify } from './notify.ts';
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
  /** Which full sweep of all regions this is — each cycle is one more pass everywhere. */
  cycle: number;
  current?: { country: string; region: string };
  currentExtractionId?: string;
}

let active: CoverageRun | null = null;
let stopped = false;

export const getCoverageRun = (): CoverageRun | null => active;

/** The settings key holding the in-flight campaign, so a reboot can resume it. */
const CAMPAIGN_KEY = 'activeCampaign';

function persistCampaign(vertical: string, language: string): void {
  const db = openDatabase();
  try {
    db.setSetting(CAMPAIGN_KEY, JSON.stringify({ vertical, language }));
  } finally {
    db.close();
  }
}

function clearCampaign(): void {
  const db = openDatabase();
  try {
    db.deleteSetting(CAMPAIGN_KEY);
  } finally {
    db.close();
  }
}

/**
 * If a campaign was running when the app last died — a reboot, an update, a
 * power cut — pick it up again without anyone having to notice or click.
 * Explicit stops and completed sweeps clear the record, so only genuine
 * interruptions resume.
 */
export function resumeCampaignIfAny(
  onExtraction: (e: Extraction) => void,
  onUpdate: (run: CoverageRun) => void,
): CoverageRun | null {
  if (active?.status === 'running') return active;
  const db = openDatabase();
  let saved: { vertical: string; language: string } | null = null;
  try {
    const raw = db.getSetting(CAMPAIGN_KEY);
    if (raw) saved = JSON.parse(raw) as { vertical: string; language: string };
  } catch {
    saved = null;
  } finally {
    db.close();
  }
  if (!saved?.vertical) return null;
  return startCoverage(saved.vertical, saved.language ?? 'en', onExtraction, onUpdate);
}

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
    cycle: 1,
  };
  active = run;
  stopped = false;
  persistCampaign(vertical, language);
  void execute(run, onExtraction, onUpdate);
  return run;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sleep that wakes early when the campaign is stopped. */
async function pause(ms: number): Promise<void> {
  for (let waited = 0; waited < ms && !stopped; waited += 1_000) await sleep(1_000);
}

/** Least-covered first: zero-pass regions always outrank deepening covered ones. */
function buildQueue(vertical: string): { country: string; region: string }[] {
  const db = openDatabase();
  let passesByRegion = new Map<string, number>();
  try {
    passesByRegion = new Map(
      db.coverage()
        .filter((c) => c.vertical === vertical)
        .map((c) => [c.region, c.passes]),
    );
  } finally {
    db.close();
  }
  return allRegions()
    .map((r, order) => ({ ...r, order, passes: passesByRegion.get(`${r.country}/${r.region}`) ?? 0 }))
    .sort((a, b) => a.passes - b.passes || a.order - b.order);
}

async function execute(
  run: CoverageRun,
  onExtraction: (e: Extraction) => void,
  onUpdate: (run: CoverageRun) => void,
): Promise<void> {
  const publish = () => onUpdate(run);

  const buildOne = async (
    target: { country: string; region: string },
  ): Promise<{ ok: boolean; added: number }> => {
    run.current = { country: target.country, region: target.region };
    const extraction = startExtraction(
      { vertical: run.vertical, location: { country: target.country, region: target.region }, language: run.language },
      onExtraction,
    );
    run.currentExtractionId = extraction.id;
    publish();
    await awaitExtraction(extraction.id);
    const done = getExtraction(extraction.id);
    return { ok: done?.status !== 'failed', added: done?.progress.newThisRun ?? 0 };
  };

  // Perpetual: each cycle adds one pass everywhere, and Google returns a
  // different sample each time, so every cycle keeps finding businesses the
  // previous ones missed. Runs until someone presses Stop.
  for (;;) {
    const cycleStarted = Date.now();
    const queue = buildQueue(run.vertical);
    run.regionsDone = 0;
    run.failures = 0;
    publish();

    const failed: { country: string; region: string }[] = [];
    for (const target of queue) {
      if (stopped) break;
      const result = await buildOne(target);
      if (result.ok) {
        notify('Places Scraper', `${target.country}-${target.region} ${run.vertical} done: +${result.added.toLocaleString()} new`);
      } else {
        run.failures += 1;
        failed.push(target);
      }
      run.regionsDone += 1;
      publish();
    }

    // One retry round: a transient failure kills that region's extraction, but
    // its units are checkpointed — a retry resumes the pass and usually lands it.
    for (const target of failed) {
      if (stopped) break;
      if ((await buildOne(target)).ok) run.failures -= 1;
      else notify('Places Scraper', `${target.country}-${target.region} failed twice — will retry next cycle`);
      publish();
    }

    if (stopped) break;
    notify('Places Scraper', `Cycle ${run.cycle} complete — starting the next pass.`);
    run.cycle += 1;
    run.current = undefined;
    run.currentExtractionId = undefined;
    publish();

    // Cool-down between cycles. A suspiciously fast or fully-failing cycle
    // means something is systematically wrong (no proxies, no network) — back
    // off for an hour instead of hammering in a hot loop.
    const wholeCycleFailed = run.failures >= run.regionsTotal;
    const suspiciouslyFast = Date.now() - cycleStarted < 10 * 60_000;
    await pause(wholeCycleFailed || suspiciouslyFast ? 60 * 60_000 : 60_000);
    if (stopped) break;
  }

  run.status = 'cancelled';
  run.finishedAt = Date.now();
  run.current = undefined;
  run.currentExtractionId = undefined;
  // Stop is deliberate — don't resurrect at next boot. Only a crash leaves the
  // campaign record behind for auto-resume.
  clearCampaign();
  publish();
}
