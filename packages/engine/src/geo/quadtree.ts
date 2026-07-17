/**
 * Recursive coverage: turn one "restaurants in Texas" request into a set of
 * search cells small enough that none of them hits Google's per-search result cap.
 *
 * The driver searches a cell, and if the cell came back saturated (at or near
 * the cap) it splits into four and searches each child instead. A saturated cell
 * means Google truncated the list, so places were silently dropped; a cell that
 * comes back under the cap is complete and needs no further work.
 *
 * Cells are searched breadth-first so that partial results are broad rather than
 * deep — cancelling a job halfway still gives coverage across the whole region.
 */

import { type BBox, diagonalMetres, subdivide, zoomForBox } from './tiles.ts';

export interface Cell {
  box: BBox;
  /** Root cells are depth 0; each subdivision adds one. */
  depth: number;
  zoom: number;
}

export interface CoverageOptions {
  /**
   * Stop subdividing once a cell's diagonal falls below this. Past a certain
   * size, splitting costs more searches than it surfaces new places.
   */
  minCellMetres: number;
  /**
   * Always subdivide a cell larger than this, whatever its saturation. This is
   * the floor of coverage for large regions: a province's wilderness interior
   * probes as sparse, so pure saturation-driven splitting would search the
   * centre once and never reach the populated edges. Forcing big cells to split
   * guarantees every part of the region is probed at a resolution fine enough to
   * find a metro before the adaptive logic takes over.
   */
  maxCellMetres: number;
  /** Hard ceiling on subdivision, as a runaway guard. */
  maxDepth: number;
}

export const DEFAULT_COVERAGE: CoverageOptions = {
  // Stop subdividing at ~700m diagonal (~500m cells). Below this, a single
  // search already captures the cell's businesses and finer splitting mostly
  // re-finds the same places — the dominant cost in dense metros. Balances
  // coverage against the cell count: at 250m a downtown box took 349 cells to
  // add ~50 places over what 700m finds in ~30.
  minCellMetres: 700,
  // ~42 km sides. A rural town fits inside one such cell and is captured by its
  // single search; a metro saturates it and splits further. Small regions start
  // below this, so it only affects province/state/country-sized sweeps.
  maxCellMetres: 60_000,
  maxDepth: 9,
};

/** What a search of one cell produced, as far as coverage is concerned. */
export interface CellOutcome {
  /** Number of places the search returned for this cell. */
  count: number;
  /**
   * Whether Google appears to have truncated this cell's list. Decided by the
   * searcher (see geo/saturation.ts), which can see where the places actually
   * are; a count alone cannot tell truncation from sparseness.
   */
  saturated: boolean;
}

export type CellSearcher = (cell: Cell) => Promise<CellOutcome>;

export interface CoverageProgress {
  cell: Cell;
  outcome: CellOutcome;
  /** True when the cell was split because it looked truncated. */
  subdivided: boolean;
  /** Cells searched so far, including this one. */
  searched: number;
  /** Cells currently waiting in the queue. */
  pending: number;
  /** Set when the cell's search threw; the cell contributed no places. */
  error?: Error;
}

export interface CoverageResult {
  cellsSearched: number;
  cellsSubdivided: number;
  /** Cells that stayed saturated even at max depth or min size — likely truncated. */
  cellsTruncated: number;
  /** Cells whose search threw and were skipped. */
  cellsFailed: number;
}

function shouldSubdivide(cell: Cell, outcome: CellOutcome, opts: CoverageOptions): boolean {
  if (cell.depth >= opts.maxDepth) return false;
  const diagonal = diagonalMetres(cell.box);
  if (diagonal <= opts.minCellMetres) return false;
  // Force-split cells too large to trust from a single probe, before consulting
  // saturation — otherwise a big region with an empty centre stops immediately.
  if (diagonal > opts.maxCellMetres) return true;
  return outcome.saturated;
}

export function rootCell(box: BBox): Cell {
  return { box, depth: 0, zoom: zoomForBox(box) };
}

/**
 * Walk `box` until every cell comes back under the saturation threshold.
 *
 * `search` is called once per cell and is responsible for actually fetching and
 * persisting places; this function only reads the result count to decide whether
 * to split. Cells are processed `concurrency` at a time.
 */
export async function coverRegion(
  box: BBox,
  search: CellSearcher,
  options: Partial<CoverageOptions> & { concurrency?: number } = {},
  onProgress?: (progress: CoverageProgress) => void,
): Promise<CoverageResult> {
  const opts: CoverageOptions = { ...DEFAULT_COVERAGE, ...options };
  const concurrency = Math.max(1, options.concurrency ?? 4);

  const queue: Cell[] = [rootCell(box)];
  let searched = 0;
  let subdividedCount = 0;
  let truncated = 0;
  let failed = 0;

  const runCell = async (cell: Cell): Promise<void> => {
    let outcome: CellOutcome;
    try {
      outcome = await search(cell);
    } catch (error) {
      // One bad cell must not abort the region. Treat it as unsaturated so we
      // don't split a cell we never actually read, and surface it as truncated.
      searched += 1;
      failed += 1;
      onProgress?.({
        cell,
        outcome: { count: 0, saturated: false },
        subdivided: false,
        searched,
        pending: queue.length,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }
    searched += 1;

    const split = shouldSubdivide(cell, outcome, opts);
    if (split) {
      subdividedCount += 1;
      for (const child of subdivide(cell.box)) {
        queue.push({ box: child, depth: cell.depth + 1, zoom: zoomForBox(child) });
      }
    } else if (outcome.saturated) {
      // Bottomed out while still saturated: this cell is denser than we can
      // resolve, so some places here were never seen.
      truncated += 1;
    }

    onProgress?.({
      cell,
      outcome,
      subdivided: split,
      searched,
      pending: queue.length,
    });
  };

  const inFlight = new Set<Promise<void>>();
  while (queue.length > 0 || inFlight.size > 0) {
    while (queue.length > 0 && inFlight.size < concurrency) {
      const cell = queue.shift()!;
      const task = runCell(cell).finally(() => inFlight.delete(task));
      inFlight.add(task);
    }
    if (inFlight.size > 0) await Promise.race(inFlight);
  }

  return {
    cellsSearched: searched,
    cellsSubdivided: subdividedCount,
    cellsTruncated: truncated,
    cellsFailed: failed,
  };
}
