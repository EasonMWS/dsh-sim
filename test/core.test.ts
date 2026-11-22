import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SimEngine } from '../src/engine.ts';
import { fingerprint, similarity } from '../src/fingerprint.ts';
import { COLD_AFTER, memoryLedger } from '../src/ledger.ts';
import { makeRecipe } from '../src/recipes.ts';
import type { Outcome, ToolCall } from '../src/types.ts';
import { wrapHint } from '../src/surface.ts';

const failure: Outcome = { kind: 'failure', code: 'SHELL_EXIT', diagnostic: 'ERR_PNPM_USAGE Cannot execute package script with the current package manager' };
const success: Outcome = { kind: 'success' };
const bad = 'npm test';
const fixed = 'pnpm test';

function call(step: number, command = bad, overrides: Partial<ToolCall> = {}): ToolCall {
  return { session: 's1', turn: 1, step, model: 'remote/cheap', project: 'p', directory: 'root', tool: 'bash', recipe: makeRecipe('bash', { command })!, ...overrides };
}

function setup() {
  let now = 1_000_000;
  const store = memoryLedger();
  const engine = new SimEngine(store, () => now);
  const entries = () => store.snapshot().entries;
  async function learn(turn = 1, model = 'remote/cheap', repair = fixed) {
    await engine.observe(call(1, bad, { turn, model }), failure);
    await engine.observe(call(2, repair, { turn, model }), success);
    engine.endTurn('s1', turn);
  }
  return { engine, entries, learn, advance: (ms: number) => { now += ms; } };
}

test('normalization strips timestamps, ANSI, drive and POSIX roots, lines, UUIDs and addresses', () => {
  const a = '2026-11-22T10:30:59.512Z \u001b[31mTS2322 Cannot assign module type at C:\\Checkout\\temp\\config.ts:12:33 0x90da 123e4567-e89b-12d3-a456-426614174000\u001b[0m';
  const b = '2026-12-10T09:00:32Z TS2322 Cannot assign module type at /home/other/project/config.ts:54:88 0x4401 773e4567-e89b-12d3-a456-426614174999';
  assert.equal(fingerprint(a, 'shell', 'C:\\Checkout\\temp')?.hash, fingerprint(b, 'shell', '/home/other/project')?.hash);
  assert.notEqual(fingerprint(a, 'shell')?.hash, fingerprint(b.replace('TS2322', 'TS2307'), 'shell')?.hash);
  assert.notEqual(fingerprint(a, 'shell')?.hash, fingerprint(b, 'args')?.hash);
  assert.equal(fingerprint('Error: command failed'), undefined);
});

test('fingerprints strip PID and Chinese locations, keep hex words, and distinguish same-named files', () => {
  const a = fingerprint('Error: TS2307 pid=87654 找不到模块 第 17 行 第 3 列 "C:\\My Repo\\utils\\helper.ts" build a1b2c3d', 'SHELL_EXIT', 'C:\\My Repo');
  const b = fingerprint('Error: TS2307 pid 345 找不到模块 第9行 第47列 ./utils/helper.ts build c1d2e3f', 'SHELL_EXIT', '/repo');
  assert.ok(a && b);
  assert.equal(a.hash, b.hash);
  assert.notEqual(fingerprint('Error: failed to parse acceded template')?.hash, fingerprint('Error: failed to parse defaced template')?.hash);
  const api = fingerprint('TS2307 Cannot resolve internal workspace module during validation at /repo/packages/api/index.ts');
  const web = fingerprint('TS2307 Cannot resolve internal workspace module during validation at /repo/packages/web/index.ts');
  assert.notEqual(api?.hash, web?.hash);
  assert.equal(similarity(api!, web!), 0);
  assert.notEqual(fingerprint('TS2307 Cannot resolve /repo/apps/a/shared/index.ts', '', '/repo')?.hash,
    fingerprint('TS2307 Cannot resolve /repo/apps/b/shared/index.ts', '', '/repo')?.hash);
});

test('lexical fallback requires high overlap and the same specific diagnostic', () => {
  const a = fingerprint('TS2322 Cannot assign private generic module parameter to readonly build config');
  const b = fingerprint('TS2322 Cannot assign private generic module parameter to readonly build config object');
  const c = fingerprint('TS2307 Cannot assign private generic module parameter to readonly build config');
  assert.ok(similarity(a!, b!) >= 0.8 && similarity(a!, b!) < 1);
  assert.equal(similarity(a!, c!), 0);
  assert.equal(similarity(a!, fingerprint('TS2322 Build output target already exists')!), 0);
});

