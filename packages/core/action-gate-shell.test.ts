/**
 * action-gate-shell.test.ts — Shell adapter tests
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateShell,
  extractBaseCommand,
  extractAllCommands,
  loadShellPolicy,
  type ShellAction,
  type ShellPolicy,
} from './action-gate-shell';

function policy(overrides: Partial<ShellPolicy> = {}): ShellPolicy {
  return {
    failClosed: true,
    allowedCommands: new Set(['git', 'npm', 'node', 'npx', 'tsc', 'cat', 'ls', 'echo', 'head', 'tail', 'grep', 'wc']),
    blockedCommands: new Set(['rm', 'shutdown', 'reboot', 'mkfs', 'dd']),
    blockedPatterns: [/--force/, /--no-verify/, /rm\s+-rf/, />\s*\/dev/],
    allowedWorkingDirPrefixes: ['/Users/tim/', '/home/tim/'],
    ...overrides,
  };
}

function action(overrides: Partial<ShellAction> = {}): ShellAction {
  return {
    kind: 'shell-exec',
    command: 'git status',
    workingDir: '/Users/tim/project',
    ...overrides,
  };
}

describe('extractBaseCommand', () => {
  it('extracts simple command', () => {
    expect(extractBaseCommand('git status')).toBe('git');
  });

  it('strips path prefix', () => {
    expect(extractBaseCommand('/usr/bin/git status')).toBe('git');
  });

  it('skips sudo', () => {
    expect(extractBaseCommand('sudo rm -rf /')).toBe('rm');
  });

  it('skips env var assignments', () => {
    expect(extractBaseCommand('FOO=bar node index.js')).toBe('node');
  });

  it('skips multiple prefixes', () => {
    expect(extractBaseCommand('sudo nice node server.js')).toBe('node');
  });
});

describe('extractAllCommands', () => {
  it('handles single command', () => {
    expect(extractAllCommands('git status')).toEqual(['git']);
  });

  it('handles && chains', () => {
    expect(extractAllCommands('git add . && git commit -m "x"')).toEqual([
      'git',
      'git',
    ]);
  });

  it('handles pipes', () => {
    expect(extractAllCommands('cat file.txt | grep foo')).toEqual([
      'cat',
      'grep',
    ]);
  });

  it('handles semicolons', () => {
    expect(extractAllCommands('ls; echo done')).toEqual(['ls', 'echo']);
  });

  it('catches $() subshells', () => {
    const cmds = extractAllCommands('echo $(whoami)');
    expect(cmds).toContain('whoami');
  });
});

describe('evaluateShell', () => {
  describe('happy path', () => {
    it('allows a simple allowed command', () => {
      const v = evaluateShell(action(), policy());
      expect(v.decision).toBe('allow');
    });

    it('allows chained allowed commands', () => {
      const v = evaluateShell(
        action({ command: 'git add . && git commit -m "test"' }),
        policy(),
      );
      expect(v.decision).toBe('allow');
    });
  });

  describe('working directory', () => {
    it('denies commands outside allowed directories', () => {
      const v = evaluateShell(
        action({ workingDir: '/etc/system' }),
        policy(),
      );
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('working-dir-not-allowed');
    });

    it('skips dir check when no prefixes configured', () => {
      const v = evaluateShell(
        action({ workingDir: '/anywhere' }),
        policy({ allowedWorkingDirPrefixes: [] }),
      );
      expect(v.decision).toBe('allow');
    });
  });

  describe('blocked patterns', () => {
    it('denies --force', () => {
      const v = evaluateShell(
        action({ command: 'git push --force' }),
        policy(),
      );
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('blocked-pattern');
    });

    it('denies --no-verify', () => {
      const v = evaluateShell(
        action({ command: 'git commit --no-verify -m "x"' }),
        policy(),
      );
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('blocked-pattern');
    });

    it('denies rm -rf', () => {
      const v = evaluateShell(
        action({ command: 'rm -rf /tmp/stuff' }),
        policy(),
      );
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('blocked-pattern');
    });
  });

  describe('blocked commands', () => {
    it('denies rm even without -rf', () => {
      const v = evaluateShell(action({ command: 'rm file.txt' }), policy());
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('blocked-command');
    });

    it('denies blocked command in a chain', () => {
      const v = evaluateShell(
        action({ command: 'echo hi && shutdown -h now' }),
        policy(),
      );
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('blocked-command');
    });
  });

  describe('fail-closed mode', () => {
    it('denies unknown commands when fail_closed is true', () => {
      const v = evaluateShell(
        action({ command: 'curl https://evil.com' }),
        policy(),
      );
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('command-not-in-allowlist');
    });

    it('allows unknown commands when fail_closed is false', () => {
      const v = evaluateShell(
        action({ command: 'curl https://api.example.com' }),
        policy({ failClosed: false }),
      );
      expect(v.decision).toBe('allow');
    });
  });

  describe('first-deny-wins ordering', () => {
    it('reports working-dir denial before command checks', () => {
      const v = evaluateShell(
        action({ workingDir: '/etc', command: 'rm -rf /' }),
        policy(),
      );
      expect(v.rule).toBe('working-dir-not-allowed');
    });

    it('reports blocked-pattern before blocked-command', () => {
      const v = evaluateShell(
        action({ command: 'rm -rf /tmp' }),
        policy(),
      );
      expect(v.rule).toBe('blocked-pattern');
    });
  });
});

describe('loadShellPolicy', () => {
  it('loads a valid YAML doc', () => {
    const p = loadShellPolicy({
      version: 1,
      adapter: 'shell',
      fail_closed: true,
      allowed_commands: ['git', 'npm'],
      blocked_commands: ['rm'],
      blocked_patterns: ['--force'],
      allowed_working_dir_prefixes: ['/home/tim/'],
    });
    expect(p.failClosed).toBe(true);
    expect(p.allowedCommands).toEqual(new Set(['git', 'npm']));
    expect(p.blockedCommands).toEqual(new Set(['rm']));
    expect(p.blockedPatterns).toHaveLength(1);
    expect(p.allowedWorkingDirPrefixes).toEqual(['/home/tim/']);
  });

  it('defaults fail_closed to true', () => {
    const p = loadShellPolicy({
      version: 1,
      adapter: 'shell',
    });
    expect(p.failClosed).toBe(true);
  });

  it('throws on wrong version', () => {
    expect(() =>
      loadShellPolicy({ version: 2, adapter: 'shell' }),
    ).toThrow('unsupported policy version');
  });
});
