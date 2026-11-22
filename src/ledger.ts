import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Entry, Ledger } from './types.ts';

export const COLD_AFTER = 30 * 24 * 60 * 60 * 1000;
const LIMIT = 600;
const REFRESH_INTERVAL = 10_000;
const LOCK_GRACE = 30_000;
const ownerName = /^(\d+)-[a-f0-9-]{36}$/;

const emptyLedger = (): Ledger => ({ version: 1, entries: [] });

export function isHot(entry: Entry, now: number): boolean {
  return entry.state !== 'archived' && now - (entry.lastHitAt ?? entry.verifiedAt) < COLD_AFTER;
}

export interface LedgerStore {
  snapshot(): Ledger;
  refresh(force?: boolean): Promise<void>;
  update(change: (ledger: Ledger) => boolean): Promise<void>;
}

export function memoryLedger(): LedgerStore {
  let stored: Ledger = { version: 1, entries: [] };
  return {
    snapshot: () => stored,
    refresh: async () => {},
    async update(change) {
      const draft = structuredClone(stored);
      if (change(draft)) stored = draft;
    },
  };
}

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === code;

class DamagedLedger extends Error {}

const strings = (value: unknown, max: number): value is string[] =>
  Array.isArray(value) && value.length <= max && value.every((item) => typeof item === 'string');
const validRecipe = (recipe: Entry['verified_fix']['recipe'] | undefined): boolean =>
  !!recipe && typeof recipe.input === 'string' && typeof recipe.key === 'string' &&
  typeof recipe.task === 'string' && ['shell', 'arguments'].includes(recipe.shape);

function validEntry(entry: Entry): boolean {
  if (!entry || !entry.context || !entry.rationale || !Array.isArray(entry.failed_attempts) ||
      !Array.isArray(entry.modelEvidence) || !validRecipe(entry.verified_fix?.recipe)) return false;
  const { context, rationale } = entry;
  return entry.failed_attempts.length >= 1 && entry.failed_attempts.length <= 3 &&
    entry.failed_attempts.every((attempt) => !!attempt && validRecipe(attempt.recipe) && typeof attempt.model_id === 'string' &&
      typeof attempt.fingerprint?.hash === 'string' && strings(attempt.fingerprint.terms, 72) &&
      strings(attempt.fingerprint.signals, 2048) && (attempt.fingerprint.paths === undefined || strings(attempt.fingerprint.paths, 128))) &&
    entry.modelEvidence.length <= 16 && entry.modelEvidence.every((item) => !!item && typeof item.model_id === 'string' && strings(item.keys, 8)) &&
    ['active', 'stale', 'archived'].includes(entry.state) && ['project', 'model_scoped'].includes(entry.scope) &&
    [entry.id, context.project, context.directory, context.tool, context.task, context.model_id, entry.verified_fix.model_id]
      .every((item) => typeof item === 'string') && (entry.supersedes === undefined || typeof entry.supersedes === 'string') &&
    (rationale.kind === 'input_diff' ? typeof rationale.from === 'string' && typeof rationale.to === 'string' :
      rationale.kind === 'verified_retry' && typeof rationale.text === 'string' && (rationale.paths === undefined || strings(rationale.paths, 3))) &&
    [entry.verifiedAt, entry.createdAt, entry.confidence, entry.consecutiveMisses, entry.verifiedEpisodes].every(Number.isFinite) &&
    (entry.lastHitAt === null || Number.isFinite(entry.lastHitAt)) && typeof entry.pinned === 'boolean';
}

async function readLedger(path: string): Promise<Ledger> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return emptyLedger();
    throw error;
  }
  let value: Ledger | null;
  try { value = JSON.parse(content) as Ledger | null; }
  catch { throw new DamagedLedger('Damaged SIM ledger'); }
  if (value?.version !== undefined && value.version !== 1) throw new Error('Unsupported SIM ledger version');
  if (!value || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > LIMIT || !value.entries.every(validEntry)) {
    throw new DamagedLedger('Damaged SIM ledger');
  }
  return value;
}

function ownerAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) return true;
  try { process.kill(pid, 0); } catch (error) { return !hasCode(error, 'ESRCH'); }
  return true;
}

async function removeEmptyLock(path: string): Promise<void> {
  try { await rmdir(path); }
  catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].some((code) => hasCode(error, code))) throw error;
  }
}

