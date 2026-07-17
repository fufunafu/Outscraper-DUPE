import { readFileSync } from 'node:fs';
import { crawlSite } from './packages/engine/src/enrich/crawl.ts';
import { extractEmails } from './packages/engine/src/enrich/emails.ts';
const SCRATCH = '/private/tmp/claude-501/-Users-fuannegao-Documents-PERSONAL-WEBSITE-Outscrapper-DUPE/3877ed2c-2f68-4fb9-b5a3-e06ced1d47d2/scratchpad';
const sample = JSON.parse(readFileSync(`${SCRATCH}/enrich_sample.json`, 'utf8')) as {name:string;site:string;their_email:string|null}[];
const cats = { fetchFail:0, jsRendered:0, differentPage:0, weGotIt:0, noEmailExists:0 };
for (const biz of sample) {
  const crawl = await crawlSite(biz.site, { timeoutMs: 15000, maxExtraPages: 3 });
  const { emails } = crawl.html ? extractEmails(crawl.html, crawl.finalUrl ?? biz.site) : { emails: [] };
  if (emails.length) { cats.weGotIt++; continue; }
  if (!biz.their_email) { cats.noEmailExists++; continue; }
  if (!crawl.html) { cats.fetchFail++; continue; }
  // We fetched HTML but found no email, yet they did → JS-rendered or on a page we didn't reach.
  const theirInHtml = crawl.html.toLowerCase().includes(biz.their_email.toLowerCase());
  if (theirInHtml) cats.differentPage++; else cats.jsRendered++;
}
console.log('CATEGORIES OF ALL 60:');
console.log(`  we got an email:                    ${cats.weGotIt}`);
console.log(`  no email exists anyway:             ${cats.noEmailExists}`);
console.log(`  fetch failed (site down/blocks):    ${cats.fetchFail}`);
console.log(`  email in our HTML but we missed it: ${cats.differentPage}  (extraction bug — fixable)`);
console.log(`  email NOT in our HTML (JS-rendered): ${cats.jsRendered}  (needs a browser)`);
