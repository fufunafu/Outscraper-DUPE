/**
 * Loading proxy settings for a double-clickable app.
 *
 * An environment variable is the wrong mechanism here: a `.app` launched from
 * Finder inherits none of a shell's environment, so `PROXY_URLS` would simply be
 * empty. Instead we read a plain text file the user can edit — one the app
 * writes a commented template for on first run — and fall back to the env var
 * for anyone running from a terminal.
 *
 * The file lives next to the exports, where the user already knows to look, and
 * is parsed leniently: blank lines and `#` comments are ignored, and each
 * remaining line (or comma-separated entry) is one proxy URL.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ProxyPool } from './proxy.ts';

export const CONFIG_DIR = join(homedir(), 'Documents', 'Places Scraper');
export const PROXY_FILE = join(CONFIG_DIR, 'proxies.txt');

const TEMPLATE = `# Places Scraper — proxy list
#
# Without proxies, every request goes out from this computer's own IP address.
# That is fine for small runs (a city or two). For anything larger, add proxies
# here so the work is spread across many IPs and your own address is not
# rate-limited.
#
# Paste one proxy URL per line, in this format:
#
#   http://username:password@host:port
#
# Webshare (webshare.io) gives you these under Proxy > List. A single rotating
# endpoint is enough — you do not need to paste hundreds of lines.
#
# Lines starting with # are ignored. Delete these comments or leave them; either
# way, add your proxy URLs below this line.

`;

function parseProxyLines(text: string): string[] {
  return text
    // Proxy lists pasted from Windows exports carry \r; scrub before parsing.
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    // A line may itself be a comma-separated list, so flatten those too.
    .flatMap((line) => line.split(',').map((s) => s.trim()))
    .filter((entry) => /^https?:\/\//i.test(entry) || /^socks5?:\/\//i.test(entry))
    // One malformed line must not crash the whole app at boot.
    .filter((entry) => URL.canParse(entry));
}

/**
 * Write the commented template if no proxy file exists yet, so the user has
 * something to edit rather than a blank they have to format from memory.
 */
export async function ensureProxyTemplate(): Promise<void> {
  try {
    await readFile(PROXY_FILE, 'utf8');
  } catch {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(PROXY_FILE, TEMPLATE, 'utf8');
  }
}

/**
 * Overwrite the proxy file with a fresh set — e.g. pulled straight from the
 * Webshare API. Any hand edits are replaced, which is the intent: the provider
 * is now the source of truth. The dir is created if the app has never run.
 */
export async function saveProxies(urls: string[], note = 'Synced from Webshare'): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  const header =
    `# Places Scraper — proxy list\n` +
    `# ${note} on ${new Date().toISOString()}\n` +
    `# ${urls.length} proxies. This file is overwritten on the next sync.\n\n`;
  await writeFile(PROXY_FILE, header + urls.join('\n') + (urls.length ? '\n' : ''), 'utf8');
}

export interface ProxyLoadResult {
  pool: ProxyPool | null;
  /** How many proxy URLs were loaded, for surfacing in the UI. */
  count: number;
  /** Where they came from, so the UI can tell the user what's in effect. */
  source: 'file' | 'env' | 'none';
}

/**
 * Load proxies from the file, falling back to the env var, falling back to none.
 * The file wins: it is the mechanism the packaged app actually uses.
 */
export async function loadProxies(): Promise<ProxyLoadResult> {
  let urls: string[] = [];
  let source: ProxyLoadResult['source'] = 'none';

  try {
    urls = parseProxyLines(await readFile(PROXY_FILE, 'utf8'));
    if (urls.length > 0) source = 'file';
  } catch {
    // No file yet; fall through to the env var.
  }

  if (urls.length === 0) {
    const env = process.env.PROXY_URLS?.trim();
    if (env) {
      urls = parseProxyLines(env.replace(/,/g, '\n'));
      if (urls.length > 0) source = 'env';
    }
  }

  return {
    pool: urls.length > 0 ? new ProxyPool({ urls }) : null,
    count: urls.length,
    source,
  };
}
