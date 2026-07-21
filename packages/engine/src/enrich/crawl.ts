/**
 * Fetching the few pages of a business site that carry contact details.
 *
 * The homepage often has the email in a footer, but the contact/about page is
 * where it reliably lives, so we fetch the homepage and follow at most a couple
 * of same-domain links that look like contact pages. This is deliberately
 * shallow: the goal is one business's email, not a crawl of their whole site.
 */

import { fetch as undiciFetch, type Dispatcher, type RequestInit as UndiciRequestInit } from 'undici';

import { domainOf } from './emails.ts';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Link text/paths that lead to contact details, best-first. */
const CONTACT_HINTS = /\b(contact|about|team|staff|impressum|reach|connect|get-in-touch|contact-us|about-us)\b/i;

export interface CrawlOptions {
  dispatcher?: Dispatcher;
  timeoutMs?: number;
  /** Extra pages to fetch beyond the homepage. */
  maxExtraPages?: number;
  signal?: AbortSignal;
}

export interface CrawlResult {
  /** Concatenated HTML of every page fetched, for extraction to run over once. */
  html: string;
  /** The homepage URL after redirects, for domain-matching emails. */
  finalUrl: string | null;
  pagesFetched: number;
  /** Set when the site couldn't be reached at all. */
  error?: string;
  /** The homepage failed specifically by timing out — a slow-connection signal,
   *  not a dead site. Lets the caller throttle when the network is struggling. */
  timedOut?: boolean;
}

/**
 * Read a response body up to `cap` decompressed bytes, then stop pulling. undici
 * decompresses lazily as the stream is read, so halting early means the tail is
 * never expanded — bounding memory no matter how large the payload inflates to.
 */
async function readCapped(res: Awaited<ReturnType<typeof undiciFetch>>, cap: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8');
  let out = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      out += decoder.decode(value, { stream: true });
      if (bytes >= cap) { await reader.cancel(); break; }
    }
  } catch {
    // A mid-stream error still leaves us whatever decoded so far — good enough.
  }
  return out;
}

interface FetchResult {
  page: { html: string; finalUrl: string } | null;
  /** True when the attempt was aborted by our own timeout — the "bad connection"
   *  signal, distinct from a DNS/refused failure that means the site is dead. */
  timedOut: boolean;
}

async function fetchPage(url: string, options: CrawlOptions): Promise<FetchResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 12_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const res = await undiciFetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        // A real browser always sends one; its absence is a cheap bot tell.
        'Accept-Language': 'en-CA,en-US;q=0.9,en;q=0.8',
      },
      signal,
      redirect: 'follow',
      ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
    } as UndiciRequestInit);

    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.includes('html')) {
      // Drain the body so the connection can be reused.
      await res.body?.cancel();
      return { page: null, timedOut: false };
    }
    // Cap the body WHILE reading, not after. `res.text()` fully decompresses
    // first, so a small brotli/gzip payload that expands to gigabytes (a
    // decompression bomb, or just a pathological page) blows the heap before any
    // post-hoc .slice() runs — which crashed the app under concurrent crawling.
    // Reading the stream and stopping at the cap means the rest is never
    // decompressed at all.
    const html = await readCapped(res, 1_500_000);
    return { page: { html, finalUrl: res.url }, timedOut: false };
  } catch {
    // Our timeout signal firing means the request was too slow — the congestion
    // signal. A caller-supplied abort doesn't count as a timeout.
    return { page: null, timedOut: timeout.aborted && !options.signal?.aborted };
  }
}

/** Same-domain links whose text or path suggests a contact page, best-first. */
function contactLinks(html: string, baseUrl: string): string[] {
  const base = domainOf(baseUrl);
  const scored: { url: string; score: number }[] = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    let url: URL;
    try {
      url = new URL(match[1]!, baseUrl);
    } catch {
      continue;
    }
    if (domainOf(url.href) !== base) continue; // stay on the business's own site
    const key = url.href.replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);

    const hint = `${url.pathname} ${match[1]}`;
    if (CONTACT_HINTS.test(hint)) {
      // A path literally named /contact beats a nav link mentioning it.
      scored.push({ url: url.href, score: /contact/i.test(url.pathname) ? 2 : 1 });
    }
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.url);
}

