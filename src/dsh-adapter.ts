import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-commands';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-working-directory';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { SimEngine } from './engine.ts';
import { JsonLedger } from './ledger.ts';
import { isInside, Projects } from './project.ts';
import { isShell, makeRecipe, reusablePath } from './recipes.ts';
import { containsHint, PREVENTED, retireHints, wrapHint } from './surface.ts';
import type { Outcome, ToolCall } from './types.ts';
import type { Project } from './project.ts';

export const name = 'dsh-plugin-sim';
// The interactive profile mounts commands; headless can still learn without them.
export const inject = ['tools', 'workingDirectory'];

interface Position { turn: number; step: number; model: string; }
interface Frame { position: Position; calls: Set<string>; hintCall?: string; }
interface LiveHint { model: string; event: SessionEvent<'tool/result'>; }
export interface Config { retireHintsOnModelSwitch?: boolean; }
type Scope = Omit<ToolCall, 'tool' | 'recipe'>;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function outcomeFor(tool: string, result: Readonly<ToolExecutionResult>): Outcome | undefined {
  if (result.isError) {
    const code = result.error.info?.code;
    if (code === 'INVALID_ARGS') return { kind: 'failure', diagnostic: result.error.message, code };
    return undefined;
  }
  if (!isShell(tool)) return { kind: 'success' };
  const value = object(result.value);
  if (!value || ['background', 'promoted'].includes(String(value.kind)) || value.aborted || value.timedOut ||
      value.signal || value.stopped || object(value.sandbox)?.denied || object(value.sandbox)?.runnerFailed ||
      typeof value.exitCode !== 'number') return undefined;
  if (value.exitCode === 0) return { kind: 'success' };
  const stderr = object(value.stderr)?.text;
  const stdout = object(value.stdout)?.text;
  const diagnostic = [stderr, stdout].filter((text): text is string => typeof text === 'string' && text.length > 0)
    .map((text) => text.slice(-4096)).join('\n');
  return { kind: 'failure', diagnostic, code: 'SHELL_EXIT' };
}

export function appendHint(content: ContentBlock[], text: string, shell: boolean): ContentBlock[] {
  const last = content.at(-1);
  if (last?.type !== 'text') return [...content, { type: 'text', text }];
  // Keep the final exit marker in its original position for dsh's terminal card.
  const marker = shell ? last.text.match(/\r?\n\[exit code: -?\d+\]\s*$/) : undefined;
  const split = marker?.index ?? last.text.length;
  return [...content.slice(0, -1), { ...last, text: `${last.text.slice(0, split)}\n\n${text}${last.text.slice(split)}` }];
}

