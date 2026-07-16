/**
 * The Quick Filters from the UI.
 *
 * Applied after scraping rather than during: the search endpoint has no filter
 * parameters, so every filter is a local predicate over rows we already paid to
 * fetch. That means filters make the export smaller, never the scrape cheaper —
 * worth being clear about, since the UI could easily imply otherwise.
 */

import type { Place } from '../../../packages/engine/src/schema.ts';

export interface Filters {
  onlyWithWebsite?: boolean;
  onlyWithoutWebsite?: boolean;
  operationalOnly?: boolean;
  withPhone?: boolean;
  verified?: boolean;
  /** Rating at or above this value. Places with no rating are excluded. */
  minRating?: number;
  /** Rating at or below this value. Places with no rating are excluded. */
  maxRating?: number;
  /** Ignore ratings backed by fewer than this many reviews. */
  minReviews?: number;
}

/**
 * "Good rating" and "bad rating" in Outscraper's UI are bare rating thresholds,
 * which is a trap: a single 5-star review outranks 3,000 reviews averaging 4.6.
 * We expose minReviews alongside so a rating filter can be made to mean something.
 */
export const GOOD_RATING = 4.0;
export const BAD_RATING = 3.0;

type Predicate = (place: Place) => boolean;

function predicatesFor(filters: Filters): Predicate[] {
  const predicates: Predicate[] = [];

  if (filters.onlyWithWebsite) predicates.push((p) => Boolean(p.site));
  if (filters.onlyWithoutWebsite) predicates.push((p) => !p.site);
  if (filters.withPhone) predicates.push((p) => Boolean(p.phone));
  if (filters.verified) predicates.push((p) => p.verified === true);

  if (filters.operationalOnly) {
    // A null status means Google told us nothing, not that the place is closed.
    // Excluding those would silently drop live businesses, so they're kept.
    predicates.push((p) => p.business_status == null || p.business_status === 'OPERATIONAL');
  }

  if (filters.minReviews != null) {
    const min = filters.minReviews;
    predicates.push((p) => (p.reviews ?? 0) >= min);
  }
  if (filters.minRating != null) {
    const min = filters.minRating;
    predicates.push((p) => p.rating != null && p.rating >= min);
  }
  if (filters.maxRating != null) {
    const max = filters.maxRating;
    predicates.push((p) => p.rating != null && p.rating <= max);
  }

  return predicates;
}

export function applyFilters(places: Place[], filters: Filters): Place[] {
  const predicates = predicatesFor(filters);
  if (predicates.length === 0) return places;
  return places.filter((place) => predicates.every((predicate) => predicate(place)));
}

/** Contradictory selections that would always yield zero rows. */
export function filterConflicts(filters: Filters): string[] {
  const conflicts: string[] = [];
  if (filters.onlyWithWebsite && filters.onlyWithoutWebsite) {
    conflicts.push('"Only with website" and "Only without website" can\'t both be on.');
  }
  if (filters.minRating != null && filters.maxRating != null && filters.minRating > filters.maxRating) {
    conflicts.push('Minimum rating is higher than maximum rating.');
  }
  return conflicts;
}
