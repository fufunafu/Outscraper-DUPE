/**
 * Google My Business categories, and matching against them.
 *
 * Google ranks and groups listings by these ~4,000 official categories, so
 * searching one ("Coffee shop") behaves very differently from searching free
 * text ("place for coffee"). The list is worth having exactly.
 *
 * Source: daltonluka.com/blog/google-my-business-categories, extracted 2026-07-16.
 */

import categories from '../data/gmb-categories.json' with { type: 'json' };

export const CATEGORIES: string[] = categories as string[];

export interface CategoryMatch {
  name: string;
  /** Higher is better. Only meaningful for ranking within one query. */
  score: number;
}

const normalise = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Pre-normalised once; the list is static and this runs on every keystroke. */
const INDEX: { name: string; norm: string; words: string[] }[] = CATEGORIES.map((name) => {
  const norm = normalise(name);
  return { name, norm, words: norm.split(' ') };
});

/**
 * Do the characters of `query` appear in `text` in order?
 *
 * This is what makes "cofsh" find "Coffee shop" and, more importantly, what
 * makes typos survive: a dropped or transposed letter still leaves an ordered
 * subsequence. Returns the span consumed, so tighter matches can score higher.
 */
function subsequenceSpan(query: string, text: string): number | null {
  let ti = 0;
  let start = -1;
  for (const char of query) {
    const found = text.indexOf(char, ti);
    if (found === -1) return null;
    if (start === -1) start = found;
    ti = found + 1;
  }
  return ti - start;
}

/**
 * Levenshtein distance, capped: we only care whether a word is *close*, and
 * bailing early keeps this cheap enough to run against 4,000 entries per keystroke.
 */
function editDistanceWithin(a: string, b: string, max: number): number | null {
  if (Math.abs(a.length - b.length) > max) return null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
      row.push(value);
      if (value < best) best = value;
    }
    // Every path through this row already exceeds the budget.
    if (best > max) return null;
    prev = row;
  }
  const distance = prev[b.length]!;
  return distance <= max ? distance : null;
}

/** Typo budget scales with word length: "gym" tolerates less than "restaurant". */
const typoBudget = (length: number): number => (length <= 4 ? 1 : length <= 7 ? 2 : 3);

/**
 * Rank categories against what the user typed.
 *
 * Scoring is ordered by how much the match implies intent: an exact name beats a
 * prefix, which beats a word-boundary hit, which beats a substring, which beats
 * a fuzzy or subsequence match. Without that ordering, typing "cafe" surfaces
 * "Internet cafe" above "Cafe", which feels broken even though both match.
 */
export function searchCategories(query: string, limit = 12): CategoryMatch[] {
  const q = normalise(query);
  if (!q) return [];

  const matches: CategoryMatch[] = [];

  for (const entry of INDEX) {
    let score = 0;

    if (entry.norm === q) {
      score = 1000;
    } else if (entry.norm.startsWith(q)) {
      // Break ties by word count before length. Brevity alone ranks "Rest stop"
      // above "Restaurant" for "rest", which is never what anyone meant: the
      // canonical categories are the single-word ones, and a compound name is a
      // narrower thing that happens to share a prefix.
      score = 800 - entry.words.length * 10 - entry.norm.length * 0.5;
    } else if (entry.words.some((word) => word.startsWith(q))) {
      score = 600 - entry.words.length * 10 - entry.norm.length * 0.5;
    } else if (entry.norm.includes(q)) {
      score = 400 - entry.words.length * 10 - entry.norm.length * 0.5;
    } else {
      // Fuzzy: allow a typo in any single word, e.g. "resturant" → "restaurant".
      const budget = typoBudget(q.length);
      let bestWord: number | null = null;
      for (const word of entry.words) {
        const distance = editDistanceWithin(q, word, budget);
        if (distance !== null && (bestWord === null || distance < bestWord)) bestWord = distance;
      }
      if (bestWord !== null) {
        score = 300 - bestWord * 40 - entry.norm.length * 0.1;
      } else if (q.length >= 4) {
        // Last resort: initials and abbreviations, e.g. "cofsh" → "coffee shop".
        const span = subsequenceSpan(q.replace(/ /g, ''), entry.norm.replace(/ /g, ''));
        if (span !== null) score = 150 - span;
      }
    }

    if (score > 0) matches.push({ name: entry.name, score });
  }

  matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return matches.slice(0, limit);
}

/** Is this exactly an official category? Free text still works, just differently. */
export function isOfficialCategory(name: string): boolean {
  const target = normalise(name);
  return INDEX.some((entry) => entry.norm === target);
}
