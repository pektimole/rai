#!/usr/bin/env npx tsx
/**
 * rai-shell-gate.ts — Claude Code PreToolUse hook for ActionGate shell adapter
 *
 * Reads hook JSON from stdin, evaluates shell commands (Bash + MCP shell tools)
 * AND file-write targets (Write / Edit / MultiEdit / NotebookEdit + MCP file
 * write tools) against the shell policy, and outputs a permission decision.
 *
 * Install in ~/.claude/settings.json (matcher = HOOK_MATCHER below):
 * {
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit|mcp__.*__(write_file|edit_file|patch_file|append_to_file|move_file|create_file|execute_command|run_in_terminal)",
 *       "hooks": [{
 *         "type": "command",
 *         "command": "npx tsx /path/to/rai/packages/core/hooks/rai-shell-gate.ts"
 *       }]
 *     }]
 *   }
 * }
 *
 * Decisions: allow (silent), deny (hard block), ask (native human confirm).
 * Exit 0 + JSON stdout = decision.
 *
 * Policy load failure does NOT switch the gate off: a hardcoded FALLBACK_POLICY
 * (persistence + self-protect + block patterns) still screens the call, so
 * breaking the YAML once cannot be used to bypass the gate.
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as yaml from 'js-yaml';
import {
  evaluateShell,
  evaluateFileTarget,
  loadShellPolicy,
  type ShellAction,
  type FileAction,
  type ShellPolicy,
  type ShellPolicyYaml,
  type ShellVerdict,
} from '../action-gate-shell';
import { fileTargetCandidates } from '../action-gate-file-resolve';
import { getDefaultAuditLog } from '../audit-log';

// Policy file location: next to this script in ../policies/
export const POLICY_PATH =
  process.env.RAI_SHELL_POLICY ||
  path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../policies/claude-code-shell.yaml',
  );

/** Built-in file-write tools whose target path we screen against persistence patterns. */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** MCP file-write tools (filesystem server, no5-mcp, ...), any server prefix. */
const MCP_FILE_WRITE_RE = /^mcp__.+__(write_file|edit_file|patch_file|append_to_file|move_file|create_file)$/;
/** MCP tools that run a shell command (shell server, desktop terminal). */
const MCP_SHELL_RE = /^mcp__.+__(execute_command|run_in_terminal)$/;
/** tool_input fields that can carry a write target (move_file: both ends). */
const PATH_FIELDS = ['file_path', 'notebook_path', 'path', 'source', 'destination'] as const;

/**
 * PreToolUse matcher that routes every gated tool through this hook. Keep in
 * sync with FILE_WRITE_TOOLS / MCP_*_RE (asserted in tests).
 */
export const HOOK_MATCHER =
  'Bash|Write|Edit|MultiEdit|NotebookEdit|mcp__.*__(write_file|edit_file|patch_file|append_to_file|move_file|create_file|execute_command|run_in_terminal)';

/**
 * Last-resort policy used when the YAML cannot be loaded. Mirrors the
 * security-relevant lists of claude-code-shell.yaml (subset asserted in tests).
 */
export const FALLBACK_POLICY_YAML: ShellPolicyYaml = {
  version: 1,
  adapter: 'shell',
  fail_closed: false,
  blocked_commands: ['shutdown', 'reboot', 'mkfs', 'dd'],
  blocked_patterns: [
    'git push --force',
    'git push -f',
    'git reset --hard',
    '--no-verify',
    'rm -rf /',
    'rm -rf ~',
    '> /dev/',
    String.raw`\|\s*(sudo\s+)?(ba|z|da)?sh(\s|$)`,
    String.raw`npx\s+(-y|--yes)\b`,
  ],
  ask_patterns: [
    String.raw`\bmailx?\s+[^|&;]*-[bc]\b`,
    String.raw`[Bb][Cc][Cc]:\s*\S+@`,
    String.raw`--mail-rcpt\b`,
    String.raw`\bsmtplib\b`,
  ],
  persistence_path_patterns: [
    String.raw`(?:^|/)\.(zshrc|zprofile|zshenv|zlogin|bashrc|bash_profile|bash_login|profile)\b`,
    String.raw`(?:~|/Users/[^/]+|/home/[^/]+)/bin\b`,
    String.raw`Library/LaunchAgents\b`,
    String.raw`\.git/hooks\b`,
    String.raw`\.claude/settings[^/]*\.json\b`,
    '~/rai/packages/core/policies/**',
    '~/rai/packages/core/hooks/**',
    '~/rai/packages/core/action-gate*.ts',
    String.raw`(?:^|[^\w-])packages/core/policies/`,
    String.raw`(?:^|[^\w-])packages/core/hooks/`,
    String.raw`(?:^|[^\w-])packages/core/action-gate[^/\s]*\.ts\b`,
    String.raw`(?:^|[^\w-])git-hooks/`,
  ],
};

export const FALLBACK_POLICY: ShellPolicy = loadShellPolicy(FALLBACK_POLICY_YAML);

