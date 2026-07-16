/**
 * HTTP transport for Google Maps' internal search endpoint.
 *
 * The endpoint answers a plain GET — no browser, no cookies in most regions —
 * and returns ~20 places per request in a few hundred milliseconds. That makes
 * it two orders of magnitude cheaper per record than driving a headless browser,
 * so it is the default path; the browser is reserved for detail-only fields.
 */

import type { Dispatcher } from 'undici';

export class RateLimited extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimited';
  }
}

export class BlockedByCaptcha extends Error {
  constructor(message = 'Google served a challenge instead of results') {
    super(message);
    this.name = 'BlockedByCaptcha';
  }
}

export interface FetchOptions {
  hl?: string;
  signal?: AbortSignal;
  /**
   * Egress route for this request. Omitting it sends from the operator's own
   * IP, which is fine for a handful of requests and unwise for a real run.
   */
  dispatcher?: Dispatcher;
  timeoutMs?: number;
}

/**
 * Requesting from an EU-geolocated IP redirects to a consent interstitial.
 * Presetting the consent cookie sidesteps it without a browser round-trip.
 */
const CONSENT_COOKIE = 'CONSENT=YES+cb.20260101-00-p0.en; SOCS=CAI';

function headersFor(hl: string): Record<string, string> {
  return {
    // Accept-Language must agree with hl — a mismatch is a fingerprinting signal.
    'Accept-Language': `${hl},${hl.split('-')[0]};q=0.9`,
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: '*/*',
    Referer: 'https://www.google.com/maps/',
    Cookie: CONSENT_COOKIE,
  };
}

/**
 * Google prefixes JSON responses with `)]}'` on its own line as anti-XSSI
 * padding, which must be stripped before parsing. A response that does not
 * carry that prefix is not a result payload — it is a challenge or error page.
 */
export function stripXssiPrefix(body: string): string {
  if (!body.startsWith(")]}'")) {
    throw new BlockedByCaptcha(
      `expected )]}' prefix, got: ${body.slice(0, 80).replace(/\s+/g, ' ')}`,
    );
  }
  const newline = body.indexOf('\n');
  return newline === -1 ? body.slice(4) : body.slice(newline + 1);
}

export async function fetchSearchPage(url: string, options: FetchOptions = {}): Promise<unknown> {
  const { hl = 'en', signal, dispatcher, timeoutMs = 20_000 } = options;

  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const response = await fetch(url, {
    headers: headersFor(hl),
    signal: combined,
    // `dispatcher` is an undici extension to RequestInit, not part of the DOM type.
    ...(dispatcher ? { dispatcher } : {}),
  } as RequestInit & { dispatcher?: Dispatcher });

  if (response.status === 429 || response.status === 503) {
    throw new RateLimited(`upstream returned ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`upstream returned ${response.status}`);
  }

  return JSON.parse(stripXssiPrefix(await response.text()));
}
