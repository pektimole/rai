/**
 * Persistence follow-ups (finding 2026-11-22):
 *  1. Scripts other Claude Code hooks run (derived from settings.json hook
 *     commands, plus ~/.claude/hooks|local-mods|plugins) -> ask on write.
 *  2. crontab / launchctl load via shell -> ask.
 *  3. Scheduled-task tools (CronCreate, RemoteTrigger, MCP scheduled tasks) -> ask.
 *  4. npm/pnpm/yarn/bun install|ci|update in ~/rai (the hook runtime) -> ask.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import {
  claudeSettingsFiles,
  decide,
  evaluateHookInput,
  FALLBACK_POLICY,
  hookScriptPaths,
  hookScriptPatterns,
  loadPolicyFromFile,
  POLICY_PATH,
  REPO_ROOT,
  withPersistencePaths,
} from './rai-shell-gate';

const policy = loadPolicyFromFile(POLICY_PATH);
const CORE_DIR = path.resolve(path.dirname(POLICY_PATH), '..');
const REPO_DIR = path.resolve(CORE_DIR, '../..');
const POLICIES = [['shipped policy', policy], ['fallback policy', FALLBACK_POLICY]] as const;

const bash = (command: string, cwd = '/tmp') => ({ tool_name: 'Bash', tool_input: { command }, cwd });
const edit = (file_path: string, cwd = '/tmp') => ({ tool_name: 'Edit', tool_input: { file_path }, cwd });

describe('1. hook scripts from settings.json', () => {
  let tmp: string;
  let home: string;
  let settings: string;
  let inHome: string;
  let outside: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-hookscripts-'));
    home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.claude/hooks'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'opt'), { recursive: true });
    inHome = path.join(home, 'scripts/guard.py');
    outside = path.join(tmp, 'opt/run-me.sh');
    fs.mkdirSync(path.dirname(inHome), { recursive: true });
    fs.writeFileSync(inHome, '');
    fs.writeFileSync(outside, '');
    settings = path.join(home, '.claude/settings.json');
    fs.writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: `python3 ~/scripts/guard.py --auto` }] }],
          SessionStart: [{ hooks: [{ type: 'command', command: `cd ${home} && ${outside} start` }] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/bin/env node $HOME/missing.js' }] }],
        },
      }),
    );
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('extracts scripts, skips interpreters and directories, keeps missing scripts', () => {
    const paths = hookScriptPaths([settings, path.join(tmp, 'nope.json')], home, '').sort();
    // existing scripts also contribute their realpath (/var -> /private/var on macOS)
    const want = new Set([inHome, path.join(home, 'missing.js'), outside, fs.realpathSync(inHome), fs.realpathSync(outside)]);
    expect(paths).toEqual([...want].sort());
  });

  it('invalid settings JSON is skipped', () => {
    const bad = path.join(tmp, 'bad.json');
    fs.writeFileSync(bad, '{not json');
    expect(hookScriptPaths([bad], home)).toEqual([]);
  });

  it('derived patterns ask on Edit + Bash, across ~ / expanded spellings; others allow', () => {
    const pol = withPersistencePaths(policy, hookScriptPatterns(hookScriptPaths([settings], home), home));
    expect(decide(edit(inHome), pol).decision).toBe('ask');
    expect(decide(edit(outside), pol).decision).toBe('ask');
    expect(decide(bash('echo x >> ~/scripts/guard.py'), pol).decision).toBe('ask');
    expect(decide(bash(`echo x > ${outside}`), pol).decision).toBe('ask');
    expect(decide(edit(path.join(home, 'scripts/other.py')), pol).decision).toBe('allow');
    expect(decide(edit(`${outside}.bak`), pol).decision).toBe('allow');
    expect(decide(edit(path.join(home, 'notes.md')), pol).decision, 'home dir itself not protected').toBe('allow');
  });

  it('evaluateHookInput adds derived patterns (shipped and fallback policy)', () => {
    expect(evaluateHookInput(edit(outside), POLICY_PATH, [settings]).verdict.decision).toBe('ask');
    const r = evaluateHookInput(edit(outside), '/nonexistent/policy.yaml', [settings]);
    expect(r.policyLoaded).toBe(false);
    expect(r.verdict.decision).toBe('ask');
    expect(evaluateHookInput(edit(path.join(tmp, 'opt/free.sh')), POLICY_PATH, [settings]).verdict.decision).toBe('allow');
  });

  it('claudeSettingsFiles covers user + project settings', () => {
    expect(claudeSettingsFiles('/p', '/h')).toEqual([
      '/h/.claude/settings.json',
      '/h/.claude/settings.local.json',
      '/p/.claude/settings.json',
      '/p/.claude/settings.local.json',
    ]);
  });

  for (const [label, pol] of POLICIES) {
    it(`${label}: static ~/.claude/hooks|local-mods|plugins -> ask`, () => {
      for (const f of [
        '/Users/x/.claude/hooks/wake-enforcer.sh',
        '/Users/x/.claude/local-mods/no5-guard/hooks/hooks.json',
        '/Users/x/.claude/plugins/cache/foo/hooks/run.js',
      ]) {
        expect(decide(edit(f), pol).decision, f).toBe('ask');
      }
      expect(decide(edit('/Users/x/.claude/projects/p/memory/a.md'), pol).decision).toBe('allow');
    });
  }

  const real = path.join(os.homedir(), '.claude/settings.json');
  it.skipIf(!fs.existsSync(real))('every hook script in the real settings.json -> ask', () => {
    const scripts = hookScriptPaths([real]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) {
      expect(evaluateHookInput(edit(s), POLICY_PATH, [real]).verdict.decision, s).toBe('ask');
    }
  });
});

describe('2. crontab / launchctl via shell', () => {
  for (const [label, pol] of POLICIES) {
    it(`${label}: installing -> ask, reading -> allow`, () => {
      for (const c of [
        'crontab -',
        'echo "* * * * * /tmp/x" | crontab -',
        'crontab /tmp/mycron',
        'crontab -e',
        'launchctl load ~/Library/Foo/x.plist',
        'launchctl bootstrap gui/501 /tmp/x.plist',
      ]) {
        expect(decide(bash(c), pol).decision, c).toBe('ask');
      }
      for (const c of ['crontab -l', 'launchctl list', 'git status']) {
        expect(decide(bash(c), pol).decision, c).toBe('allow');
      }
    });
  }
});

describe('5. bare hook commands resolve via PATH', () => {
  let tmp: string;
  let bin: string;
  let real: string;
  let settings: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-barecmd-'));
    bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(tmp, 'scripts'));
    real = path.join(tmp, 'scripts/mytool-impl');
    fs.writeFileSync(real, '#!/bin/sh\n', { mode: 0o755 });
    fs.symlinkSync(real, path.join(bin, 'mytool'));
    fs.writeFileSync(path.join(bin, 'notexec'), '', { mode: 0o644 });
    settings = path.join(tmp, 'settings.json');
    fs.writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'FOO=1 mytool hook claude' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'notexec x || printf ok; ghost-cmd; node x.js' }] }],
        },
      }),
    );
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('protects PATH entry + symlink target; skips non-exec, unknown, interpreters, system dirs', () => {
    const paths = hookScriptPaths([settings], tmp, `/usr/bin:${bin}:/bin`).sort();
    expect(paths).toEqual([path.join(bin, 'mytool'), fs.realpathSync(real)].sort());
  });

  it('derived patterns ask on writes, allow reads', () => {
    const pol = withPersistencePaths(policy, hookScriptPatterns(hookScriptPaths([settings], tmp, bin), tmp));
    expect(decide(edit(path.join(bin, 'mytool')), pol).decision).toBe('ask');
    expect(decide(edit(real), pol).decision).toBe('ask');
    const target = fs.realpathSync(real); // the path a write would actually name, e.g. ~/no5-scripts/rtk-ai
    expect(decide(bash(`cp /tmp/evil ${target}`), pol).decision).toBe('ask');
    expect(decide(bash(`cp /tmp/evil ${path.join(bin, 'mytool')}`), pol).decision).toBe('ask');
    expect(decide(bash(`cat ${target}`), pol).decision).toBe('allow');
  });

  const realSettings = path.join(os.homedir(), '.claude/settings.json');
  it.skipIf(!fs.existsSync(realSettings) || !process.env.PATH?.split(':').some((d) => fs.existsSync(path.join(d, 'rtk'))))(
    'real settings: rtk (bare) is protected',
    () => {
      const paths = hookScriptPaths([realSettings]);
      expect(paths.some((p) => path.basename(p) === 'rtk')).toBe(true);
    },
  );
});

describe('6. crontab only in command position', () => {
  for (const [label, pol] of POLICIES) {
    it(`${label}: mentions allow, invocations ask`, () => {
      for (const c of [
        'sudo crontab -u root /tmp/f',
        'sudo -u root crontab /tmp/f',
        '/usr/bin/crontab /tmp/f',
        '(crontab -l; echo "* * * * * x") | crontab -',
        'X=1 crontab /tmp/f',
        'echo $(crontab /tmp/f)',
        'bash -c "crontab /tmp/f"',
        "sh -c 'crontab -r'",
        'eval "crontab /tmp/f"',
        'cd /tmp && crontab f',
        'xargs crontab < /tmp/list',
      ]) {
        expect(decide(bash(c), pol).decision, c).toBe('ask');
      }
      for (const c of [
        'grep crontab file.ts',
        '/usr/bin/grep -rn "crontab\\|foo" hooks/',
        'man crontab',
        'crontab -l | grep x',
        'git commit -m "narrow crontab rule"',
        'echo crontab',
      ]) {
        expect(decide(bash(c), pol).decision, c).toBe('allow');
      }
    });
  }
});

describe('7. pure reads of protected paths', () => {
  for (const [label, pol] of POLICIES) {
    it(`${label}: read-only -> allow, anything else -> ask`, () => {
      for (const c of [
        'cat ~/.zshrc',
        'head -50 ~/rai/packages/core/hooks/rai-shell-gate.ts',
        'grep -n foo ~/.claude/settings.json | head',
        'diff ~/.zshrc /tmp/zshrc.bak',
        'ls -la ~/.claude/hooks/',
        'wc -l packages/core/policies/claude-code-shell.yaml 2>/dev/null',
        'git diff packages/core/hooks/rai-shell-gate.ts',
        'git log --oneline -5 -- packages/core/policies/',
        'tail -f ~/Library/LaunchAgents/x.plist 2>&1',
      ]) {
        const v = decide(bash(c), pol);
        expect(v.decision, c).toBe('allow');
        expect(v.rule, c).toBe('persistence-path-read');
      }
      for (const c of [
        'cat /tmp/x > ~/.zshrc',
        'cat /tmp/x >> ~/.zshrc',
        'grep a ~/.zshrc; rm /tmp/x',
        'cat ~/.zshrc && echo x >> ~/.zshrc',
        'sed -i "" s/a/b/ ~/.claude/hooks/x.sh',
        'cat ~/.zshrc | tee ~/.bashrc',
        'git diff --output=~/.zshrc',
        'git -c core.pager=x diff ~/.zshrc',
        'cat $(echo ~/.zshrc)',
        'sort -o ~/.zshrc ~/.zshrc',
      ]) {
        expect(decide(bash(c), pol).decision, c).toBe('ask');
      }
    });
  }

  it('ask patterns still win over read-only', () => {
    expect(decide(bash('cat ~/.zshrc | crontab -'), policy).decision).toBe('ask');
    expect(decide(bash('cat ~/.zshrc | crontab -'), policy).rule).toBe('ask-pattern');
  });
});

describe('3. scheduled-task tools', () => {
  const call = (tool_name: string, tool_input: Record<string, unknown> = {}) => ({ tool_name, tool_input, cwd: '/tmp' });
  for (const [label, pol] of POLICIES) {
    it(`${label}: create/update -> ask, read -> allow`, () => {
      for (const [t, i] of [
        ['CronCreate', { cron: '*/5 * * * *', prompt: 'x' }],
        ['mcp__scheduled-tasks__create_scheduled_task', { prompt: 'x' }],
        ['mcp__scheduled-tasks__update_scheduled_task', { id: '1' }],
        ['RemoteTrigger', { action: 'create' }],
        ['RemoteTrigger', { action: 'run' }],
        ['RemoteTrigger', {}],
      ] as const) {
        const v = decide(call(t, i), pol);
        expect(v.decision, `${t} ${JSON.stringify(i)}`).toBe('ask');
        expect(v.rule).toBe('scheduled-task');
      }
      expect(decide(call('RemoteTrigger', { action: 'list' }), pol).decision).toBe('allow');
      expect(decide(call('mcp__scheduled-tasks__list_scheduled_tasks'), pol).rule).toBe('not-gated');
    });
  }
});