/**
 * Normalise a Maps `site` value into a fetchable URL. These are sometimes bare
 * hostnames, sometimes tracking-wrapped, and occasionally social links.
 */
export function siteToUrl(site: string | null): string | null {
  if (!site) return null;
  // Maps site values often arrive with the query string percent-encoded
  // (`/%3Futm_source%3D...`), which makes the server 404. Decode once so a
  // pre-encoded `?`/`&` becomes a real delimiter before parsing.
  let raw = site;
  try {
    if (/%3[fF]|%26/.test(raw)) raw = decodeURIComponent(raw);
  } catch {
    // Leave it as-is if it isn't valid percent-encoding.
  }
  const url = raw.includes('://') ? raw : `https://${raw}`;
  try {
    const parsed = new URL(url);
    // A Facebook/Instagram "website" isn't crawlable for a business email.
    if (/(facebook|instagram|linktr\.ee|twitter|x)\.com$/i.test(parsed.hostname)) return null;
    // Tracking params are noise for reaching the homepage, and mangled ones are
    // the main cause of unreachable sites — drop the query and fragment.
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Alternate URLs to try when the canonical one fails: http, and www toggled. */
function fallbackUrls(start: string): string[] {
  const urls: string[] = [];
  try {
    const u = new URL(start);
    if (u.protocol === 'https:') { const h = new URL(start); h.protocol = 'http:'; urls.push(h.toString()); }
    const w = new URL(start);
    w.hostname = w.hostname.startsWith('www.') ? w.hostname.slice(4) : `www.${w.hostname}`;
    urls.push(w.toString());
  } catch {
    // start wasn't a valid URL; nothing to vary.
  }
  return urls;
}

export async function crawlSite(site: string, options: CrawlOptions = {}): Promise<CrawlResult> {
  const start = siteToUrl(site);
  if (!start) return { html: '', finalUrl: null, pagesFetched: 0, error: 'unfetchable site url' };

  // Many "unreachable" sites just need http instead of https, or the other www.
  let home = await fetchPage(start, options);
  let timedOut = home.timedOut;
  if (!home.page) {
    for (const alt of fallbackUrls(start)) {
      home = await fetchPage(alt, options);
      timedOut = timedOut || home.timedOut;
      if (home.page) break;
    }
  }
  if (!home.page) return { html: '', finalUrl: null, pagesFetched: 0, error: 'homepage unreachable', timedOut };
  const homePage = home.page;

  const parts = [homePage.html];
  let fetched = 1;

  const maxExtra = options.maxExtraPages ?? 2;
  const candidates = contactLinks(homePage.html, homePage.finalUrl);

  // A JS-rendered site (Wix, Squarespace, most builders) serves a homepage
  // whose nav only exists after scripts run, so link discovery comes up empty
  // even though /contact is right there. Probe the conventional paths directly
  // — a 404 costs one cheap request; a hit is where the email usually lives.
  if (candidates.length === 0) {
    try {
      const origin = new URL(homePage.finalUrl).origin;
      candidates.push(`${origin}/contact`, `${origin}/contact-us`, `${origin}/about`);
    } catch {
      // finalUrl unparsable; homepage HTML is all we get.
    }
  }

  for (const link of candidates.slice(0, maxExtra)) {
    if (options.signal?.aborted) break;
    const { page } = await fetchPage(link, options);
    if (page) {
      parts.push(page.html);
      fetched += 1;
    }
  }

  return { html: parts.join('\n'), finalUrl: homePage.finalUrl, pagesFetched: fetched };
}
