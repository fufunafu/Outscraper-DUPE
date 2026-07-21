/**
 * Webshare API client: pull the proxy list and request on-demand refreshes
 * straight from the provider, so the user never has to hand-download a file.
 *
 * Auth is the account's API token (Webshare dashboard → API). Every call here
 * goes directly to Webshare over the machine's own connection — never through
 * the scraping proxies — so even a fully worn pool can still be refreshed.
 */

const API = 'https://proxy.webshare.io/api/v2';

/** One proxy as Webshare returns it; only the fields we use are typed. */
interface WebshareProxy {
  proxy_address: string;
  port: number;
  username: string;
  password: string;
  valid: boolean;
}

export interface WebsharePlanInfo {
  /** On-demand refreshes left this billing period (they reset monthly, no rollover). */
  onDemandAvailable: number | null;
  onDemandTotal: number | null;
  onDemandUsed: number | null;
  /** ISO timestamp of the next free automatic refresh, if the plan schedules one. */
  autoRefreshNextAt: string | null;
  /** Seconds between automatic refreshes; 0/null means none. */
  autoRefreshEverySec: number | null;
}

const authHeaders = (token: string) => ({ Authorization: `Token ${token}` });

async function apiError(res: Response, fallback: string): Promise<Error> {
  if (res.status === 401 || res.status === 403) {
    return new Error('Webshare rejected the API token. Check it in Webshare → API.');
  }
  let detail = '';
  try {
    const body = (await res.json()) as { detail?: string };
    detail = body?.detail ?? '';
  } catch {
    /* non-JSON error body */
  }
  return new Error(detail || `${fallback} (HTTP ${res.status}).`);
}

/**
 * Pull every proxy on the account as ready-to-use `http://user:pass@host:port`
 * URLs — the exact shape proxies.txt already expects. Invalid proxies are
 * dropped. Paginates through the whole list.
 */
export async function fetchWebshareProxies(token: string): Promise<string[]> {
  const lines: string[] = [];
  let next: string | null = `${API}/proxy/list/?mode=direct&page=1&page_size=100`;
  let guard = 0;
  while (next && guard++ < 500) {
    const res: Response = await fetch(next, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw await apiError(res, 'Could not list proxies');
    const body = (await res.json()) as { next: string | null; results: WebshareProxy[] };
    for (const p of body.results) {
      if (p.valid === false) continue;
      lines.push(`http://${p.username}:${p.password}@${p.proxy_address}:${p.port}`);
    }
    next = body.next;
  }
  return lines;
}

/**
 * Ask Webshare to replace the entire proxy list with a fresh set. Consumes one
 * on-demand refresh from the monthly quota; the new IPs are provisioned a few
 * seconds later, so callers should pause before re-pulling.
 */
export async function refreshWebshareList(token: string): Promise<void> {
  const res = await fetch(`${API}/proxy/list/refresh/`, {
    method: 'POST',
    headers: authHeaders(token),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 204 || res.ok) return;
  throw await apiError(res, "Refresh was refused — you may be out of this month's on-demand refreshes");
}

/**
 * Best-effort read of the refresh quota and auto-refresh schedule. Returns null
 * if the endpoint shape differs or the call fails: the quota display is a
 * nicety, and syncing/refreshing must still work without it.
 */
export async function websharePlan(token: string): Promise<WebsharePlanInfo | null> {
  try {
    const res = await fetch(`${API}/subscription/plan/`, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown> | Record<string, unknown>[];
    // The endpoint may return a single plan or a paginated list of them.
    const plan = (Array.isArray(body)
      ? body[0]
      : ((body as { results?: Record<string, unknown>[] }).results?.[0] ?? body)) as
      | Record<string, unknown>
      | undefined;
    if (!plan) return null;
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    return {
      onDemandAvailable: num(plan.on_demand_refreshes_available),
      onDemandTotal: num(plan.on_demand_refreshes_total),
      onDemandUsed: num(plan.on_demand_refreshes_used),
      autoRefreshNextAt: str(plan.automatic_refresh_next_at),
      autoRefreshEverySec: num(plan.automatic_refresh_frequency),
    };
  } catch {
    return null;
  }
}