async function reapLock(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isFile()) {
      // v0.1.0 did not write owner metadata. Only reclaim its empty lock
      // after the grace period and a second identity check.
      if (info.size || Date.now() - info.mtimeMs < LOCK_GRACE) return;
      const current = await lstat(path);
      if (current.isFile() && current.ino === info.ino && current.mtimeMs === info.mtimeMs) await unlink(path);
      return;
    }
    if (!info.isDirectory()) return;
    const contents = await readdir(path);
    if (!contents.length) { await removeEmptyLock(path); return; }
    const owner = contents.length === 1 ? contents[0] : undefined;
    const pid = owner && ownerName.exec(owner)?.[1];
    if (!owner || !pid || Date.now() - info.mtimeMs < LOCK_GRACE || ownerAlive(Number(pid))) return;
    // Two reapers can only remove the same unique marker. No reaper can
    // remove a newly installed lock directory containing a different marker.
    await unlink(join(path, owner));
    await removeEmptyLock(path);
  } catch (error) {
    if (!['ENOENT', 'EISDIR', 'ENOTDIR', 'EPERM', 'EACCES', 'EBUSY'].some((code) => hasCode(error, code))) throw error;
  }
}

export class JsonLedger implements LedgerStore {
  readonly path: string;
  private current: Ledger = emptyLedger();
  private queue: Promise<unknown> = Promise.resolve();
  private nextRefresh = 0;
  private refreshWork?: Promise<void>;

  constructor(path: string) { this.path = path; }

  snapshot(): Ledger { return this.current; }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  refresh(force = false): Promise<void> {
    if (this.refreshWork) return this.refreshWork;
    if (!force && Date.now() < this.nextRefresh) return Promise.resolve();
    this.nextRefresh = Date.now() + REFRESH_INTERVAL;
    this.refreshWork = this.enqueue(async () => {
      try {
        this.current = await readLedger(this.path);
      } catch (error) {
        if (!(error instanceof DamagedLedger)) throw error;
        this.current = emptyLedger();
      } finally {
        this.refreshWork = undefined;
      }
    });
    return this.refreshWork;
  }

  update(change: (ledger: Ledger) => boolean): Promise<void> {
    return this.enqueue(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const lockPath = `${this.path}.lock`;
      const release = await this.acquire(lockPath);
      let temporary: string | undefined;
      try {
        let damaged = false;
        const draft = await readLedger(this.path).catch((error: unknown) => {
          if (!(error instanceof DamagedLedger)) throw error;
          damaged = true;
          return emptyLedger();
        });
        if (change(draft)) {
          if (draft.entries.length > LIMIT) {
            const now = Date.now();
            draft.entries.sort((a, b) => Number(b.pinned) - Number(a.pinned) ||
              Number(isHot(b, now)) - Number(isHot(a, now)) || b.verifiedAt - a.verifiedAt);
            draft.entries.length = LIMIT;
          }
          temporary = `${this.path}.${randomUUID()}.tmp`;
          const file = await open(temporary, 'wx', 0o600);
          try {
            await file.writeFile(`${JSON.stringify(draft, null, 2)}\n`);
            await file.sync();
          } finally {
            await file.close();
          }
          if (damaged) await rename(this.path, `${this.path}.corrupt.${Date.now()}-${randomUUID()}`);
          await rename(temporary, this.path);
        }
        this.current = draft;
        this.nextRefresh = Date.now() + REFRESH_INTERVAL;
      } finally {
        try {
          if (temporary) await rm(temporary, { force: true });
        } finally {
          await release();
        }
      }
    });
  }

  private async acquire(path: string): Promise<() => Promise<void>> {
    const marker = `${process.pid}-${randomUUID()}`;
    const pending = `${path}.pending-${marker}`;
    await mkdir(pending, { mode: 0o700 });
    try {
      await writeFile(join(pending, marker), '', { flag: 'wx', mode: 0o600 });
      for (let attempt = 0; attempt < 9; attempt++) {
        try {
          // Install an already populated directory atomically, even when
          // another writer has just removed its own marker.
          await rename(pending, path);
          return async () => {
            await rm(join(path, marker), { force: true });
            await removeEmptyLock(path);
          };
        } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EPERM', 'EACCES'].some((code) => hasCode(error, code))) throw error;
          await reapLock(path);
          await delay(8 + attempt * 4);
        }
      }
      throw new Error('SIM ledger is busy');
    } finally {
      await rm(join(pending, marker), { force: true });
      await removeEmptyLock(pending);
    }
  }
}
