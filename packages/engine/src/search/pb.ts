/**
 * Builds the `pb` parameter for Google Maps' internal search endpoint.
 *
 * `pb` is a serialised protobuf message flattened into a URL-safe string. Each
 * node is `!<field><type><value>`, where the type codes are: m=nested message,
 * s=string, i=int, d=double, f=float, b=bool, e=enum. A nested message declares
 * the total number of nodes beneath it — `!4m12` means "field 4, a message with
 * 12 nodes in its subtree", counting nested messages and their children too.
 * Get that count wrong and Google rejects or silently truncates the response,
 * which is why this builder keeps the shape fixed rather than composing it
 * dynamically.
 *
 * Shape derived from gosom/google-maps-scraper (MIT, © 2023 Georgios Komninos),
 * gmaps/searchjob.go — the only part that varies per request is the viewport,
 * the zoom, and the pagination offset.
 */

/** Places returned per request. Google ignores larger values. */
export const PAGE_SIZE = 20;

/**
 * Google stops serving results past this offset for a given query+viewport,
 * no matter how many places actually exist there. This cap — not politeness —
 * is why the region has to be subdivided into cells.
 */
export const RESULT_CAP = 120;

export interface PbParams {
  lat: number;
  lng: number;
  /** Map zoom level; larger is closer in. */
  zoom: number;
  /** Pagination offset in places; must be a multiple of PAGE_SIZE. */
  offset?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}

/**
 * Field !1d is a viewport span in metres, nominally a function of zoom and
 * latitude. Google tolerates a mismatch between it and the !4f zoom, and
 * upstream implementations simply pin it to this constant and vary the zoom
 * instead. Doing the same avoids a second, redundant source of truth.
 */
const ALTITUDE_SPAN = 3826.902183192154;

export function buildPb(params: PbParams): string {
  const {
    lat,
    lng,
    zoom,
    offset = 0,
    viewportWidth = 600,
    viewportHeight = 800,
  } = params;

  return [
    '!4m12',
    '!1m3',
    `!1d${ALTITUDE_SPAN}`,
    `!2d${lng.toFixed(4)}`, // longitude — note the response inverts this order
    `!3d${lat.toFixed(4)}`, // latitude
    '!2m3!1f0!2f0!3f0', // camera tilt / bearing / roll
    `!3m2!1i${Math.round(viewportWidth)}!2i${Math.round(viewportHeight)}`,
    `!4f${zoom.toFixed(1)}`,
    `!7i${PAGE_SIZE}`,
    `!8i${Math.round(offset)}`, // pagination offset
    '!10b1!12m22!1m3!18b1!30b1!34e1!2m3!5m1!6e2!20e3!4b0!10b1!12b1!13b1!16b1',
    '!17m1!3e1!20m3!5e2!6b1!14b1!46m1!1b0!96b1!19m4!2m3!1i360!2i120!4i8',
  ].join('');
}

export interface SearchUrlParams extends PbParams {
  query: string;
  /** UI/response language. Affects day names and status strings when parsing. */
  hl?: string;
}

/**
 * The endpoint accepts the query either as a `q=` URL param or embedded in the
 * pb; `q=` is simpler and equivalent.
 */
export function buildSearchUrl(params: SearchUrlParams): string {
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('tbm', 'map');
  url.searchParams.set('authuser', '0');
  url.searchParams.set('hl', params.hl ?? 'en');
  url.searchParams.set('q', params.query);
  url.searchParams.set('pb', buildPb(params));
  return url.toString();
}
