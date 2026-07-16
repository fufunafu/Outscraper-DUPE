/**
 * Decodes a search response into Place records.
 *
 * Index map ported from gosom/google-maps-scraper (MIT, © 2023 Georgios
 * Komninos) — gmaps/multiple.go and gmaps/entry.go — and re-verified against
 * live responses. Search results and place-detail responses share this field
 * numbering but hang off different roots, and a few fields differ in shape
 * between them; those are noted at the call site.
 */

import { emptyPlace, type Place, type WorkingHours } from '../schema.ts';
import { pick, pickArray, pickFirst, pickNumber, pickString, unwrapUrl } from './pick.ts';

/**
 * Per-place records live at `data[0][1][i][14]`. The first entry of `[0][1]` is
 * a header rather than a place, and is skipped by requiring index 14 to exist.
 */
function resultNodes(payload: unknown): unknown[] {
  const items = pickArray(payload, 0, 1) ?? [];
  return items.map((item) => pick(item, 14)).filter((node) => node != null);
}

/** Feature IDs look like `0x…:0x…`; the CID is the decimal form of the second half. */
function cidFromGoogleId(googleId: string | null): string | null {
  if (!googleId) return null;
  const second = googleId.split(':')[1];
  if (!second?.startsWith('0x')) return null;
  try {
    return BigInt(second).toString(10);
  } catch {
    return null;
  }
}

/**
 * Hours moved from [34][1] to [203][0] in November 2025; both layouts are still
 * served. Each entry is `[dayName, _, _, [[formattedRange, …], …]]`.
 */
function parseHours(node: unknown): WorkingHours | null {
  const days = pickFirst(pickArray, node, [[203, 0], [34, 1]]);
  if (!days) return null;

  const hours: WorkingHours = {};
  for (const day of days) {
    const name = pickString(day, 0);
    if (!name) continue;
    const slots = pickArray(day, 3) ?? [];
    const ranges = slots
      .map((slot) => pickString(slot, 0))
      .filter((range): range is string => range !== null);
    if (ranges.length > 0) hours[name] = ranges.join(',');
  }
  return Object.keys(hours).length > 0 ? hours : null;
}

/** Structured address components hang off [183][1], with index 2 unused. */
function parseAddressParts(node: unknown) {
  return {
    borough: pickString(node, 183, 1, 0),
    street: pickString(node, 183, 1, 1),
    city: pickString(node, 183, 1, 3),
    postal_code: pickString(node, 183, 1, 4),
    state: pickString(node, 183, 1, 5),
    country: pickString(node, 183, 1, 6),
  };
}

/**
 * Address shape differs by response type: search results carry an array of
 * lines at [2], place details carry one string at [18] prefixed with the
 * business name.
 */
function parseFullAddress(node: unknown, name: string | null): string | null {
  const lines = pickArray(node, 2);
  if (lines) {
    const joined = lines.filter((line) => typeof line === 'string').join(', ');
    if (joined) return joined;
  }

  const detail = pickString(node, 18);
  if (detail && name && detail.startsWith(`${name},`)) {
    return detail.slice(name.length + 1).trim();
  }
  return detail;
}

export function parsePlace(node: unknown, query: string): Place | null {
  const name = pickString(node, 11);
  const googleId = pickString(node, 10);
  const placeId = pickString(node, 78);

  // A record with no name and no identity is a header or filler node, not a place.
  if (!name && !placeId && !googleId) return null;

  const place = emptyPlace(query);
  const address = parseAddressParts(node);

  place.name = name;
  place.google_id = googleId;
  place.place_id = placeId;
  place.cid = cidFromGoogleId(googleId);

  place.full_address = parseFullAddress(node, name);
  Object.assign(place, address);
  place.plus_code = pickString(node, 183, 2, 2, 0);
  // The response inverts the request's !2d/!3d order: here [9][2] is latitude.
  place.latitude = pickNumber(node, 9, 2);
  place.longitude = pickNumber(node, 9, 3);
  place.time_zone = pickString(node, 30);

  place.site = unwrapUrl(pickString(node, 7, 0));
  place.phone = pickString(node, 178, 0, 0);

  const categories = pickArray(node, 13) ?? [];
  const categoryNames = categories.filter((c): c is string => typeof c === 'string');
  place.category = categoryNames[0] ?? null;
  place.type = categoryNames[0] ?? null;
  place.subtypes = categoryNames.length > 1 ? categoryNames.slice(1).join(', ') : null;

  place.rating = pickNumber(node, 4, 7);
  place.reviews = pickNumber(node, 4, 8);
  place.reviews_link = pickString(node, 4, 3, 0);
  place.range = pickString(node, 4, 2);

  place.working_hours = parseHours(node);
  place.working_hours_old_format = place.working_hours
    ? Object.entries(place.working_hours)
        .map(([day, hours]) => `${day}: ${hours}`)
        .join('|')
    : null;
  place.business_status = pickFirst(pickString, node, [[34, 4, 4], [88, 0]]);

  place.description = pickString(node, 32, 1, 1);
  place.location_link = pickString(node, 27);
  place.menu_link = pickString(node, 38, 0);
  place.photo = pickString(node, 72, 0, 1, 6, 0);
  place.owner_id = pickString(node, 57, 2);
  place.owner_title = pickString(node, 57, 1);

  const scores = pickArray(node, 175, 3);
  if (scores) {
    place.reviews_per_score = {
      '1': pickNumber(scores, 0) ?? 0,
      '2': pickNumber(scores, 1) ?? 0,
      '3': pickNumber(scores, 2) ?? 0,
      '4': pickNumber(scores, 3) ?? 0,
      '5': pickNumber(scores, 4) ?? 0,
    };
  }

  return place;
}

export interface ParsedSearchPage {
  places: Place[];
  /** Nodes that looked like places but failed to parse; a spike means a layout change. */
  skipped: number;
}

export function parseSearchPage(payload: unknown, query: string): ParsedSearchPage {
  const nodes = resultNodes(payload);
  const places: Place[] = [];
  let skipped = 0;

  for (const node of nodes) {
    const place = parsePlace(node, query);
    if (place) places.push(place);
    else skipped += 1;
  }

  return { places, skipped };
}
