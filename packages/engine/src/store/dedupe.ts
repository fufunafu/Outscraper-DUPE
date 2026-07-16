/**
 * Identity for a place.
 *
 * Adjacent search cells overlap, and a business near a boundary is returned by
 * every cell that touches it — so the same place arrives many times in a normal
 * run. Dedupe is not a tidy-up step, it is load-bearing.
 *
 * Three layers, because no single key is sufficient:
 *   1. CID — Google's internal identity, stable across rebrands and moves.
 *   2. place_id — the public key, which Google says may change over time and
 *      may be one of several for a single place.
 *   3. name + rounded location — catches genuine duplicate *listings*: one
 *      business with two Business Profiles has two CIDs and two place_ids, so
 *      it is invisible to both key layers.
 *
 * Layer 3 is the one most implementations skip, and it is why their exports
 * still contain visible duplicates.
 */

import type { Place } from '../schema.ts';

/**
 * ~1e-4 degrees is roughly 11 m — tight enough that neighbouring storefronts
 * stay distinct, loose enough to absorb the coordinate jitter Google reports
 * for the same place across different queries.
 */
const COORD_PRECISION = 4;

/** Strip punctuation, case, and legal suffixes so "Joe's Pizza" == "Joes Pizza LLC". */
export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(inc|llc|ltd|corp|co|company|the)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Keys this place could be known by, strongest first. Two records are the same
 * place if they share ANY key.
 */
export function identityKeys(place: Place): string[] {
  const keys: string[] = [];
  if (place.cid) keys.push(`cid:${place.cid}`);
  if (place.place_id) keys.push(`pid:${place.place_id}`);

  if (place.name && place.latitude != null && place.longitude != null) {
    const name = normaliseName(place.name);
    if (name) {
      const lat = place.latitude.toFixed(COORD_PRECISION);
      const lng = place.longitude.toFixed(COORD_PRECISION);
      keys.push(`geo:${name}@${lat},${lng}`);
    }
  }
  return keys;
}

/**
 * Tracks which places have been seen, across all three identity layers.
 *
 * Kept in memory: even a national run is a few million keys, which is cheap
 * next to the network cost of the requests that produce them.
 */
export class Deduper {
  readonly #seen = new Set<string>();
  #unique = 0;
  #duplicates = 0;

  /**
   * Record a place. Returns true the first time it is seen, false when it is a
   * duplicate of something already recorded.
   */
  add(place: Place): boolean {
    const keys = identityKeys(place);
    // A place with no identity at all can't be deduped; keep it rather than
    // silently dropping data, and let the caller decide.
    if (keys.length === 0) {
      this.#unique += 1;
      return true;
    }

    if (keys.some((key) => this.#seen.has(key))) {
      this.#duplicates += 1;
      return false;
    }

    // Register every key, so a later record matching on any one of them resolves
    // to this same place.
    for (const key of keys) this.#seen.add(key);
    this.#unique += 1;
    return true;
  }

  has(place: Place): boolean {
    return identityKeys(place).some((key) => this.#seen.has(key));
  }

  get stats(): { unique: number; duplicates: number } {
    return { unique: this.#unique, duplicates: this.#duplicates };
  }
}
