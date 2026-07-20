/**
 * The local app server.
 *
 * Deliberately dependency-free and bound to loopback. This is a tool that runs
 * on someone's laptop, not a service: there is no auth because there is no
 * remote access, and adding either would be pretending otherwise.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';

import { cancelJob, getJob, listJobs, startJob, OUTPUT_DIR, type Job } from './jobs.ts';
import { filterConflicts } from './filters.ts';
import { geocode, areaSquareKm } from '../../../packages/engine/src/geo/geocode.ts';
import { searchCategories } from '../../../packages/engine/src/categories.ts';
import { loadProxies, PROXY_FILE } from '../../../packages/engine/src/search/proxy-config.ts';
import { COUNTRIES, citySearch, toQuery, type LocationSelection } from '../../../packages/engine/src/locations.ts';
import { verticalNames, verticalTerms } from '../../../packages/engine/src/verticals.ts';
import {
  startExtraction, cancelExtraction, listExtractions, openDatabase, exportDatabase, exportLeads,
  type Extraction,
} from './extraction.ts';
import {
  startAutoEnrichment, pauseEnrichment, resumeEnrichment, getEnrichment,
  type EnrichmentState,
} from './enrichment.ts';
import { livePools, startProxyCheck, getProxyCheck, type ProxyCheck } from './health.ts';
import {
  startCoverage, cancelCoverage, getCoverageRun, resumeCampaignIfAny, type CoverageRun,
} from './coverage.ts';
import { startBackups, getBackupInfo } from './backup.ts';
import type { PlaceQuery } from '../../../packages/engine/src/store/database.ts';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** Clients listening for job updates, so progress streams instead of being polled. */
const listeners = new Set<ServerResponse>();

function broadcast(job: Job): void {
  const payload = JSON.stringify({ type: 'job', job: summarise(job) });
  for (const res of listeners) res.write(`data: ${payload}\n\n`);
}

function broadcastExtraction(extraction: Extraction): void {
  const payload = JSON.stringify({ type: 'extraction', extraction });
  for (const res of listeners) res.write(`data: ${payload}\n\n`);
}

function broadcastEnrichment(state: EnrichmentState): void {
  const payload = JSON.stringify({ type: 'enrichment', enrichment: state });
  for (const res of listeners) res.write(`data: ${payload}\n\n`);
}

function broadcastCoverage(run: CoverageRun): void {
  const payload = JSON.stringify({ type: 'coverage', coverage: run });
  for (const res of listeners) res.write(`data: ${payload}\n\n`);
}

function broadcastHealth(check: ProxyCheck): void {
  const payload = JSON.stringify({ type: 'health', check });
  for (const res of listeners) res.write(`data: ${payload}\n\n`);
}

/**
 * The wire shape of a job. Places are omitted deliberately — a finished sweep is
 * tens of thousands of rows, and pushing them through an event stream on every
 * progress tick would swamp the UI for no benefit.
 */
