import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toXlsx } from './xlsx.ts';

describe('toXlsx', () => {
  it('produces a valid zip that a real unzip verifies', () => {
    const buf = toXlsx(
      [
        { name: 'Acme Glass & Sons', email: 'info@acme.com', reviews: 120 },
        { name: 'Björk <Windows>', email: null, reviews: 4.5 },
      ],
      ['name', 'email', 'reviews'],
    );
    const path = join(tmpdir(), `xlsx-test-${process.pid}.xlsx`);
    try {
      writeFileSync(path, buf);
      // `unzip -t` validates every CRC and the central directory — if the zip
      // structure or a checksum is wrong, this throws.
      execFileSync('unzip', ['-t', path], { stdio: 'pipe' });
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('escapes XML and keeps numbers numeric', () => {
    const buf = toXlsx([{ a: '<b>&"quote"', n: 42 }], ['a', 'n']).toString('latin1');
    assert.ok(buf.includes('&lt;b&gt;&amp;&quot;quote&quot;'), 'strings are XML-escaped');
    assert.ok(buf.includes('<c><v>42</v></c>'), 'numbers are numeric cells');
    assert.ok(!buf.includes('<b>&"'), 'raw markup never leaks into the sheet');
  });
});
