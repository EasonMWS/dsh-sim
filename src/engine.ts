import { digest, fingerprint, similarity } from './fingerprint.ts';
import { COLD_AFTER, isHot, type LedgerStore } from './ledger.ts';
import { relatedInputs } from './recipes.ts';
import { HINT_END, HINT_OPEN } from './surface.ts';
import type { Entry, FailedAttempt, Fingerprint, Hint, Ledger, Outcome, Rationale, Recipe, ToolCall } from './types.ts';

const MAX_STEPS = 4;
const MAX_TASKS_PER_TURN = 24;
const MAX_HINTS_PER_TURN = 8;
const FIELD_LIMIT = 500;
const HINT_BYTES = 100;
const NO_CHANGE: Extract<Rationale, { kind: 'verified_retry' }> = { kind: 'verified_retry', text: 'The same input passed after an observed project edit.' };
const INDEX_KEY = (project: string, directory: string, tool: string, task: string) => JSON.stringify([project, directory, tool, task]);
const callKey = (call: ToolCall) => INDEX_KEY(call.project, call.directory, call.tool, call.recipe.task);
const entryKey = ({ context: c }: Entry) => INDEX_KEY(c.project, c.directory, c.tool, c.task);

interface Track {
  attempts: FailedAttempt[];
  lastStep: number;
  validationOnly: boolean;
}

interface Offered { entry: Entry; step: number; }
interface Turn {
  turn: number;
  model: string;
  tasks: Map<string, Track>;
  edits: Map<string, { step: number; path?: string }[]>;
  offered: Map<string, Offered>;
  used: Set<string>;
  hintStep: number;
}

function diff(failed: Recipe, fix: Recipe, paths: string[]): Rationale {
  if (failed.key === fix.key) return paths.length ? { ...NO_CHANGE, paths } : NO_CHANGE;
  if (failed.shape === 'arguments' && fix.shape === 'arguments') {
    const before = JSON.parse(failed.input) as Record<string, unknown>;
    const after = JSON.parse(fix.input) as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => before[key] !== after[key]);
    const fields = (side: Record<string, unknown>) => keys.map((key) => `${key}=${Object.hasOwn(side, key) ? JSON.stringify(side[key]) : '(omitted)'}`).join(', ').slice(0, FIELD_LIMIT);
    return { kind: 'input_diff', from: fields(before), to: fields(after) };
  }
  return { kind: 'input_diff', from: failed.input.slice(0, FIELD_LIMIT), to: fix.input.slice(0, FIELD_LIMIT) };
}

function addEvidence(existing: Entry['modelEvidence'], attempts: FailedAttempt[]): Entry['modelEvidence'] {
  const result = new Map(existing.map(({ model_id, keys }) => [model_id, [...keys]]));
  for (const { model_id, recipe } of attempts) {
    const keys = result.get(model_id) ?? [];
    result.set(model_id, [...new Set([...keys, recipe.key])].slice(-8));
  }
  return [...result].slice(-16).map(([model_id, keys]) => ({ model_id, keys }));
}

function confidence(value: number): number { return Math.max(0, Math.min(100, value)); }

function boost(entry: Entry, now: number): void {
  entry.state = 'active';
  entry.lastHitAt = now;
  entry.verifiedAt = now;
  entry.consecutiveMisses = 0;
  entry.confidence = confidence(entry.confidence + 15);
}

function grade(entry: Entry, actual: Fingerprint): number {
  return Math.max(...entry.failed_attempts.map(({ fingerprint: previous }) => similarity(previous, actual)));
}

function choose(entries: Entry[], actual: Fingerprint, call: ToolCall): Entry | undefined {
  const scored = entries.map((entry) => ({
    entry, score: grade(entry, actual),
    exactRecipe: entry.failed_attempts.some(({ recipe }) => recipe.key === call.recipe.key),
  })).filter(({ entry, score, exactRecipe }) => score > 0 &&
    (exactRecipe || entry.failed_attempts.some(({ recipe }) => relatedInputs(recipe, call.recipe))));
  scored.sort((a, b) => b.score - a.score || Number(b.exactRecipe) - Number(a.exactRecipe) ||
    Number(b.entry.state === 'active') - Number(a.entry.state === 'active') || b.entry.confidence - a.entry.confidence);
  const [best, next] = scored;
  if (!best || (best.score < 1 && (best.entry.state === 'stale' || !best.exactRecipe))) return undefined;
  if (next && next.entry.verified_fix.recipe.key !== best.entry.verified_fix.recipe.key &&
      best.score - next.score < 0.1 && best.exactRecipe === next.exactRecipe) return undefined;
  return best.entry;
}

function boundedIdentity(value: string): string {
  if (value.length <= FIELD_LIMIT) return value;
  return `${value.slice(0, FIELD_LIMIT - 65)}:${digest(value)}`;
}

