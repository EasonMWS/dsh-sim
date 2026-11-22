import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Entry, Ledger } from './types.ts';

export const COLD_AFTER = 30 * 24 * 60 * 60 * 1000;
const LIMIT = 600;
const REFRESH_INTERVAL = 10_000;

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

function validEntry(entry: Entry): boolean {
  return Array.isArray(entry.failed_attempts) && entry.failed_attempts.length >= 1 && entry.failed_attempts.length <= 3 &&
    Array.isArray(entry.modelEvidence) && ['active', 'stale', 'archived'].includes(entry.state) &&
    ['project', 'model_scoped'].includes(entry.scope) && typeof entry.id === 'string' &&
    typeof entry.context?.tool === 'string' && typeof entry.verified_fix?.recipe?.key === 'string' &&
    typeof entry.rationale?.kind === 'string' && Number.isFinite(entry.verifiedAt);
}

async function readLedger(path: string): Promise<Ledger> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Ledger;
    if (value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > LIMIT || !value.entries.every(validEntry)) {
      throw new Error('Unsupported or damaged SIM ledger');
    }
    return value;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { version: 1, entries: [] };
    throw error;
  }
}

export class JsonLedger implements LedgerStore {
  readonly path: string;
  private current: Ledger = { version: 1, entries: [] };
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
      const lock = await this.acquire(lockPath);
      let temporary: string | undefined;
      try {
        const draft = await readLedger(this.path);
        if (change(draft)) {
          if (draft.entries.length > LIMIT) {
            draft.entries.sort((a, b) => Number(b.pinned) - Number(a.pinned) ||
              Number(isHot(b, Date.now())) - Number(isHot(a, Date.now())) || b.verifiedAt - a.verifiedAt);
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
          await rename(temporary, this.path);
        }
        this.current = draft;
        this.nextRefresh = Date.now() + REFRESH_INTERVAL;
      } finally {
        try {
          if (temporary) await rm(temporary, { force: true });
        } finally {
          await lock.close();
          await rm(lockPath, { force: true });
        }
      }
    });
  }

  private async acquire(path: string) {
    for (let attempt = 0; attempt < 9; attempt++) {
      try {
        return await open(path, 'wx', 0o600);
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
        await delay(8 + attempt * 4);
      }
    }
    throw new Error('SIM ledger is busy');
  }
}
