import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SimEngine } from '../src/engine.ts';
import { JsonLedger } from '../src/ledger.ts';
import { makeRecipe } from '../src/recipes.ts';
import type { ToolCall } from '../src/types.ts';

test('independent JSON ledger writers serialize changes and persist safe records across restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sim-ledger-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.json');
  const one = new JsonLedger(path);
  const two = new JsonLedger(path);
  const engines = [new SimEngine(one), new SimEngine(two)];
  await Promise.all(engines.map(async (engine, index) => {
    const where = { session: `s-${index}`, turn: 1, project: `p-${index}`, directory: 'd', model: 'p/m', tool: 'bash' };
    const failing: ToolCall = { ...where, step: 1, recipe: makeRecipe('bash', { command: 'npm test' })! };
    await engine.observe(failing, { kind: 'failure', code: 'SHELL_EXIT',
      diagnostic: 'ERR_PNPM_USAGE Cannot execute package script, password=superPrivateText' });
    await engine.observe({ ...where, step: 2, recipe: makeRecipe('bash', { command: 'pnpm test' })! }, { kind: 'success' });
  }));
  const restarted = new JsonLedger(path);
  await restarted.refresh();
  assert.equal(restarted.snapshot().entries.length, 2);
  assert.deepEqual(await readdir(dir), ['ledger.json']);
  assert.doesNotMatch(await readFile(path, 'utf8'), /superPrivateText|Cannot execute package script/);
});

test('a forward ledger version fails closed and preserves original disk bytes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sim-broken-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.json');
  await writeFile(path, '{"version":2,"entries":[]}');
  const ledger = new JsonLedger(path);
  await assert.rejects(ledger.refresh(), /Unsupported SIM ledger version/);
  await assert.rejects(ledger.update(() => true), /Unsupported SIM ledger version/);
  assert.equal(await readFile(path, 'utf8'), '{"version":2,"entries":[]}');
  assert.deepEqual(await readdir(dir), ['ledger.json']);
});

test('stale legacy lock and a dead owner recover, while a live lock stays held even when old', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sim-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.json');
  const lock = `${path}.lock`;
  const old = new Date(Date.now() - 60_000);
  const ledger = new JsonLedger(path);
  await writeFile(lock, '');
  await utimes(lock, old, old);
  await ledger.update(() => true);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = child.pid;
  await once(child, 'exit');
  assert.ok(pid);
  await mkdir(lock);
  await writeFile(join(lock, `${pid}-${randomUUID()}`), '');
  await utimes(lock, old, old);
  await Promise.all([ledger.update(() => true), new JsonLedger(path).update(() => true)]);
  await mkdir(lock);
  const live = `${process.pid}-${randomUUID()}`;
  await writeFile(join(lock, live), '');
  await utimes(lock, old, old);
  await assert.rejects(ledger.update(() => true), /busy/);
  assert.deepEqual(await readdir(lock), [live]);
  assert.equal((await readdir(dir)).some((name) => name.includes('.pending-')), false);
});

test('a malformed ledger is backed up verbatim on the next write', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sim-recover-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.json');
  const original = '{"version":1,"entries":[null';
  await writeFile(path, original);
  const ledger = new JsonLedger(path);
  await ledger.refresh();
  assert.deepEqual(ledger.snapshot().entries, []);
  assert.equal(await readFile(path, 'utf8'), original);
  await ledger.update(() => true);
  const backup = (await readdir(dir)).find((name) => name.startsWith('ledger.json.corrupt.'));
  assert.ok(backup);
  assert.equal(await readFile(join(dir, backup), 'utf8'), original);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 1, entries: [] });
});

test('the on-disk ledger retains at most 600 records, prioritizing pinned and hot records', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sim-cap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.json');
  const ledger = new JsonLedger(path);
  const engine = new SimEngine(ledger);
  const failed = { session: 's', turn: 1, step: 1, model: 'p/m', project: 'p', directory: 'd', tool: 'bash',
    recipe: makeRecipe('bash', { command: 'npm test' })! };
  await engine.observe(failed, { kind: 'failure', diagnostic: 'ERR_PNPM_USAGE Cannot execute package script', code: 'SHELL_EXIT' });
  await engine.observe({ ...failed, step: 2, recipe: makeRecipe('bash', { command: 'pnpm test' })! }, { kind: 'success' });
  const template = ledger.snapshot().entries[0]!;
  await ledger.update((draft) => {
    draft.entries = Array.from({ length: 602 }, (_, index) => ({ ...structuredClone(template), id: `entry-${index}`,
      verifiedAt: Date.now() - 100_000 + index, pinned: index === 0, state: index <= 1 ? 'archived' : 'active' }));
    return true;
  });
  const reopened = new JsonLedger(path);
  await reopened.refresh();
  assert.equal(reopened.snapshot().entries.length, 600);
  assert.ok(reopened.snapshot().entries.some(({ id }) => id === 'entry-0'));
  assert.ok(!reopened.snapshot().entries.some(({ id }) => id === 'entry-1' || id === 'entry-2'));
});
