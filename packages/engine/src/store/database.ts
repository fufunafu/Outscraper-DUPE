/**
 * The place database: a local SQLite store that turns a stream of scraped places
 * into a queryable, durable dataset.
 *
 * This is what makes the "scrape once, query forever" model real. A vertical run
 * writes every place here as it finds it; afterwards, any filter — a category, a
 * city, "has email", a rating floor — is an instant local lookup with no
 * scraping, no proxies, no waiting. It also makes a big run *resumable*: the run
 * records which units of work (a query over one box) it has completed, so a
 * restart after a crash or a closed laptop skips everything already done.
 *
 * Built on Node's own `node:sqlite` — no native dependency to compile, which is
 * what lets the whole app stay a double-click with no install step. Places are
 * stored both as indexed columns (for fast filtering on the fields people
 * actually query) and as a complete JSON blob (so an export can reconstruct all
 * 54+ fields losslessly).
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { EnrichedPlace, Place } from '../schema.ts';
import { identityKeys } from './dedupe.ts';

/** A place plus the query and run that discovered it. */
export interface StoredPlace extends EnrichedPlace {
  /** Stable identity: cid, else place_id, else a geo+name fallback. */
  id: string;
  /** Unix ms first written. */
  first_seen: number;
  /** Unix ms last confirmed present. */
  last_seen: number;
}

/** Filters for querying the stored dataset — the same shape the UI exposes. */
export interface PlaceQuery {
  category?: string;
  city?: string;
  state?: string;
  query?: string;
  hasEmail?: boolean;
  hasPhone?: boolean;
  hasWebsite?: boolean;
  /** Places with no email yet — the enrichment work list. */
  missingEmail?: boolean;
  minRating?: number;
  minReviews?: number;
  /** Free-text match against name. */
  search?: string;
  limit?: number;
  offset?: number;
}

/** A map pin: position plus just enough to label it. */
export interface GeoPoint {
  lat: number;
  lng: number;
  name: string | null;
  category: string | null;
  city: string | null;
  rating: number | null;
  reviews: number | null;
  phone: string | null;
  email: string | null;
  site: string | null;
}

/** The columns pulled out of the JSON blob for indexed querying. */
const INDEXED_COLUMNS = [
  'cid', 'place_id', 'name', 'category', 'subtypes', 'full_address', 'city',
  'state', 'postal_code', 'country', 'latitude', 'longitude', 'phone', 'site',
  'rating', 'reviews', 'business_status', 'verified', 'email_1', 'facebook',
  'instagram', 'linkedin', 'query',
] as const;

/** The stable identity for a place, matching the in-memory deduper's primary key. */
function idForPlace(place: Place): string {
  const keys = identityKeys(place);
  return keys[0] ?? `anon:${place.name ?? ''}:${place.latitude ?? ''},${place.longitude ?? ''}`;
}

