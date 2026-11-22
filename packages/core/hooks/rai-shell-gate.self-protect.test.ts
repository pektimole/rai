/**
 * RAI self-protection (finding 2026-11-22): the gate's own policy, hook and
 * adapter sources are persistence-sensitive. An agent that can silently edit
 * them can switch the gate off. Edits route to ask, including via symlinks.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { decide, loadPolicyFromFile, POLICY_PATH } from './rai-shell-gate';
import { fileTargetCandidates } from '../action-gate-file-resolve';
import { globToRegExp, loadShellPolicy } from '../action-gate-shell';

const policy = loadPolicyFromFile(POLICY_PATH);
const CORE_DIR = path.resolve(path.dirname(POLICY_PATH), '..');
const REPO_DIR = path.resolve(CORE_DIR, '../..');

function edit(file_path: string, cwd = REPO_DIR) {
  return { tool_name: 'Edit', tool_input: { file_path }, cwd };
}

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-selfprotect-'));
  // Fake repo whose .git/hooks/pre-commit is a symlink to an innocuous-looking path
  // (deliberately not under a "git-hooks/" dir, so only the reverse map catches it).
  fs.mkdirSync(path.join(tmp, 'repo/.git/hooks'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'repo/tools/hookimpl'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'repo/src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'repo/tools/hookimpl/pre-commit'), '#!/bin/sh\n');
  fs.symlinkSync(
    path.join(tmp, 'repo/tools/hookimpl/pre-commit'),
    path.join(tmp, 'repo/.git/hooks/pre-commit'),
  );
  // Innocuous-looking dir symlinked INTO the protected policies dir.
  fs.symlinkSync(path.dirname(POLICY_PATH), path.join(tmp, 'cfg'));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('self-protection: own sources -> ask', () => {
  it('Edit on own policy yaml -> ask', () => {
    const v = decide(edit(POLICY_PATH), policy);
    expect(v.decision).toBe('ask');
    expect(v.rule).toBe('persistence-path');
  });
  it('Edit on own policy yaml, relative path -> ask', () => {
    expect(decide(edit('packages/core/policies/claude-code-shell.yaml'), policy).decision).toBe('ask');
  });
  it('Edit on own hook ts -> ask', () => {
    expect(decide(edit(path.join(CORE_DIR, 'hooks/rai-shell-gate.ts')), policy).decision).toBe('ask');
  });
  it('Write of a new file into own hooks dir -> ask', () => {
    const v = decide(
      { tool_name: 'Write', tool_input: { file_path: path.join(CORE_DIR, 'hooks/new-hook.ts') }, cwd: REPO_DIR },
      policy,
    );
    expect(v.decision).toBe('ask');
  });
  it('Edit on action-gate adapter sources -> ask', () => {
    for (const f of ['action-gate-shell.ts', 'action-gate.ts', 'action-gate-mcp.ts', 'action-gate-file-resolve.ts']) {
      expect(decide(edit(path.join(CORE_DIR, f)), policy).decision, f).toBe('ask');
    }
  });
  it('Bash command touching own policy -> ask', () => {
    const v = decide(
      { tool_name: 'Bash', tool_input: { command: 'sed -i "" s/a/b/ packages/core/policies/claude-code-shell.yaml' }, cwd: REPO_DIR },
      policy,
    );
    expect(v.decision).not.toBe('allow');
  });
});

describe('self-protection: symlinked targets -> ask', () => {
  it('Edit on the real target of a .git/hooks symlink -> ask (reverse map)', () => {
    const target = path.join(tmp, 'repo/tools/hookimpl/pre-commit');
    const v = decide(edit(target, path.join(tmp, 'repo')), policy);
    expect(v.decision).toBe('ask');
    expect(v.reason).toMatch(/\.git\/hooks/);
  });
  it('Edit via a symlinked dir pointing into own policies -> ask (realpath)', () => {
    const v = decide(edit(path.join(tmp, 'cfg/claude-code-shell.yaml'), tmp), policy);
    expect(v.decision).toBe('ask');
    expect(v.reason).toMatch(/resolves to/);
  });
  it('Edit on a git-hooks/ script dir -> ask', () => {
    expect(decide(edit('/Users/tim/no5-context/scripts/git-hooks/pre-commit'), policy).decision).toBe('ask');
  });
  const realNo5Hook = path.join(os.homedir(), 'no5-context/scripts/git-hooks/pre-commit');
  it.skipIf(!fs.existsSync(realNo5Hook))('Edit on real no5-context git-hook target -> ask', () => {
    expect(decide(edit(realNo5Hook, os.homedir()), policy).decision).toBe('ask');
  });
});

describe('self-protection: normal edits -> allow', () => {
  it('Edit on a normal file in a repo with symlinked hooks -> allow', () => {
    fs.writeFileSync(path.join(tmp, 'repo/src/index.ts'), '');
    expect(decide(edit(path.join(tmp, 'repo/src/index.ts'), path.join(tmp, 'repo')), policy).decision).toBe('allow');
  });
  it('Edit on a normal core source -> allow', () => {
    expect(decide(edit(path.join(CORE_DIR, 'scanner.ts')), policy).decision).toBe('allow');
  });
  it('Edit on docs -> allow', () => {
    expect(decide(edit(path.join(REPO_DIR, 'docs/28-rai-actiongate-spec.md')), policy).decision).toBe('allow');
  });
});

describe('self-protection: literal ~/rai globs in policy', () => {
  const globs = [
    '~/rai/packages/core/policies/**',
    '~/rai/packages/core/hooks/**',
    '~/rai/packages/core/action-gate*.ts',
  ];
  it('policy yaml carries the requested globs verbatim', () => {
    const raw = fs.readFileSync(POLICY_PATH, 'utf-8');
    for (const g of globs) expect(raw).toContain(`"${g}"`);
  });
  it('each glob alone routes its targets to ask (raw, expanded, $HOME, Bash)', () => {
    const only = (g: string) => loadShellPolicy({ version: 1, adapter: 'shell', fail_closed: false, persistence_path_patterns: [g] });
    const cases: Array<[string, string]> = [
      [globs[0], '~/rai/packages/core/policies/claude-code-shell.yaml'],
      [globs[0], '/Users/someone/rai/packages/core/policies/sub/deep.yaml'],
      [globs[1], '$HOME/rai/packages/core/hooks/rai-shell-gate.ts'],
      [globs[2], '/home/u/rai/packages/core/action-gate-shell.ts'],
      [globs[2], '/home/u/rai/packages/core/action-gate.ts'],
    ];
    for (const [g, p] of cases) {
      expect(decide(edit(p, '/'), only(g)).decision, `${g} vs ${p}`).toBe('ask');
    }
    expect(
      decide({ tool_name: 'Bash', tool_input: { command: 'sed -i "" s/a/b/ ~/rai/packages/core/hooks/x.ts' }, cwd: '/' }, only(globs[1])).decision,
    ).toBe('ask');
  });
  it('globs do not over-match', () => {
    const p = loadShellPolicy({ version: 1, adapter: 'shell', fail_closed: false, persistence_path_patterns: globs });
    for (const f of [
      '/Users/x/rai/packages/core/index.ts',
      '/Users/x/rai/packages/core/action-gate-shell.tsx',
      '/Users/x/rai/packages/core/sub/action-gate.ts',
      '/Users/x/other/packages/core/policies/a.yaml',
      '/Users/x/rai/packages/core/policiesX/a.yaml',
    ]) {
      expect(decide(edit(f, '/'), p).decision, f).toBe('allow');
    }
  });
  it('globToRegExp: * stays in one segment, ** crosses', () => {
    expect(globToRegExp('~/a/*.ts').test('/Users/u/a/b/c.ts')).toBe(false);
    expect(globToRegExp('~/a/**').test('/Users/u/a/b/c.ts')).toBe(true);
  });
});

describe('fileTargetCandidates', () => {
  it('expands ~ and resolves relative to cwd', () => {
    const c = fileTargetCandidates('~/x/y.txt', '/nowhere', '/home/u');
    expect(c[0]).toBe('/home/u/x/y.txt');
    expect(fileTargetCandidates('a/../b.txt', '/w', '/home/u')[0]).toBe('/w/b.txt');
  });
  it('expands $HOME', () => {
    expect(fileTargetCandidates('$HOME/.zshrc', '/w', '/home/u')[0]).toBe('/home/u/.zshrc');
  });
  it('includes realpath for a not-yet-existing file under a symlinked dir', () => {
    const c = fileTargetCandidates(path.join(tmp, 'cfg/does-not-exist.yaml'), tmp);
    expect(c.some((p) => p === path.join(fs.realpathSync(path.dirname(POLICY_PATH)), 'does-not-exist.yaml'))).toBe(true);
  });
  it('never throws on garbage', () => {
    expect(() => fileTargetCandidates('\0', '/')).not.toThrow();
  });
});
