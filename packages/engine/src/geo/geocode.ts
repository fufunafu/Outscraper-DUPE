/**
 * Turning "Brooklyn, NY" into a region to sweep.
 *
 * Uses OpenStreetMap's Nominatim, which is free and returns a real bounding box
 * rather than just a centre point — the box is what the coverage engine needs.
 * Google's own geocoder would be a licensing problem for this use, and paying
 * for one is silly when the free answer is this good for city-sized regions.
 *
 * Nominatim's usage policy asks for one request per second and a real
 * User-Agent. We're well inside that: geocoding happens once per job, not once
 * per cell.
 */

import type { BBox } from './tiles.ts';

export interface GeocodeResult {
  /** Canonical name, e.g. "Brooklyn, Kings County, City of New York, New York". */
  displayName: string;
  box: BBox;
  /** OSM's own type, e.g. "city", "suburb", "state" — useful for sanity checks. */
  type: string;
  /** How prominent this match is, 0–1. Higher means a more confident match. */
  importance: number;
}

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';

/**
 * Nominatim asks callers to identify themselves so they can contact you if your
 * traffic misbehaves, rather than silently blocking.
 */
const USER_AGENT = 'outscraper-dupe/0.1 (local lead-gen tool)';

interface NominatimPlace {
  display_name: string;
  /** [south, north, west, east] — note the order, which is not the usual one. */
  boundingbox: [string, string, string, string];
  type: string;
  importance?: number;
  class: string;
}

function toBBox(raw: NominatimPlace['boundingbox']): BBox {
  const [south, north, west, east] = raw.map(Number) as [number, number, number, number];
  return { south, north, west, east };
}

export async function geocode(query: string, limit = 5): Promise<GeocodeResult[]> {
  const url = new URL(ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', String(limit));
  // Without this the response has no bounding box, only a point.
  url.searchParams.set('polygon_geojson', '0');
  url.searchParams.set('addressdetails', '0');

  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) {
    throw new Error(`geocoding failed: ${response.status}`);
  }

  const places = (await response.json()) as NominatimPlace[];
  return places
    .filter((place) => Array.isArray(place.boundingbox) && place.boundingbox.length === 4)
    .map((place) => ({
      displayName: place.display_name,
      box: toBBox(place.boundingbox),
      type: place.type,
      importance: place.importance ?? 0,
    }));
}

/** The single best match, or null when nothing is found. */
export async function geocodeOne(query: string): Promise<GeocodeResult | null> {
  const results = await geocode(query, 1);
  return results[0] ?? null;
}

/**
 * Rough area of a region, for warning before someone sweeps a whole country by
 * accident. A US state is ~10^5 km²; a city is ~10^2.
 */
export function areaSquareKm(box: BBox): number {
  const midLat = ((box.south + box.north) / 2) * (Math.PI / 180);
  const kmPerDegLat = 110.574;
  const kmPerDegLng = 111.32 * Math.cos(midLat);
  return Math.abs(box.north - box.south) * kmPerDegLat * Math.abs(box.east - box.west) * kmPerDegLng;
}