function bytePreview(value: string, budget: number): string {
  if (Buffer.byteLength(value) <= budget) return value;
  if (budget < 3) return '';
  let result = '';
  let remaining = budget - 3;
  for (const char of value) {
    remaining -= Buffer.byteLength(char);
    if (remaining < 0) break;
    result += char;
  }
  return `${result}…`;
}

function format(entry: Entry, mode: Hint['mode']): Hint | undefined {
  const latest = entry.failed_attempts.at(-1)!;
  const prior = entry.failed_attempts.find((attempt) => attempt.recipe.key !== entry.verified_fix.recipe.key) ?? latest;
  // Reserve bytes for the tool-result separator, marker and Cordis error prefix.
  const limit = HINT_BYTES - Buffer.byteLength(HINT_END) - 7;
  const recipe = entry.verified_fix.recipe.input;
  const label = entry.rationale.kind === 'verified_retry' ? 'Passed after edit: ' : 'Verified input: ';
  if (Buffer.byteLength(HINT_OPEN + label + recipe) > limit) {
    if (mode === 'pre') return undefined;
    const prefix = `${HINT_OPEN}Verified preview: `;
    const suffix = '\nFull input: /sim list';
    return { id: entry.id, mode, text: prefix + bytePreview(recipe, limit - Buffer.byteLength(prefix + suffix)) + suffix };
  }
  const budget = limit - Buffer.byteLength(HINT_OPEN + label + recipe);
  const source = prior.model_id.replace(/\p{C}/gu, '?');
  const detail = budget >= 14 ? bytePreview(`${source}; failed ${prior.recipe.input}`, budget - 1) + '\n' : '';
  return { id: entry.id, mode, text: HINT_OPEN + detail + label + recipe };
}

export class SimEngine {
  readonly ledger: LedgerStore;
  private readonly clock: () => number;
  private readonly turns = new Map<string, Turn>();
  private indexed?: Ledger;
  private nextExpiry = 0;
  private readonly hot = new Map<string, Entry[]>();

  constructor(ledger: LedgerStore, clock: () => number = Date.now) {
    this.ledger = ledger;
    this.clock = clock;
  }

  hasPending(session: string): boolean {
    const turn = this.turns.get(session);
    return Boolean(turn && (turn.tasks.size || turn.offered.size));
  }

  endTurn(session: string, turn?: number): void {
    if (turn === undefined || this.turns.get(session)?.turn === turn) this.turns.delete(session);
  }

  recordEdit(call: Omit<ToolCall, 'tool' | 'recipe'>, path?: string): void {
    const turn = this.turnFor({ ...call, model: boundedIdentity(call.model) });
    if (!turn?.tasks.size) return;
    const key = JSON.stringify([call.project, call.directory]);
    if (!turn.edits.has(key) && turn.edits.size >= MAX_TASKS_PER_TURN) return;
    const history = turn.edits.get(key) ?? [];
    turn.edits.set(key, [...history, { step: call.step, path: path?.slice(0, FIELD_LIMIT) }].slice(-3));
  }

  private turnFor(call: Pick<ToolCall, 'session' | 'turn' | 'model'>, create = false): Turn | undefined {
    let turn = this.turns.get(call.session);
    if (turn?.turn !== call.turn || turn.model !== call.model) {
      if (!create) return undefined;
      if (this.turns.size >= 256) {
        const oldest = this.turns.keys().next().value;
        if (oldest !== undefined) this.turns.delete(oldest);
      }
      turn = { turn: call.turn, model: call.model, tasks: new Map(), edits: new Map(), offered: new Map(), used: new Set(), hintStep: -1 };
      this.turns.set(call.session, turn);
    }
    return turn;
  }

  private candidates(key: string): Entry[] {
    const current = this.ledger.snapshot();
    const now = this.clock();
    if (this.indexed !== current || now >= this.nextExpiry) {
      this.hot.clear();
      this.nextExpiry = Infinity;
      for (const entry of current.entries) {
        if (!isHot(entry, now)) continue;
        const group = entryKey(entry);
        const bucket = this.hot.get(group) ?? [];
        bucket.push(entry);
        this.hot.set(group, bucket);
        this.nextExpiry = Math.min(this.nextExpiry, (entry.lastHitAt ?? entry.verifiedAt) + COLD_AFTER);
      }
      this.indexed = current;
    }
    return this.hot.get(key) ?? [];
  }

  private offer(entry: Entry, turn: Turn, key: string, step: number, mode: Hint['mode']): Hint | undefined {
    if (turn.hintStep === step || turn.used.has(entry.id) || turn.used.size >= MAX_HINTS_PER_TURN) return undefined;
    const hint = format(entry, mode);
    if (!hint) return undefined;
    turn.used.add(entry.id);
    turn.hintStep = step;
    turn.offered.set(key, { entry, step });
    return hint;
  }

