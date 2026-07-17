import { readFileSync } from 'node:fs';
import { crawlSite } from './packages/engine/src/enrich/crawl.ts';
import { extractEmails } from './packages/engine/src/enrich/emails.ts';
const SCRATCH = '/private/tmp/claude-501/-Users-fuannegao-Documents-PERSONAL-WEBSITE-Outscrapper-DUPE/3877ed2c-2f68-4fb9-b5a3-e06ced1d47d2/scratchpad';
const sample = JSON.parse(readFileSync(`${SCRATCH}/enrich_sample.json`,'utf8')) as {name:string;site:string;their_email:string|null}[];
for (const biz of sample) {
  const crawl = await crawlSite(biz.site, { timeoutMs: 15000, maxExtraPages: 3 });
  const { emails } = crawl.html ? extractEmails(crawl.html, crawl.finalUrl ?? biz.site) : { emails: [] };
  if (emails.length || !biz.their_email || !crawl.html) continue;
  if (crawl.html.toLowerCase().includes(biz.their_email.toLowerCase())) {
    // Their email IS in our html but we didn't extract it. Show the surrounding context.
    const idx = crawl.html.toLowerCase().indexOf(biz.their_email.toLowerCase());
    console.log(`\n${biz.site}\n  their email: ${biz.their_email}`);
    console.log(`  context: ...${crawl.html.slice(Math.max(0,idx-70), idx+biz.their_email.length+20).replace(/\s+/g,' ')}...`);
  }
}
