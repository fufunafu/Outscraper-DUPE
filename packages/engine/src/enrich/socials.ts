/**
 * Pulling social profile links out of a business website's HTML.
 *
 * These sit in header/footer icon rows, so a page fetch that already happened
 * for email extraction yields them for free. The work is filtering: the same
 * markup links to share widgets, the platform's own pages, and developer
 * credits, none of which are the business's profile.
 */

export interface Socials {
  facebook: string | null;
  instagram: string | null;
  linkedin: string | null;
  twitter: string | null;
  youtube: string | null;
  tiktok: string | null;
}

interface Matcher {
  key: keyof Socials;
  host: RegExp;
  /** Paths that are the platform's own, a share widget, or a plugin — not a profile. */
  reject: RegExp;
}

const MATCHERS: Matcher[] = [
  { key: 'facebook', host: /(?:facebook|fb)\.com/i,
    reject: /\/(sharer|share\.php|dialog|plugins|tr\?|events|groups|policy|help)\b/i },
  { key: 'instagram', host: /instagram\.com/i,
    reject: /\/(p|explore|accounts|about|developer)\//i },
  { key: 'linkedin', host: /linkedin\.com/i,
    reject: /\/(shareArticle|sharing|feed|pulse|jobs|learning)\b/i },
  { key: 'twitter', host: /(?:twitter|x)\.com/i,
    reject: /\/(intent|share|hashtag|search|home|privacy|tos)\b/i },
  { key: 'youtube', host: /youtube\.com/i,
    reject: /\/(watch|embed|results|feed|howyoutubeworks)\b/i },
  { key: 'tiktok', host: /tiktok\.com/i,
    reject: /\/(tag|discover|foryou|about|legal)\b/i },
];

/** Platform home pages that appear as generic links, never a business profile. */
const BARE_PLATFORM = /^https?:\/\/(www\.)?(facebook|fb|instagram|linkedin|twitter|x|youtube|tiktok)\.com\/?$/i;

function isProfile(url: string, matcher: Matcher): boolean {
  if (BARE_PLATFORM.test(url)) return false;
  if (matcher.reject.test(url)) return false;
  try {
    // A profile URL has a path beyond the host.
    return new URL(url).pathname.replace(/\/+$/, '').length > 1;
  } catch {
    return false;
  }
}

/** Normalise so the same profile linked twice doesn't read as two. */
function canonical(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    u.protocol = 'https:';
    u.hostname = u.hostname.replace(/^www\./, '');
    return u.toString().replace(/\/+$/, '');
  } catch {
    return url;
  }
}

export function extractSocials(html: string): Socials {
  const result: Socials = {
    facebook: null, instagram: null, linkedin: null,
    twitter: null, youtube: null, tiktok: null,
  };

  // Only look at href targets, not arbitrary text, to avoid matching prose.
  for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const raw = match[1]!;
    const url = raw.startsWith('//') ? `https:${raw}` : raw;
    if (!/^https?:\/\//i.test(url)) continue;

    for (const matcher of MATCHERS) {
      if (result[matcher.key]) continue; // keep the first good one
      if (matcher.host.test(url) && isProfile(url, matcher)) {
        result[matcher.key] = canonical(url);
      }
    }
  }
  return result;
}