test('recipe filters chained commands, risky fields, secret-like inputs and full edit payloads', () => {
  for (const input of [{ command: 'npm test; exit 0' }, { command: 'env CI_SECRET=123 npm test' },
    { command: 'npm test', run_in_background: true }, { command: 'npm test', sandbox_permissions: 'escalated' }]) {
    assert.equal(makeRecipe('pwsh', input), undefined);
  }
  assert.equal(makeRecipe('edit', { file_path: 'a.txt', new_string: 'text' }), undefined);
  assert.notEqual(makeRecipe('bash', { command: 'npm test -- tests/a.test.ts' })?.task,
    makeRecipe('bash', { command: 'pnpm test -- tests/b.test.ts' })?.task);
  assert.notEqual(makeRecipe('bash', { command: 'pnpm test --filter=core' })?.task,
    makeRecipe('bash', { command: 'pnpm test --filter=desktop' })?.task);
  assert.notEqual(makeRecipe('pwsh', { command: 'dotnet test --filter=Desktop' })?.task,
    makeRecipe('pwsh', { command: 'dotnet test --filter=Core' })?.task);
  assert.equal(makeRecipe('pwsh', { command: 'dotnet test Core.csproj --no-restore' })?.task,
    makeRecipe('pwsh', { command: 'dotnet test Core.csproj' })?.task);
  assert.equal(makeRecipe('bash', { command: 'npm run test -- "with spaces.ts"' })?.task,
    makeRecipe('bash', { command: 'pnpm test -- "with spaces.ts"' })?.task);
});

test('failure and a changed successful retry create all four SIM fields and retain up to three failures', async () => {
  const { engine, entries } = setup();
  for (const [step, command] of ['npm test', 'npm run test', 'yarn test', 'bun test'].entries()) {
    assert.equal(await engine.observe(call(step + 1, command), failure), undefined);
  }
  assert.equal(entries().length, 0);
  assert.equal(await engine.observe(call(5, fixed), success), undefined);
  const [entry] = entries();
  assert.equal(entry?.context.model_id, 'remote/cheap');
  assert.equal(entry?.context.tool, 'bash');
  assert.deepEqual(entry?.failed_attempts.map(({ recipe }) => recipe.input), ['npm run test', 'yarn test', 'bun test']);
  assert.equal(entry?.verified_fix.recipe.input, fixed);
  assert.deepEqual(entry?.rationale, { kind: 'input_diff', from: 'bun test', to: fixed });
  assert.equal(entry?.state, 'active');
});

test('success across a different step window, turn, same step, model, project, cwd, tool or target cannot close the loop', async () => {
  for (const unrelated of [call(8, fixed), call(2, fixed, { session: 's2' }), call(2, fixed, { turn: 2 }),
    call(1, fixed), call(2, fixed, { model: 'remote/strong' }), call(2, fixed, { project: 'other' }),
    call(2, fixed, { directory: 'subdir' }), call(2, fixed, { tool: 'pwsh' }), call(2, 'pnpm lint')]) {
    const { engine, entries } = setup();
    await engine.observe(call(1), failure);
    await engine.observe(unrelated, success);
    assert.equal(entries().length, 0);
  }
});

test('exact retry needs an observed edit between failure and success', async () => {
  const { engine, entries } = setup();
  await engine.observe(call(1), failure);
  await engine.observe(call(2), success);
  assert.equal(entries().length, 0);
  await engine.observe(call(3), failure);
  engine.recordEdit(call(4), 'src/index.ts');
  await engine.observe(call(5), success);
  assert.equal(entries()[0]?.rationale.kind, 'verified_retry');
  assert.deepEqual(entries()[0]?.rationale, { kind: 'verified_retry', text: 'The same input passed after an observed project edit.', paths: ['src/index.ts'] });
});

test('strong model stays silent on a clean execution and gets one post hint only after a recurrence', async () => {
  const { engine, learn, entries } = setup();
  await learn();
  const model = { turn: 2, model: 'remote/strong' };
  assert.equal(engine.before(call(1, bad, model)), undefined);
  assert.equal(await engine.observe(call(1, fixed, model), success), undefined);
  const hint = await engine.observe(call(2, bad, model), failure);
  assert.equal(hint?.mode, 'post');
  assert.match(hint!.text, /remote\/cheap.*npm test/);
  assert.match(hint!.text, /Verified input: pnpm test/);
  assert.equal(await engine.observe(call(2, bad, model), failure), undefined);
  await engine.observe(call(3, fixed, model), success);
  assert.ok(entries()[0]!.confidence > 55);
  assert.ok(entries()[0]!.modelEvidence.some(({ model_id }) => model_id === model.model));
});

