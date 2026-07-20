/**
 * Cheap deliverability check: does the email's domain accept mail at all?
 *
 * One DNS MX lookup per unique domain kills the addresses that are guaranteed
 * to bounce — dead companies, typo'd domains, parked pages. That matters for
 * cold outreach: a bounce rate over a few percent gets a sender flagged, so
 * dropping provably-dead addresses before export is the single cheapest
 * deliverability win. A domain with no MX but an A/AAAA record still counts as
 * deliverable (RFC 5321 fallback), and DNS timeouts count as deliverable too —
 * a slow resolver must never delete a good lead.
 */

import { resolveMx, resolve4, resolve6 } from 'node:dns/promises';

/** Per-process cache: an export batch repeats domains, and DNS answers don't churn. */
const cache = new Map<string, boolean>();

async function domainAcceptsMail(domain: string): Promise<boolean> {
  try {
    const mx = await resolveMx(domain);
    if (mx.length > 0) return true;
  } catch {
    // NXDOMAIN / no MX record — fall through to the A/AAAA fallback.
  }
  try {
    if ((await resolve4(domain)).length > 0) return true;
  } catch { /* keep trying */ }
  try {
    if ((await resolve6(domain)).length > 0) return true;
  } catch { /* dead */ }
  return false;
}

/** Race DNS against a timeout; on timeout, assume deliverable (never drop on slowness). */
function withTimeout(check: Promise<boolean>, ms: number): Promise<boolean> {
  return Promise.race([
    check,
    new Promise<boolean>((resolve) => setTimeout(resolve, ms, true).unref?.()),
  ]);
}

/**
 * Validate the domains of a batch of emails. Returns the set of domains that
 * provably accept no mail; everything else (valid, unknown, or slow) passes.
 */
export async function deadEmailDomains(
  emails: string[],
  { concurrency = 20, timeoutMs = 2_500 }: { concurrency?: number; timeoutMs?: number } = {},
): Promise<Set<string>> {
  const domains = [...new Set(
    emails.map((e) => e.split('@')[1]?.toLowerCase()).filter((d): d is string => !!d),
  )].filter((d) => !cache.has(d));

  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, domains.length) }, async () => {
    while (cursor < domains.length) {
      const domain = domains[cursor++]!;
      cache.set(domain, await withTimeout(domainAcceptsMail(domain), timeoutMs));
    }
  }));

  const dead = new Set<string>();
  for (const email of emails) {
    const domain = email.split('@')[1]?.toLowerCase();
    if (domain && cache.get(domain) === false) dead.add(domain);
  }
  return dead;
}
