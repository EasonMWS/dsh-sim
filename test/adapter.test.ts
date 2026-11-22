import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import { appendHint, outcomeFor } from '../src/dsh-adapter.ts';
import { containsHint, wrapHint } from '../src/surface.ts';

const shellResult = (value: Record<string, unknown>) => ({
  isError: false, value: { cwd: '/fixture', exitCode: 0, stdout: { text: '' }, stderr: { text: '' }, ...value }, content: [],
} as ToolExecutionResult);

test('normalized Harness results recognize non-zero shell status and schema errors precisely', () => {
  assert.deepEqual(outcomeFor('pwsh', shellResult({ exitCode: 1, stderr: { text: 'bad flag' }, stdout: { text: 'ERR_EXAMPLE' } })),
    { kind: 'failure', code: 'SHELL_EXIT', diagnostic: 'bad flag\nERR_EXAMPLE' });
  assert.deepEqual(outcomeFor('bash', shellResult({})), { kind: 'success' });
  assert.deepEqual(outcomeFor('read', { isError: true, content: [], error: { message: 'invalid', info: { code: 'INVALID_ARGS', name: 'ToolArgsError' } } }),
    { kind: 'failure', code: 'INVALID_ARGS', diagnostic: 'invalid' });
  for (const value of [{ timedOut: true }, { aborted: true }, { kind: 'background' }, { kind: 'promoted' },
    { stopped: 'output-limit' }, { signal: 'SIGTERM' }, { sandbox: { denied: true } }, { sandbox: { runnerFailed: true } }]) {
    assert.equal(outcomeFor('pwsh', shellResult({ exitCode: 1, ...value })), undefined);
  }
  assert.equal(outcomeFor('read', { isError: true, content: [], error: { message: 'permission denied' } }), undefined);
});

test('tool result hint preserves the original output and terminal exit marker', () => {
  const original = [{ type: 'text', text: 'stdout\n[stderr]\nreal error\n[exit code: 3]' }] as const;
  const note = wrapHint('[SIM] 已注入 1 条历史防复发经验 (tool failure)\nVerified input: pnpm test');
  const enriched = appendHint([...original], note, true);
  assert.equal(enriched.length, 1);
  assert.deepEqual(enriched[0], { type: 'text', text: `stdout\n[stderr]\nreal error\n\n${note}\n[exit code: 3]` });
  assert.ok(containsHint(enriched));
  assert.equal(containsHint(original), false);
});
