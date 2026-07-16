/**
 * Deciding whether Google truncated a cell's results.
 *
 * This is the crux of exhaustive coverage, and it is harder than it looks:
 * Google never says "truncated". It just stops sending places.
 *
 * The obvious test — `count >= cap` — does not work, because there is no fixed
 * cap. Measured on the same region: a viewport truncated at 95 places while a
 * different one served 129. Trusting a 129 threshold reported that 95-place
 * cell as complete when it was missing 85% of its businesses.
 *
 * So we use two signals:
 *
 *  1. **Count**, thresholded low. A cell returning several pages is suspicious
 *     regardless of the exact number.
 *  2. **Spatial spread.** When Google truncates, it keeps the places nearest the
 *     viewport centre, so results cluster in the middle and the cell's edges
 *     come back empty. A cell that is genuinely exhausted has places out to its
 *     corners. Comparing the bounding box of the returned places against the
 *     cell tells us which happened — and unlike a count, it doesn't depend on a
 *     magic number that Google can change.
 */

import type { BBox } from './tiles.ts';
import { haversineMetres } from './tiles.ts';

export interface SaturationSignals {
  count: number;
  /** Fraction of the cell's area the returned places actually span, 0–1. */
  spread: number;
  saturated: boolean;
  reason: 'sparse' | 'count' | 'clustered';
}

/**
 * A cell returning fewer than this is sparse enough to trust, whatever its
 * spread. Set below the smallest truncation seen (95) with wide margin, because
 * a false split costs four cheap requests while a false "complete" silently
 * loses data forever. The asymmetry justifies erring toward splitting.
 */
const TRUST_BELOW = 40;

/**
 * If results span less than this fraction of the cell, Google was almost
 * certainly cutting the list off at a radius rather than running out of places.
 */
const CLUSTERED_BELOW = 0.55;

/** The bounding box the returned places actually occupy. */
function extentOf(points: { latitude: number | null; longitude: number | null }[]): BBox | null {
  const valid = points.filter(
    (p): p is { latitude: number; longitude: number } => p.latitude != null && p.longitude != null,
  );
  if (valid.length < 2) return null;

  return {
    west: Math.min(...valid.map((p) => p.longitude)),
    east: Math.max(...valid.map((p) => p.longitude)),
    south: Math.min(...valid.map((p) => p.latitude)),
    north: Math.max(...valid.map((p) => p.latitude)),
  };
}

/**
 * How much of `cell` the places span, by area, 0–1.
 *
 * Compares the results' own bounding box to the cell's, in metres rather than
 * degrees so that longitude convergence at high latitude doesn't skew it.
 */
export function spatialSpread(
  cell: BBox,
  places: { latitude: number | null; longitude: number | null }[],
): number {
  const extent = extentOf(places);
  if (!extent) return 0;

  const midLat = (cell.south + cell.north) / 2;
  const widthOf = (box: BBox) =>
    haversineMetres({ lat: midLat, lng: box.west }, { lat: midLat, lng: box.east });
  const heightOf = (box: BBox) =>
    haversineMetres({ lat: box.south, lng: box.west }, { lat: box.north, lng: box.west });

  const cellArea = widthOf(cell) * heightOf(cell);
  if (cellArea <= 0) return 0;

  const placesArea = widthOf(extent) * heightOf(extent);
  return Math.min(1, placesArea / cellArea);
}

export function assessSaturation(
  cell: BBox,
  places: { latitude: number | null; longitude: number | null }[],
): SaturationSignals {
  const count = places.length;
  const spread = spatialSpread(cell, places);

  if (count < TRUST_BELOW) {
    return { count, spread, saturated: false, reason: 'sparse' };
  }
  if (spread < CLUSTERED_BELOW) {
    // Plenty of results, all huddled near the centre — the classic truncation
    // fingerprint, and the signal a count threshold misses entirely.
    return { count, spread, saturated: true, reason: 'clustered' };
  }
  return { count, spread, saturated: true, reason: 'count' };
}
