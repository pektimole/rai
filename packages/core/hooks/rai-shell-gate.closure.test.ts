/**
 * Import closure + crash path (finding 2026-11-22, follow-up):
 *  1. Every file the hook loads at runtime (relative imports + bare packages,
 *     plus tsx, package.json, tsconfig) is persistence-protected. Editing any
 *     of it would run attacker code inside the gate.
 *  2. A crash must never fail open: the settings wrapper prints ask when the
 *     hook process dies, and an in-process error also routes to ask.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import { builtinModules, createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import {
  CRASH_OUTPUT,
  decide,
  FALLBACK_POLICY,
  hookCommand,
  loadPolicyFromFile,
  POLICY_PATH,
  SCRIPT_PATH,
} from './rai-shell-gate';

const policy = loadPolicyFromFile(POLICY_PATH);
const CORE_DIR = path.resolve(path.dirname(POLICY_PATH), '..');
const REPO_DIR = path.resolve(CORE_DIR, '../..');
const req = createRequire(path.join(CORE_DIR, 'package.json'));
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/** Walk the hook's runtime imports. Returns local .ts files and resolved package entries. */
function importClosure(entry: string): { local: string[]; packages: string[] } {
  const local = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  const re = /^\s*import\s+(?!type\b)(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  while (queue.length) {
    const file = queue.pop()!;
    if (local.has(file)) continue;
    local.add(file);
    const src = fs.readFileSync(file, 'utf-8');
    for (const m of src.matchAll(re)) {
      const spec = m[1];
      if (BUILTINS.has(spec)) continue;
      if (spec.startsWith('.')) {
        const base = path.resolve(path.dirname(file), spec);
        const resolved = [base, `${base}.ts`, path.join(base, 'index.ts')].find(
          (p) => fs.existsSync(p) && fs.statSync(p).isFile(),
        );
        if (!resolved) throw new Error(`unresolved import ${spec} in ${file}`);
        queue.push(resolved);
      } else {
        packages.add(req.resolve(spec));
      }
    }
  }
  return { local: [...local], packages: [...packages] };
}

function edit(file_path: string) {
  return { tool_name: 'Edit', tool_input: { file_path }, cwd: REPO_DIR };
}

/** Same file as it sits in the protected install (~/rai), so the test holds in CI checkouts too. */
function installed(f: string): string {
  const rel = path.relative(REPO_DIR, f);
  if (rel.startsWith('..')) throw new Error(`closure file outside repo: ${f}`);
  return `~/rai/${rel}`;
}

describe('import closure is protected', () => {
  const closure = importClosure(SCRIPT_PATH);

  it('walker finds the known closure', () => {
    const rel = closure.local.map((f) => path.relative(CORE_DIR, f)).sort();
    expect(rel).toEqual(
      expect.arrayContaining(['action-gate-file-resolve.ts', 'action-gate-shell.ts', 'audit-log.ts', 'hooks/rai-shell-gate.ts']),
    );
    expect(closure.packages.some((p) => p.includes(`${path.sep}js-yaml${path.sep}`))).toBe(true);
  });

  const runtime = [
    path.join(REPO_DIR, 'node_modules/tsx/dist/cli.mjs'),
    path.join(REPO_DIR, 'node_modules/.bin/tsx'),
    path.join(CORE_DIR, 'package.json'),
    path.join(CORE_DIR, 'tsconfig.json'),
  ];

  for (const [label, pol] of [['shipped policy', policy], ['fallback policy', FALLBACK_POLICY]] as const) {
    it(`${label}: Edit on every closure file -> ask`, () => {
      for (const f of [...closure.local, ...closure.packages, ...runtime]) {
        expect(decide(edit(installed(f)), pol).decision, f).toBe('ask');
      }
    });
  }

  it('Bash mentioning audit-log.ts relatively -> ask', () => {
    const v = decide(
      { tool_name: 'Bash', tool_input: { command: 'sed -i "" s/a/b/ packages/core/audit-log.ts' }, cwd: REPO_DIR },
      policy,
    );
    expect(v.decision).toBe('ask');
  });

  it('normal core sources and other projects stay allowed', () => {
    for (const f of [
      path.join(CORE_DIR, 'scanner.ts'),
      path.join(CORE_DIR, 'audit-log.test.ts'),
      '/Users/x/other/package.json',
      '/Users/x/other/node_modules/js-yaml/index.js',
    ]) {
      expect(decide(edit(f), policy).decision, f).toBe('allow');
    }
  });
});

describe('crash path never fails open', () => {
  const askJson = (out: string) => {
    const last = out.trim().split('\n').pop()!;
    return JSON.parse(last).hookSpecificOutput;
  };
  const stdin = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: REPO_DIR });

  it('CRASH_OUTPUT is valid ask JSON, safe inside single quotes', () => {
    expect(JSON.parse(CRASH_OUTPUT).hookSpecificOutput.permissionDecision).toBe('ask');
    expect(CRASH_OUTPUT).not.toContain("'");
  });

  it('hookCommand pins repo tsx + tsconfig (no npx, no cwd resolution)', () => {
    const cmd = hookCommand();
    expect(cmd.startsWith(path.join(REPO_DIR, 'node_modules/.bin/tsx') + ' --tsconfig ')).toBe(true);
    expect(cmd).not.toMatch(/\bnpx\b/);
  });

  it('wrapper: hook script missing (crash) -> ask', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-crash-'));
    try {
      const fakeScript = path.join(REPO_DIR, 'packages/core/hooks/__missing__.ts');
      const out = execSync(hookCommand(fakeScript), { input: stdin, cwd: tmp, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
      expect(askJson(out).permissionDecision).toBe('ask');
      expect(askJson(out).permissionDecisionReason).toMatch(/hook-crash/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('real hook: invalid stdin -> ask, not allow', () => {
    const out = execSync(hookCommand(), { input: '{not json', cwd: os.tmpdir(), encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    expect(askJson(out).permissionDecision).toBe('ask');
  });

  it('real hook from a foreign cwd: git status -> allow', () => {
    const out = execSync(hookCommand(), { input: stdin, cwd: os.tmpdir(), encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    expect(askJson(out).permissionDecision).toBe('allow');
  });

  const settings = path.join(os.homedir(), '.claude/settings.json');
  it.skipIf(!fs.existsSync(settings) || SCRIPT_PATH !== path.join(os.homedir(), 'rai/packages/core/hooks/rai-shell-gate.ts'))(
    'installed settings.json uses hookCommand()',
    () => {
      const s = JSON.parse(fs.readFileSync(settings, 'utf-8'));
      const cmds: string[] = (s.hooks?.PreToolUse ?? []).flatMap((e: any) => e.hooks.map((h: any) => h.command));
      expect(cmds).toContain(hookCommand());
    },
  );
});
