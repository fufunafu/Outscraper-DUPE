/**
 * Enrichment: turn a scraped place into a lead by finding its email and socials.
 *
 * This is the layer that separates a place list from a lead list, and the only
 * source is the business's own website — Outscraper's own output confirms it:
 * every place with an email had a website, and no place without one did. So a
 * place with no `site` is skipped, not failed; there is nothing to enrich.
 *
 * Runs many sites concurrently, since each is dominated by network wait, and is
 * careful to isolate failures: one dead site must not take down the batch.
 */

import type { EnrichedPlace, Place } from '../schema.ts';
import type { ProxyPool } from '../search/proxy.ts';
import { crawlSite } from './crawl.ts';
import { extractEmails } from './emails.ts';
import { extractSocials } from './socials.ts';

/** What happened when one place's site was crawled. */
export type CrawlOutcome = 'ok' | 'unreachable' | 'timeout' | 'no_site';

export interface EnrichOptions {
  proxies?: ProxyPool | null;
  /** Sites fetched at once. Network-bound, so this can run higher than scraping. */
  concurrency?: number;
  signal?: AbortSignal;
  perSiteTimeoutMs?: number;
  /**
   * When provided, filled per input index with each place's crawl outcome, so a
   * caller can treat "site unreachable" differently from "reached, no email".
   */
  outcomes?: CrawlOutcome[];
}

export interface EnrichProgress {
  done: number;
  total: number;
  withEmail: number;
  lastSite?: string;
}

/** Populate the enrichment fields of one place from its website. */
async function enrichOne(
  place: Place,
  options: EnrichOptions,
): Promise<{ place: EnrichedPlace; outcome: CrawlOutcome }> {
  const enriched: EnrichedPlace = { ...place };
  if (!place.site) return { place: enriched, outcome: 'no_site' };

  const crawl = await crawlSite(place.site, {
    dispatcher: options.proxies?.next(),
    timeoutMs: options.perSiteTimeoutMs ?? 12_000,
    signal: options.signal,
  });
  if (!crawl.html) return { place: enriched, outcome: crawl.timedOut ? 'timeout' : 'unreachable' };

  const { emails } = extractEmails(crawl.html, crawl.finalUrl ?? place.site);
  const socials = extractSocials(crawl.html);

  enriched.email_1 = emails[0] ?? null;
  enriched.email_2 = emails[1] ?? null;
  enriched.email_3 = emails[2] ?? null;
  enriched.facebook = socials.facebook;
  enriched.instagram = socials.instagram;
  enriched.linkedin = socials.linkedin;
  enriched.twitter = socials.twitter;
  enriched.youtube = socials.youtube;
  enriched.tiktok = socials.tiktok;
  return { place: enriched, outcome: 'ok' };
}

/**
 * Enrich a batch of places. Returns them in the same order, each with whatever
 * contact details its site yielded; places without a site pass through unchanged.
 */
export async function enrichPlaces(
  places: Place[],
  options: EnrichOptions = {},
  onProgress?: (progress: EnrichProgress) => void,
): Promise<EnrichedPlace[]> {
  const concurrency = Math.max(1, options.concurrency ?? 10);
  const results: EnrichedPlace[] = new Array(places.length);
  let done = 0;
  let withEmail = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < places.length) {
      if (options.signal?.aborted) return;
      const index = cursor++;
      const place = places[index]!;
      try {
        const { place: enriched, outcome } = await enrichOne(place, options);
        results[index] = enriched;
        if (options.outcomes) options.outcomes[index] = outcome;
        if (enriched.email_1) withEmail += 1;
      } catch {
        // A crawl failure must not lose the place — keep the un-enriched row.
        results[index] = { ...place };
        if (options.outcomes) options.outcomes[index] = 'unreachable';
      }
      done += 1;
      onProgress?.({ done, total: places.length, withEmail, lastSite: place.site ?? undefined });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

/** Columns enrichment adds, in the order they append to an export. */
export const ENRICHMENT_COLUMNS = [
  'email_1', 'email_2', 'email_3',
  'facebook', 'instagram', 'linkedin', 'twitter', 'youtube', 'tiktok',
] as const;
