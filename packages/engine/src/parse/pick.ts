/**
 * Safe access into Google's response arrays.
 *
 * The payload is a deeply nested, sparse array with no schema and no field
 * names — position is the only identifier. Any given index may be absent, null,
 * or hold a different type than it did last month, so every read goes through
 * these helpers and yields null rather than throwing. A parse that throws on one
 * odd listing would take down the whole cell.
 */

export function pick(root: unknown, ...path: (number | string)[]): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (node === null || node === undefined) return null;
    if (typeof node !== 'object') return null;
    node = (node as Record<string | number, unknown>)[key];
  }
  return node ?? null;
}

export function pickString(root: unknown, ...path: (number | string)[]): string | null {
  const value = pick(root, ...path);
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number') return String(value);
  return null;
}

export function pickNumber(root: unknown, ...path: (number | string)[]): number | null {
  const value = pick(root, ...path);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // Some numeric fields arrive as strings, and locales may use a decimal comma.
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function pickBool(root: unknown, ...path: (number | string)[]): boolean | null {
  const value = pick(root, ...path);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return null;
}

export function pickArray(root: unknown, ...path: (number | string)[]): unknown[] | null {
  const value = pick(root, ...path);
  return Array.isArray(value) ? value : null;
}

/**
 * Read the first path that yields a value.
 *
 * Google relocates fields without notice — opening hours moved from [34][1] to
 * [203][0] in late 2025 — and both layouts can be served concurrently during a
 * rollout. Listing paths newest-first keeps old and new responses both parsing.
 */
export function pickFirst<T>(
  read: (root: unknown, ...path: (number | string)[]) => T | null,
  root: unknown,
  paths: (number | string)[][],
): T | null {
  for (const path of paths) {
    const value = read(root, ...path);
    if (value !== null) return value;
  }
  return null;
}

/** Google wraps outbound links in a redirect; unwrap to the real destination. */
export function unwrapUrl(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith('http')) return null;
  try {
    const url = new URL(raw);
    if (url.hostname.endsWith('google.com') && url.pathname === '/url') {
      return url.searchParams.get('q') ?? url.searchParams.get('url') ?? raw;
    }
    return raw;
  } catch {
    return null;
  }
}
