import { createHash } from 'node:crypto';
import type { Fingerprint } from './types.ts';

export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

const generic = /^(?:error|failed|failure|exit|code|unknown|invalid|exception|at|the|with|in|for|not|was|is|of|a|an|to|line|file|path|time|id|hash|redacted)$/;
const diagnosticCode = /\b(?:[A-Z]{1,10}\d{3,6}|ERR_[A-Z\d_]+|E(?:NOENT|ACCES|PERM|EXIST|INVAL|PIPE)|[A-Za-z]+(?:Error|Exception))\b/g;

export function fingerprint(diagnostic: string, code = ''): Fingerprint | undefined {
  const input = diagnostic.slice(0, 8192).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter((line) =>
    line && !/^(?:at\s|File\s+".*", line \d+|Traceback \(|\[exit code:|\^+$)/i.test(line));
  const errors = lines.filter((line) => /\berror\b|\bfailed\b|\bexception\b|\bfatal\b|\bnot found\b|\bcannot\b|^E\s+|ERR_|[A-Z]{1,10}\d{3,6}/i.test(line));
  const selected = (errors.length ? errors : lines).slice(0, 8).join('\n');
  const normalized = selected
    .replace(/\b\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?)?\b/gi, '<time>')
    .replace(/\b\d\d:\d\d:\d\d(?:[.,]\d+)?\b/g, '<time>')
    .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b|\b0x[0-9a-f]+\b|\b[0-9a-f]{7,}\b/gi, '<id>')
    .replace(/\b(?:tmp|temp)[-_][\w-]{5,}\b/gi, '<id>')
    .replace(/(["'])(?:[A-Za-z]:[\\/]|\\\\|\/)([^"'\r\n]+)\1/g, (_path, quote: string, suffix: string) =>
      `${quote}<path>/${suffix.split(/[\\/]/).at(-1) ?? suffix}${quote}`)
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|(?<![\w./-])\/)(?:[^\s"'`<>:()]+[\\/])*([^\s"'`<>:()/\\]+)/g, '<path>/$1')
    .replace(/:\d+(?::\d+)?\b|\(\d+,\s*\d+\)|\b(?:line|column)\s+\d+\b/gi, ':#')
    .replace(/\b(?:Bearer\s+[^\s,;]+|(?:token|password|api[-_]?key|secret)\s*[:=]\s*[^\s,;]+)\b/gi, '<redacted>')
    .toLowerCase().replace(/\s+/g, ' ').trim();
  const words = normalized.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  const informative = [...new Set(words.filter((word) => !generic.test(word) && !/^\d+$/.test(word)))].slice(0, 72);
  if (informative.length < 2) return undefined;
  // Persist term hashes, not raw diagnostics, which may include private source/output.
  const signals = [...new Set(Array.from(selected.matchAll(diagnosticCode), ([value]) => digest(value.toLowerCase())))].sort();
  return { hash: digest(`${code}\n${normalized}`), terms: informative.map(digest).sort(), signals };
}

/** Conservative lexical match after exact target scoping and exact hash lookup. */
export function similarity(left: Fingerprint, right: Fingerprint): number {
  if (left.hash === right.hash) return 1;
  if (left.terms.length < 5 || right.terms.length < 5 || !left.signals.length ||
      left.signals.join() !== right.signals.join()) return 0;
  const shared = left.terms.filter((term) => right.terms.includes(term)).length;
  const score = shared / (left.terms.length + right.terms.length - shared);
  return score >= 0.8 ? score : 0;
}