function summarise(job: Job) {
  return {
    id: job.id,
    request: job.request,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    legs: job.legs,
    progress: job.progress,
    filtered: job.filtered,
    error: job.error,
    csvPath: job.csvPath,
    total: job.places.length,
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A request body here is a small JSON form; anything larger is a mistake.
    if (size > 1_000_000) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const requested = urlPath === '/' ? '/index.html' : urlPath;
  // Resolve against the UI dir and confirm we stayed inside it, so a crafted
  // path can't read arbitrary files off the user's disk.
  const target = join(UI_DIR, normalize(requested));
  if (!target.startsWith(UI_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

/** Reveal a file in Finder — the natural "where did my export go" affordance. */
function revealInFinder(path: string): void {
  if (process.platform === 'darwin') exec(`open -R ${JSON.stringify(path)}`);
  else if (process.platform === 'win32') exec(`explorer /select,${JSON.stringify(path)}`);
  else exec(`xdg-open ${JSON.stringify(dirname(path))}`);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({
      type: 'hello',
      jobs: listJobs().map(summarise),
      extractions: listExtractions(),
      enrichment: getEnrichment(),
      coverage: getCoverageRun(),
    })}\n\n`);
    listeners.add(res);
    req.on('close', () => listeners.delete(res));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/proxies') {
    const { count, source } = await loadProxies();
    return json(res, 200, { count, source, file: PROXY_FILE });
  }

  if (req.method === 'POST' && url.pathname === '/api/proxies/open') {
    // Open the proxy file so the user can paste their Webshare URL into it.
    revealInFinder(PROXY_FILE);
    return json(res, 200, { ok: true });
  }

  // --- Verticals & database extraction ---
  if (req.method === 'GET' && url.pathname === '/api/verticals') {
    return json(res, 200, verticalNames().map((name) => ({ name, terms: verticalTerms(name).length })));
  }

  if (req.method === 'POST' && url.pathname === '/api/extractions') {
    const body = (await readBody(req)) as { vertical?: string; location?: LocationSelection; language?: string };
    if (!body.vertical || !body.location?.country || !body.location?.region) {
      return json(res, 400, { error: 'Pick a vertical and a province/state.' });
    }
    const extraction = startExtraction(
      { vertical: body.vertical, location: body.location, language: body.language === 'fr' ? 'fr' : 'en' },
      broadcastExtraction,
    );
    return json(res, 202, extraction);
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/extractions/') && url.pathname.endsWith('/cancel')) {
    const id = url.pathname.split('/')[3]!;
    const cancelled = cancelExtraction(id);
    return json(res, cancelled ? 200 : 404, { cancelled });
  }

  if (req.method === 'GET' && url.pathname === '/api/database/stats') {
    const db = openDatabase();
    try {
      return json(res, 200, {
        count: db.count,
        contact: db.contactStats(),
        // Return every distinct value: the UI's Category/City fields are
        // searchable comboboxes, so a top-N cap would silently hide the long
        // tail (e.g. "Railing contractor", ranked ~95th) that a user can type.
        categories: db.facet('category'),
        cities: db.cityStateFacet(),
        states: db.facet('state'),
      });
    } finally {
      db.close();
    }
  }

  // The coverage board: for each vertical, every target region (all of Canada +
  // USA) with its completed pass count — what the progress bars are drawn from.
  if (req.method === 'GET' && url.pathname === '/api/database/coverage') {
    const db = openDatabase();
    try {
      const passes = new Map(db.coverage().map((c) => [`${c.vertical}|${c.region}`, c.passes]));
      const runningKeys = new Set(
        listExtractions()
          .filter((e) => e.status === 'running' || e.status === 'starting')
          .map((e) => `${e.request.vertical}|${e.request.location.country}/${e.request.location.region}`),
      );
      const verticals = verticalNames().map((name) => {
        const regions = Object.entries(COUNTRIES).flatMap(([cc, country]) =>
          country.regions.map((r) => ({
            country: cc,
            code: r.code,
            name: r.name,
            passes: passes.get(`${name}|${cc}/${r.code}`) ?? 0,
            running: runningKeys.has(`${name}|${cc}/${r.code}`),
          })),
        );
        return {
          name,
          regions,
          covered: regions.filter((r) => r.passes > 0).length,
          total: regions.length,
        };
      });
      return json(res, 200, { verticals, contact: db.contactStats(), auto: getCoverageRun() });
    } finally {
      db.close();
    }
  }

  // Map points for the current filter — same query language as the table view.
  if (req.method === 'POST' && url.pathname === '/api/database/geo') {
    const filter = (await readBody(req)) as PlaceQuery;
    const db = openDatabase();
    try {
      const limit = 30_000;
      const points = db.geo(filter, limit);
      const total = db.countWhere(filter);
      return json(res, 200, { points, total, truncated: total > points.length });
    } finally {
      db.close();
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/database/enrich/pause') {
    return json(res, 200, pauseEnrichment());
  }

  if (req.method === 'POST' && url.pathname === '/api/database/enrich/resume') {
    return json(res, 200, resumeEnrichment());
  }

  if (req.method === 'POST' && url.pathname === '/api/coverage/run') {
    const body = (await readBody(req)) as { vertical?: string; language?: string };
    if (!body.vertical) return json(res, 400, { error: 'Pick a vertical.' });
    try {
      const run = startCoverage(
        body.vertical,
        body.language === 'fr' ? 'fr' : 'en',
        broadcastExtraction,
        broadcastCoverage,
      );
      return json(res, 202, run);
    } catch (error) {
      return json(res, 409, { error: (error as Error).message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/coverage/cancel') {
    return json(res, 200, { cancelled: cancelCoverage() });
  }

  // --- Proxy health ---
  if (req.method === 'GET' && url.pathname === '/api/health') {
    const { count, source } = await loadProxies();
    return json(res, 200, {
      proxies: count, source, pools: livePools(), check: getProxyCheck(), backup: getBackupInfo(),
      remote: remote ? { enabled: true, url: remote.url } : { enabled: false },
    });
  }

  // Lets the double-clickable app offer a real Quit; harmless from a browser.
  if (req.method === 'POST' && url.pathname === '/api/shutdown') {
    json(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 300);
    return;
  }

  // --- Remote access (opt-in) ---
  if (req.method === 'POST' && url.pathname === '/api/remote/enable') {
    try {
      return json(res, 200, await enableRemote());
    } catch (error) {
      return json(res, 500, { error: (error as Error).message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/remote/disable') {
    disableRemote();
    return json(res, 200, { enabled: false });
  }

  if (req.method === 'POST' && url.pathname === '/api/health/check') {
    return json(res, 202, startProxyCheck(broadcastHealth));
  }

  if (req.method === 'POST' && url.pathname === '/api/database/query') {
    const filter = (await readBody(req)) as PlaceQuery;
    const db = openDatabase();
    try {
      const places = db.query({ ...filter, limit: Math.min(filter.limit ?? 200, 500) });
      return json(res, 200, { places, count: db.count, matched: db.countWhere(filter) });
    } finally {
      db.close();
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/database/export-leads') {
    const body = (await readBody(req)) as { filter?: PlaceQuery; label?: string };
    const { path, rows, dropped } = await exportLeads(body.filter ?? {}, body.label ?? 'leads');
    return json(res, 200, { path, rows, dropped });
  }

  if (req.method === 'POST' && url.pathname === '/api/database/export') {
    const body = (await readBody(req)) as { filter?: PlaceQuery; label?: string };
    // No row cap on export: unlike the on-screen preview, a CSV should be complete.
    const { path, rows } = await exportDatabase(body.filter ?? {}, body.label ?? 'places-export');
    return json(res, 200, { path, rows });
  }

  if (req.method === 'GET' && url.pathname === '/api/categories') {
    const query = url.searchParams.get('q')?.trim() ?? '';
    return json(res, 200, searchCategories(query, 12).map((m) => m.name));
  }

  // The whole country → region → city tree, sent once and filtered client-side:
  // it is ~325 KB and every keystroke would otherwise be a round trip.
  if (req.method === 'GET' && url.pathname === '/api/countries') {
    return json(res, 200, COUNTRIES);
  }

  if (req.method === 'GET' && url.pathname === '/api/cities') {
    const country = url.searchParams.get('country') ?? '';
    const query = url.searchParams.get('q') ?? '';
    return json(res, 200, citySearch(country, query, 8));
  }

  // Resolve a selection to a real region so the UI can show its size before
  // someone commits to sweeping it.
  if (req.method === 'GET' && url.pathname === '/api/resolve') {
    const country = url.searchParams.get('country') ?? '';
    const region = url.searchParams.get('region') ?? '';
    const city = url.searchParams.get('city') ?? undefined;
    if (!country || !region) return json(res, 400, { error: 'country and region required' });
    try {
      const query = toQuery({ country, region, city });
      const matches = await geocode(query, 1);
      const first = matches[0];
      return json(res, 200, first
        ? { query, displayName: first.displayName, areaKm2: Math.round(areaSquareKm(first.box)) }
        : { query, displayName: null, areaKm2: null });
    } catch (error) {
      return json(res, 502, { error: (error as Error).message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/jobs') {
    const body = (await readBody(req)) as Record<string, unknown>;
    const queries = Array.isArray(body.queries)
      ? body.queries.map((q) => String(q).trim()).filter(Boolean)
      : [];
    const locations = Array.isArray(body.locations) ? (body.locations as LocationSelection[]) : [];

    if (queries.length === 0) return json(res, 400, { error: 'Pick at least one category.' });
    if (locations.length === 0) return json(res, 400, { error: 'Pick at least one location.' });

    const filters = (body.filters ?? {}) as Record<string, unknown>;
    const conflicts = filterConflicts(filters);
    if (conflicts.length > 0) return json(res, 400, { error: conflicts.join(' ') });

    const job = startJob(
      {
        queries,
        locations,
        limit: typeof body.limit === 'number' && body.limit > 0 ? body.limit : undefined,
        filters,
        language: body.language === 'fr' ? 'fr' : 'en',
        enrich: body.enrich === true,
      },
      broadcast,
    );
    return json(res, 202, summarise(job));
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/jobs/') && url.pathname.endsWith('/cancel')) {
    const id = url.pathname.split('/')[3]!;
    const cancelled = cancelJob(id);
    return json(res, cancelled ? 200 : 404, { cancelled });
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/') && url.pathname.endsWith('/preview')) {
    const job = getJob(url.pathname.split('/')[3]!);
    if (!job) return json(res, 404, { error: 'no such job' });
    // Enough rows to judge the data, not enough to choke the browser.
    return json(res, 200, { total: job.places.length, places: job.places.slice(0, 200) });
  }

  if (req.method === 'POST' && url.pathname === '/api/reveal') {
    const body = (await readBody(req)) as { path?: string };
    // Only ever reveal files this app wrote, so a stray request can't open
    // arbitrary paths on the user's machine.
    if (!body.path || !normalize(body.path).startsWith(OUTPUT_DIR)) {
      return json(res, 400, { error: 'path outside output directory' });
    }
    revealInFinder(body.path);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET') return serveStatic(res, url.pathname);
  res.writeHead(405).end('Method not allowed');
}

// --- Remote access -------------------------------------------------------------
//
// The main server binds loopback only, on purpose. Remote access is a second,
// explicitly-enabled listener on all interfaces, gated by a random key: the
// first visit needs ?key=… in the URL (which sets a cookie), and every request
// without the cookie is refused. Meant for a trusted LAN or a Tailscale
// network — the UI says so — not for exposure to the open internet.

const REMOTE_PORT = 4318;
let remote: { server: Server; url: string; key: string } | null = null;

function lanAddress(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}

async function enableRemote(): Promise<{ enabled: true; url: string }> {
  if (remote) return { enabled: true, url: remote.url };

  // A stable key, so the link colleagues saved keeps working across restarts.
  const db = openDatabase();
  let key: string;
  try {
    key = db.getSetting('remoteKey') ?? randomBytes(6).toString('hex');
    db.setSetting('remoteKey', key);
    // Deliberately enabled — stay enabled across restarts until disabled.
    db.setSetting('remoteEnabled', '1');
  } finally {
    db.close();
  }

  const gate = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cookieKey = /(?:^|;\s*)psk=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (url.searchParams.get('key') === key) {
      // Key in the URL: set the cookie and redirect to a clean address, so the
      // secret doesn't linger in the location bar or get copy-pasted around.
      url.searchParams.delete('key');
      res.writeHead(302, {
        'Set-Cookie': `psk=${key}; Path=/; HttpOnly; SameSite=Lax`,
        Location: url.pathname + url.search,
      });
      res.end();
      return;
    }
    if (cookieKey !== key) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Places Scraper: open the invite link (with its key) first.');
      return;
    }
    handle(req, res).catch((error) => {
      if (!res.headersSent) json(res, 500, { error: (error as Error).message });
      else res.end();
    });
  };

  const server = createServer(gate);
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(REMOTE_PORT, '0.0.0.0', () => resolve());
  });
  remote = { server, key, url: `http://${lanAddress()}:${REMOTE_PORT}/?key=${key}` };
  return { enabled: true, url: remote.url };
}

function disableRemote(): void {
  remote?.server.close();
  remote = null;
  const db = openDatabase();
  try {
    db.deleteSetting('remoteEnabled');
  } finally {
    db.close();
  }
}

export function startServer(port = 4317): Promise<string> {
  // The email finder lives for as long as the app does — no button, no opt-in.
  startAutoEnrichment(broadcastEnrichment);
  // Dated snapshots of the database: shortly after boot, then daily.
  startBackups();
  // A campaign interrupted by a crash or reboot continues by itself. Delayed a
  // few seconds so the server is reachable before heavy work spins up.
  setTimeout(() => resumeCampaignIfAny(broadcastExtraction, broadcastCoverage), 5_000).unref();
  // Remote access was a deliberate choice; restore it after a restart so the
  // link on someone's phone doesn't silently die.
  setTimeout(() => {
    const db = openDatabase();
    let wanted = false;
    try {
      wanted = db.getSetting('remoteEnabled') === '1';
    } finally {
      db.close();
    }
    if (wanted) void enableRemote().catch(() => undefined);
  }, 2_000).unref();

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) json(res, 500, { error: (error as Error).message });
      else res.end();
    });
  });

  // Loopback only. This process can reach Google and read the user's disk;
  // binding it to a routable interface would expose both to the local network.
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${port}`));
  });
}