export class PlaceDatabase {
  readonly #db: DatabaseSync;
  #insert: ReturnType<DatabaseSync['prepare']>;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    // WAL lets reads (a query from the UI) run while a scrape is still writing.
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#migrate();
    this.#insert = this.#prepareInsert();
  }

  #migrate(): void {
    const cols = INDEXED_COLUMNS.map((c) => {
      const type = ['latitude', 'longitude', 'rating', 'reviews'].includes(c) ? 'REAL' : 'TEXT';
      return `${c} ${type}`;
    }).join(', ');

    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS places (
        id TEXT PRIMARY KEY,
        ${cols},
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_places_category ON places(category);
      CREATE INDEX IF NOT EXISTS idx_places_city ON places(city);
      CREATE INDEX IF NOT EXISTS idx_places_state ON places(state);

      CREATE TABLE IF NOT EXISTS completed_units (
        key TEXT PRIMARY KEY,
        completed_at INTEGER NOT NULL,
        place_count INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS passes (
        region TEXT NOT NULL,
        vertical TEXT NOT NULL,
        pass INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        new_places INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (region, vertical, pass)
      );
    `);
  }

  #prepareInsert(): ReturnType<DatabaseSync['prepare']> {
    const cols = ['id', ...INDEXED_COLUMNS, 'first_seen', 'last_seen', 'data'];
    const placeholders = cols.map((c) => `@${c}`).join(', ');
    // On conflict, refresh last_seen and re-store the record, but keep the
    // original first_seen — a re-scrape updates the data without losing history.
    const updates = [...INDEXED_COLUMNS, 'last_seen', 'data']
      .map((c) => `${c} = excluded.${c}`)
      .join(', ');
    return this.#db.prepare(
      `INSERT INTO places (${cols.join(', ')}) VALUES (${placeholders})
       ON CONFLICT(id) DO UPDATE SET ${updates}`,
    );
  }

  /**
   * Insert or merge a place. Returns true if it was new, false if it updated an
   * existing row — so a caller can count genuinely new discoveries.
   */
  upsert(place: EnrichedPlace, at = Date.now()): boolean {
    const id = idForPlace(place);
    const existing = this.#db.prepare('SELECT 1 FROM places WHERE id = ?').get(id);
    const record = place as unknown as Record<string, unknown>;

    const row: Record<string, string | number | null> = {
      id,
      first_seen: at,
      last_seen: at,
      data: JSON.stringify(place),
    };
    for (const col of INDEXED_COLUMNS) {
      const value = record[col];
      // Coerce to the scalar SQLite accepts; nested fields never reach a column.
      row[col] =
        value === undefined || value === null
          ? null
          : typeof value === 'number' || typeof value === 'string'
            ? value
            : typeof value === 'boolean'
              ? value ? 1 : 0
              : String(value);
    }
    this.#insert.run(row);
    return existing === undefined;
  }

  /** Bulk upsert inside a transaction — far faster for a batch from one cell. */
  upsertMany(places: EnrichedPlace[], at = Date.now()): { inserted: number } {
    let inserted = 0;
    this.#db.exec('BEGIN');
    try {
      for (const place of places) if (this.upsert(place, at)) inserted += 1;
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return { inserted };
  }

  get count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM places').get() as { n: number };
    return row.n;
  }

  /** Distinct values of a column with counts — powers the query UI's facets. */
  facet(column: 'category' | 'city' | 'state'): { value: string; count: number }[] {
    const rows = this.#db
      .prepare(`SELECT ${column} AS value, COUNT(*) AS count FROM places
                WHERE ${column} IS NOT NULL GROUP BY ${column} ORDER BY count DESC`)
      .all() as { value: string; count: number }[];
    return rows;
  }

  /** Translate a PlaceQuery into a WHERE clause + params, shared by every read path. */
  #where(filter: PlaceQuery): { clause: string; params: Record<string, string | number> } {
    const where: string[] = [];
    const params: Record<string, string | number> = {};

    if (filter.category) { where.push('category = @category'); params.category = filter.category; }
    if (filter.city) { where.push('city = @city'); params.city = filter.city; }
    if (filter.state) { where.push('state = @state'); params.state = filter.state; }
    if (filter.query) { where.push('query = @query'); params.query = filter.query; }
    if (filter.hasEmail) where.push("email_1 IS NOT NULL AND email_1 != ''");
    if (filter.missingEmail) where.push("(email_1 IS NULL OR email_1 = '')");
    if (filter.hasPhone) where.push("phone IS NOT NULL AND phone != ''");
    if (filter.hasWebsite) where.push("site IS NOT NULL AND site != ''");
    if (filter.minRating != null) { where.push('rating >= @minRating'); params.minRating = filter.minRating; }
    if (filter.minReviews != null) { where.push('reviews >= @minReviews'); params.minReviews = filter.minReviews; }
    if (filter.search) { where.push('name LIKE @search'); params.search = `%${filter.search}%`; }

    return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  /** Query stored places, reconstructing each full record from its JSON blob. */
  query(filter: PlaceQuery = {}): StoredPlace[] {
    const { clause, params } = this.#where(filter);
    const limit = filter.limit ?? 1000;
    const offset = filter.offset ?? 0;

    const rows = this.#db
      .prepare(`SELECT id, first_seen, last_seen, data FROM places ${clause}
                ORDER BY reviews DESC NULLS LAST LIMIT ${limit} OFFSET ${offset}`)
      .all(params) as { id: string; first_seen: number; last_seen: number; data: string }[];

    return rows.map((r) => ({
      ...(JSON.parse(r.data) as EnrichedPlace),
      id: r.id,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
    }));
  }

  /** Stream every stored place, for a full export without loading all into memory. */
  *iterate(filter: PlaceQuery = {}): Generator<StoredPlace> {
    const pageSize = 5_000;
    let offset = 0;
    for (;;) {
      const page = this.query({ ...filter, limit: pageSize, offset });
      if (page.length === 0) return;
      yield* page;
      offset += page.length;
      if (page.length < pageSize) return;
    }
  }

  /** One place by its stored id, for targeted updates like batch enrichment. */
  byId(id: string): StoredPlace | undefined {
    const row = this.#db
      .prepare('SELECT id, first_seen, last_seen, data FROM places WHERE id = ?')
      .get(id) as { id: string; first_seen: number; last_seen: number; data: string } | undefined;
    if (!row) return undefined;
    return {
      ...(JSON.parse(row.data) as EnrichedPlace),
      id: row.id,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
    };
  }

  /** Just the ids matching a filter — a stable work list that survives row updates. */
  ids(filter: PlaceQuery = {}): string[] {
    const { clause, params } = this.#where(filter);
    const rows = this.#db
      .prepare(`SELECT id FROM places ${clause}`)
      .all(params) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** How many rows match a filter, without materialising them. */
  countWhere(filter: PlaceQuery = {}): number {
    const { clause, params } = this.#where(filter);
    const row = this.#db.prepare(`SELECT COUNT(*) AS n FROM places ${clause}`).get(params) as { n: number };
    return row.n;
  }

  /**
   * Lightweight map points for a filter: position plus just enough to label a
   * pin. Kept to a handful of columns so tens of thousands of points travel to
   * the browser without dragging every 54-field record along.
   */
  geo(filter: PlaceQuery = {}, limit = 30_000): GeoPoint[] {
    const { clause, params } = this.#where(filter);
    const and = clause ? `${clause} AND` : 'WHERE';
    const rows = this.#db
      .prepare(`SELECT latitude AS lat, longitude AS lng, name, category, city, rating, reviews,
                       phone, email_1 AS email, site
                FROM places ${and} latitude IS NOT NULL AND longitude IS NOT NULL
                ORDER BY reviews DESC NULLS LAST LIMIT ${limit}`)
      .all(params) as unknown as GeoPoint[];
    return rows;
  }

  /** Contactability at a glance: how much of the database is actionable as leads. */
  contactStats(): { total: number; withEmail: number; withSite: number; withPhone: number } {
    const row = this.#db
      .prepare(`SELECT COUNT(*) AS total,
                       SUM(CASE WHEN email_1 IS NOT NULL AND email_1 != '' THEN 1 ELSE 0 END) AS withEmail,
                       SUM(CASE WHEN site IS NOT NULL AND site != '' THEN 1 ELSE 0 END) AS withSite,
                       SUM(CASE WHEN phone IS NOT NULL AND phone != '' THEN 1 ELSE 0 END) AS withPhone
                FROM places`)
      .get() as { total: number; withEmail: number | null; withSite: number | null; withPhone: number | null };
    return {
      total: row.total,
      withEmail: row.withEmail ?? 0,
      withSite: row.withSite ?? 0,
      withPhone: row.withPhone ?? 0,
    };
  }

  /** Completed passes per region+vertical — the raw material for a coverage map. */
  coverage(): { region: string; vertical: string; passes: number; lastCompleted: number | null }[] {
    return this.#db
      .prepare(`SELECT region, vertical, COUNT(*) AS passes, MAX(completed_at) AS lastCompleted
                FROM passes WHERE completed_at IS NOT NULL GROUP BY region, vertical`)
      .all() as { region: string; vertical: string; passes: number; lastCompleted: number | null }[];
  }

  // --- Resumability ------------------------------------------------------------

  /** Has this unit of work (a query over one box) already been completed? */
  isUnitDone(key: string): boolean {
    return this.#db.prepare('SELECT 1 FROM completed_units WHERE key = ?').get(key) !== undefined;
  }

  markUnitDone(key: string, placeCount: number, at = Date.now()): void {
    this.#db
      .prepare('INSERT OR REPLACE INTO completed_units (key, completed_at, place_count) VALUES (?, ?, ?)')
      .run(key, at, placeCount);
  }

  get unitsDone(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM completed_units').get() as { n: number };
    return row.n;
  }

  // --- Multi-pass accumulation -------------------------------------------------

  /**
   * Which pass to run for this region+vertical.
   *
   * Google Maps returns a different ~50–60% sample of a region each time, so a
   * single pass is never complete. Repeated passes accumulate the businesses
   * earlier passes missed — the database converges toward the true population
   * where a one-shot export cannot. An interrupted pass is resumed (so a crash
   * doesn't waste work); a finished one bumps to the next pass, which re-sweeps
   * everything and folds new finds into the same deduplicated table.
   */
  resolvePass(region: string, vertical: string, at = Date.now()): { pass: number; resuming: boolean } {
    const latest = this.#db
      .prepare('SELECT pass, completed_at FROM passes WHERE region = ? AND vertical = ? ORDER BY pass DESC LIMIT 1')
      .get(region, vertical) as { pass: number; completed_at: number | null } | undefined;

    if (latest && latest.completed_at === null) return { pass: latest.pass, resuming: true };

    const next = (latest?.pass ?? 0) + 1;
    this.#db
      .prepare('INSERT INTO passes (region, vertical, pass, started_at) VALUES (?, ?, ?, ?)')
      .run(region, vertical, next, at);
    return { pass: next, resuming: false };
  }

  completePass(region: string, vertical: string, pass: number, newPlaces: number, at = Date.now()): void {
    this.#db
      .prepare('UPDATE passes SET completed_at = ?, new_places = ? WHERE region = ? AND vertical = ? AND pass = ?')
      .run(at, newPlaces, region, vertical, pass);
  }

  /** Pass history for a region+vertical, newest first, for the UI. */
  passHistory(region: string, vertical: string): { pass: number; completed_at: number | null; new_places: number }[] {
    return this.#db
      .prepare('SELECT pass, completed_at, new_places FROM passes WHERE region = ? AND vertical = ? ORDER BY pass DESC')
      .all(region, vertical) as { pass: number; completed_at: number | null; new_places: number }[];
  }

  close(): void {
    this.#db.close();
  }
}
