/**
 * Google session cookies.
 *
 * Google serves a **degraded payload to cookieless clients** — same URL, same
 * headers, but review counts and other fields are silently stripped. It does
 * not error, warn, or block; it just gives you less. A single anonymous `NID`
 * cookie, which Google hands to any first-time visitor, flips it back to the
 * full response.
 *
 * Measured on the `pb` endpoint:
 *
 *   no cookies        → [4] length 8,  0/20 places have a review count
 *   CONSENT+SOCS only → [4] length 8,  0/20
 *   warmed NID        → [4] length 9, 20/20
 *
 * This is worth stating plainly because it is easy to misdiagnose: the same
 * symptom appears as "headless Chrome gets less data", which is a confound —
 * a real browser has a warm NID and a fresh automation profile does not.
 * Nothing here needs a browser, a stealth plugin, or an account.
 */

import { fetch as undiciFetch, type Dispatcher, type RequestInit as UndiciRequestInit } from 'undici';

/** Cookies worth carrying. NID is the one that matters; the rest keep consent quiet. */
const CONSENT_COOKIES = ['CONSENT=YES+cb.20260101-00-p0.en', 'SOCS=CAI'];
const SESSION_COOKIE_NAMES = /^(NID|__Secure-STRP|AEC)=/;

const WARMUP_URL = 'https://www.google.com/maps?hl=en';

/** NID has a long TTL, but refresh periodically so a stale one can't quietly degrade us. */
const SESSION_TTL_MS = 30 * 60 * 1000;

export interface SessionOptions {
  hl?: string;
  dispatcher?: Dispatcher;
  userAgent: string;
}

/**
 * A warmed cookie jar.
 *
 * One jar per egress IP: a session cookie issued to one proxy exit and replayed
 * from another is an obvious inconsistency, and pinning identity to the IP that
 * earned it is both safer and more honest about what a "session" is.
 */
export class GoogleSession {
  #cookie: string | null = null;
  #warmedAt = 0;
  #warming: Promise<string> | null = null;

  readonly #options: SessionOptions;

  constructor(options: SessionOptions) {
    this.#options = options;
  }

  /** The Cookie header to send, warming up first if needed. */
  async cookie(): Promise<string> {
    if (this.#cookie && Date.now() - this.#warmedAt < SESSION_TTL_MS) {
      return this.#cookie;
    }
    // Collapse concurrent warm-ups: many cells start at once and would
    // otherwise each fire their own request for the same cookie.
    this.#warming ??= this.#warm().finally(() => {
      this.#warming = null;
    });
    return this.#warming;
  }

  async #warm(): Promise<string> {
    const headers: Record<string, string> = {
      'User-Agent': this.#options.userAgent,
      'Accept-Language': `${this.#options.hl ?? 'en'}-US,${this.#options.hl ?? 'en'};q=0.9`,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Cookie: CONSENT_COOKIES.join('; '),
    };

    const jar = [...CONSENT_COOKIES];
    try {
      const response = await undiciFetch(WARMUP_URL, {
        headers,
        ...(this.#options.dispatcher ? { dispatcher: this.#options.dispatcher } : {}),
      } as UndiciRequestInit);

      for (const [name, value] of response.headers) {
        if (name.toLowerCase() !== 'set-cookie') continue;
        // Multiple cookies arrive comma-joined; split only where a new pair starts.
        for (const part of value.split(/,(?=[^;]+=)/)) {
          const pair = part.split(';')[0]?.trim();
          if (pair && SESSION_COOKIE_NAMES.test(pair)) jar.push(pair);
        }
      }
    } catch {
      // A failed warm-up is not fatal: we still get results, just degraded ones.
      // Better to proceed and let the caller notice missing fields than to abort.
    }

    this.#cookie = jar.join('; ');
    this.#warmedAt = Date.now();
    return this.#cookie;
  }

  /** True once a real session cookie — not just consent — has been obtained. */
  get isWarm(): boolean {
    return this.#cookie !== null && /(?:^|; )NID=/.test(this.#cookie);
  }
}