/** Load and parse the shell policy from a YAML file. Throws on read/parse error. */
export function loadPolicyFromFile(policyPath: string = POLICY_PATH): ShellPolicy {
  const raw = fs.readFileSync(policyPath, 'utf-8');
  const policyYaml = yaml.load(raw) as ShellPolicyYaml;
  return loadShellPolicy(policyYaml);
}

/**
 * Pure decision function over a parsed hook-input object + policy.
 * Testable without stdin. Returns the ActionGate verdict for this tool call.
 */
export function decide(input: any, policy: ShellPolicy): ShellVerdict {
  const toolName: string = input?.tool_name ?? input?.hookEventName ?? '';

  // Bash + MCP shell tools: screen the full command string.
  if (toolName === 'Bash' || MCP_SHELL_RE.test(toolName)) {
    const command = input?.tool_input?.command;
    if (!command) {
      return { decision: 'allow', rule: 'no-command', reason: 'no command in tool input' };
    }
    const action: ShellAction = {
      kind: 'shell-exec',
      command,
      workingDir: input?.tool_input?.cwd || input?.cwd || process.cwd(),
    };
    return evaluateShell(action, policy);
  }

  // File-write tools: screen every target path against persistence paths.
  if (FILE_WRITE_TOOLS.has(toolName) || MCP_FILE_WRITE_RE.test(toolName)) {
    const targets = PATH_FIELDS.map((f) => input?.tool_input?.[f]).filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    );
    if (targets.length === 0) {
      return { decision: 'allow', rule: 'no-file-path', reason: 'no file path in tool input' };
    }
    const workingDir = input?.cwd || process.cwd();
    let verdict: ShellVerdict | undefined;
    for (const filePath of targets) {
      const action: FileAction = {
        kind: 'file-write',
        filePath,
        workingDir,
        // raw + realpath + .git/hooks aliases, so symlinked targets can't dodge the patterns
        resolvedPaths: fileTargetCandidates(filePath, workingDir),
      };
      verdict = evaluateFileTarget(action, policy);
      if (verdict.decision !== 'allow') return verdict;
    }
    return verdict!;
  }

  // Any other tool is outside this gate's scope.
  return { decision: 'allow', rule: 'not-gated', reason: `tool "${toolName}" not gated by shell adapter` };
}

export interface HookEvaluation {
  verdict: ShellVerdict;
  policyLoaded: boolean;
  loadError?: string;
}

/**
 * Load the policy and decide. If the policy cannot be loaded, screen against
 * FALLBACK_POLICY instead of failing open: sensitive actions keep their
 * deny/ask verdict (rule prefixed policy-load-failed/), everything else allows.
 */
export function evaluateHookInput(input: any, policyPath: string = POLICY_PATH): HookEvaluation {
  let policy: ShellPolicy;
  try {
    policy = loadPolicyFromFile(policyPath);
  } catch (err) {
    const loadError = String(err);
    const v = decide(input, FALLBACK_POLICY);
    const verdict: ShellVerdict =
      v.decision === 'allow'
        ? { decision: 'allow', rule: 'policy-load-failed', reason: `policy load failed, fallback allowed: ${v.reason}` }
        : { decision: v.decision, rule: `policy-load-failed/${v.rule}`, reason: `policy load failed, fallback policy: ${v.reason}` };
    return { verdict, policyLoaded: false, loadError };
  }
  return { verdict: decide(input, policy), policyLoaded: true };
}

export async function main(): Promise<void> {
  // Read stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf-8'));

  const startUs = performance.now();
  const { verdict, policyLoaded, loadError } = evaluateHookInput(input);
  const evalUs = Math.round((performance.now() - startUs) * 1000);

  if (!policyLoaded) {
    process.stderr.write(
      `[rai-shell-gate] warning: could not load policy from ${POLICY_PATH}: ${loadError}; using fallback policy\n`,
    );
  }

  // Audit log
  try {
    const ti = input?.tool_input ?? {};
    const summary: string =
      ti.command ?? ti.file_path ?? ti.notebook_path ?? ti.path ?? ti.source ?? '';
    getDefaultAuditLog().log({
      adapter: 'shell',
      decision: verdict.decision,
      rule: verdict.rule,
      reason: verdict.reason,
      action_summary: summary.length > 200 ? summary.slice(0, 200) + '...' : summary,
      source: 'claude-code',
      policy_file: policyLoaded ? POLICY_PATH : `${POLICY_PATH} (fallback)`,
      eval_us: evalUs,
    });
  } catch {
    // Never let audit log errors break the hook
  }

  if (verdict.decision === 'deny') {
    outputDecision('deny', `[ActionGate L4] ${verdict.reason} (rule: ${verdict.rule})`);
  } else if (verdict.decision === 'ask') {
    outputDecision('ask', `[ActionGate L4] ${verdict.reason} (rule: ${verdict.rule})`);
  } else {
    outputDecision('allow', verdict.reason);
  }
}

function outputDecision(
  decision: 'allow' | 'deny' | 'ask' | 'defer',
  reason: string,
): void {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(output) + '\n');
}

// Only run against stdin when executed directly, not when imported by tests.
const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`[rai-shell-gate] fatal: ${err}\n`);
    // Exit 0 with allow on unexpected errors (fail open, don't break workflow)
    outputDecision('allow', `hook error: ${err}`);
  });
}
