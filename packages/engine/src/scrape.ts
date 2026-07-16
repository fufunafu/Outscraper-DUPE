/**
 * The scrape pipeline: a query plus a region in, deduplicated places out.
 *
 * Wires the coverage engine to the search client. Each cell the quadtree hands
 * us is paged to exhaustion, parsed, and deduped; the resulting count decides
 * whether that cell gets subdivided.
 */

import { coverRegion, type Cell, type CoverageResult } from './geo/quadtree.ts';
import { assessSaturation } from './geo/saturation.ts';
import type { BBox } from './geo/tiles.ts';
import { centreOf } from './geo/tiles.ts';
import { parseSearchPage } from './parse/search.ts';
import { buildSearchUrl, PAGE_SIZE, RESULT_CAP } from './search/pb.ts';
import { BlockedByCaptcha, fetchSearchPage, RateLimited } from './search/client.ts';
import { Deduper } from './store/dedupe.ts';
import type { ProxyPool } from './search/proxy.ts';
import type { Place } from './schema.ts';

export interface ScrapeOptions {
  query: string;
  region: BBox;
  /** Stop once this many unique places have been found. */
  limit?: number;
  language?: string;
  /** Cells searched in parallel. Past ~8 the gain flattens and block risk rises. */
  concurrency?: number;
  /**
   * Egress IPs to rotate through. Without one, every request carries the
   * operator's own address; a run of any size will get it rate-limited.
   */
  proxies?: ProxyPool | null;
  signal?: AbortSignal;
}

export interface ScrapeProgress {
  found: number;
  duplicates: number;
  cellsSearched: number;
  cellsPending: number;
  /** Cells abandoned after repeated failures — each is a hole in coverage. */
  cellsFailed: number;
  lastPlace?: string;
}

export interface ScrapeResult {
  places: Place[];
  coverage: CoverageResult;
  duplicates: number;
  /** True when the run stopped early because `limit` was reached. */
  truncatedByLimit: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Page a single cell until it stops yielding, or hits the cap.
 *
 * Throws on a block rather than returning a short count. This distinction is
 * the whole correctness story for coverage: a cell that returns few results
 * because it is sparse must NOT be treated the same as a cell that returns few
 * results because we were throttled. The first is complete; the second is a
 * silent hole, and returning a number for it would tell the quadtree the cell
 * was fully enumerated when it never even ran.
 */
async function searchCell(
  cell: Cell,
  options: ScrapeOptions,
  onPlaces: (places: Place[]) => void,
): Promise<number> {
  const { lat, lng } = centreOf(cell.box);
  let total = 0;

  for (let offset = 0; offset < RESULT_CAP; offset += PAGE_SIZE) {
    options.signal?.throwIfAborted();

    const url = buildSearchUrl({
      query: options.query,
      lat,
      lng,
      zoom: cell.zoom,
      offset,
      hl: options.language ?? 'en',
    });

    const payload = await withRetry(() =>
      fetchSearchPage(url, {
        hl: options.language,
        signal: options.signal,
        // A fresh dispatcher per attempt, so a retry after a block leaves the
        // IP that got blocked rather than hammering it again.
        ...(options.proxies ? { dispatcher: options.proxies.next() } : {}),
      }),
    );
    const { places } = parseSearchPage(payload, options.query);
    if (places.length === 0) break;

    onPlaces(places);
    total += places.length;

    // A short page means the result list is exhausted before the cap.
    if (places.length < PAGE_SIZE) break;
  }

  return total;
}

/**
 * Retry transient blocks with exponential backoff.
 *
 * Rethrows after the last attempt instead of swallowing — see searchCell: a
 * swallowed block would be indistinguishable from an empty cell.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof RateLimited || error instanceof BlockedByCaptcha;
      if (!retryable || attempt === attempts - 1) throw error;
      // Jittered backoff: 1s, 2s, 4s ± 50%, so parallel workers don't retry in lockstep.
      const base = 1000 * 2 ** attempt;
      await sleep(base * (0.5 + Math.random()));
    }
  }
  throw lastError;
}

export async function scrape(
  options: ScrapeOptions,
  onProgress?: (progress: ScrapeProgress) => void,
): Promise<ScrapeResult> {
  const deduper = new Deduper();
  const places: Place[] = [];
  const limit = options.limit ?? Infinity;
  let truncatedByLimit = false;

  const coverage = await coverRegion(
    options.region,
    async (cell) => {
      if (places.length >= limit) {
        truncatedByLimit = true;
        // Report the cell as unsaturated so the quadtree stops descending here;
        // we're done regardless, and splitting would only cost requests.
        return { count: 0, saturated: false };
      }

      // Keep this cell's own places, including ones already seen elsewhere:
      // saturation is about what Google served for THIS viewport, so filtering
      // to new-only would make a heavily-overlapped cell look artificially sparse.
      const cellPlaces: Place[] = [];
      const count = await searchCell(cell, options, (found) => {
        cellPlaces.push(...found);
        for (const place of found) {
          if (places.length >= limit) {
            truncatedByLimit = true;
            return;
          }
          if (deduper.add(place)) places.push(place);
        }
      });

      const { saturated } = assessSaturation(cell.box, cellPlaces);
      return { count, saturated };
    },
    { concurrency: options.concurrency ?? 4 },
    (progress) => {
      onProgress?.({
        found: places.length,
        duplicates: deduper.stats.duplicates,
        cellsSearched: progress.searched,
        cellsPending: progress.pending,
        cellsFailed: 0,
        lastPlace: places.at(-1)?.name ?? undefined,
      });
    },
  );

  return { places, coverage, duplicates: deduper.stats.duplicates, truncatedByLimit };
}
