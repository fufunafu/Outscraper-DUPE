/**
 * Verticals: named bundles of search terms that define a database extraction.
 *
 * A vertical ("construction") is just an ordered list of the search terms that,
 * swept across a region, capture that whole slice of Google Maps. The lists are
 * curated hubs — because Google's search is fuzzy, each term pulls in adjacent
 * categories, so ~79 construction terms surface far more than 79 categories'
 * worth of businesses.
 *
 * Kept as data (verticals.json) rather than code so the terms can be edited
 * without touching the engine.
 */

import verticals from '../data/verticals.json' with { type: 'json' };

export type VerticalName = keyof typeof verticals & string;

const DATA = verticals as Record<string, string[]>;

export function verticalNames(): VerticalName[] {
  return Object.keys(DATA) as VerticalName[];
}

export function verticalTerms(name: string): string[] {
  return DATA[name] ?? [];
}

export function isVertical(name: string): name is VerticalName {
  return name in DATA;
}
