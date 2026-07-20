/**
 * Automatic database backups.
 *
 * The entire asset — weeks of scraping, the proxy spend, every found email —
 * is one SQLite file on one disk. This module quietly keeps dated snapshots
 * beside it: one shortly after every launch, then daily, pruned to the last
 * seven. Snapshots use VACUUM INTO, which reads a consistent point-in-time
 * image, so a backup taken mid-scrape is still a valid database.
 *
 * Restoring is deliberately manual and obvious: quit the app, copy a snapshot
 * from `backups/` over `places.db`, relaunch.
 */

import { mkdirSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { PlaceDatabase } from '../../../packages/engine/src/store/database.ts';
import { OUTPUT_DIR } from './jobs.ts';
import { DATABASE_PATH } from './extraction.ts';

export const BACKUP_DIR = join(OUTPUT_DIR, 'backups');

const KEEP = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Wait for launch to settle before the first snapshot. */
const BOOT_DELAY_MS = 60_000;

export interface BackupInfo {
  lastAt: number | null;
  lastPath: string | null;
  count: number;
  error?: string;
}

const info: BackupInfo = { lastAt: null, lastPath: null, count: 0 };
let started = false;

export const getBackupInfo = (): BackupInfo => info;

const stamp = (at: Date) => at.toISOString().slice(0, 10);

function runBackup(): void {
  try {
    if (!existsSync(DATABASE_PATH)) return; // nothing to protect yet
    mkdirSync(BACKUP_DIR, { recursive: true });
    const target = join(BACKUP_DIR, `places-${stamp(new Date())}.db`);

    // One snapshot per calendar day is plenty; re-running on the same day
    // (a second launch) is a no-op rather than churning gigabytes.
    if (!existsSync(target)) {
      const db = new PlaceDatabase(DATABASE_PATH);
      try {
        db.backupTo(target);
      } finally {
        db.close();
      }
    }

    // Prune to the newest KEEP snapshots.
    const snapshots = readdirSync(BACKUP_DIR)
      .filter((f) => /^places-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort()
      .reverse();
    for (const old of snapshots.slice(KEEP)) rmSync(join(BACKUP_DIR, old), { force: true });

    info.count = Math.min(snapshots.length, KEEP);
    info.lastPath = target;
    info.lastAt = statSync(target).mtimeMs;
    delete info.error;
  } catch (error) {
    // A failed backup must never disturb the app; surface it on the health page.
    info.error = (error as Error).message;
  }
}

/** Start the backup schedule: once after boot, then daily. Idempotent. */
export function startBackups(): void {
  if (started) return;
  started = true;
  setTimeout(runBackup, BOOT_DELAY_MS).unref();
  setInterval(runBackup, DAY_MS).unref();
}
