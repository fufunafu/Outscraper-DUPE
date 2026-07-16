import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emptyPlace } from '../schema.ts';
import { toCsv } from './csv.ts';

function placeNamed(name: string) {
  const place = emptyPlace('restaurants');
  place.name = name;
  return place;
}

describe('toCsv', () => {
  it('quotes fields containing commas, quotes, and newlines', () => {
    const csv = toCsv([placeNamed('Joe\'s "Best", Pizza\nDowntown')]);
    assert.match(csv, /"Joe's ""Best"", Pizza\nDowntown"/);
  });

  it('neutralises formula injection in business names', () => {
    // A place named like a formula executes on open in Excel/Sheets. Business
    // names are attacker-controlled, so this is a real vector, not a nicety.
    const csv = toCsv([placeNamed('=HYPERLINK("http://evil.test","click")')]);
    assert.ok(!/^=HYPERLINK/m.test(csv), 'formula must not start a cell');
    assert.match(csv, /\t=HYPERLINK/, 'should be tab-prefixed and quoted');
  });

  it('serialises nested values as JSON rather than [object Object]', () => {
    const place = emptyPlace('restaurants');
    place.working_hours = { Monday: '9AM-5PM' };
    const csv = toCsv([place]);
    assert.match(csv, /\{""Monday"":""9AM-5PM""\}/);
    assert.ok(!csv.includes('[object Object]'));
  });

  it('writes a BOM so Excel reads UTF-8 correctly', () => {
    const csv = toCsv([placeNamed('Café Münster 北京')]);
    assert.equal(csv.charCodeAt(0), 0xfeff);
    assert.match(csv, /Café Münster 北京/);
  });

  it('renders null as empty rather than the string "null"', () => {
    const csv = toCsv([placeNamed('Test')], { columns: ['name', 'phone'] });
    assert.equal(csv.trimEnd().split('\r\n')[1], 'Test,');
  });

  it('emits the header even with no rows', () => {
    const csv = toCsv([], { columns: ['name', 'phone'] });
    assert.equal(csv.trimEnd(), '﻿name,phone');
  });
});
