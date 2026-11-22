import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

test('invalid ledger fails closed and preserves original disk bytes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sim-broken-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.json');
  await writeFile(path, '{"version":2,"entries":[]}');
  const ledger = new JsonLedger(path);
  await assert.rejects(ledger.refresh(), /damaged SIM ledger/);
  await assert.rejects(ledger.update(() => true), /damaged SIM ledger/);
  assert.equal(await readFile(path, 'utf8'), '{"version":2,"entries":[]}');
  assert.deepEqual(await readdir(dir), ['ledger.json']);
});
