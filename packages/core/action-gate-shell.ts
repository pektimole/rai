/**
 * action-gate-shell.ts — RAI ActionGate shell adapter (L4)
 *
 * Evaluates shell commands against a deterministic policy.
 * Designed for Claude Code PreToolUse hooks, Cursor, Aider.
 *
 * Same principles as fs-git: fail-closed, first-deny-wins, pure function.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShellDecision = 'allow' | 'deny';

export interface ShellVerdict {
  decision: ShellDecision;
  rule: string;
  reason: string;
}

export interface ShellAction {
  kind: 'shell-exec';
  /** Full command string as submitted by the agent. */
  command: string;
  /** Working directory. */
  workingDir: string;
}

export interface ShellPolicy {
  /**
   * If true (default), commands not explicitly allowed are denied.
   * If false, commands not explicitly blocked are allowed.
   */
  failClosed: boolean;
  /** Base commands that are always allowed (e.g. "git", "npm", "node"). */
  allowedCommands: Set<string>;
  /** Base commands that are always denied (e.g. "rm", "shutdown"). */
  blockedCommands: Set<string>;
  /** Regex patterns matched against the full command string. First match = deny. */
  blockedPatterns: RegExp[];
  /** If non-empty, working directory must start with one of these prefixes. */
  allowedWorkingDirPrefixes: string[];
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Extract the base command from a shell command string.
 * Handles env vars, sudo, and common prefixes.
 * Returns the first "real" command token.
 */
export function extractBaseCommand(command: string): string {
  const trimmed = command.trim();
  // Split on first line only (ignore chained commands for base extraction)
  const tokens = trimmed.split(/\s+/);

  let i = 0;
  // Skip env assignments (FOO=bar), sudo, nice, nohup, etc.
  const skipPrefixes = new Set([
    'sudo',
    'nice',
    'nohup',
    'env',
    'time',
    'timeout',
  ]);

  while (i < tokens.length) {
    const t = tokens[i];
    // Skip env var assignments
    if (t.includes('=') && !t.startsWith('-') && !t.startsWith('/')) {
      i++;
      continue;
    }
    // Skip common command prefixes
    if (skipPrefixes.has(t)) {
      i++;
      continue;
    }
    // This is the base command
    // Strip path: /usr/bin/git -> git
    const base = t.split('/').pop() || t;
    return base;
  }

  return tokens[0] || '';
}

/**
 * Check if a command string contains chained commands (&&, ||, ;, |, $(...)).
 * Returns the list of base commands found.
 */
export function extractAllCommands(command: string): string[] {
  // Split on shell operators
  const parts = command.split(/\s*(?:&&|\|\||;|\|)\s*/);
  // Also catch $() and backtick subshells
  const subshells = command.match(/\$\(([^)]+)\)/g) || [];
  const backticks = command.match(/`([^`]+)`/g) || [];

  const allParts = [
    ...parts,
    ...subshells.map((s) => s.slice(2, -1)),
    ...backticks.map((s) => s.slice(1, -1)),
  ];

  return allParts.map((p) => extractBaseCommand(p)).filter(Boolean);
}

/**
 * Pure evaluation function. Returns a verdict for the given shell action.
 */
export function evaluateShell(
  action: ShellAction,
  policy: ShellPolicy,
): ShellVerdict {
  // 1. Working directory check
  if (policy.allowedWorkingDirPrefixes.length > 0) {
    const inAllowed = policy.allowedWorkingDirPrefixes.some((prefix) =>
      action.workingDir.startsWith(prefix),
    );
    if (!inAllowed) {
      return {
        decision: 'deny',
        rule: 'working-dir-not-allowed',
        reason: `working directory "${action.workingDir}" not in allowed prefixes`,
      };
    }
  }

  // 2. Blocked patterns (full command string)
  for (const pattern of policy.blockedPatterns) {
    if (pattern.test(action.command)) {
      return {
        decision: 'deny',
        rule: 'blocked-pattern',
        reason: `command matches blocked pattern: ${pattern.source}`,
      };
    }
  }

  // 3. Extract all commands (handles chaining)
  const commands = extractAllCommands(action.command);

  // 4. Check each command against blocked list
  for (const cmd of commands) {
    if (policy.blockedCommands.has(cmd)) {
      return {
        decision: 'deny',
        rule: 'blocked-command',
        reason: `command "${cmd}" is in blocklist`,
      };
    }
  }

  // 5. In fail-closed mode, every command must be in the allowlist
  if (policy.failClosed) {
    for (const cmd of commands) {
      if (!policy.allowedCommands.has(cmd)) {
        return {
          decision: 'deny',
          rule: 'command-not-in-allowlist',
          reason: `command "${cmd}" not in allowlist (fail-closed mode)`,
        };
      }
    }
  }

  return {
    decision: 'allow',
    rule: 'all-checks-passed',
    reason: 'command permitted by policy',
  };
}

// ---------------------------------------------------------------------------
// YAML policy schema + loader
// ---------------------------------------------------------------------------

export interface ShellPolicyYaml {
  version: number;
  adapter: 'shell';
  fail_closed?: boolean;
  allowed_commands?: string[];
  blocked_commands?: string[];
  blocked_patterns?: string[];
  allowed_working_dir_prefixes?: string[];
}

export function loadShellPolicy(yamlDoc: ShellPolicyYaml): ShellPolicy {
  if (yamlDoc.version !== 1) {
    throw new Error(`unsupported policy version: ${yamlDoc.version}`);
  }
  if (yamlDoc.adapter !== 'shell') {
    throw new Error(`expected adapter "shell", got "${yamlDoc.adapter}"`);
  }

  return {
    failClosed: yamlDoc.fail_closed ?? true,
    allowedCommands: new Set(yamlDoc.allowed_commands ?? []),
    blockedCommands: new Set(yamlDoc.blocked_commands ?? []),
    blockedPatterns: (yamlDoc.blocked_patterns ?? []).map(
      (p) => new RegExp(p),
    ),
    allowedWorkingDirPrefixes: yamlDoc.allowed_working_dir_prefixes ?? [],
  };
}
