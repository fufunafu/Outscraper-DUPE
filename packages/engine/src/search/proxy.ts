/**
 * Proxy egress.
 *
 * Without this, every request comes from the operator's own IP — fine for a few
 * hundred requests, not fine for sustained work, and the cost of finding the
 * limit empirically is your home address getting rate-limited or blocked.
 *
 * Residential proxies bill by the gigabyte, and this scraper's responses run
 * ~136 KB each. The duplicate rate therefore drives the bill directly: cells
 * overlap, so the same place is fetched many times, and each re-fetch is paid
 * bandwidth. Reducing over-subdivision is a cost optimisation, not just a speed one.
 */

import { ProxyAgent, Agent, type Dispatcher } from 'undici';

export interface ProxyConfig {
  /** e.g. `http://user:pass@gate.provider.com:7000` */
  url: string;
  /**
   * Provider-side rotation is the norm: one gateway host hands out a different
   * exit IP per connection. When true we keep a single dispatcher and let the
   * provider rotate. When false, we rotate across `urls` ourselves.
   */
  rotatesUpstream?: boolean;
}

export interface ProxyPoolOptions {
  /** One entry for a rotating gateway, or many for a static list. */
  urls: string[];
  rotatesUpstream?: boolean;
}

/**
 * Hands out a dispatcher per request.
 *
 * Two shapes, because providers differ: a single rotating gateway (Bright Data,
 * Oxylabs, Decodo) where every connection already exits from a new IP, or a
 * list of fixed endpoints (Webshare, IPRoyal static) that we round-robin.
 */
/** A proxy's display identity: host:port, never credentials. */
export function proxyLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '80'}`;
  } catch {
    return 'proxy';
  }
}

export class ProxyPool {
  readonly #dispatchers: Dispatcher[];
  readonly #labels: string[];
  #next = 0;

  constructor(options: ProxyPoolOptions) {
    if (options.urls.length === 0) {
      throw new Error('ProxyPool needs at least one proxy URL');
    }
    this.#labels = options.urls.map(proxyLabel);
    this.#dispatchers = options.urls.map(
      (url) =>
        new ProxyAgent({
          uri: url,
          // Keep connections short-lived: on a rotating gateway, a new connection
          // is what earns a new exit IP, so pooling them defeats the rotation.
          connections: 4,
          keepAliveTimeout: 10_000,
          keepAliveMaxTimeout: 30_000,
        }),
    );
  }

  next(): Dispatcher {
    const dispatcher = this.#dispatchers[this.#next % this.#dispatchers.length]!;
    this.#next += 1;
    return dispatcher;
  }

  /** Every proxy with its label, for health checks and per-IP telemetry. */
  entries(): { dispatcher: Dispatcher; label: string }[] {
    return this.#dispatchers.map((dispatcher, i) => ({ dispatcher, label: this.#labels[i]! }));
  }

  get size(): number {
    return this.#dispatchers.length;
  }

  async close(): Promise<void> {
    await Promise.all(this.#dispatchers.map((d) => d.close()));
  }
}

/** Direct egress — the operator's own IP. Fine for testing, not for volume. */
export function directDispatcher(): Dispatcher {
  return new Agent({ connections: 8 });
}

/**
 * Parse the `PROXY_URLS` env var: comma-separated proxy URLs, empty for direct.
 * Kept out of the UI on purpose — credentials belong in the environment, not in
 * a settings field that ends up in a shared export.
 */
export function proxyPoolFromEnv(): ProxyPool | null {
  const raw = process.env.PROXY_URLS?.trim();
  if (!raw) return null;
  const urls = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return urls.length > 0 ? new ProxyPool({ urls }) : null;
}
