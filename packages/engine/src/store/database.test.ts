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

  it('supports the enrichment work list and map views', () => {
    const { db, path } = freshDb();
    try {
      db.upsertMany([
        place({ cid: '1', name: 'HasEmail', site: 'a.com', email_1: 'x@a.com', latitude: 49.2, longitude: -123.1, reviews: 10 }),
        place({ cid: '2', name: 'NeedsEmail', site: 'b.com', latitude: 49.3, longitude: -123.0, reviews: 99 }),
        place({ cid: '3', name: 'NoSite' }),
      ]);
      // The enrichment work list: has a website, missing an email.
      const ids = db.ids({ hasWebsite: true, missingEmail: true });
      assert.equal(ids.length, 1);
      assert.equal(db.byId(ids[0]!)!.name, 'NeedsEmail');
      assert.equal(db.byId('nope'), undefined);
      assert.equal(db.countWhere({ missingEmail: true }), 2);
      // Map points: only rows with coordinates, most-reviewed first.
      const points = db.geo();
      assert.equal(points.length, 2);
      assert.equal(points[0]!.name, 'NeedsEmail');
      assert.equal(points[0]!.lat, 49.3);
      // Contactability rollup.
      assert.deepEqual(db.contactStats(), { total: 3, withEmail: 1, withSite: 2, withPhone: 0, checked: 0 });
    } finally {
      db.close();
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it('queues unchecked websites for the email finder, once each', () => {
    const { db, path } = freshDb();
    try {
      db.upsertMany([
        place({ cid: '1', name: 'HasEmail', site: 'a.com', email_1: 'x@a.com' }),
        place({ cid: '2', name: 'Unchecked', site: 'b.com' }),
        place({ cid: '3', name: 'NoSite' }),
      ]);
      const targets = db.nextEmailTargets();
      assert.equal(targets.length, 1, 'only site-having, email-missing places queue');
      assert.equal(db.pendingEmailChecks(), 1);

      // Checked (even with no email found) leaves the queue for good…
      db.markEmailChecked(targets);
      assert.deepEqual(db.nextEmailTargets(), []);
      assert.equal(db.pendingEmailChecks(), 0);

      // …and a later re-scrape of the same place must not re-queue it.
      db.upsert(place({ cid: '2', name: 'Unchecked', site: 'b.com', rating: 4.0 }));
      assert.deepEqual(db.nextEmailTargets(), [], 're-scrape kept the checked marker');
    } finally {
      db.close();
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it('summarises completed passes as coverage', () => {
    const { db, path } = freshDb();
    try {
      db.resolvePass('CA/BC', 'construction');
      db.completePass('CA/BC', 'construction', 1, 100);
      db.resolvePass('CA/BC', 'construction');
      db.completePass('CA/BC', 'construction', 2, 40);
      db.resolvePass('CA/AB', 'construction'); // started, never finished
      const cov = db.coverage();
      assert.equal(cov.length, 1, 'only completed passes count as coverage');
      assert.deepEqual({ region: cov[0]!.region, vertical: cov[0]!.vertical, passes: cov[0]!.passes },
        { region: 'CA/BC', vertical: 'construction', passes: 2 });
    } finally {
      db.close();
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it('stores settings durably and snapshots via backupTo', () => {
    const { db, path } = freshDb();
    const backupPath = `${path}.backup`;
    try {
      assert.equal(db.getSetting('campaign'), null);
      db.setSetting('campaign', '{"vertical":"construction"}');
      db.setSetting('campaign', '{"vertical":"medical"}'); // upsert overwrites
      assert.equal(db.getSetting('campaign'), '{"vertical":"medical"}');
      db.deleteSetting('campaign');
      assert.equal(db.getSetting('campaign'), null);

      db.upsert(place({ cid: '7', name: 'Snapshot Me' }));
      db.backupTo(backupPath);
      const restored = new PlaceDatabase(backupPath);
      try {
        assert.equal(restored.count, 1, 'backup contains the data');
      } finally {
        restored.close();
      }
    } finally {
      db.close();
      for (const p of [path, backupPath]) {
        rmSync(p, { force: true });
        rmSync(`${p}-wal`, { force: true });
        rmSync(`${p}-shm`, { force: true });
      }
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
