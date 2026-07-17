/**
 * An egress is one exit identity: a proxy dispatcher paired with its own warmed
 * Google session cookie.
 *
 * The pairing matters. Google issues a session cookie (`NID`) to a specific IP,
 * and serving a full — not degraded — response depends on the cookie matching
 * the IP it arrives from. Warming one cookie and then sending it through a
 * rotating pool of exits works at ten proxies but breaks down at a hundred: the
 * cookie no longer matches most of the IPs, and Google starts trimming fields
 * or challenging. Binding each proxy to its own session keeps identity coherent
 * however large the pool grows, which is what makes adding proxies actually
 * speed things up instead of degrading them.
 */

import { directDispatcher } from './client.ts';
import { GoogleSession } from './session.ts';
import type { ProxyPool } from './proxy.ts';
import type { Dispatcher } from 'undici';

export interface Egress {
  dispatcher: Dispatcher;
  session: GoogleSession;
}

/**
 * Hands out egresses round-robin. With proxies, one egress per proxy IP, each
 * with its own session. Without, a single direct egress on the operator's IP.
 */
export class EgressPool {
  readonly #egresses: Egress[];
  #next = 0;

  private constructor(egresses: Egress[]) {
    this.#egresses = egresses;
  }

  /**
   * Build a pool from an optional proxy pool. Sessions are created here but not
   * warmed until first use, so constructing the pool is cheap.
   */
  static create(proxies: ProxyPool | null, hl: string, userAgent: string): EgressPool {
    if (!proxies || proxies.size === 0) {
      const dispatcher = directDispatcher();
      return new EgressPool([{ dispatcher, session: new GoogleSession({ hl, userAgent, dispatcher }) }]);
    }
    const egresses: Egress[] = [];
    for (let i = 0; i < proxies.size; i++) {
      // proxies.next() round-robins, so this pulls each distinct dispatcher once.
      const dispatcher = proxies.next();
      egresses.push({ dispatcher, session: new GoogleSession({ hl, userAgent, dispatcher }) });
    }
    return new EgressPool(egresses);
  }

  next(): Egress {
    const egress = this.#egresses[this.#next % this.#egresses.length]!;
    this.#next += 1;
    return egress;
  }

  get size(): number {
    return this.#egresses.length;
  }

  /**
   * Warm every session up front, in parallel. Optional — sessions warm lazily on
   * first request — but doing it once at the start avoids a burst of warm-up
   * requests racing with the first wave of real searches.
   */
  async warmAll(): Promise<void> {
    await Promise.all(this.#egresses.map((e) => e.session.cookie().catch(() => undefined)));
  }
}

/**
 * How many cells to search at once, given the egress pool.
 *
 * Concurrency is bounded by exit IPs, not by the machine: each concurrent
 * request should ideally leave from a different IP so no single one is hammered.
 * More proxies therefore genuinely means more parallelism — up to a ceiling
 * where local CPU, memory, and diminishing returns take over rather than
 * Google's per-IP tolerance.
 */
export function concurrencyFor(egressCount: number): number {
  if (egressCount <= 1) return 4; // direct: keep it gentle on the one IP
  // ~2 concurrent requests per IP is comfortably under any per-IP rate limit.
  return Math.min(48, Math.max(8, egressCount * 2));
}
