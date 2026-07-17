/**
 * HTTP transport for Google Maps' internal search endpoint.
 *
 * The endpoint answers a plain GET — no browser, no cookies in most regions —
 * and returns ~20 places per request in a few hundred milliseconds. That makes
 * it two orders of magnitude cheaper per record than driving a headless browser,
 * so it is the default path; the browser is reserved for detail-only fields.
 */

import { fetch as undiciFetch, Agent, type Dispatcher, type RequestInit as UndiciRequestInit } from 'undici';

/**
 * Node's global fetch is built on its own bundled undici, which rejects a
 * dispatcher created from the separately-installed undici with UND_ERR_INVALID_ARG.
 * Using undici's own fetch keeps request and dispatcher on the same instance,
 * so proxy routing actually takes effect instead of silently erroring.
 */

import { GoogleSession } from './session.ts';

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
  /**
   * Warmed cookie jar. Without one Google silently strips fields (review counts
   * among them) rather than erroring — see session.ts.
   */
  session?: GoogleSession;
}

let sharedDirect: Agent | null = null;
/** One reused Agent for un-proxied egress, instead of a fresh one per request. */
function directDispatcher(): Agent {
  return (sharedDirect ??= new Agent({ connections: 16 }));
}

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function headersFor(hl: string, cookie: string): Record<string, string> {
  return {
    // Accept-Language must agree with hl — a mismatch is a fingerprinting signal.
    'Accept-Language': `${hl},${hl.split('-')[0]};q=0.9`,
    'User-Agent': USER_AGENT,
    Accept: '*/*',
    Referer: 'https://www.google.com/maps/',
    Cookie: cookie,
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
  const { hl = 'en', signal, dispatcher, timeoutMs = 20_000, session } = options;

  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const cookie = session ? await session.cookie() : '';
  const response = await undiciFetch(url, {
    headers: headersFor(hl, cookie),
    signal: combined,
    dispatcher: dispatcher ?? directDispatcher(),
  } as UndiciRequestInit);

  if (response.status === 429 || response.status === 503) {
    throw new RateLimited(`upstream returned ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`upstream returned ${response.status}`);
  }

  return JSON.parse(stripXssiPrefix(await response.text()));
}
