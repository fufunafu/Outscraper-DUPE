import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { concurrencyFor, EgressPool } from './egress.ts';

/**
 * Build a pool over N fake proxies. `create` warms nothing until asked and makes
 * no network calls to construct, so these tests are fully offline: they exercise
 * the pacing, health, and backoff logic, not real requests.
 */
function pool(n: number) {
  const urls = Array.from({ length: n }, (_, i) => `http://user:pass@10.0.0.${i}:8000`);
  // A minimal ProxyPool stand-in: EgressPool only calls size and next().
  let next = 0;
  const fake = {
    size: n,
    next: () => ({ dispatch: () => {} }) as unknown,
    close: async () => {},
  } as unknown as import('./proxy.ts').ProxyPool;
  void urls;
  void next;
  return EgressPool.create(fake, 'en', 'UA', { baseIntervalMs: 50, cooldownMs: 200, failureThreshold: 3 });
}

describe('EgressPool pacing', () => {
  it('spreads requests across distinct egresses before repeating', async () => {
    const p = pool(4);
    const seen = new Set<unknown>();
    for (let i = 0; i < 4; i++) seen.add(await p.acquire());
    // Four acquires with four IPs should hit four distinct egresses.
    assert.equal(seen.size, 4, 'load should spread across all IPs');
  });

  it('paces a single egress: consecutive acquires are spaced apart', async () => {
    const p = pool(1);
    const t0 = performance.now();
    await p.acquire();
    await p.acquire(); // must wait ~baseInterval since only one IP exists
    const elapsed = performance.now() - t0;
    // Jitter is 0.5x–1.5x of the 50ms base, so the delay floor is ~25ms; a
    // non-paced second acquire would be ~0ms. 20ms proves pacing without
    // being brittle to the random jitter.
    assert.ok(elapsed >= 20, `expected a pacing delay, only ${elapsed.toFixed(0)}ms elapsed`);
  });
});

describe('EgressPool health', () => {
  it('benches an egress after repeated failures and stops handing it out', async () => {
    const p = pool(2);
    const bad = await p.acquire();
    // Three failures (the threshold) should bench this egress.
    for (let i = 0; i < 3; i++) p.reportFailure(bad, { pushback: false });
    assert.equal(p.benched, 1, 'the failing egress should be benched');

    // The remaining acquires should avoid the benched one.
    for (let i = 0; i < 5; i++) {
      const e = await p.acquire();
      assert.notEqual(e, bad, 'a benched egress must not be handed out');
    }
  });

  it('waits for recovery when every egress is benched, rather than failing', async () => {
    const p = pool(1);
    const only = await p.acquire();
    for (let i = 0; i < 3; i++) p.reportFailure(only, { pushback: false });
    assert.equal(p.benched, 1);
    // With cooldownMs=200, acquire should block then succeed once it lifts.
    const t0 = performance.now();
    const recovered = await p.acquire();
    assert.ok(performance.now() - t0 >= 150, 'should have waited for cooldown');
    assert.equal(recovered, only, 'the recovered egress comes back into rotation');
  });
});

describe('EgressPool backoff', () => {
  it('widens on pushback and eases on success', () => {
    const p = pool(3);
    const start = p.backoff;
    assert.equal(start, 1);
    const e = { session: null, dispatcher: null } as never;
    p.reportFailure(e, { pushback: true });
    assert.ok(p.backoff > start, 'pushback should widen backoff');
    const widened = p.backoff;
    for (let i = 0; i < 20; i++) p.reportSuccess(e);
    assert.ok(p.backoff < widened, 'sustained success should ease backoff');
    assert.ok(p.backoff >= 1, 'backoff never drops below 1');
  });

  it('caps backoff so it cannot grow without bound', () => {
    const p = pool(3);
    const e = { session: null, dispatcher: null } as never;
    for (let i = 0; i < 100; i++) p.reportFailure(e, { pushback: true });
    assert.ok(p.backoff <= 8, `backoff should be capped, got ${p.backoff}`);
  });
});

describe('concurrencyFor', () => {
  it('scales with pool size but stays bounded', () => {
    assert.equal(concurrencyFor(1), 3, 'direct stays gentle');
    assert.ok(concurrencyFor(10) > concurrencyFor(1));
    assert.ok(concurrencyFor(250) > concurrencyFor(50));
    assert.ok(concurrencyFor(100_000) <= 256, 'capped where the machine, not IPs, is the limit');
  });
});
