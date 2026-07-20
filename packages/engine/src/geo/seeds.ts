/**
 * Population-seeded coverage for large regions.
 *
 * Tiling a whole province uniformly wastes almost all of its searches on empty
 * wilderness — British Columbia is 2.1M km², and its businesses sit in a few
 * hundred km² of metros. The efficient approach, and the one commercial
 * scrapers use (Outscraper fans out over postal codes for the same reason), is
 * to search only where people are: seed the coverage at known population
 * centres and let the adaptive quadtree resolve density around each.
 *
 * Seeds here are GeoNames cities. Each becomes a box sized by population, and
 * overlapping boxes merge — Metro Vancouver's dozen adjacent cities collapse to
 * a couple of boxes rather than a dozen overlapping searches of the same ground.
 */

import type { BBox, LatLng } from './tiles.ts';
import { haversineMetres } from './tiles.ts';

export interface Seed extends LatLng {
  name: string;
  population: number;
}

/**
 * Search radius around a city, in km, by population. Bigger cities sprawl their
 * businesses further out; a small town's are within a few km of centre.
 */
function radiusKmFor(population: number): number {
  if (population >= 250_000) return 22;
  if (population >= 100_000) return 16;
  if (population >= 30_000) return 11;
  return 7;
}

/** A degree of latitude is ~111km; longitude shrinks by cos(lat) toward the poles. */
function boxAround(seed: Seed): BBox {
  const radiusKm = radiusKmFor(seed.population);
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.cos((seed.lat * Math.PI) / 180));
  return {
    south: seed.lat - dLat,
    north: seed.lat + dLat,
    west: seed.lng - dLng,
    east: seed.lng + dLng,
  };
}

function intersects(a: BBox, b: BBox): boolean {
  return !(a.east < b.west || b.east < a.west || a.north < b.south || b.north < a.south);
}

function union(a: BBox, b: BBox): BBox {
  return {
    west: Math.min(a.west, b.west),
    south: Math.min(a.south, b.south),
    east: Math.max(a.east, b.east),
    north: Math.max(a.north, b.north),
  };
}

/**
 * Merge overlapping boxes until none overlap. Adjacent cities (a metro) collapse
 * into one box the quadtree can sweep once, instead of many overlapping sweeps
 * of the same streets.
 */
function mergeBoxes(boxes: BBox[]): BBox[] {
  let merged = [...boxes];
  let changed = true;
  while (changed) {
    changed = false;
    const next: BBox[] = [];
    for (const box of merged) {
      const hit = next.findIndex((existing) => intersects(existing, box));
      if (hit === -1) {
        next.push(box);
      } else {
        next[hit] = union(next[hit]!, box);
        changed = true;
      }
    }
    merged = next;
  }
  return merged;
}

export interface SeedBox {
  box: BBox;
  /** Cities that fell inside this box, for progress reporting. */
  seeds: string[];
}

/**
 * Largest a coverage box may be, per side, in km. This is the size of one unit
 * of work, so it sets the grain of everything downstream: progress reporting,
 * checkpointing, and the time estimate.
 *
 * It must be small. A dense downtown inside a big box makes a single term
 * subdivide into hundreds of cells — one unit that grinds for half an hour while
 * `unitsDone` sits still and the units/min estimate collapses to "~0 min left".
 * At 12km a metro becomes several small units instead of one giant one: they run
 * in parallel across the proxy pool, progress climbs smoothly, and the estimate
 * stays honest. The cost is more units (more top-level searches), which the
 * 500-proxy pool absorbs easily.
 */
const MAX_BOX_KM = 12;

/** Split a box into a grid of sub-boxes, each at most `maxKm` per side. */
function gridSplit(box: BBox, seeds: string[], maxKm: number): SeedBox[] {
  const midLat = (box.south + box.north) / 2;
  const widthKm = haversineMetres({ lat: midLat, lng: box.west }, { lat: midLat, lng: box.east }) / 1000;
  const heightKm = haversineMetres({ lat: box.south, lng: box.west }, { lat: box.north, lng: box.west }) / 1000;

  const cols = Math.max(1, Math.ceil(widthKm / maxKm));
  const rows = Math.max(1, Math.ceil(heightKm / maxKm));
  if (cols === 1 && rows === 1) return [{ box, seeds }];

  const dLng = (box.east - box.west) / cols;
  const dLat = (box.north - box.south) / rows;
  const out: SeedBox[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const sub: BBox = {
        west: box.west + c * dLng,
        east: box.west + (c + 1) * dLng,
        south: box.south + r * dLat,
        north: box.south + (r + 1) * dLat,
      };
      // Attribute a seed name to a sub-box only if a city actually lands in it,
      // so progress labels stay meaningful; unlabelled sub-boxes still get swept.
      const within = seeds.length ? [`${seeds[0]} +area`] : [];
      out.push({ box: sub, seeds: within });
    }
  }
  return out;
}

/**
 * Turn a set of population seeds into the minimal set of coverage boxes.
 *
 * Only seeds inside `bound` are used, so passing a region's full city list plus
 * the region's own bounding box keeps coverage within the region even when a
 * seed near the border would otherwise reach outside it.
 */
export function seedBoxes(seeds: Seed[], bound?: BBox): SeedBox[] {
  const within = bound
    ? seeds.filter((s) => s.lat >= bound.south && s.lat <= bound.north && s.lng >= bound.west && s.lng <= bound.east)
    : seeds;

  const boxes = within.map(boxAround);
  const merged = mergeBoxes(boxes);

  // Attribute each seed to its merged box, then split any oversized box into a
  // grid so no single unit of work covers an unmanageable area.
  return merged.flatMap((box) => {
    const seeds = within
      .filter((s) => s.lat >= box.south && s.lat <= box.north && s.lng >= box.west && s.lng <= box.east)
      .map((s) => s.name);
    return gridSplit(box, seeds, MAX_BOX_KM);
  });
}

/** Total ground area of a set of boxes in km², for logging how much is actually swept. */
export function totalAreaKm2(boxes: SeedBox[]): number {
  return boxes.reduce((sum, { box }) => {
    const midLat = ((box.south + box.north) / 2) * (Math.PI / 180);
    const w = haversineMetres({ lat: (box.south + box.north) / 2, lng: box.west }, { lat: (box.south + box.north) / 2, lng: box.east });
    const h = haversineMetres({ lat: box.south, lng: box.west }, { lat: box.north, lng: box.west });
    void midLat;
    return sum + (w * h) / 1_000_000;
  }, 0);
}
