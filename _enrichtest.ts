/**
 * Head-to-head enrichment: run our real enrichPlaces over 60 BC business sites
 * and compare our email hit rate against Outscraper's for the same sites.
 */
import { readFileSync } from 'node:fs';
import { enrichPlaces } from './packages/engine/src/enrich/enrich.ts';
import { domainOf } from './packages/engine/src/enrich/emails.ts';
import { loadProxies } from './packages/engine/src/search/proxy-config.ts';
import { emptyPlace, type Place } from './packages/engine/src/schema.ts';

const SCRATCH = '/private/tmp/claude-501/-Users-fuannegao-Documents-PERSONAL-WEBSITE-Outscrapper-DUPE/3877ed2c-2f68-4fb9-b5a3-e06ced1d47d2/scratchpad';
const sample = JSON.parse(readFileSync(`${SCRATCH}/enrich_sample.json`, 'utf8')) as
  { name: string; site: string; their_email: string | null; their_fb: string | null }[];

const { pool } = await loadProxies();
console.log(`enriching ${sample.length} sites through ${pool?.size ?? 0} proxies\n`);

const places: Place[] = sample.map((biz) => {
  const p = emptyPlace('glass shop');
  p.name = biz.name;
  p.site = biz.site;
  return p;
});

const started = Date.now();
const enriched = await enrichPlaces(places, { proxies: pool, concurrency: 12 }, (pr) => {
  process.stdout.write(`\r  ${pr.done}/${pr.total}, ${pr.withEmail} with email   `);
});

let ourEmail = 0, theirEmail = 0, both = 0, oursOnly = 0, theirsOnly = 0, ourSocial = 0, domainMatch = 0;
for (let i = 0; i < sample.length; i++) {
  const we = enriched[i]!.email_1 ?? null;
  const they = sample[i]!.their_email;
  if (we) ourEmail++;
  if (they) theirEmail++;
  if (we && they) both++;
  if (we && !they) oursOnly++;
  if (!we && they) theirsOnly++;
  const e = enriched[i]!;
  if (e.facebook || e.instagram || e.linkedin) ourSocial++;
  if (we && domainOf(sample[i]!.site) && we.split('@')[1] === domainOf(sample[i]!.site)) domainMatch++;
}

const n = sample.length;
const pct = (x: number) => Math.round((100 * x) / n);
console.log(`\n\n=== EMAIL HIT RATE (${n} sites, ${((Date.now() - started) / 1000).toFixed(0)}s) ===`);
console.log(`  Outscraper found email:  ${theirEmail}/${n}  (${pct(theirEmail)}%)`);
console.log(`  We found email:          ${ourEmail}/${n}  (${pct(ourEmail)}%)`);
console.log(`  both:                    ${both}`);
console.log(`  we found, they didn't:   ${oursOnly}`);
console.log(`  they found, we didn't:   ${theirsOnly}`);
console.log(`  our domain-matching:     ${domainMatch}`);
console.log(`  we found socials:        ${ourSocial}/${n}  (${pct(ourSocial)}%)`);

console.log('\nside-by-side (first 18):');
for (let i = 0; i < 18; i++) {
  const site = (domainOf(sample[i]!.site) ?? sample[i]!.site).slice(0, 32);
  console.log(`  ${site.padEnd(34)} ${String(enriched[i]!.email_1 ?? '—').slice(0, 30).padEnd(32)} ${String(sample[i]!.their_email ?? '—').slice(0, 30)}`);
}
await pool?.close();
