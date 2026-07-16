/**
 * The place record.
 *
 * Field names deliberately mirror Outscraper's Google Maps Search output so
 * that exports drop straight into anything already built against their CSVs.
 * That means inheriting their naming quirks rather than tidying them up:
 * `site` not `website`, `range` not `price_range`, `full_address` as one string.
 * Renaming these would be a nicer schema and a migration for every consumer.
 *
 * Not every field is populated from every source — a search-list response
 * carries maybe half of these, and the rest need a place-detail fetch.
 */

/** Attribute groups Google exposes on a listing, each mapping attribute → enabled. */
export type About = Record<string, Record<string, boolean>>;

/** Day name → hours string, e.g. `{ Monday: "11:30 AM-3 PM,5-10 PM" }`. */
export type WorkingHours = Record<string, string>;

/** Star rating → number of reviews at that rating. */
export type ReviewsPerScore = Partial<Record<'1' | '2' | '3' | '4' | '5', number>>;

export interface PopularTimeSlot {
  hour: number;
  /** Relative busyness, 0–100. */
  percentage: number;
}

export type PopularTimes = Record<string, PopularTimeSlot[]>;

export interface Place {
  /** The search query this record was found by. */
  query: string;

  // Identity
  name: string | null;
  /** `ChIJ…` — the stable public identifier; our dedupe key. */
  place_id: string | null;
  /** Feature ID, `0x89c259a715fb5059:0xe5543b76e952fab3`. */
  google_id: string | null;
  /** Decimal form of the second half of google_id. */
  cid: string | null;

  // Location
  full_address: string | null;
  borough: string | null;
  street: string | null;
  city: string | null;
  postal_code: string | null;
  /** Full state/province name. */
  state: string | null;
  /** Two-letter state, US only. */
  us_state: string | null;
  country: string | null;
  country_code: string | null;
  latitude: number | null;
  longitude: number | null;
  plus_code: string | null;
  time_zone: string | null;
  /** Set when the business serves an area rather than occupying an address. */
  area_service: boolean | null;

  // Contact
  site: string | null;
  phone: string | null;

  // Classification
  /** Primary category. */
  type: string | null;
  category: string | null;
  /** Comma-joined secondary categories, not an array. */
  subtypes: string | null;

  // Ratings
  rating: number | null;
  /** Total review count. */
  reviews: number | null;
  reviews_per_score: ReviewsPerScore | null;
  reviews_link: string | null;
  reviews_id: string | null;
  reviews_tags: string[] | null;

  // Hours & status
  working_hours: WorkingHours | null;
  working_hours_old_format: string | null;
  other_hours: Record<string, WorkingHours>[] | null;
  /** `OPERATIONAL`, `CLOSED_TEMPORARILY`, `CLOSED_PERMANENTLY`. */
  business_status: string | null;
  popular_times: PopularTimes | null;

  // Descriptive
  description: string | null;
  about: About | null;
  /** Price band, `$` to `$$$$`. */
  range: string | null;
  logo: string | null;
  photo: string | null;
  photos_count: number | null;
  street_view: string | null;
  posts: unknown[] | null;

  // Links
  location_link: string | null;
  menu_link: string | null;
  order_links: string[] | null;
  reservation_links: string[] | null;
  booking_appointment_link: string | null;

  // Ownership
  verified: boolean | null;
  owner_id: string | null;
  owner_title: string | null;
  owner_link: string | null;
  located_in: string | null;
  located_google_id: string | null;
}

/** Fields added by the website-crawl enrichment; kept separate so the base record stays pure. */
export interface Enrichment {
  email_1: string | null;
  email_1_full_name: string | null;
  email_1_title: string | null;
  email_2: string | null;
  email_3: string | null;
  facebook: string | null;
  instagram: string | null;
  linkedin: string | null;
  twitter: string | null;
  youtube: string | null;
  tiktok: string | null;
  /** Extra phone numbers found on the site, beyond the listing's own. */
  site_phone_1: string | null;
}

export type EnrichedPlace = Place & Partial<Enrichment>;

/** Column order for CSV/XLSX export, matching Outscraper's own. */
export const PLACE_COLUMNS: (keyof Place)[] = [
  'query', 'name', 'place_id', 'google_id', 'full_address', 'borough', 'street',
  'postal_code', 'area_service', 'country_code', 'country', 'city', 'us_state',
  'state', 'plus_code', 'latitude', 'longitude', 'time_zone', 'popular_times',
  'site', 'phone', 'type', 'logo', 'description', 'located_in',
  'located_google_id', 'category', 'subtypes', 'posts', 'reviews_tags', 'rating',
  'reviews', 'photos_count', 'cid', 'reviews_link', 'reviews_id', 'photo',
  'street_view', 'working_hours_old_format', 'working_hours', 'other_hours',
  'business_status', 'about', 'range', 'reviews_per_score', 'reservation_links',
  'booking_appointment_link', 'menu_link', 'order_links', 'owner_id', 'verified',
  'owner_title', 'owner_link', 'location_link',
];

export function emptyPlace(query: string): Place {
  const place = { query } as Place;
  for (const column of PLACE_COLUMNS) {
    if (column !== 'query') (place as Record<string, unknown>)[column] = null;
  }
  return place;
}
