#!/usr/bin/env npx tsx
/**
 * rai-shell-gate.ts — Claude Code PreToolUse hook for ActionGate shell adapter
 *
 * Reads hook JSON from stdin, evaluates the Bash command against the shell
 * policy, and outputs a permission decision.
 *
 * Install in ~/.claude/settings.json:
 * {
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": "Bash",
 *       "hooks": [{
 *         "type": "command",
 *         "command": "npx tsx /path/to/rai/packages/core/hooks/rai-shell-gate.ts"
 *       }]
 *     }]
 *   }
 * }
 *
 * Exit 0 + JSON stdout = decision (allow/deny/defer)
 * Exit 2 + stderr = block with reason
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  evaluateShell,
  loadShellPolicy,
  type ShellAction,
  type ShellPolicyYaml,
} from '../action-gate-shell';
import { getDefaultAuditLog } from '../audit-log';

// Policy file location: next to this script in ../policies/
const POLICY_PATH =
  process.env.RAI_SHELL_POLICY ||
  path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../policies/claude-code-shell.yaml',
  );

async function main(): Promise<void> {
  // Read stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf-8'));

  // Only evaluate Bash tool calls
  const toolName = input.tool_name ?? input.hookEventName;
  if (toolName !== 'Bash' && input.hook_event_name !== 'PreToolUse') {
    // Not a Bash call, defer to default behavior
    outputDecision('allow', 'not a Bash tool call');
    return;
  }

  const command = input.tool_input?.command;
  if (!command) {
    outputDecision('allow', 'no command in tool input');
    return;
  }

  // Load policy
  let policyYaml: ShellPolicyYaml;
  try {
    const raw = fs.readFileSync(POLICY_PATH, 'utf-8');
    policyYaml = yaml.load(raw) as ShellPolicyYaml;
  } catch (err) {
    // If policy file missing or malformed, fail open with warning
    // (don't break the developer's workflow over a config issue)
    process.stderr.write(
      `[rai-shell-gate] warning: could not load policy from ${POLICY_PATH}: ${err}\n`,
    );
    outputDecision('allow', 'policy load failed, failing open');
    return;
  }

  const policy = loadShellPolicy(policyYaml);

  const action: ShellAction = {
    kind: 'shell-exec',
    command,
    workingDir: input.cwd || process.cwd(),
  };

  const startUs = performance.now();
  const verdict = evaluateShell(action, policy);
  const evalUs = Math.round((performance.now() - startUs) * 1000);

  // Audit log
  try {
    getDefaultAuditLog().log({
      adapter: 'shell',
      decision: verdict.decision,
      rule: verdict.rule,
      reason: verdict.reason,
      action_summary: command.length > 200 ? command.slice(0, 200) + '...' : command,
      source: 'claude-code',
      policy_file: POLICY_PATH,
      eval_us: evalUs,
    });
  } catch {
    // Never let audit log errors break the hook
  }

  if (verdict.decision === 'deny') {
    outputDecision('deny', `[ActionGate L4] ${verdict.reason} (rule: ${verdict.rule})`);
  } else {
    outputDecision('allow', verdict.reason);
  }
}

function outputDecision(
  decision: 'allow' | 'deny' | 'defer',
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

main().catch((err) => {
  process.stderr.write(`[rai-shell-gate] fatal: ${err}\n`);
  // Exit 0 with allow on unexpected errors (fail open, don't break workflow)
  outputDecision('allow', `hook error: ${err}`);
});
