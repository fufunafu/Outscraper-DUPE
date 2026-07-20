import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

import { PlaceDatabase } from './database.ts';
import { emptyPlace, type EnrichedPlace } from '../schema.ts';

function place(over: Partial<EnrichedPlace>): EnrichedPlace {
  return { ...emptyPlace('glass shop'), ...over };
}

function freshDb(): { db: PlaceDatabase; path: string } {
  const path = join(tmpdir(), `placedb-${process.pid}-${Math.round(performance.now())}.db`);
  return { db: new PlaceDatabase(path), path };
}

describe('PlaceDatabase', () => {
  it('inserts places and counts them', () => {
    const { db, path } = freshDb();
    try {
      assert.equal(db.upsert(place({ name: 'A', cid: '1', city: 'Vancouver' })), true);
      assert.equal(db.upsert(place({ name: 'B', cid: '2', city: 'Victoria' })), true);
      assert.equal(db.count, 2);
    } finally {
      db.close();
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it('dedupes on identity: the same place twice updates, not duplicates', () => {
    const { db, path } = freshDb();
    try {
      db.upsert(place({ name: 'Joe Glass', cid: '42', rating: 4.1 }));
      // Same cid found again by a different query, with an updated rating.
      const second = db.upsert(place({ name: 'Joe Glass', cid: '42', rating: 4.6, query: 'glazier' }));
      assert.equal(second, false, 'second upsert should report not-new');
      assert.equal(db.count, 1);
      assert.equal(db.query()[0]!.rating, 4.6, 'record should be updated');
    } finally {
      db.close();
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it('filters by the fields the UI exposes', () => {
    const { db, path } = freshDb();
    try {
      db.upsertMany([
        place({ cid: '1', city: 'Vancouver', category: 'Glass Shop', site: 'a.com', email_1: 'x@a.com', rating: 4.8, reviews: 100 }),
        place({ cid: '2', city: 'Vancouver', category: 'Plumber', rating: 3.2, reviews: 5 }),
        place({ cid: '3', city: 'Victoria', category: 'Glass Shop', site: 'b.com', rating: 4.9, reviews: 400 }),
      ]);
      assert.equal(db.query({ city: 'Vancouver' }).length, 2);
      assert.equal(db.query({ category: 'Glass Shop' }).length, 2);
      assert.equal(db.query({ hasEmail: true }).length, 1);
      assert.equal(db.query({ hasWebsite: true }).length, 2);
      assert.equal(db.query({ minRating: 4.5 }).length, 2);
      assert.equal(db.query({ minReviews: 200 }).length, 1);
      // Ordered by reviews desc: the 400-review Victoria shop leads.
      assert.equal(db.query({ category: 'Glass Shop' })[0]!.cid, '3');
    } finally {
      db.close();
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it('survives reopen — data is durable', () => {
    const path = join(tmpdir(), `placedb-reopen-${process.pid}.db`);
    try {
      const db1 = new PlaceDatabase(path);
      db1.upsert(place({ cid: '99', name: 'Persist' }));
      db1.markUnitDone('BC|glass shop|box0', 1);
      db1.close();

      const db2 = new PlaceDatabase(path);
      assert.equal(db2.count, 1, 'data survived reopen');
      assert.equal(db2.isUnitDone('BC|glass shop|box0'), true, 'resume marker survived');
      assert.equal(db2.isUnitDone('BC|glass shop|box1'), false);
      db2.close();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it('resolves passes: resumes an unfinished one, else starts the next', () => {
    const { db, path } = freshDb();
    try {
      // First call starts pass 1.
      const a = db.resolvePass('CA/BC', 'construction');
      assert.deepEqual(a, { pass: 1, resuming: false });
      // Pass 1 unfinished — a repeat call resumes it, not a new pass.
      const b = db.resolvePass('CA/BC', 'construction');
      assert.deepEqual(b, { pass: 1, resuming: true });
      // Finish pass 1; next call opens pass 2.
      db.completePass('CA/BC', 'construction', 1, 500);
      const c = db.resolvePass('CA/BC', 'construction');
      assert.deepEqual(c, { pass: 2, resuming: false });
      // A different vertical/region is independent.
      assert.deepEqual(db.resolvePass('CA/BC', 'medical'), { pass: 1, resuming: false });
      assert.equal(db.passHistory('CA/BC', 'construction')[0]!.pass, 2);
    } finally {
      db.close();
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it('facets return value counts for the query UI', () => {
    const { db, path } = freshDb();
    try {
      db.upsertMany([
        place({ cid: '1', category: 'Plumber' }),
        place({ cid: '2', category: 'Plumber' }),
        place({ cid: '3', category: 'Electrician' }),
      ]);
      const facets = db.facet('category');
      assert.equal(facets[0]!.value, 'Plumber');
      assert.equal(facets[0]!.count, 2);
    } finally {
      db.close();
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });
});
