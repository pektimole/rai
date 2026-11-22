/**
 * action-gate-file-resolve.ts — Node-only path resolution for file-write targets.
 *
 * Kept out of action-gate-shell.ts so that module stays a pure function with no
 * fs dependency (it is re-exported from core/index.ts and may be bundled for the
 * browser). The Claude Code hook calls this, then passes the result into
 * evaluateFileTarget as FileAction.resolvedPaths.
 *
 * Approach ported from no5-context/scripts/drain-guard.py (b65871ee):
 *   1. raw:      ~ / $HOME expanded, resolved against cwd, normalized, symlinks NOT followed
 *   2. realpath: symlinks followed (nearest existing ancestor if the file is new)
 *   3. reverse:  if the realpath is the target of a `.git/hooks/*` symlink in the
 *                enclosing repo, add that `.git/hooks/<name>` path too, so a direct
 *                write to e.g. scripts/git-hooks/pre-commit is caught as a git hook.
 *
 * Every candidate is matched against the same persistence_path_patterns, so a
 * symlink pointing INTO a protected dir and a protected symlink pointing OUT to an
 * innocuous-looking path are both caught.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Expand ~ and $HOME / ${HOME}, resolve against cwd, normalize. No symlink resolution. */
export function rawTargetPath(filePath: string, workingDir: string, home = os.homedir()): string {
  let p = filePath.trim().replace(/^['"]|['"]$/g, '');
  p = p.replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  if (p === '~') p = home;
  else if (p.startsWith('~/')) p = path.join(home, p.slice(2));
  return path.normalize(path.resolve(workingDir, p));
}

/** realpath of p; for a not-yet-existing file, realpath of the nearest existing ancestor + rest. */
export function realTargetPath(p: string): string {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p; // nothing resolvable, fall back to raw
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/** Walk up from dir to the first directory containing a `.git` dir. */
function findRepoRoot(dir: string): string | null {
  let cur = dir;
  for (;;) {
    try {
      if (fs.statSync(path.join(cur, '.git')).isDirectory()) return cur;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** `.git/hooks/<name>` entries (in the repo enclosing realPath) whose realpath equals realPath. */
export function gitHookAliases(realPath: string): string[] {
  const root = findRepoRoot(path.dirname(realPath));
  if (!root) return [];
  const hooksDir = path.join(root, '.git', 'hooks');
  let entries: string[];
  try {
    entries = fs.readdirSync(hooksDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const hookPath = path.join(hooksDir, name);
    try {
      if (fs.realpathSync(hookPath) === realPath) out.push(hookPath);
    } catch {
      /* dangling link, skip */
    }
  }
  return out;
}

/**
 * All paths a file-write target should be screened under: raw, realpath, and any
 * `.git/hooks/*` alias. Deduped. Never throws.
 */
export function fileTargetCandidates(filePath: string, workingDir: string, home = os.homedir()): string[] {
  try {
    const raw = rawTargetPath(filePath, workingDir, home);
    const real = realTargetPath(raw);
    return [...new Set([raw, real, ...gitHookAliases(real)])];
  } catch {
    return [];
  }
}
