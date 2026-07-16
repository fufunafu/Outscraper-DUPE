/**
 * CSV export, column-compatible with Outscraper's own.
 *
 * Written by hand rather than pulled from a dependency: the format is small,
 * and a zero-dependency engine is what lets the whole thing ship as a single
 * double-clickable app with no install step.
 */

import { PLACE_COLUMNS, type EnrichedPlace, type Place } from '../schema.ts';

/**
 * RFC 4180 quoting. Fields containing a comma, quote, or newline get wrapped,
 * and embedded quotes are doubled.
 *
 * The leading-character check guards against CSV injection: a cell starting
 * with =, +, -, or @ is executed as a formula when the file is opened in Excel
 * or Sheets, and business names are attacker-controlled text. Prefixing with a
 * tab neutralises it while still displaying the original string.
 */
function escapeCell(value: string): string {
  const dangerous = /^[=+\-@\t\r]/.test(value);
  const body = dangerous ? `\t${value}` : value;
  if (/[",\n\r]/.test(body)) {
    return `"${body.replace(/"/g, '""')}"`;
  }
  return body;
}

/** Flatten a value into something a spreadsheet cell can hold. */
function toCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  // Nested structures — working_hours, about, reviews_per_score — round-trip as
  // JSON rather than being flattened lossily into columns.
  return JSON.stringify(value);
}

export interface CsvOptions {
  /** Restrict and order the output columns. Defaults to the full schema. */
  columns?: string[];
  /** Extra columns appended after the standard ones, e.g. enrichment fields. */
  extraColumns?: string[];
}

export function toCsv(places: EnrichedPlace[], options: CsvOptions = {}): string {
  const columns = options.columns ?? [...PLACE_COLUMNS, ...(options.extraColumns ?? [])];

  const lines: string[] = [columns.map((c) => escapeCell(c)).join(',')];
  for (const place of places) {
    const row = columns.map((column) => escapeCell(toCell((place as unknown as Record<string, unknown>)[column])));
    lines.push(row.join(','));
  }

  // Excel needs a BOM to read UTF-8 correctly, and place names are full of
  // accents and non-Latin scripts.
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Only the columns that any row actually populated — keeps exports readable. */
export function usedColumns(places: Place[]): string[] {
  const used = new Set<string>();
  for (const place of places) {
    for (const [key, value] of Object.entries(place)) {
      if (value !== null && value !== undefined && value !== '') used.add(key);
    }
  }
  return PLACE_COLUMNS.filter((column) => used.has(column));
}
