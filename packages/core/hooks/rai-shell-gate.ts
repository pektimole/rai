#!/usr/bin/env npx tsx
/**
 * rai-shell-gate.ts — Claude Code PreToolUse hook for ActionGate shell adapter
 *
 * Reads hook JSON from stdin, evaluates Bash commands AND file-write targets
 * (Write / Edit / MultiEdit) against the shell policy, and outputs a permission
 * decision.
 *
 * Install in ~/.claude/settings.json:
 * {
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": "Bash|Write|Edit|MultiEdit",
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

/** File-write tools whose target path we screen against persistence patterns. */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

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
  const toolName = input?.tool_name ?? input?.hookEventName;

  // Bash: screen the full command string.
  if (toolName === 'Bash') {
    const command = input?.tool_input?.command;
    if (!command) {
      return { decision: 'allow', rule: 'no-command', reason: 'no command in tool input' };
    }
    const action: ShellAction = {
      kind: 'shell-exec',
      command,
      workingDir: input?.cwd || process.cwd(),
    };
    return evaluateShell(action, policy);
  }

  // Write / Edit / MultiEdit: screen the file target against persistence paths.
  if (FILE_WRITE_TOOLS.has(toolName)) {
    const filePath = input?.tool_input?.file_path;
    if (!filePath) {
      return { decision: 'allow', rule: 'no-file-path', reason: 'no file_path in tool input' };
    }
    const workingDir = input?.cwd || process.cwd();
    const action: FileAction = {
      kind: 'file-write',
      filePath,
      workingDir,
      // raw + realpath + .git/hooks aliases, so symlinked targets can't dodge the patterns
      resolvedPaths: fileTargetCandidates(filePath, workingDir),
    };
    return evaluateFileTarget(action, policy);
  }

  // Any other tool is outside this gate's scope.
  return { decision: 'allow', rule: 'not-gated', reason: `tool "${toolName}" not gated by shell adapter` };
}

export async function main(): Promise<void> {
  // Read stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf-8'));

  // Load policy (fail open on config error — don't break the workflow)
  let policy: ShellPolicy;
  try {
    policy = loadPolicyFromFile();
  } catch (err) {
    process.stderr.write(
      `[rai-shell-gate] warning: could not load policy from ${POLICY_PATH}: ${err}\n`,
    );
    outputDecision('allow', 'policy load failed, failing open');
    return;
  }

  const startUs = performance.now();
  const verdict = decide(input, policy);
  const evalUs = Math.round((performance.now() - startUs) * 1000);

  // Audit log
  try {
    const summary =
      input?.tool_input?.command ?? input?.tool_input?.file_path ?? '';
    getDefaultAuditLog().log({
      adapter: 'shell',
      decision: verdict.decision,
      rule: verdict.rule,
      reason: verdict.reason,
      action_summary: summary.length > 200 ? summary.slice(0, 200) + '...' : summary,
      source: 'claude-code',
      policy_file: POLICY_PATH,
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
