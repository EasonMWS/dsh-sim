import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { digest } from './fingerprint.ts';

export interface Project { project: string; directory: string; cwd: string; }
const maxPaths = 256;
const ttl = 60_000;

export function isInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function canonical(path: string): string {
  const normalized = normalize(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export class Projects {
  private readonly cache = new Map<string, { expires: number; project: Promise<Project | undefined> }>();

  resolve(base: string, override?: string): Promise<Project | undefined> {
    if (!isAbsolute(base)) return Promise.resolve(undefined);
    const path = resolve(base, override ?? '.');
    const key = canonical(path);
    const existing = this.cache.get(key);
    if (existing && existing.expires > Date.now()) return existing.project;
    this.cache.delete(key);
    if (this.cache.size >= maxPaths) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    const project = findProject(path);
    this.cache.set(key, { expires: Date.now() + ttl, project });
    return project;
  }
}

async function findProject(path: string): Promise<Project | undefined> {
  let cwd: string;
  try {
    cwd = await realpath(path);
    if (!(await stat(cwd)).isDirectory()) return undefined;
  } catch { return undefined; }
  let root = cwd;
  for (let candidate = cwd; ; candidate = dirname(candidate)) {
    const git = await stat(join(candidate, '.git')).catch(() => undefined);
    if (git?.isDirectory() || git?.isFile()) {
      root = candidate;
      break;
    }
    if (dirname(candidate) === candidate) break;
  }
  return { project: digest(canonical(root)), directory: digest(canonical(cwd)), cwd };
}
