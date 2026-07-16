import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { coverRegion, rootCell } from './quadtree.ts';
import type { BBox } from './tiles.ts';
import { contains, centreOf } from './tiles.ts';

/** Roughly the island of Manhattan, as a test region. */
const MANHATTAN: BBox = { west: -74.02, south: 40.7, east: -73.93, north: 40.88 };

describe('coverRegion', () => {
  it('searches a sparse region exactly once', async () => {
    const searched: number[] = [];
    const result = await coverRegion(MANHATTAN, async (cell) => {
      searched.push(cell.depth);
      return { count: 12, saturated: false };
    });

    assert.equal(result.cellsSearched, 1);
    assert.equal(result.cellsSubdivided, 0);
    assert.equal(result.cellsTruncated, 0);
    assert.deepEqual(searched, [0]);
  });

  it('subdivides a saturated cell into four children', async () => {
    // Saturated at depth 0 only; children come back sparse.
    const result = await coverRegion(
      MANHATTAN,
      async (cell) => ({ count: cell.depth === 0 ? 100 : 5, saturated: cell.depth === 0 }),
      {},
    );

    assert.equal(result.cellsSearched, 5, 'root plus four children');
    assert.equal(result.cellsSubdivided, 1);
    assert.equal(result.cellsTruncated, 0);
  });

  it('stops at maxDepth and reports the cell as truncated', async () => {
    // Everything is saturated, so only maxDepth can halt the recursion.
    const result = await coverRegion(
      MANHATTAN,
      async () => ({ count: 500, saturated: true }),
      { maxDepth: 2, minCellMetres: 0 },
    );

    // Depth 0: 1 cell, depth 1: 4, depth 2: 16 — the 16 leaves stay saturated.
    assert.equal(result.cellsSearched, 21);
    assert.equal(result.cellsSubdivided, 5);
    assert.equal(result.cellsTruncated, 16);
  });

  it('stops subdividing once cells fall below minCellMetres', async () => {
    const result = await coverRegion(
      MANHATTAN,
      async () => ({ count: 500, saturated: true }),
      { maxDepth: 20, minCellMetres: 5_000 },
    );

    // Bounded by cell size rather than depth, so it must stop well short of depth 20.
    assert.ok(result.cellsSearched < 200, `expected an early stop, got ${result.cellsSearched}`);
    assert.ok(result.cellsTruncated > 0);
  });

  it('children tile the parent without gaps', async () => {
    const boxes: BBox[] = [];
    await coverRegion(
      MANHATTAN,
      async (cell) => {
        if (cell.depth > 0) boxes.push(cell.box);
        return { count: cell.depth === 0 ? 100 : 1, saturated: cell.depth === 0 };
      },
      {},
    );

    assert.equal(boxes.length, 4);
    // The parent's centre and each corner must land in exactly one child.
    for (const probe of [
      centreOf(MANHATTAN),
      { lat: 40.75, lng: -74.0 },
      { lat: 40.85, lng: -73.95 },
    ]) {
      const hits = boxes.filter((b) => contains(b, probe)).length;
      assert.ok(hits >= 1, `no child covers ${JSON.stringify(probe)}`);
    }
  });

  it('keeps going when a search throws', async () => {
    const result = await coverRegion(
      MANHATTAN,
      async (cell) => {
        if (cell.depth === 1) throw new Error('429 from upstream');
        return { count: 100, saturated: true };
      },
      { maxDepth: 3 },
    );

    assert.equal(result.cellsFailed, 4, 'all four children failed');
    assert.equal(result.cellsSearched, 5);
  });
});
