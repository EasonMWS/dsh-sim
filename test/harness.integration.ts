import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as sim from '../dist/dsh-adapter.js';

const resolveSdk = process.env.SIM_DSH_NODE_MODULES
  ? createRequire(join(process.env.SIM_DSH_NODE_MODULES, '..', 'package.json'))
  : createRequire(import.meta.url);
const sdk = (name: string) => import(pathToFileURL(resolveSdk.resolve(`@deepseek-ai/${name}`)).href);

for (const retireHintsOnModelSwitch of [false, true]) test(`real Cordis recurrence with route retirement ${retireHintsOnModelSwitch ? 'enabled' : 'disabled'}`, async (t) => {
  const [{ Context }, { SystemPrompt }, { ToolRuntime, defineTool }, { SessionStore }, { CommandRuntime },
    { createAssistantMessage, createToolResultMessage }, { scopeTarget }] = await Promise.all([
    sdk('cordis'), sdk('dsh-system-prompt'), sdk('dsh-tools'), sdk('dsh-session'), sdk('dsh-commands'), sdk('dsh-llm'), sdk('dsh-scope'),
  ]);
  const home = await mkdtemp(join(tmpdir(), 'sim-harness-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });
  const cwd = join(home, 'project');
  await mkdir(cwd);
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  const batchExecutor = typeof ctx.tools.setExecutor === 'function';
  if (batchExecutor) await ctx.plugin(await sdk('dsh-tool-executor-native'));
  await ctx.plugin(SessionStore);
  await ctx.plugin(CommandRuntime);
  await ctx.plugin({ apply(local) { local.provide('workingDirectory', { get: () => cwd }); } });
  const installed = ctx.plugin(sim, { retireHintsOnModelSwitch });
  await installed;
  const session = ctx.sessions.create('sim-fixture', { meta: { cwd } });
  const agent = { session, ctx };
  const signal = new AbortController().signal;
  const toolRuns: string[] = [];
  ctx.tools.register(defineTool({
    name: 'pwsh', description: 'Deterministic terminal-shaped fixture',
    parameters: { command: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: value.exitCode ?
      '[stderr]\nERR_PNPM_USAGE Cannot execute package script with the current package manager\n[exit code: 1]' : 'success' }] },
    async execute({ command }) {
      toolRuns.push(command);
      const fail = command === 'npm test';
      return { cwd, exitCode: fail ? 1 : 0, signal: null, stdout: { text: '' },
        stderr: { text: fail ? 'ERR_PNPM_USAGE Cannot execute package script with the current package manager' : '' } };
    },
  }));

  const slash = (line: string) => ctx.commands.execute(agent, line, [], signal);
  const capturedSelection = Boolean(batchExecutor);
  const route = (turn: number, step: number, model: string) => ctx.waterfall(scopeTarget(agent, agent), 'agent/pre-step',
    { agent, step, turn, signal, messages: [], ...(capturedSelection ? { modelSelection: { provider: 'fixture', model } } : {}) },
    async () => ({ kind: 'enter', messages: [] }));
  const execute = async (turn: number, step: number, model: string, command: string) => {
    await route(turn, step, model);
    session.append('step/start', { step, turn });
    const callId = `call-${turn}-${step}`;
    const args = { command };
    const input = JSON.stringify(args);
    const block = { type: 'tool-call', id: callId, name: 'pwsh', arguments: input };
    const message = createAssistantMessage({ content: [block],
      source: { provider: 'fixture', model } });
    session.append('assistant/message', { turn, step, message, stream: [] }, { surfaceOp: 'append' });
    let result;
    if (batchExecutor) {
      ({ results: [{ result }] } = await ctx.tools.execute({ calls: [block], agent, signal, log: { turn, step } }));
    } else {
      const logged = session.append('tool/call', { turn, step, callId, name: 'pwsh', arguments: input });
      result = await ctx.tools.execute({ name: 'pwsh', callId, arguments: args, agent, signal });
      session.append('tool/result', {
        turn, step, message: createToolResultMessage({ callId, isError: result.isError, content: result.content }),
        ...(result.error?.info ? { error: result.error.info } : {}),
      }, { surfaceOp: 'append', sourceEventSeqs: [logged.seq] });
    }
    session.append('step/end', { turn, step });
    return result;
  };
  const begin = (turn: number) => session.append('turn/start', { turn });
  const end = (turn: number) => session.append('turn/end', { turn, reason: { kind: 'completed' } });
  const history = () => session.deriveMessages().flatMap(({ content }) => content.filter(({ type }) => type === 'text').map(({ text }) => text)).join('\n');

  begin(1);
  assert.doesNotMatch((await execute(1, 1, 'cheap', 'npm test')).content[0].text, /\[SIM]/);
  assert.equal((await execute(1, 2, 'cheap', 'pnpm test')).content[0].text, 'success');
  end(1);
  const stored = JSON.parse(await readFile(join(home, 'sim', 'ledger.json'), 'utf8'));
  assert.equal(stored.entries[0].context.model_id, 'fixture/cheap');
  assert.equal((await slash('/sim status')).result.kind, 'success');
  assert.match((await slash('/sim list')).result.text, /pnpm test/);
  assert.doesNotMatch(history(), /\[SIM]/);

  begin(2);
  const hit = await execute(2, 1, 'strong', 'npm test');
  assert.equal(hit.isError, false);
  assert.equal(hit.value.exitCode, 1);
  assert.match(hit.content[0].text, /Verified input: pnpm test[\s\S]*\[exit code: 1]$/);
  await route(2, 2, 'strong');
  assert.match(history(), /Verified input: pnpm test/);
  const beforeSwitch = [...session.surface.nodes];
  await route(2, 4, 'strong');
  assert.deepEqual(session.surface.nodes, beforeSwitch);
  await route(2, 4, 'stronger');
  if (retireHintsOnModelSwitch && capturedSelection) {
    assert.doesNotMatch(history(), /Verified input:|\[SIM]/);
    assert.notDeepEqual(session.surface.nodes, beforeSwitch);
  } else {
    assert.match(history(), /Verified input: pnpm test/);
    assert.deepEqual(session.surface.nodes, beforeSwitch);
  }
  assert.match(history(), /ERR_PNPM_USAGE[\s\S]*\[exit code: 1]/);
  end(2);

  assert.equal((await slash(`/sim pin ${stored.entries[0].id}`)).result.kind, 'success');
  begin(3);
  const prevented = await execute(3, 1, 'cheap', 'npm test');
  assert.equal(prevented.error.info.code, 'SIM_PREVENTED_RETRY');
  assert.equal(toolRuns.length, 3);
  await execute(3, 2, 'cheap', 'pnpm test');
  assert.match(history(), /\[SIM]/);
  await route(3, 3, 'cheap');
  assert.match(history(), /\[SIM]/);
  await route(3, 4, 'stronger');
  if (retireHintsOnModelSwitch && capturedSelection) {
    assert.doesNotMatch(history(), /\[SIM]/);
    assert.match(history(), /Error: tool call skipped before execution/);
  } else assert.match(history(), /\[SIM]/);
  end(3);
  assert.equal((await slash(`/sim drop ${stored.entries[0].id}`)).result.kind, 'success');

  await installed.dispose();
  assert.equal((await slash('/sim status')), undefined);
});
