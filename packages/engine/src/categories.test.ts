import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CATEGORIES, searchCategories, isOfficialCategory } from './categories.ts';

const names = (query: string, limit = 12) => searchCategories(query, limit).map((m) => m.name);

describe('searchCategories', () => {
  it('has the real category list loaded', () => {
    assert.ok(CATEGORIES.length > 3500, `expected ~4000 categories, got ${CATEGORIES.length}`);
    assert.ok(isOfficialCategory('Restaurant'));
    assert.ok(isOfficialCategory('coffee shop'), 'matching should ignore case');
    assert.ok(!isOfficialCategory('not a real category'));
  });

  it('ranks the exact category first, not a longer one containing it', () => {
    // The failure this guards: typing "cafe" and getting "Internet cafe" on top.
    assert.equal(names('cafe')[0], 'Cafe');
    assert.equal(names('restaurant')[0], 'Restaurant');
    assert.equal(names('dentist')[0], 'Dentist');
  });

  it('prefers the canonical single-word category on a partial prefix', () => {
    // "rest" used to surface "Rest stop" over "Restaurant" because it is two
    // characters shorter. Word count is the better tiebreak.
    assert.equal(names('rest')[0], 'Restaurant');
    assert.equal(names('dent')[0], 'Dentist');
    assert.equal(names('plumb')[0], 'Plumber');
    assert.equal(names('gym')[0], 'Gym');
  });

  it('matches on a prefix as you type', () => {
    assert.ok(names('denti').includes('Dentist'));
    assert.ok(names('plumb').includes('Plumber'));
  });

  it('matches a word inside a multi-word category', () => {
    // "pizza" should reach "Pizza restaurant" even though it isn't the prefix.
    assert.ok(names('pizza', 20).some((n) => n.includes('Pizza')));
  });

  it('survives typos', () => {
    assert.ok(names('resturant', 20).includes('Restaurant'), 'dropped letter');
    assert.ok(names('dentst', 20).includes('Dentist'), 'dropped letter');
    assert.ok(names('plummer', 20).includes('Plumber'), 'wrong letter');
  });

  it('matches abbreviations by subsequence', () => {
    assert.ok(names('cofshop', 20).some((n) => n.toLowerCase().includes('coffee')));
  });

  it('returns nothing for an empty query rather than everything', () => {
    assert.deepEqual(searchCategories(''), []);
    assert.deepEqual(searchCategories('   '), []);
  });

  it('respects the limit', () => {
    assert.ok(searchCategories('a', 5).length <= 5);
  });

  it('stays fast enough to run on every keystroke', () => {
    const started = performance.now();
    for (const q of ['r', 're', 'res', 'rest', 'resta', 'restur', 'resturant']) searchCategories(q);
    const perKeystroke = (performance.now() - started) / 7;
    assert.ok(perKeystroke < 50, `${perKeystroke.toFixed(1)}ms per keystroke is too slow`);
  });
});
