/**
 * Pulling email addresses out of a business website's HTML.
 *
 * Emails appear in several shapes, and a regex over the raw text misses most of
 * them: `mailto:` links, JSON-LD contact blocks, and — the one that defeats
 * naive scrapers — Cloudflare's email obfuscation, which replaces the address
 * with a hex blob that only decodes in the browser. Outscraper's 93%-of-sites
 * hit rate is not achievable without handling all of these.
 */

/** Addresses that are never a real contact — assets, placeholders, examples. */
const JUNK_LOCALPART =
  /^(no-?reply|do-?not-?reply|postmaster|abuse|mailer-daemon|example|test|your-?e?mail|sample|name|email|user|username|yourname|firstname|lastname)$/i;
const JUNK_PATTERNS = [
  /\.(png|jpe?g|gif|svg|webp|css|js|ico)$/i, // filenames caught by the regex
  /^[0-9a-f]{16,}@/i, // sentry/tracking hashes
  /@(example|domain|email|yourdomain|yourwebsite|sentry|wixpress|sentry-next|mailservice|test)\./i,
  /@(2x|3x|[0-9]+x)\./i, // retina asset filenames like logo@2x.png that slipped the extension check
  /@[0-9.]+$/, // bare IPs
];

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

function isPlausible(email: string): boolean {
  const lower = email.toLowerCase();
  const [local, domain] = lower.split('@');
  if (!local || !domain) return false;
  if (JUNK_LOCALPART.test(local)) return false;
  if (JUNK_PATTERNS.some((re) => re.test(lower))) return false;
  // A TLD-only domain or an over-long localpart is almost always a false hit.
  if (local.length > 64 || domain.length > 255) return false;
  return true;
}

/**
 * Decode a Cloudflare-obfuscated email.
 *
 * Cloudflare rewrites `<a href="/cdn-cgi/l/email-protection#HEX">` and
 * `<span data-cfemail="HEX">`. The first hex byte is an XOR key; each subsequent
 * byte XORed with it yields one character of the address. Without this, every
 * Cloudflare-fronted site — a large share of small business sites — returns no
 * email at all.
 */
export function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 4 || hex.length % 2 !== 0) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let email = '';
  for (let i = 2; i < hex.length; i += 2) {
    email += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  }
  return email.includes('@') ? email : null;
}

function collectCfEmails(html: string, into: Set<string>): void {
  // Both the data-cfemail attribute and the email-protection href carry the hex.
  const patterns = [
    /data-cfemail=["']([0-9a-f]+)["']/gi,
    /\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi,
  ];
  for (const re of patterns) {
    for (const match of html.matchAll(re)) {
      const decoded = decodeCfEmail(match[1]!);
      if (decoded && isPlausible(decoded)) into.add(decoded.toLowerCase());
    }
  }
}

function collectMailto(html: string, into: Set<string>): void {
  for (const match of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    const email = decodeURIComponent(match[1]!).trim();
    if (isPlausible(email)) into.add(email.toLowerCase());
  }
}

function collectPlainText(html: string, into: Set<string>): void {
  // Strip scripts and styles first, so we don't mine tracking IDs out of JS.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    // " at " / " dot " obfuscations are common; normalise the cheap ones.
    // Quantifiers here are BOUNDED on purpose: unbounded \s* flanking optional
    // tokens let the engine try every split of a long whitespace run —
    // catastrophic backtracking that froze the whole app on a real-world page.
    // Nobody obfuscates an email with five spaces.
    .replace(/\(\s{0,4}at\s{0,4}\)|\[\s{0,4}at\s{0,4}\]|＠/gi, '@')
    .replace(/[ \t]{0,4}(?:\(\s{0,4}dot\s{0,4}\)|\[\s{0,4}dot\s{0,4}\])[ \t]{0,4}/gi, '.')
    .replace(/[ \t]{1,4}@[ \t]{1,4}/g, '@')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
  for (const match of text.matchAll(EMAIL_RE)) {
    const email = trimGluedTld(match[0]);
    if (isPlausible(email)) into.add(email.toLowerCase());
  }
}

/**
 * Prose glued straight onto an address ("info@gmail.comOffice hours…") makes
 * the TLD regex swallow the next word. Real TLDs never mix case, while glued
 * prose almost always starts its next word with a capital — so a lower→upper
 * transition inside the final label marks where the address really ended.
 * Must run on the RAW match, before lowercasing destroys the signal.
 */
function trimGluedTld(email: string): string {
  const at = email.lastIndexOf('@');
  const lastDot = email.lastIndexOf('.');
  if (at < 0 || lastDot < at) return email;
  const tld = email.slice(lastDot + 1);
  const glued = /^([a-z0-9]{2,})[A-Z]/.exec(tld);
  return glued ? email.slice(0, lastDot + 1 + glued[1]!.length) : email;
}

/**
 * Emails declared in structured data or plain JS config: JSON-LD LocalBusiness
 * blocks (`"email": "info@acme.com"`) are how site builders like Wix and
 * Squarespace expose contact details — often the ONLY place the address exists
 * server-side, since the visible page renders it with JavaScript we never run.
 * The plain-text pass strips <script> tags on purpose, so this looks at the
 * raw HTML; the quoted-"email"-key shape keeps tracking IDs out.
 */
function collectStructured(html: string, into: Set<string>): void {
  for (const match of html.matchAll(/"email"\s*:\s*"(?:mailto:)?([^"\\]{3,254})"/gi)) {
    const email = match[1]!.trim();
    if (isPlausible(email) && EMAIL_RE.test(email)) into.add(email.toLowerCase());
    EMAIL_RE.lastIndex = 0; // .test on a /g regex is stateful; reset between uses
  }
}

export interface RankedEmails {
  /** Emails found, best-first. */
  emails: string[];
}

/**
 * Rank so the business's own address leads.
 *
 * A domain-matching address (`info@acme.com` on acme.com) is far more likely to
 * be the real contact than a Gmail also listed on the page, and a role address
 * (`info@`, `contact@`, `sales@`) beats a personal one for cold outreach. Free
 * providers still get kept — plenty of small trades list only a Gmail — just
 * ranked below.
 */
function rankEmails(emails: Set<string>, siteDomain: string | null): string[] {
  const ROLE = /^(info|contact|sales|hello|admin|office|enquiries|inquiries|support|mail)@/i;
  const score = (email: string): number => {
    const domain = email.split('@')[1] ?? '';
    let s = 0;
    if (siteDomain && domain === siteDomain) s += 100;
    if (ROLE.test(email)) s += 10;
    return s;
  };
  return [...emails].sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}

export function domainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url.includes('://') ? url : `http://${url}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Pages bigger than this are almost entirely bundled JS; contact details live
 * in the first fraction. Capping bounds worst-case regex time on any input —
 * this extraction runs on the app's only thread, so a slow page here would
 * freeze the UI, the scraper, everything.
 */
const MAX_HTML_BYTES = 1_500_000;

/** Extract and rank every email from one page's HTML. */
export function extractEmails(html: string, siteUrl: string | null): RankedEmails {
  const capped = html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html;
  const found = new Set<string>();
  collectCfEmails(capped, found);
  collectMailto(capped, found);
  collectStructured(capped, found);
  collectPlainText(capped, found);
  return { emails: rankEmails(found, domainOf(siteUrl)) };
}
