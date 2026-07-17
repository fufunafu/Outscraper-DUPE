/**
 * The scrape pipeline: a query plus a region in, deduplicated places out.
 *
 * Wires the coverage engine to the search client. Each cell the quadtree hands
 * us is paged to exhaustion, parsed, and deduped; the resulting count decides
 * whether that cell gets subdivided.
 */

import { coverRegion, type Cell, type CoverageResult } from './geo/quadtree.ts';
import type { BBox } from './geo/tiles.ts';
import { centreOf } from './geo/tiles.ts';
import { parseSearchPage, type ParsedSearchPage } from './parse/search.ts';
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
  /** Cells searched in parallel. Defaults to scale with the egress pool size. */
  concurrency?: number;
  /**
   * Egress IPs to rotate through. Without one, every request carries the
   * operator's own address; a run of any size will get it rate-limited.
   * Ignored when a pre-built `egress` pool is supplied.
   */
  proxies?: ProxyPool | null;
  /**
   * A pre-built, already-warmed egress pool to reuse across many scrape calls.
   * A vertical run scrapes hundreds of boxes; building and warming a fresh pool
   * for each would re-issue every session warm-up hundreds of times and hammer
   * the proxies. Build one pool for the whole run and pass it here.
   */
  egress?: EgressPool;
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
): Promise<{ total: number; hitCap: boolean }> {
  const { lat, lng } = centreOf(cell.box);
  let total = 0;
  let hitCap = false;

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

    const page = await fetchPage(url, options, egress);
    const places = page.places;
    if (places.length === 0) break;

    onPlaces(places);
    total += places.length;

    // A short page means Google served the whole list before the cap — the cell
    // is complete. A full page every time until the cap means the list was
    // truncated and real places were dropped; that cell must be subdivided.
    if (places.length < PAGE_SIZE) break;
    if (offset + PAGE_SIZE >= RESULT_CAP) hitCap = true;
  }

  return { total, hitCap };
}

/** How many times one page is retried through fresh egresses before giving up. */
const MAX_PAGE_ATTEMPTS = 5;

/**
 * Fetch and parse one page, resiliently.
 *
 * Pacing and IP selection are the egress pool's job; this loop decides what to
 * do with the outcome:
 *
 *  - **Success, full payload** → return it.
 *  - **Success, degraded payload** (fields stripped under load) → retry a couple
 *    of times for a full one, but if it stays degraded, RETURN it anyway. The
 *    places are real; losing the whole cell over a missing review count is the
 *    exact failure that stalled the province run. A cell of stripped-but-real
 *    places beats a cell of nothing.
 *  - **Block / rate-limit / network error** → report it as push-back so the pool
 *    slows every IP, then retry through a different egress. Only after exhausting
 *    attempts does it throw, which correctly fails the cell (a blocked cell must
 *    not be mistaken for a complete one — see searchCell).
 */
async function fetchPage(url: string, options: ScrapeOptions, egress: EgressPool): Promise<ParsedSearchPage> {
  let lastDegraded: ParsedSearchPage | null = null;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_PAGE_ATTEMPTS; attempt++) {
    options.signal?.throwIfAborted();
    const exit = await egress.acquire(options.signal);
    try {
      const payload = await fetchSearchPage(url, {
        hl: options.language,
        signal: options.signal,
        session: exit.session,
        dispatcher: exit.dispatcher,
      });
      const parsed = parseSearchPage(payload, options.query);
      egress.reportSuccess(exit);

      if (!parsed.degraded) return parsed;
      // Keep the best degraded result seen; try once or twice more for a full one.
      lastDegraded = parsed;
      if (attempt >= 2) return parsed;
    } catch (error) {
      lastError = error;
      const pushback = error instanceof RateLimited || error instanceof BlockedByCaptcha;
      egress.reportFailure(exit, { pushback });
      // A non-network, non-block error (a genuine bug) is not worth retrying.
      if (!pushback && !isTransientNetworkError(error)) throw error;
    }
  }

  // Out of attempts. Prefer real-but-stripped data over failing the cell.
  if (lastDegraded) return lastDegraded;
  throw lastError ?? new Error('page fetch failed after retries');
}

/** undici/network hiccups worth retrying, as opposed to a programming error. */
function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code ?? '';
  const cause = ((error.cause as { code?: string } | undefined)?.code) ?? '';
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|UND_ERR|fetch failed|terminated|timeout/i.test(
    `${error.name} ${error.message} ${code} ${cause}`,
  );
}

export async function scrape(
  options: ScrapeOptions,
  onProgress?: (progress: ScrapeProgress) => void,
): Promise<ScrapeResult> {
  const deduper = new Deduper();
  const places: Place[] = [];
  const limit = options.limit ?? Infinity;
  let truncatedByLimit = false;

  // Reuse a pre-built, already-warmed pool when the caller supplies one (a
  // vertical run shares one pool across hundreds of boxes). Otherwise build and
  // warm a fresh one for this call — warming once here, not once per cell.
  const egress = options.egress ?? EgressPool.create(options.proxies ?? null, options.language ?? 'en', USER_AGENT);
  if (!options.egress) await egress.warmAll(options.signal);

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

      // Keep only in-region places. Google widens a sparse search to fill the
      // viewport (glass shops in London for an empty BC cell) and a domestic IP
      // biases toward its own location; those are not leads and are dropped.
      let inRegionCount = 0;
      const { hitCap } = await searchCell(cell, options, egress, (found) => {
        for (const place of found) {
          if (!inRegion(place, options.region)) continue;
          inRegionCount += 1;
          if (places.length >= limit) {
            truncatedByLimit = true;
            return;
          }
          if (deduper.add(place)) places.push(place);
        }
      });

      // Subdivide only when Google truncated the list (pagination hit the cap).
      // A cell that returned everything before the cap is complete, however many
      // places it held — this is what stops the runaway splitting of dense-but-
      // finite areas that a count/spread heuristic caused.
      return { count: inRegionCount, saturated: hitCap };
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
