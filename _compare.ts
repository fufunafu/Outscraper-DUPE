/**
 * Head-to-head: our scraper vs an Outscraper run, same 8 categories over Vancouver.
 * Matches our results against their full BC dataset by place_id and cid, so their
 * city-labelling doesn't skew the overlap.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { scrape } from './packages/engine/src/scrape.ts';
import { loadProxies } from './packages/engine/src/search/proxy-config.ts';
import { geocodeOne } from './packages/engine/src/geo/geocode.ts';
import { Deduper } from './packages/engine/src/store/dedupe.ts';
import type { Place } from './packages/engine/src/schema.ts';

const SCRATCH = '/private/tmp/claude-501/-Users-fuannegao-Documents-PERSONAL-WEBSITE-Outscrapper-DUPE/3877ed2c-2f68-4fb9-b5a3-e06ced1d47d2/scratchpad';
const theirs = JSON.parse(readFileSync(`${SCRATCH}/their_all_bc.json`, 'utf8')) as
  { place_id: string; cid: string | null; name: string; lat: number; lng: number }[];
const theirPids = new Set(theirs.map((t) => t.place_id));
const theirCids = new Set(theirs.filter((t) => t.cid).map((t) => t.cid));

const CATEGORIES = ['glass & mirror shop', 'glass shop', 'glass industry', 'glass merchant',
  'railing contractor', 'deck builder', 'swimming pool contractor', 'fence contractor'];

const { pool } = await loadProxies();
console.log(`proxies: ${pool?.size ?? 0}\n`);

const region = await geocodeOne('Vancouver, BC, Canada');
if (!region) throw new Error('geocode failed');
console.log(`Vancouver bbox: ${JSON.stringify(region.box)} (${region.displayName})\n`);

const deduper = new Deduper();
const ours: Place[] = [];
const started = Date.now();

for (const category of CATEGORIES) {
  const before = ours.length;
  const r = await scrape(
    { query: category, region: region.box, language: 'en', concurrency: pool ? 8 : 4, proxies: pool },
    (p) => process.stdout.write(`\r  ${category.padEnd(26)} ${p.found} found, ${p.cellsSearched} cells   `),
  );
  for (const place of r.places) if (deduper.add(place)) ours.push(place);
  console.log(`\r  ${category.padEnd(26)} +${ours.length - before} unique (${r.places.length} raw)          `);
}

const mins = ((Date.now() - started) / 60000).toFixed(1);
console.log(`\nOURS: ${ours.length} unique places in ${mins} min\n`);

// Match ours against their full BC set.
const inTheirs = (p: Place) =>
  (p.place_id && theirPids.has(p.place_id)) || (p.cid && theirCids.has(p.cid));
const overlap = ours.filter(inTheirs);
const oursOnly = ours.filter((p) => !inTheirs(p));

// Which of their places fall inside our Vancouver bbox — the recall denominator.
const b = region.box;
const inBox = (lat: number, lng: number) => lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;
const theirsInBox = theirs.filter((t) => t.lat && t.lng && inBox(t.lat, t.lng));
const ourPids = new Set(ours.map((p) => p.place_id).filter(Boolean));
const ourCids = new Set(ours.map((p) => p.cid).filter(Boolean));
const theyHaveWeMissed = theirsInBox.filter((t) => !ourPids.has(t.place_id) && !(t.cid && ourCids.has(t.cid)));

const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);
console.log('=== RECALL (their Vancouver-area places, did we find them?) ===');
console.log(`  their places inside our bbox:     ${theirsInBox.length}`);
console.log(`  we also found:                    ${theirsInBox.length - theyHaveWeMissed.length} (${pct(theirsInBox.length - theyHaveWeMissed.length, theirsInBox.length)}%)`);
console.log(`  we MISSED:                        ${theyHaveWeMissed.length}`);
console.log('\n=== NEW (we found, not anywhere in their BC run) ===');
console.log(`  ours total:                       ${ours.length}`);
console.log(`  also in their BC data:            ${overlap.length}`);
console.log(`  NOT in their data (new leads):    ${oursOnly.length} (${pct(oursOnly.length, ours.length)}%)`);

const fill = (f: keyof Place) => pct(ours.filter((p) => p[f] != null && p[f] !== '').length, ours.length);
console.log('\n=== OUR FIELD FILL ===');
for (const f of ['name','phone','site','full_address','rating','reviews','working_hours','category'] as (keyof Place)[])
  console.log(`  ${f.padEnd(16)} ${fill(f)}%`);

console.log('\nsome new-lead examples (not in their run):');
for (const p of oursOnly.slice(0, 8)) console.log(`  ${p.name} — ${p.category} — ${p.full_address ?? ''}`);
for (const p of theyHaveWeMissed.slice(0, 8)) if (theyHaveWeMissed.length) { break; }

writeFileSync(`${SCRATCH}/our_vancouver.json`, JSON.stringify(ours.map((p) =>
  ({ name: p.name, place_id: p.place_id, cid: p.cid, category: p.category, phone: p.phone, site: p.site, reviews: p.reviews })), null, 1));
await pool?.close();
