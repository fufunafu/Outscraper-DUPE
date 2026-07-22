/**
 * The location picker's data: country → state/province → city.
 *
 * Cities come from GeoNames (cities over 5,000 population, CC BY), capped at the
 * 150 largest per region — past that you are picking villages from a list, which
 * no one does; type a name instead and let the geocoder resolve it.
 *
 * A region selection resolves to a bounding box at scrape time via the geocoder,
 * not from this file: keeping boxes here would mean shipping a second, staler
 * source of truth for the same fact.
 */

import locations from '../data/locations.json' with { type: 'json' };

export interface City {
  /** Name. */
  n: string;
  lat: number;
  lng: number;
  /** Population, used only for ordering. */
  p: number;
}

export interface Region {
  /** Postal abbreviation, e.g. "ON", "NY". */
  code: string;
  name: string;
  cities: City[];
}

export interface Country {
  name: string;
  flag: string;
  regions: Region[];
}

export const COUNTRIES: Record<string, Country> = locations as unknown as Record<string, Country>;

export type CountryCode = keyof typeof COUNTRIES & string;

/**
 * A place to sweep. Either a whole region, or one city within it.
 *
 * Kept as a query string rather than a box because Google's own geocoding of
 * "Toronto, ON, Canada" is what users are implicitly comparing us against.
 */
export interface LocationSelection {
  country: string;
  region: string;
  city?: string;
}

export function regionsOf(country: string): Region[] {
  return COUNTRIES[country]?.regions ?? [];
}

export function findRegion(country: string, code: string): Region | undefined {
  return regionsOf(country).find((region) => region.code === code);
}

/** The geocoder query for a selection, e.g. "Toronto, ON, Canada". */
export function toQuery(selection: LocationSelection): string {
  const country = COUNTRIES[selection.country];
  const region = findRegion(selection.country, selection.region);
  // Use the region's FULL NAME, not its 2-letter code: a code like "LA" geocodes
  // to Los Angeles, not Louisiana, dropping the search box on the wrong side of
  // the country. Full names ("Louisiana, United States") are unambiguous.
  const parts = [selection.city, region?.name ?? region?.code ?? selection.region, country?.name ?? selection.country];
  return parts.filter(Boolean).join(', ');
}

/** Human-readable label for the UI, e.g. "Toronto, ON". */
export function toLabel(selection: LocationSelection): string {
  return selection.city ? `${selection.city}, ${selection.region}` : selection.region;
}

export function citySearch(country: string, query: string, limit = 8): LocationSelection[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const matches: { selection: LocationSelection; score: number }[] = [];
  for (const region of regionsOf(country)) {
    for (const city of region.cities) {
      const name = city.n.toLowerCase();
      if (!name.includes(q)) continue;
      // Prefix beats substring; bigger cities break ties, since a search for
      // "york" should surface New York City before York, Nebraska.
      const score = (name.startsWith(q) ? 1_000_000 : 0) + city.p;
      matches.push({ selection: { country, region: region.code, city: city.n }, score });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, limit).map((m) => m.selection);
}