  before(call: ToolCall): Hint | undefined {
    call = { ...call, model: boundedIdentity(call.model), tool: boundedIdentity(call.tool) };
    const key = callKey(call);
    const matches = this.candidates(key).filter((entry) =>
      entry.state === 'active' && entry.verified_fix.recipe.key !== call.recipe.key && entry.rationale.kind === 'input_diff' &&
      entry.modelEvidence.some(({ model_id, keys }) => model_id === call.model && keys.includes(call.recipe.key)) &&
      (entry.scope === 'project' || entry.context.model_id === call.model) &&
      (entry.pinned || (entry.verifiedEpisodes >= 3 && entry.confidence >= 75 && entry.modelEvidence.length >= 2)));
    if (matches.length !== 1) return undefined;
    return this.offer(matches[0]!, this.turnFor(call, true)!, key, call.step, 'pre');
  }

  async observe(call: ToolCall, outcome: Outcome): Promise<Hint | undefined> {
    call = { ...call, model: boundedIdentity(call.model), tool: boundedIdentity(call.tool) };
    const actual = outcome.kind === 'failure' ? fingerprint(outcome.diagnostic, outcome.code, call.cwd) : undefined;
    const turn = this.turnFor(call, actual !== undefined);
    if (!turn) return undefined;
    const key = callKey(call);
    const track = turn.tasks.get(key);
    for (const [pendingKey, pending] of turn.offered) {
      if (call.step - pending.step > MAX_STEPS) turn.offered.delete(pendingKey);
    }
    const offered = turn.offered.get(key);
    let credited: string | undefined;
    if (offered && call.step > offered.step) {
      const usedFix = call.recipe.key === offered.entry.verified_fix.recipe.key;
      const sameError = actual !== undefined && grade(offered.entry, actual) > 0 &&
        offered.entry.failed_attempts.some(({ recipe }) => relatedInputs(recipe, call.recipe));
      if (usedFix || sameError) {
        turn.offered.delete(key);
        await this.recordFeedback(offered.entry.id, outcome.kind === 'failure');
        if (outcome.kind === 'success') credited = offered.entry.id;
      }
    }

    if (outcome.kind === 'success') {
      if (track && call.step > track.lastStep) {
        turn.tasks.delete(key);
        const edits = (turn.edits.get(JSON.stringify([call.project, call.directory])) ?? [])
          .filter(({ step }) => step > track.lastStep && step < call.step);
        const attempts = track.attempts.filter(({ recipe }) => relatedInputs(recipe, call.recipe));
        const changed = attempts.length > 0 && attempts.every(({ recipe }) => recipe.key !== call.recipe.key);
        const edited = attempts.length > 0 && !track.validationOnly && edits.length > 0;
        if (call.step - track.lastStep <= MAX_STEPS && (changed || edited)) {
          const paths = [...new Set(edits.flatMap(({ path }) => path ? [path] : []))];
          await this.verify(call, attempts, paths, credited);
        }
      }
      return undefined;
    }

    if (!actual) return undefined;
    const compatible = track && call.step >= track.lastStep && call.step - track.lastStep <= MAX_STEPS &&
      track.validationOnly === (outcome.code === 'INVALID_ARGS') &&
      track.attempts.some((attempt) => relatedInputs(attempt.recipe, call.recipe) && similarity(attempt.fingerprint, actual) > 0);
    const existing = compatible ? track.attempts : [];
    if (!turn.tasks.has(key) && turn.tasks.size >= MAX_TASKS_PER_TURN) {
      const oldest = turn.tasks.keys().next().value;
      if (oldest !== undefined) turn.tasks.delete(oldest);
    }
    turn.tasks.set(key, {
      attempts: [...existing.filter((attempt) => attempt.recipe.key !== call.recipe.key),
        { recipe: call.recipe, fingerprint: actual, model_id: call.model }].slice(-3),
      lastStep: call.step,
      validationOnly: outcome.code === 'INVALID_ARGS',
    });
    await this.ledger.refresh();
    if (this.turns.get(call.session) !== turn) return undefined;
    const entry = choose(this.candidates(key).filter((item) =>
      item.verified_fix.recipe.key !== call.recipe.key || item.rationale.kind === 'verified_retry'), actual, call);
    return entry && this.offer(entry, turn, key, call.step, 'post');
  }

  private async recordFeedback(id: string, failed: boolean): Promise<void> {
    const now = this.clock();
    await this.ledger.update(({ entries }) => {
      const entry = entries.find((item) => item.id === id && item.state !== 'archived');
      if (!entry) return false;
      if (failed) {
        entry.lastHitAt = now;
        entry.confidence = confidence(entry.confidence - 25);
        entry.consecutiveMisses++;
        entry.state = entry.consecutiveMisses >= 2 ? 'archived' : 'stale';
      } else boost(entry, now);
      return true;
    });
  }

