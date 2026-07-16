/**
 * Viewport math for Google Maps search cells.
 *
 * Google Maps searches are scoped by a viewport, expressed in map URLs as
 * `@lat,lng,ZOOMz`. A search returns places within roughly that viewport, and
 * caps out at a fixed number of results regardless of how many exist. Covering
 * a dense region therefore means splitting it into cells small enough that each
 * one stays under the cap. See `quadtree.ts` for the subdivision driver.
 */

/** Web Mercator ground resolution at zoom 0, in metres per pixel at the equator. */
const EQUATOR_METRES_PER_PIXEL = 156543.03392;

/** Google Maps renders at 256px tiles; a viewport is ~1000px of map at typical window sizes. */
const ASSUMED_VIEWPORT_PIXELS = 1000;

export interface LatLng {
  lat: number;
  lng: number;
}

/** An axis-aligned geographic bounding box. */
export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Metres per pixel at a given latitude and zoom. Longitude lines converge
 * toward the poles, so the same zoom covers less ground the further north you go.
 */
export function metresPerPixel(lat: number, zoom: number): number {
  return (EQUATOR_METRES_PER_PIXEL * Math.cos(toRadians(lat))) / 2 ** zoom;
}

/** Approximate width of a full viewport, in metres, at a given latitude and zoom. */
export function viewportWidthMetres(lat: number, zoom: number): number {
  return metresPerPixel(lat, zoom) * ASSUMED_VIEWPORT_PIXELS;
}

/**
 * The zoom level whose viewport is closest to `metres` wide at this latitude.
 * Clamped to the range Google actually honours for search.
 */
export function zoomForWidth(lat: number, metres: number): number {
  const zoom = Math.log2(
    (EQUATOR_METRES_PER_PIXEL * Math.cos(toRadians(lat)) * ASSUMED_VIEWPORT_PIXELS) / metres,
  );
  return Math.min(21, Math.max(1, Math.round(zoom * 100) / 100));
}

export function centreOf(box: BBox): LatLng {
  return {
    lat: (box.south + box.north) / 2,
    lng: (box.west + box.east) / 2,
  };
}

/** Split a box into four equal children: NW, NE, SW, SE. */
export function subdivide(box: BBox): [BBox, BBox, BBox, BBox] {
  const { lat: midLat, lng: midLng } = centreOf(box);
  return [
    { west: box.west, south: midLat, east: midLng, north: box.north },
    { west: midLng, south: midLat, east: box.east, north: box.north },
    { west: box.west, south: box.south, east: midLng, north: midLat },
    { west: midLng, south: box.south, east: box.east, north: midLat },
  ];
}

/**
 * The diagonal span of a box in metres, via the haversine distance between its
 * SW and NE corners. Used to decide when a cell is too small to keep splitting.
 */
export function diagonalMetres(box: BBox): number {
  return haversineMetres(
    { lat: box.south, lng: box.west },
    { lat: box.north, lng: box.east },
  );
}

const EARTH_RADIUS_METRES = 6_371_008.8;

export function haversineMetres(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(h));
}

export function contains(box: BBox, point: LatLng): boolean {
  return (
    point.lat >= box.south &&
    point.lat <= box.north &&
    point.lng >= box.west &&
    point.lng <= box.east
  );
}

/** The zoom at which this box roughly fills the viewport. */
export function zoomForBox(box: BBox): number {
  const { lat } = centreOf(box);
  const widthMetres = haversineMetres(
    { lat, lng: box.west },
    { lat, lng: box.east },
  );
  return zoomForWidth(lat, Math.max(widthMetres, 1));
}