describe('4. package installs in ~/rai', () => {
  for (const [label, pol] of POLICIES) {
    it(`${label}: install in repo -> ask, elsewhere / non-mutating -> allow`, () => {
      for (const [c, cwd] of [
        ['npm install', REPO_DIR],
        ['npm ci', path.join(REPO_DIR, 'packages/core')],
        ['npm i left-pad', REPO_ROOT],
        ['npm --prefix ~/rai install', '/tmp'],
        ['cd ~/rai && npm i', '/tmp'],
        [`cd ${REPO_ROOT} && pnpm add x`, '/tmp'],
        ['yarn --cwd /Users/someone/rai upgrade', '/tmp'],
      ] as const) {
        const v = decide(bash(c, cwd), pol);
        expect(v.decision, `${c} @ ${cwd}`).toBe('ask');
        expect(v.rule).toBe('repo-install');
      }
      for (const [c, cwd] of [
        ['npm install', '/tmp'],
        ['npm test', REPO_DIR],
        ['npm run build', REPO_DIR],
        ['cd ~/rai-notes && npm install', '/tmp'],
      ] as const) {
        expect(decide(bash(c, cwd), pol).decision, `${c} @ ${cwd}`).toBe('allow');
      }
    });
  }

  it('block rules still win over repo-install', () => {
    expect(decide(bash('npx -y foo && npm install', REPO_DIR), policy).decision).toBe('deny');
  });
});