test('matching stays in the exact directory and rejects unrelated diagnostics', async () => {
  const { engine, learn } = setup();
  await learn();
  assert.equal(await engine.observe(call(1, bad, { turn: 2, directory: 'other' }), failure), undefined);
  assert.equal(await engine.observe(call(1, 'npm lint', { turn: 3 }), failure), undefined);
  assert.equal(await engine.observe(call(1, bad, { turn: 4 }),
    { ...failure, diagnostic: 'TS2307 Cannot find module missingDependency in test fixture' }), undefined);
});

test('next repeated error moves active to stale; a second independent missed hint archives it', async () => {
  const { engine, learn, entries } = setup();
  await learn();
  for (const [turn, state] of [[2, 'stale'], [3, 'archived']] as const) {
    assert.equal((await engine.observe(call(1, bad, { turn }), failure))?.mode, 'post');
    assert.equal(await engine.observe(call(2, bad, { turn }), failure), undefined);
    assert.equal(entries()[0]?.state, state);
    engine.endTurn('s1', turn);
  }
  assert.equal(await engine.observe(call(1, bad, { turn: 4 }), failure), undefined);
});

test('feedback uses a four-step window and ignores intervening reads and unrelated attempts', async () => {
  const { engine, learn, entries } = setup();
  await learn();
  const turn = 2;
  assert.equal((await engine.observe(call(1, bad, { turn }), failure))?.mode, 'post');
  await engine.observe(call(2, bad, { turn, tool: 'read', recipe: makeRecipe('read', { file_path: 'index.ts' })! }), success);
  await engine.observe(call(3, 'yarn test', { turn }), { ...failure, diagnostic: 'TS2307 Cannot find dependency in workspace' });
  await engine.observe(call(5, fixed, { turn }), success);
  assert.equal(entries()[0]?.confidence, 70);
  assert.equal(entries()[0]?.state, 'active');
  await engine.observe(call(1, bad, { turn: 3 }), failure);
  await engine.observe(call(3, bad, { turn: 3 }), failure);
  assert.equal(entries()[0]?.state, 'stale');
  await engine.observe(call(1, bad, { turn: 4 }), failure);
  await engine.observe(call(6, bad, { turn: 4 }), failure);
  assert.equal(entries()[0]?.consecutiveMisses, 1);
});

test('a recommended input failing with a new or unclassifiable error counts as a miss', async () => {
  const { engine, learn, entries } = setup();
  await learn();
  for (const [turn, diagnostic, state] of [[2, 'TS2307 Cannot find dependency in workspace', 'stale'], [3, '', 'archived']] as const) {
    assert.equal((await engine.observe(call(1, bad, { turn }), failure))?.mode, 'post');
    await engine.observe(call(3, fixed, { turn }), { ...failure, diagnostic });
    assert.equal(entries()[0]?.state, state);
  }
  assert.equal(entries()[0]?.consecutiveMisses, 2);
});

test('a replacement fix inherits cross-model failure evidence without inheriting verification counts', async () => {
  const { engine, learn, entries } = setup();
  await learn(1, 'remote/cheap');
  await learn(2, 'remote/cheap');
  assert.equal(entries()[0]?.scope, 'model_scoped');
  await learn(3, 'remote/other');
  const original = entries()[0]!.id;
  await learn(4, 'remote/cheap', 'yarn test');
  const replacement = entries()[1]!;
  assert.equal(replacement.supersedes, original);
  assert.equal(replacement.verifiedEpisodes, 1);
  assert.equal(replacement.scope, 'project');
  assert.deepEqual(replacement.modelEvidence.map(({ model_id }) => model_id), ['remote/cheap', 'remote/other']);
  await engine.command('p', `pin ${replacement.id}`);
  assert.equal(engine.before(call(1, bad, { turn: 5, model: 'remote/other' }))?.mode, 'pre');
});

test('oversized model identifiers stay bounded and long multibyte fixes are preview-only', async () => {
  const { engine, entries } = setup();
  const model = `remote/${'m'.repeat(575)}`;
  const target = `src/${'测试'.repeat(18)}.ts`;
  const makeCall = (step: number, turn: number, offset: string | number) => call(step, bad, {
    turn, model, tool: 'read', recipe: makeRecipe('read', { file_path: target, offset })!,
  });
  const invalid: Outcome = { kind: 'failure', code: 'INVALID_ARGS', diagnostic: 'invalid arguments: offset must be an integer' };
  await engine.observe(makeCall(1, 1, '1'), invalid);
  await engine.observe(makeCall(2, 1, 1), success);
  assert.equal(entries()[0]?.context.model_id.length, 500);
  await engine.command('p', `pin ${entries()[0]!.id}`);
  assert.equal(engine.before(makeCall(1, 2, '1')), undefined);
  const hint = await engine.observe(makeCall(1, 2, '1'), invalid);
  assert.match(hint?.text ?? '', /Verified preview:[\s\S]*…[\s\S]*\/sim list/);
  assert.ok(Buffer.byteLength(`Error: ${wrapHint(hint!.text)}`) <= 100);
});

