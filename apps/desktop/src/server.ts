/**
 * The local app server.
 *
 * Deliberately dependency-free and bound to loopback. This is a tool that runs
 * on someone's laptop, not a service: there is no auth because there is no
 * remote access, and adding either would be pretending otherwise.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

import { cancelJob, getJob, listJobs, startJob, OUTPUT_DIR, type Job } from './jobs.ts';
import { filterConflicts } from './filters.ts';
import { geocode, areaSquareKm } from '../../../packages/engine/src/geo/geocode.ts';
import { searchCategories } from '../../../packages/engine/src/categories.ts';
import { loadProxies, PROXY_FILE } from '../../../packages/engine/src/search/proxy-config.ts';
import { COUNTRIES, citySearch, toQuery, type LocationSelection } from '../../../packages/engine/src/locations.ts';

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
  for (const res of listeners) {
    res.write(`data: ${payload}\n\n`);
  }
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
    res.write(`data: ${JSON.stringify({ type: 'hello', jobs: listJobs().map(summarise) })}\n\n`);
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

export function startServer(port = 4317): Promise<string> {
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