/** Cordis adapter for native model tool calls. The core has no SDK dependency. */
export function apply(ctx: Context, config: Config = {}): void {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  const ledger = new JsonLedger(join(home, 'sim', 'ledger.json'));
  const engine = new SimEngine(ledger);
  const projects = new Projects();
  const frames = new WeakMap<Session, Frame>();
  const retireOnSwitch = config.retireHintsOnModelSwitch === true;
  const delivered = new WeakMap<Session, LiveHint[]>();
  let lastWarning: number | undefined;

  function fault(error: unknown): void {
    // Avoid printing raw tool output or ledger content into host logs.
    if (lastWarning !== undefined && Date.now() - lastWarning < 60_000) return;
    lastWarning = Date.now();
    const code = object(error)?.code;
    ctx.logger.warn(`SIM storage or tracking unavailable${typeof code === 'string' ? ` (${code})` : ''}`);
  }

  function position(exec: ToolExecution): Position | undefined {
    if (!exec.agent || exec.parent || exec.signal.aborted) return undefined;
    const frame = frames.get(exec.agent.session);
    return frame?.calls.has(exec.callId) ? frame.position : undefined;
  }

  function scope(exec: ToolExecution, at: Position, project: Project): Scope {
    return { ...at, session: exec.agent!.session.id, project: project.project, directory: project.directory, cwd: project.cwd };
  }

  function markHint(exec: ToolExecution): void {
    if (!retireOnSwitch) return;
    const frame = frames.get(exec.agent!.session);
    if (frame) frame.hintCall = exec.callId;
  }

  function projectFor(exec: ToolExecution, actual?: unknown): Promise<Project | undefined> {
    const fromSession = ctx.workingDirectory.get(exec.agent!.session);
    const args = object(exec.arguments);
    const override = isShell(exec.name) && typeof args?.workdir === 'string' ? args.workdir : undefined;
    return typeof actual === 'string' ? projects.resolve(actual) : projects.resolve(fromSession, override);
  }

  async function noteEdit(exec: ToolExecution, at: Position, project: Project, result: Readonly<ToolExecutionResult>): Promise<void> {
    const args = object(exec.arguments);
    const value = object(result.value);
    const candidate = value?.path ?? args?.file_path ?? args?.path;
    if (typeof candidate !== 'string') return;
    const path = await realpath(resolve(project.cwd, candidate)).catch(() => undefined);
    if (path && isInside(project.cwd, path) && position(exec) === at) {
      engine.recordEdit(scope(exec, at, project), reusablePath(relative(project.cwd, path)));
    }
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (event.type === 'assistant/message') {
        const { message, step, turn, interrupted } = event.data;
        if (interrupted || !message.source?.provider || !message.source?.model) {
          frames.delete(session);
          return;
        }
        frames.set(session, { position: { step, turn, model: `${message.source.provider}/${message.source.model}` }, calls: new Set() });
      } else if (event.type === 'tool/call') {
        const frame = frames.get(session);
        if (frame?.position.turn === event.data.turn && frame.position.step === event.data.step && frame.calls.size < 128) {
          frame.calls.add(event.data.callId);
        }
      } else if (retireOnSwitch && event.type === 'tool/result') {
        const frame = frames.get(session);
        if (frame && frame.hintCall === event.data.message.toolCallId && frame.position.turn === event.data.turn &&
            frame.position.step === event.data.step && containsHint(event.data.message.content)) {
          delete frame.hintCall;
          const hints = delivered.get(session) ?? [];
          hints.push({ model: frame.position.model, event });
          delivered.set(session, hints);
        }
      } else if (event.type === 'turn/end') {
        frames.delete(session);
        engine.endTurn(session.id, event.data.turn);
      } else if (event.type === 'user/message' && event.data.source?.kind === 'user') {
        engine.endTurn(session.id);
      }
    } catch (error) { fault(error); }
  });
  ctx.on('session/disposed', (session) => {
    frames.delete(session);
    delivered.delete(session);
    engine.endTurn(session.id);
  });

  if (retireOnSwitch) ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind !== 'enter' || payload.signal.aborted) return decision;
    const session = payload.agent.session;
    const hints = delivered.get(session);
    if (!hints?.length) return decision;
    // Newer Harness payloads include the route captured for this exact step.
    const route = object(object(payload)?.modelSelection);
    if (typeof route?.provider !== 'string' || typeof route.model !== 'string') {
      delivered.delete(session);
      return decision;
    }
    const model = `${route.provider}/${route.model}`;
    const retire = hints.filter((hint) => hint.model !== model);
    if (!retire.length) return decision;
    try {
      retireHints(session, retire.map(({ event }) => event));
      delivered.set(session, hints.filter((hint) => hint.model === model));
    } catch (error) { fault(error); }
    return decision;
  });

  // Pre-execute is where the proposed arguments actually exist. The gate only
  // denies positively matched known retries; it never rewrites tool arguments.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (decision.kind !== 'allow') return decision;
    const at = position(exec);
    if (!at) return decision;
    // When the ledger is empty, normal tool dispatch needs no project lookup.
    void ledger.refresh().catch(fault);
    if (!ledger.snapshot().entries.length) return decision;
    const recipes = [makeRecipe(exec.name, exec.arguments)];
    if (isShell(exec.name)) recipes.push(makeRecipe(exec.name, exec.arguments, true));
    if (!recipes.some(Boolean)) return decision;
    try {
      const project = await projectFor(exec);
      if (!project || position(exec) !== at) return decision;
      for (const recipe of recipes) {
        if (!recipe) continue;
        const hint = engine.before({ ...scope(exec, at, project), tool: exec.name, recipe });
        if (hint) {
          markHint(exec);
          return { kind: 'deny', reason: wrapHint(hint.text), info: { name: 'SimRetryNotice', code: PREVENTED } };
        }
      }
    } catch (error) { fault(error); }
    return decision;
  });

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    if (decision.kind !== 'accept' || decision.value !== undefined) return decision;
    const at = position(exec);
    if (!at) return decision;
    const isEdit = !result.isError && (exec.name === 'write' || exec.name === 'edit' ||
      (exec.name === 'str_replace_editor' && ['create', 'str_replace', 'insert'].includes(String(object(exec.arguments)?.command))));
    const outcome = outcomeFor(exec.name, result);
    if (!outcome) return decision;
    if (outcome.kind === 'success' && !engine.hasPending(exec.agent!.session.id)) return decision;
    const shell = isShell(exec.name);
    const recipes = [makeRecipe(exec.name, exec.arguments, outcome.kind === 'failure' && outcome.code === 'INVALID_ARGS')];
    if (shell && outcome.kind === 'success') recipes.push(makeRecipe(exec.name, exec.arguments, true));
    if (!isEdit && !recipes.some(Boolean)) return decision;
    try {
      const project = await projectFor(exec, shell && !result.isError ? object(result.value)?.cwd : undefined);
      if (!project || position(exec) !== at) return decision;
      if (isEdit) await noteEdit(exec, at, project, result);
      for (const recipe of recipes) {
        if (!recipe || position(exec) !== at) continue;
        const hint = await engine.observe({ ...scope(exec, at, project), tool: exec.name, recipe }, outcome);
        if (hint && position(exec) === at) {
          markHint(exec);
          return { ...decision, content: appendHint(decision.content ?? result.content, wrapHint(hint.text), shell) };
        }
      }
    } catch (error) { fault(error); }
    return decision;
  });

  ctx.inject(['commands'], (local) => {
    local.commands.register({
      name: 'sim',
      description: 'Inspect or manage local SIM failure memory',
      input: { hint: 'status | list | pin <id> | drop <id>' },
      async handler({ agent, rawInput }) {
        try {
          const project = await projects.resolve(ctx.workingDirectory.get(agent.session));
          if (project) return await engine.command(project.project, rawInput);
          return { kind: 'error', text: 'SIM · The current local project is unavailable.' };
        } catch (error) {
          fault(error);
          return { kind: 'error', text: 'SIM · The local ledger is unavailable.' };
        }
      },
    });
  });
  void ledger.refresh().catch(fault);
}