test('stale entries are redeemed by a proven fix and a different valid fix supersedes the original', async () => {
  const { engine, learn, entries } = setup();
  await learn();
  const original = entries()[0]!.id;
  await engine.observe(call(1, bad, { turn: 2 }), failure);
  await engine.observe(call(2, bad, { turn: 2 }), failure);
  assert.equal(entries()[0]?.state, 'stale');
  await learn(3);
  assert.equal(entries()[0]?.state, 'active');
  assert.equal(entries()[0]?.consecutiveMisses, 0);
  await learn(4, 'remote/cheap', 'yarn test');
  assert.equal(entries()[0]?.state, 'archived');
  assert.equal(entries()[1]?.supersedes, original);
  assert.equal(entries()[1]?.verified_fix.recipe.input, 'yarn test');
});

test('cold entries drop out of the hot index upon crossing the 30-day boundary', async () => {
  const { engine, learn, entries, advance } = setup();
  await learn();
  const id = entries()[0]!.id;
  await engine.command('p', `pin ${id}`);
  assert.equal(engine.before(call(1, bad, { turn: 2 }))?.mode, 'pre');
  advance(COLD_AFTER);
  assert.equal(engine.before(call(1, bad, { turn: 3 })), undefined);
  assert.equal(await engine.observe(call(1, bad, { turn: 3 }), failure), undefined);
  assert.equal(entries().length, 1);
  assert.match((await engine.command('p', 'status')).text, /0 hot.*1 cold\/archived/);
});

test('prevention requires exact current-model evidence, then pin or repeated cross-model evidence', async () => {
  const { engine, learn, entries } = setup();
  await learn();
  assert.equal(engine.before(call(1, bad, { turn: 2 })), undefined);
  await learn(2, 'remote/other');
  await learn(3, 'remote/cheap');
  assert.ok(entries()[0]!.confidence >= 75);
  assert.equal(engine.before(call(1, bad, { turn: 4, model: 'remote/new' })), undefined);
  assert.equal(engine.before(call(1, 'npm run test', { turn: 4 })), undefined);
  assert.equal(engine.before(call(1, bad, { turn: 4 }))?.mode, 'pre');
});

test('schema failures retain a precise argument diff and a single-model repeated pattern is model_scoped', async () => {
  const { engine, entries } = setup();
  const args = (step: number, offset: unknown, turn: number, model = 'remote/cheap') => call(step, bad, {
    turn, model, tool: 'read', recipe: makeRecipe('read', { file_path: 'index.ts', offset })!,
  });
  const invalid: Outcome = { kind: 'failure', code: 'INVALID_ARGS', diagnostic: 'invalid arguments: offset must be an integer' };
  for (const turn of [1, 2]) {
    await engine.observe(args(1, '10', turn), invalid);
    await engine.observe(args(2, 10, turn), success);
  }
  assert.deepEqual(entries()[0]?.rationale, { kind: 'input_diff', from: 'offset="10"', to: 'offset=10' });
  assert.equal(entries()[0]?.scope, 'model_scoped');
  await engine.command('p', `pin ${entries()[0]!.id}`);
  assert.equal(engine.before(args(1, '10', 3, 'remote/new')), undefined);
  assert.equal((await engine.observe(args(1, '10', 3, 'remote/new'), invalid))?.mode, 'post');
});

test('command control plane is project-scoped and destructive drop requires the full ID', async () => {
  const { engine, learn, entries } = setup();
  await learn();
  const id = entries()[0]!.id;
  assert.equal((await engine.command('other', `pin ${id}`)).kind, 'error');
  assert.equal((await engine.command('p', `drop ${id.slice(0, 5)}`)).kind, 'error');
  assert.equal((await engine.command('p', `pin ${id}`)).kind, 'success');
  assert.match((await engine.command('p', 'list')).text, /pinned.*pnpm test/);
  assert.equal((await engine.command('p', `drop ${id}`)).kind, 'success');
  assert.equal(entries().length, 0);
});
