import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Fingerprint } from './types.ts';

export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

const generic = /^(?:error|failed|failure|exit|code|unknown|invalid|exception|at|the|with|in|for|not|was|is|of|a|an|to|line|file|path|time|id|hash|redacted)$/;
const diagnosticCode = /\b(?:[A-Z]{1,10}\d{3,6}|ERR_[A-Z\d_]+|E(?:NOENT|ACCES|PERM|EXIST|INVAL|PIPE)|[A-Za-z]+(?:Error|Exception))\b/g;
const absolutePath = /^(?:[a-z]:\/|\/)/i;
const diagnosticPath = /(["'])((?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/]|[\w.-]+[\\/])[^"'\r\n]*?)\1|(?<![\w./\\-])((?:[A-Za-z]:[\\/]|[\\/]{1,2}|\.{1,2}[\\/]|[\w.-]+[\\/])(?:[^\s"'`<>:()[\]\/\\,;]+[\\/])*[^\s"'`<>:()[\]\/\\,;]+)/g;

function pathLabel(path: string, cwd?: string): string | undefined {
  const forward = path.replaceAll('\\', '/');
  const normalized = posix.normalize(forward);
  const windows = /^[a-z]:\/|^\/\//i.test(forward) || Boolean(cwd && /^[a-z]:[\\/]|^\\\\/i.test(cwd));
  const canonical = windows ? normalized.toLowerCase() : normalized;
  if (absolutePath.test(canonical)) {
    const root = cwd && posix.normalize(cwd.replaceAll('\\', '/')).replace(/\/$/, '');
    const prefix = root === undefined ? undefined : `${windows ? root.toLowerCase() : root}/`;
    if (prefix && canonical.startsWith(prefix)) return canonical.slice(prefix.length);
    return canonical.replace(/^[a-z]:/i, '').split('/').filter(Boolean).slice(-2).join('/');
  }
  return canonical.includes('/') || forward.startsWith('./') ? canonical : undefined;
}

function boundedSet(values: Iterable<string>): string[] {
  const sorted = [...new Set(values)].sort();
  return sorted.length <= 128 ? sorted : [digest(sorted.join('\n'))];
}

export function fingerprint(diagnostic: string, code = '', cwd?: string): Fingerprint | undefined {
  const input = diagnostic.slice(0, 8192).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter((line) =>
    line && !/^(?:at\s|File\s+".*", line \d+|Traceback \(|\[exit code:|\^+$)/i.test(line));
  const errors = lines.filter((line) => /\berror\b|\bfailed\b|\bexception\b|\bfatal\b|\bnot found\b|\bcannot\b|^E\s+|ERR_|[A-Z]{1,10}\d{3,6}/i.test(line));
  const selected = (errors.length ? errors : lines).slice(0, 8).join('\n');
  const paths = new Set<string>();
  const normalized = selected
    .replace(/\b\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?)?\b/gi, '<time>')
    .replace(/\b\d\d:\d\d:\d\d(?:[.,]\d+)?\b/g, '<time>')
    .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b|\b0x[0-9a-f]+\b|\b(?=[0-9a-f]{7,}\b)(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]+\b/gi, '<id>')
    .replace(/\b(?:tmp|temp)[-_][\w-]{5,}\b/gi, '<id>')
    .replace(/\b(?:Bearer\s+[^\s,;]+|(?:token|password|api[-_]?key|secret)\s*[:=]\s*[^\s,;]+)\b/gi, '<redacted>')
    .replace(/\bpid(?:\s*[:=]\s*|\s+)\d+\b/gi, 'pid <id>')
    .replace(/第\s*\d+\s*行/g, 'line :#').replace(/第\s*\d+\s*列/g, 'column :#')
    .replace(/:\d+(?::\d+)?\b|\(\d+,\s*\d+\)|\b(?:line|column)\s+\d+\b/gi, ':#')
    .replace(diagnosticPath, (original, _quote: string | undefined, quoted: string | undefined, raw: string | undefined) => {
      const path = quoted ?? raw;
      if (!path) return original;
      const suffix = path.endsWith(':#') ? ':#' : '';
      const label = pathLabel(suffix ? path.slice(0, -2) : path, cwd);
      if (!label) return original;
      paths.add(digest(label.toLowerCase()));
      return `<path>/${label}${suffix}`;
    })
    .toLowerCase().replace(/\s+/g, ' ').trim();
  const words = normalized.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  const informative = [...new Set(words.filter((word) => !generic.test(word) && !/^\d+$/.test(word)))].slice(0, 72);
  if (informative.length < 2) return undefined;
  // Persist term hashes, not raw diagnostics, which may include private source/output.
  const signals = boundedSet(Array.from(selected.matchAll(diagnosticCode), ([value]) => digest(value.toLowerCase())));
  return { hash: digest(`${code}\n${normalized}`), terms: informative.map(digest).sort(), signals, paths: boundedSet(paths) };
}

/** Conservative lexical match after exact target scoping and exact hash lookup. */
export function similarity(left: Fingerprint, right: Fingerprint): number {
  if (left.hash === right.hash) return 1;
  if (left.paths?.join() !== right.paths?.join()) return 0;
  if (left.terms.length < 5 || right.terms.length < 5 || !left.signals.length ||
      left.signals.join() !== right.signals.join()) return 0;
  const shared = left.terms.filter((term) => right.terms.includes(term)).length;
  const score = shared / (left.terms.length + right.terms.length - shared);
  return score >= 0.8 ? score : 0;
}
