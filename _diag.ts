/** For the sites we missed, WHY? Fetch failed, or fetched-but-no-email? */
import { readFileSync } from 'node:fs';
import { crawlSite, siteToUrl } from './packages/engine/src/enrich/crawl.ts';
import { extractEmails } from './packages/engine/src/enrich/emails.ts';

const SCRATCH = '/private/tmp/claude-501/-Users-fuannegao-Documents-PERSONAL-WEBSITE-Outscrapper-DUPE/3877ed2c-2f68-4fb9-b5a3-e06ced1d47d2/scratchpad';
const sample = JSON.parse(readFileSync(`${SCRATCH}/enrich_sample.json`, 'utf8')) as
  { name: string; site: string; their_email: string|null }[];

// Only look at ones where they found an email (so an email exists to find).
let fetchFail=0, noEmail=0, foundNow=0, htmlHadTheirEmail=0;
for (const biz of sample.slice(0, 30)) {
  if (!biz.their_email) continue;
  const crawl = await crawlSite(biz.site, { timeoutMs: 15000, maxExtraPages: 3 });
  const dom = siteToUrl(biz.site);
  if (!crawl.html) { fetchFail++; console.log(`FETCH-FAIL  ${dom}  (${crawl.error})`); continue; }
  const { emails } = extractEmails(crawl.html, crawl.finalUrl ?? biz.site);
  const theirInHtml = crawl.html.toLowerCase().includes(biz.their_email.toLowerCase());
  if (emails.length) { foundNow++; }
  else {
    noEmail++;
    if (theirInHtml) htmlHadTheirEmail++;
    console.log(`NO-EMAIL    ${String(dom).slice(0,40).padEnd(42)} pages=${crawl.pagesFetched} theirEmailInHtml=${theirInHtml} htmlLen=${crawl.html.length}`);
  }
}
console.log(`\nfetch-fail=${fetchFail}  no-email=${noEmail}  (of which their email WAS in our html: ${htmlHadTheirEmail})  found=${foundNow}`);
