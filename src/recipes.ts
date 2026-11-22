import { digest } from './fingerprint.ts';
import type { Recipe } from './types.ts';

const sensitive = /(?:(?:^|[\W_])(?:token|secret|password|passwd|authorization|bearer|api[-_]?key|credential|private[-_]?key)(?:$|[\W_])|\bsk-[\w-]+|[a-z]+:\/\/|\b(?:AKIA|gh[pousr]_)[\w-]+|-----BEGIN)/i;
const unsafeText = /[\p{C}`]/u;
const presentation = new Set(['description', 'title', 'workdir', 'run_in_background', 'sandbox_permissions', 'justification']);
const targetKey = /^(?:file(?:_?path)?|path|target|directory|pattern|query|command|script|module|test)$/i;
const targetOption = /^(?:--(?:filter|workspace|workspaces|project|prefix|cwd|root|dir|directory|package|test-name-pattern|testNamePattern|config|grep|select|scope|ignore|exclude|include|grep-invert|runTestsByPath|testPathPatterns?)(?:=|$)|-[Cwk](?:=|$))/;
const executionOption = /^(?:--(?:no-restore|no-build|offline|quiet|verbose)|-[qv])$/;

export const isShell = (tool: string): boolean => /^(?:bash|pwsh)(?:_persistent)?$/.test(tool);

export function reusablePath(path: string): string | undefined {
  return path && path.length <= 150 && !sensitive.test(path) && !unsafeText.test(path) ? path : undefined;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

function comparableShell(command: string): string | undefined {
  // A single simple invocation only. Chaining, interpolation and redirection can
  // hide a changed task or make a trailing success command mask an earlier error.
  if (/[;&|<>$`\r\n]/.test(command)) return undefined;
  const words = command.match(/(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'])+/g);
  if (!words?.length || words.join('').replace(/\s+/g, '') !== command.replace(/\s+/g, '')) return undefined;
  const [executable = '', ...args] = words;
  const bin = executable.toLowerCase().replace(/\.(?:exe|cmd|ps1)$/, '');
  if (/^(?:npm|pnpm|yarn|bun)$/.test(bin)) {
    if (args[0] === 'run' || args[0] === 'run-script') args.shift();
    const known = args[0] ?? '';
    if (/^(?:test|lint|build|check|typecheck|format|verify)(?::[\w-]+)*$/.test(known)) {
      const separator = args.indexOf('--');
      const position = separator === -1 ? args.length : separator;
      return JSON.stringify(['js-script', ...args.slice(0, position).filter((arg) => !arg.startsWith('-') || targetOption.test(arg)),
        ...args.slice(position + 1)]);
    }
    if (['install', 'i', 'ci'].includes(known)) {
      if (args.slice(1).some((arg) => !arg.startsWith('-') || targetOption.test(arg))) return undefined;
      return 'js-install';
    }
  }
  // Retain targets and unknown option values. A few common execution flags
  // can be removed during a retry without changing the requested operation.
  return JSON.stringify([bin, ...args.filter((arg) => !executionOption.test(arg))]);
}

export function makeRecipe(tool: string, input: unknown, validation = false): Recipe | undefined {
  if (input === null || Array.isArray(input) || typeof input !== 'object') return undefined;
  const args = input as Record<string, unknown>;
  if (args.run_in_background || args.sandbox_permissions || args.justification) return undefined;
  if (isShell(tool) && !validation && typeof args.command === 'string') {
    const command = args.command.trim();
    if (!command || command.length > 150 || sensitive.test(command) || unsafeText.test(command)) return undefined;
    const task = comparableShell(command);
    if (task === undefined) return undefined;
    return { input: command, task: digest(task), key: digest(command), shape: 'shell' };
  }
  const meaningful = Object.fromEntries(Object.entries(args).filter(([key]) => !presentation.has(key)));
  const entries = Object.entries(meaningful);
  if (entries.some(([key, value]) => sensitive.test(key) || /^(?:content|text|body|replacement|(?:old|new|file)[_-]?(?:text|str|string))$/i.test(key) ||
    (value !== null && typeof value === 'object') || (typeof value === 'string' && (sensitive.test(value) || unsafeText.test(value))))) return undefined;
  const normalized = JSON.stringify(stable(meaningful));
  if (normalized.length > 150) return undefined;
  const targets = entries.filter(([key, value]) => targetKey.test(key) && typeof value === 'string');
  // Beyond targeted operations, require a shared parameter or an empty side
  // and at most one changed field when verifying a retry (see relatedInputs).
  return { input: normalized, key: digest(normalized), task: digest(JSON.stringify(stable(Object.fromEntries(targets)))), shape: 'arguments' };
}

export function relatedInputs(left: Recipe, right: Recipe): boolean {
  if (left.task !== right.task || left.shape !== right.shape) return false;
  if (left.shape === 'shell' || left.key === right.key) return true;
  const a = JSON.parse(left.input) as Record<string, unknown>;
  const b = JSON.parse(right.input) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const changes = keys.filter((key) => a[key] !== b[key]);
  return changes.length === 1 && (keys.length === 1 || keys.some((key) => a[key] !== undefined && a[key] === b[key]));
}
