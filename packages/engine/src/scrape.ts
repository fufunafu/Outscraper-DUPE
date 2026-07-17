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
import { BlockedByCaptcha, fetchSearchPage, RateLimited, USER_AGENT } from './search/client.ts';
import { EgressPool, concurrencyFor } from './search/egress.ts';
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
 * Is this place inside the region being scraped?
 *
 * A small margin lets in places right on the border, whose coordinates Google
 * rounds slightly, without admitting the wrong-continent filler results that a
 * sparse viewport pulls in. A place with no coordinates is kept — it is more
 * likely a parse gap than a real out-of-region hit.
 */
function inRegion(place: Place, region: BBox): boolean {
  if (place.latitude == null || place.longitude == null) return true;
  const margin = 0.05; // ~5.5 km, absorbing boundary rounding
  return (
    place.latitude >= region.south - margin &&
    place.latitude <= region.north + margin &&
    place.longitude >= region.west - margin &&
    place.longitude <= region.east + margin
  );
}

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
  egress: EgressPool,
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

    const { places } = await withRetry(async () => {
      // A different egress per attempt: a retry after a block leaves the IP that
      // got blocked, and its cookie goes with it since they're paired.
      const { dispatcher, session } = egress.next();
      const payload = await fetchSearchPage(url, {
        hl: options.language,
        signal: options.signal,
        session,
        dispatcher,
      });
      const parsed = parseSearchPage(payload, options.query);
      // A degraded page has real places with fields stripped. Retrying is worth
      // it because the cause is a transient server-side race, not our request —
      // an identical retry usually comes back full.
      if (parsed.degraded) throw new DegradedPayload();
      return parsed;
    });
    if (places.length === 0) break;

    onPlaces(places);
    total += places.length;

    // A short page means the result list is exhausted before the cap.
    if (places.length < PAGE_SIZE) break;
  }

  return total;
}

/** Google returned a real but field-stripped response; an identical retry usually fixes it. */
class DegradedPayload extends Error {
  constructor() {
    super('Google served a reduced payload');
    this.name = 'DegradedPayload';
  }
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
      const retryable =
        error instanceof RateLimited ||
        error instanceof BlockedByCaptcha ||
        error instanceof DegradedPayload;
      // Out of retries on a degraded page: take the stripped data rather than
      // losing the cell entirely. Missing a review count beats missing 20 places.
      if (error instanceof DegradedPayload && attempt === attempts - 1) throw error;
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

  // One egress (proxy + its own session) per exit IP. Warm them all up front so
  // the first wave of searches doesn't race a burst of cookie warm-ups.
  const egress = EgressPool.create(options.proxies ?? null, options.language ?? 'en', USER_AGENT);
  await egress.warmAll();

  // Concurrency scales with the number of exit IPs: more proxies, more parallel
  // cells, up to a ceiling. An explicit option still overrides.
  const concurrency = options.concurrency ?? concurrencyFor(egress.size);

  const coverage = await coverRegion(
    options.region,
    async (cell) => {
      if (places.length >= limit) {
        truncatedByLimit = true;
        // Report the cell as unsaturated so the quadtree stops descending here;
        // we're done regardless, and splitting would only cost requests.
        return { count: 0, saturated: false };
      }

      // Keep this cell's own in-region places. Google widens a search when the
      // viewport is sparse — returning glass shops in London for a tiny empty
      // cell in BC — and a domestic IP can bias results toward its own location.
      // Anything outside the target region is not a lead and must be dropped;
      // just as important, it must NOT count toward saturation, or those global
      // filler results make an empty cell look full and drive pointless splits.
      const cellPlaces: Place[] = [];
      await searchCell(cell, options, egress, (found) => {
        for (const place of found) {
          if (!inRegion(place, options.region)) continue;
          cellPlaces.push(place);
          if (places.length >= limit) {
            truncatedByLimit = true;
            return;
          }
          if (deduper.add(place)) places.push(place);
        }
      });

      const { saturated } = assessSaturation(cell.box, cellPlaces);
      return { count: cellPlaces.length, saturated };
    },
    { concurrency },
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
