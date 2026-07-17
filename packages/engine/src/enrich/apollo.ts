/**
 * Apollo.io enrichment — PARKED, not wired in.
 *
 * The user only needs company email and phone, both of which come free from the
 * website crawl and the Maps listing. Apollo is kept here as a documented
 * drop-in for later, because it is the same source Outscraper uses for the one
 * thing website scraping cannot get: named decision-makers with job titles.
 * Outscraper's file showed ~1,600 of their contacts sourced from Apollo /
 * ZoomInfo / ContactOut / LinkedIn — all person-level, none scrapeable.
 *
 * To activate: implement `apolloEnrich` against Apollo's People Enrichment API
 * (POST https://api.apollo.io/v1/people/match with the business domain), drop
 * an API key into the same config file the proxies use, and call it from
 * enrich.ts alongside the website crawl. It bills per matched contact
 * (~$0.02), so it should run only when the user opts in — never on every place.
 *
 * Left unimplemented on purpose: no key, no current need, and dead code that
 * pretends to work is worse than an honest stub.
 */

import type { Place } from '../schema.ts';

export interface ApolloContact {
  full_name: string | null;
  title: string | null;
  email: string | null;
  linkedin: string | null;
}

export interface ApolloConfig {
  apiKey: string;
  /** Cap contacts fetched per business, since each one is billed. */
  maxPerBusiness?: number;
}

/**
 * Would return named contacts for a business from Apollo, keyed off its website
 * domain. Throws until implemented, so an accidental call fails loudly rather
 * than silently returning nothing.
 */
export async function apolloEnrich(_place: Place, _config: ApolloConfig): Promise<ApolloContact[]> {
  throw new Error('Apollo enrichment is not implemented — parked for later. See apollo.ts.');
}
