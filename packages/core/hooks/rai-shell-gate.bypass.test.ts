/**
 * Self-protection bypasses (finding 2026-11-22, follow-up):
 *  1. Write/shell tools outside the original Bash|Write|Edit|MultiEdit matcher
 *     (NotebookEdit, MCP filesystem / no5-mcp writes, MCP shell + terminal).
 *  2. Policy load failure used to fail open, so breaking the YAML once
 *     switched the gate off. Now a hardcoded fallback policy still screens.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import {
  decide,
  evaluateHookInput,
  FALLBACK_POLICY_YAML,
  HOOK_MATCHER,
  loadPolicyFromFile,
  POLICY_PATH,
} from './rai-shell-gate';

const policy = loadPolicyFromFile(POLICY_PATH);
const CORE_DIR = path.resolve(path.dirname(POLICY_PATH), '..');
const REPO_DIR = path.resolve(CORE_DIR, '../..');
const OWN_HOOK = path.join(CORE_DIR, 'hooks/rai-shell-gate.ts');

function call(tool_name: string, tool_input: Record<string, unknown>, cwd = REPO_DIR) {
  return { tool_name, tool_input, cwd };
}

describe('bypass 1: other write tools -> ask on own sources', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['NotebookEdit', { notebook_path: POLICY_PATH, new_source: 'x' }],
    ['mcp__filesystem__write_file', { path: POLICY_PATH, content: '' }],
    ['mcp__filesystem__edit_file', { path: OWN_HOOK, edits: [] }],
    ['mcp__filesystem__move_file', { source: POLICY_PATH, destination: '/tmp/x.yaml' }],
    ['mcp__filesystem__move_file', { source: '/tmp/evil.yaml', destination: POLICY_PATH }],
    ['mcp__82e39fbf-3864-45e2-b982-a935932a3c6e__write_file', { path: '/Users/x/.zshrc', content: '' }],
    ['mcp__82e39fbf-3864-45e2-b982-a935932a3c6e__patch_file', { path: 'scripts/git-hooks/pre-commit' }],
    ['mcp__82e39fbf-3864-45e2-b982-a935932a3c6e__append_to_file', { path: '/Users/x/.claude/settings.json' }],
  ];
  for (const [tool, input] of cases) {
    it(`${tool} ${JSON.stringify(input).slice(0, 80)} -> ask`, () => {
      const v = decide(call(tool, input), policy);
      expect(v.decision).toBe('ask');
      expect(v.rule).toBe('persistence-path');
    });
  }

  it('MCP shell tools are screened like Bash', () => {
    for (const tool of ['mcp__shell__execute_command', 'mcp__terminal__run_in_terminal']) {
      expect(decide(call(tool, { command: `sed -i "" s/a/b/ ${POLICY_PATH}` }), policy).decision, tool).toBe('ask');
      expect(decide(call(tool, { command: 'git push --force origin main' }), policy).decision, tool).toBe('deny');
      expect(decide(call(tool, { command: 'git status', cwd: '/tmp' }), policy).decision, tool).toBe('allow');
    }
  });

  it('normal targets stay allowed', () => {
    expect(decide(call('NotebookEdit', { notebook_path: path.join(REPO_DIR, 'nb.ipynb') }), policy).decision).toBe('allow');
    expect(decide(call('mcp__filesystem__write_file', { path: path.join(CORE_DIR, 'scanner.ts') }), policy).decision).toBe('allow');
    expect(
      decide(call('mcp__filesystem__move_file', { source: '/tmp/a.txt', destination: '/tmp/b.txt' }), policy).decision,
    ).toBe('allow');
  });

  it('read-only MCP tools stay out of scope', () => {
    expect(decide(call('mcp__filesystem__read_file', { path: POLICY_PATH }), policy).rule).toBe('not-gated');
  });

  it('HOOK_MATCHER routes every gated tool to the hook, not read tools', () => {
    const re = new RegExp(`^(?:${HOOK_MATCHER})$`);
    for (const t of [
      'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
      'mcp__filesystem__write_file', 'mcp__filesystem__edit_file', 'mcp__filesystem__move_file',
      'mcp__82e39fbf-3864-45e2-b982-a935932a3c6e__write_file',
      'mcp__82e39fbf-3864-45e2-b982-a935932a3c6e__patch_file',
      'mcp__82e39fbf-3864-45e2-b982-a935932a3c6e__append_to_file',
      'mcp__shell__execute_command', 'mcp__terminal__run_in_terminal',
    ]) {
      expect(re.test(t), t).toBe(true);
    }
    for (const t of ['Read', 'Grep', 'mcp__filesystem__read_file', 'mcp__terminal__read_terminal']) {
      expect(re.test(t), t).toBe(false);
    }
  });
});

describe('bypass 2: policy load failure -> fallback policy, not fail-open', () => {
  let tmp: string;
  let broken: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-fallback-'));
    broken = path.join(tmp, 'broken.yaml');
    fs.writeFileSync(broken, 'version: 1\nadapter: shell\nblocked_patterns: [\n  "unterminated\n');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  for (const [label, p] of [['missing', '/nonexistent/rai/policy.yaml'], ['broken yaml', '']] as const) {
    it(`${label}: Edit on own policy -> ask`, () => {
      const r = evaluateHookInput(call('Edit', { file_path: POLICY_PATH }), p || broken);
      expect(r.policyLoaded).toBe(false);
      expect(r.verdict.decision).toBe('ask');
      expect(r.verdict.rule).toBe('policy-load-failed/persistence-path');
      expect(r.verdict.reason).toMatch(/^policy load failed/);
    });
    it(`${label}: git push --force -> deny`, () => {
      const r = evaluateHookInput(call('Bash', { command: 'git push --force' }), p || broken);
      expect(r.verdict.decision).toBe('deny');
    });
    it(`${label}: normal edit -> allow`, () => {
      const r = evaluateHookInput(call('Edit', { file_path: path.join(CORE_DIR, 'scanner.ts') }), p || broken);
      expect(r.verdict.decision).toBe('allow');
      expect(r.verdict.rule).toBe('policy-load-failed');
    });
  }

  it('wrong schema (version 2) also falls back', () => {
    const v2 = path.join(tmp, 'v2.yaml');
    fs.writeFileSync(v2, 'version: 2\nadapter: shell\n');
    expect(evaluateHookInput(call('Write', { file_path: OWN_HOOK }), v2).verdict.decision).toBe('ask');
  });

  it('real policy loads normally', () => {
    const r = evaluateHookInput(call('Bash', { command: 'git status' }));
    expect(r.policyLoaded).toBe(true);
    expect(r.verdict.decision).toBe('allow');
  });

  it('fallback lists are a subset of the shipped YAML (no drift)', () => {
    const shipped = yaml.load(fs.readFileSync(POLICY_PATH, 'utf-8')) as Record<string, string[]>;
    for (const key of ['blocked_commands', 'blocked_patterns', 'ask_patterns', 'persistence_path_patterns'] as const) {
      for (const entry of (FALLBACK_POLICY_YAML as any)[key] as string[]) {
        expect(shipped[key], `${key}: ${entry}`).toContain(entry);
      }
    }
    // every shipped persistence path is mirrored (self-protection must not depend on the YAML)
    expect(FALLBACK_POLICY_YAML.persistence_path_patterns).toEqual(shipped.persistence_path_patterns);
  });
});