  private async verify(call: ToolCall, attempts: FailedAttempt[], paths: string[], credited?: string): Promise<void> {
    const now = this.clock();
    const key = callKey(call);
    const latest = attempts.at(-1)!;
    await this.ledger.update(({ entries }) => {
      const matches = entries.filter((entry) => entryKey(entry) === key && entry.failed_attempts.some((attempt) =>
        attempts.some((failure) => failure.recipe.key === attempt.recipe.key && failure.fingerprint.hash === attempt.fingerprint.hash)));
      const same = matches.find((entry) => entry.state !== 'archived' && entry.verified_fix.recipe.key === call.recipe.key);
      const prior = same ?? matches.find((entry) => entry.state !== 'archived') ?? matches.at(-1);
      // Archival needs a fresh verified episode to create a new active record.
      const evidence = addEvidence(prior?.modelEvidence ?? [], attempts);
      const scope = evidence.length === 1 && ((prior?.verifiedEpisodes ?? 0) + 1 >= 2)
        ? 'model_scoped' : 'project';
      if (same) {
        const distinct = new Map([...same.failed_attempts, ...attempts].map((attempt) => [attempt.recipe.key, attempt]));
        same.failed_attempts = [...distinct.values()].slice(-3);
        same.modelEvidence = evidence;
        same.scope = scope;
        same.verifiedEpisodes++;
        if (same.id !== credited) boost(same, now);
        return true;
      }
      if (prior) prior.state = 'archived';
      entries.push({
        id: digest(JSON.stringify([key, latest.fingerprint.hash, call.recipe.key, prior?.id ?? ''])).slice(0, 16),
        context: { project: call.project, directory: call.directory, tool: call.tool, task: call.recipe.task, model_id: latest.model_id },
        failed_attempts: attempts,
        verified_fix: { recipe: call.recipe, model_id: call.model },
        rationale: diff(attempts.find(({ recipe }) => recipe.key === call.recipe.key)?.recipe ?? latest.recipe, call.recipe, paths),
        scope, state: 'active', pinned: false, verifiedEpisodes: 1, confidence: 55,
        consecutiveMisses: 0, modelEvidence: evidence, createdAt: now, verifiedAt: now, lastHitAt: null,
        ...(prior ? { supersedes: prior.id } : {}),
      });
      return true;
    });
  }

  async command(project: string, input: string): Promise<{ kind: 'success' | 'error'; text: string }> {
    const [action, id, extra] = input.trim().split(/\s+/);
    if (extra || !action || !['status', 'list', 'pin', 'drop'].includes(action) ||
        ((action === 'pin' || action === 'drop') !== Boolean(id))) {
      return { kind: 'error', text: '/sim status | /sim list | /sim pin <id> | /sim drop <id>' };
    }
    const getProject = (ledger: Ledger) => ledger.entries.filter((entry) => entry.context.project === project);
    await this.ledger.refresh(true);
    const entries = getProject(this.ledger.snapshot());
    if (action === 'status') {
      const now = this.clock();
      const hot = entries.filter((entry) => isHot(entry, now));
      return { kind: 'success', text: `SIM · ${hot.length} hot (${hot.filter(({ state }) => state === 'stale').length} stale) · ${entries.length - hot.length} cold/archived · ${entries.filter(({ pinned }) => pinned).length} pinned` };
    }
    if (action === 'list') {
      const latest = entries.slice().sort((a, b) => b.verifiedAt - a.verifiedAt).slice(0, 25);
      const lines = latest.map((entry) => `${entry.id} ${entry.state}${entry.pinned ? ' pinned' : ''} ${entry.scope} ${entry.context.tool} — ${entry.verified_fix.recipe.input}`);
      return { kind: 'success', text: lines.length ? lines.join('\n') + (entries.length > 25 ? `\nShowing 25 of ${entries.length}` : '') : 'SIM · No verified entries for this project.' };
    }
    let changed = false;
    await this.ledger.update((ledger) => {
      const entry = getProject(ledger).find((item) => item.id === id);
      if (!entry || (action === 'pin' && entry.state === 'archived')) return false;
      if (action === 'drop') ledger.entries = ledger.entries.filter((item) => item !== entry);
      else entry.pinned = true;
      changed = true;
      return true;
    });
    return changed ? { kind: 'success', text: `SIM · ${action === 'pin' ? 'pinned' : 'dropped'} ${id}` } :
      { kind: 'error', text: 'SIM · Entry unavailable for this action in the current project.' };
  }
}
