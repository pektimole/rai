#!/usr/bin/env npx tsx
/**
 * rai-shell-gate.ts — Claude Code PreToolUse hook for ActionGate shell adapter
 *
 * Reads hook JSON from stdin, evaluates shell commands (Bash + MCP shell tools)
 * AND file-write targets (Write / Edit / MultiEdit / NotebookEdit + MCP file
 * write tools) against the shell policy, and outputs a permission decision.
 *
 * Install in ~/.claude/settings.json: matcher = HOOK_MATCHER, command =
 * hookCommand() (pinned repo tsx + tsconfig, crash -> ask). Print both with:
 *   node_modules/.bin/tsx -e "import('./packages/core/hooks/rai-shell-gate.ts').then(m=>console.log(m.HOOK_MATCHER+'\n'+m.hookCommand()))"
 *
 * Decisions: allow (silent), deny (hard block), ask (native human confirm).
 * Exit 0 + JSON stdout = decision.
 *
 * Policy load failure does NOT switch the gate off: a hardcoded FALLBACK_POLICY
 * (persistence + self-protect + block patterns) still screens the call, so
 * breaking the YAML once cannot be used to bypass the gate.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as yaml from 'js-yaml';
import {
  compilePathPattern,
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
  'Bash|Write|Edit|MultiEdit|NotebookEdit|CronCreate|RemoteTrigger|mcp__.*__(write_file|edit_file|patch_file|append_to_file|move_file|create_file|execute_command|run_in_terminal|create_scheduled_task|update_scheduled_task)';

/** Tools that create or change a scheduled run (survives the session). */
const SCHEDULE_TOOL_RE = /^(CronCreate|RemoteTrigger|mcp__.+__(create_scheduled_task|update_scheduled_task))$/;
/** RemoteTrigger actions that only read. */
const REMOTE_TRIGGER_READ = new Set(['list', 'get', 'list_runs', 'get_run_log']);

/** Package-manager commands that rewrite node_modules (the hook's runtime). */
const PKG_MUTATE_RE =
  /\b(npm|pnpm|yarn|bun)(?:\s+--?\S+(?:[ =][^\s-]\S*)?)*\s+(install|i|ci|update|up|add|upgrade|uninstall|remove|rm|link|rebuild|dedupe|prune)\b/;
/** A command that names the protected install (~/rai). */
const RAI_PATH_RE = /(?:~|\$HOME|\$\{HOME\}|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/rai(?![\w.-])/;
/** Interpreters named in hook commands: not scripts, and too generic to protect. */
const INTERPRETERS = new Set(['node', 'python', 'python3', 'bash', 'sh', 'zsh', 'tsx', 'npx', 'deno', 'bun', 'env']);
/** SIP-protected system dirs: binaries there cannot be swapped by the agent, skip them. */
const SYSTEM_BIN_RE = /^\/(?:bin|sbin|usr\/bin|usr\/sbin|usr\/libexec|System)\//;

/** Bare program names in command position of each segment (after VAR=val prefixes). */
function bareCommands(command: string): string[] {
  const out: string[] = [];
  for (const seg of command.split(/&&|\|\||[;|&\n()`]/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && /^\w+=/.test(words[i])) i++;
    const w = words[i]?.replace(/^['"]+|['"]+$/g, '');
    if (w && /^[\w.+-]+$/.test(w) && !INTERPRETERS.has(w)) out.push(w);
  }
  return out;
}

/** First executable `name` on PATH, plus its realpath when it is a symlink. System dirs dropped. */
function resolveOnPath(name: string, pathEnv: string): string[] {
  for (const dir of pathEnv.split(':')) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (!fs.statSync(p).isFile()) continue;
    } catch {
      continue;
    }
    // Found in a SIP-protected system dir: the agent cannot swap it, and its
    // realpath may point outside system dirs (e.g. /usr/bin/printf -> uutils
    // coreutils on CI). Skip so a system binary's target is never spuriously protected.
    if (SYSTEM_BIN_RE.test(p)) return [];
    const res = [p];
    try {
      const real = fs.realpathSync(p);
      if (real !== p) res.push(real);
    } catch {
      // dangling after access check: keep the PATH entry
    }
    return res;
  }
  return [];
}

/** Read-only programs: allowed to name a persistence path (they cannot change it). */
const READ_ONLY_CMDS = new Set([
  'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'wc', 'ls', 'stat', 'diff', 'cmp',
  'shasum', 'md5', 'md5sum', 'sha256sum', 'realpath', 'readlink',
]);
const GIT_READ_SUBCMDS = new Set(['diff', 'log', 'show', 'status', 'blame', 'ls-files']);

/**
 * True when the command only reads: a single pipeline whose every stage is a
 * read-only program (or a read-only git subcommand). No chaining, redirects,
 * substitutions or heredocs.
 */
export function isReadOnlyCommand(command: string): boolean {
  const c = command.replace(/\s[12]?>&[12](?=\s|$)/g, ' ').replace(/\s[12]?>\/dev\/null(?=\s|$)/g, ' ');
  if (/[;&<>`\n]|\$\(/.test(c)) return false;
  return c.split('|').every((seg) => {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return false;
    if (words[0] === 'git') {
      return GIT_READ_SUBCMDS.has(words[1] ?? '') && !words.some((w) => /^--output\b/.test(w) || w === '-o');
    }
    return READ_ONLY_CMDS.has(words[0]);
  });
}

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
    String.raw`(?:^|[;&|(\x60\n]|\$\(|\s-c\s+['"]?|\beval\s+['"]?)\s*(?:\w+=\S*\s+)*(?:(?:sudo|env|exec|command|nohup|nice|time|xargs)\b(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+)*(?:[^\s;&|'"]*/)?crontab\b(?!\s+-l\b)`,
    String.raw`\blaunchctl\s+(load|bootstrap|enable|submit)\b`,
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
    '~/rai/packages/core/audit-log.ts',
    String.raw`(?:^|[^\w-])packages/core/audit-log\.ts\b`,
    '~/rai/packages/core/package.json',
    '~/rai/packages/core/tsconfig*.json',
    '~/rai/node_modules/**',
    '~/rai/packages/core/node_modules/**',
    '~/.claude/hooks/**',
    '~/.claude/local-mods/**',
    '~/.claude/plugins/**',
  ],
};

/** Absolute path of this hook script. */
export const SCRIPT_PATH = path.resolve(new URL(import.meta.url).pathname);
/** Repo root holding the hook runtime (node_modules, tsx). */
export const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '../../..');

/** Claude Code settings files whose hook commands we read (user + project). */
export function claudeSettingsFiles(cwd?: string, home: string = os.homedir()): string[] {
  const files = [path.join(home, '.claude/settings.json'), path.join(home, '.claude/settings.local.json')];
  if (cwd) files.push(path.join(cwd, '.claude/settings.json'), path.join(cwd, '.claude/settings.local.json'));
  return files;
}

/**
 * Scripts executed by Claude Code hooks: absolute (or ~ / $HOME) path tokens in
 * every hooks.*[].hooks[].command, minus interpreters and directories. Unreadable
 * or invalid settings files are skipped.
 */
export function hookScriptPaths(
  settingsFiles: string[],
  home: string = os.homedir(),
  pathEnv: string = process.env.PATH ?? '',
): string[] {
  const out = new Set<string>();
  for (const file of settingsFiles) {
    let settings: any;
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      continue;
    }
    const hooks = settings?.hooks;
    if (!hooks || typeof hooks !== 'object') continue;
    for (const entries of Object.values(hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        for (const h of Array.isArray(entry?.hooks) ? entry.hooks : []) {
          if (typeof h?.command !== 'string') continue;
          for (let tok of h.command.split(/[\s'"|;&()<>`]+/)) {
            tok = tok.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/)/, home);
            if (!path.isAbsolute(tok) || INTERPRETERS.has(path.basename(tok))) continue;
            try {
              if (fs.statSync(tok).isDirectory()) continue;
            } catch {
              // missing script: still protect it, creating it would plant a hook
            }
            out.add(path.normalize(tok));
            try {
              const real = fs.realpathSync(tok);
              if (real !== path.normalize(tok)) out.add(real);
            } catch {
              // missing: literal path only
            }
          }
          // Bare programs (e.g. `rtk hook claude`) run whatever PATH resolves to.
          for (const name of bareCommands(h.command)) {
            for (const p of resolveOnPath(name, pathEnv)) out.add(p);
          }
        }
      }
    }
  }
  return [...out];
}

/** Persistence patterns for hook scripts (~/ glob under home, escaped literal elsewhere). */
export function hookScriptPatterns(scripts: string[], home: string = os.homedir()): RegExp[] {
  // Literal absolute path always; plus the ~ glob (~, $HOME, /Users/<u> spellings)
  // for scripts under home. Literal also covers homes outside /Users|/home.
  return scripts.flatMap((p) => {
    const literal = new RegExp(`(?:^|[^\\w.-])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`);
    const rel = path.relative(home, p);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !/[*?]/.test(rel)) {
      return [literal, compilePathPattern(`~/${rel}`)];
    }
    return [literal];
  });
}

/** Policy plus extra persistence patterns (new object, inputs untouched). */
export function withPersistencePaths(policy: ShellPolicy, extra: RegExp[]): ShellPolicy {
  if (extra.length === 0) return policy;
  return { ...policy, persistencePathPatterns: [...policy.persistencePathPatterns, ...extra] };
}

function isUnder(dir: string, root: string): boolean {
  const rel = path.relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Printed by the settings wrapper when the hook process crashes before it can
 * decide (broken import, missing module, tsx failure). Claude Code treats a
 * non-zero hook exit as non-blocking, so without this a crash = allow.
 */
export const CRASH_OUTPUT = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'ask',
    permissionDecisionReason: '[ActionGate L4] gate crashed before deciding, confirm manually (rule: hook-crash)',
  },
});

/**
 * Settings command for this hook. Pins the repo's own tsx + tsconfig (npx and
 * tsx would otherwise resolve them from the session cwd, i.e. from code the
 * agent may control) and turns any crash into ask via CRASH_OUTPUT.
 */
export function hookCommand(script: string = SCRIPT_PATH): string {
  const repo = path.resolve(path.dirname(script), '../../..');
  const tsx = path.join(repo, 'node_modules/.bin/tsx');
  const tsconfig = path.join(repo, 'packages/core/tsconfig.json');
  return `${tsx} --tsconfig ${tsconfig} ${script} || printf '%s\\n' '${CRASH_OUTPUT}'`;
}

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
    const v = evaluateShell(action, policy);
    // Pure reads of a protected path cannot persist anything.
    if (v.rule === 'persistence-path' && isReadOnlyCommand(command)) {
      return { decision: 'allow', rule: 'persistence-path-read', reason: 'read-only command on a protected path' };
    }
    if (v.decision !== 'allow') return v;
    // Package-manager writes to ~/rai rewrite the hook's own runtime (tsx, js-yaml).
    if (
      PKG_MUTATE_RE.test(command) &&
      (isUnder(path.resolve(action.workingDir), REPO_ROOT) || RAI_PATH_RE.test(command) || command.includes(REPO_ROOT))
    ) {
      return {
        decision: 'ask',
        rule: 'repo-install',
        reason: 'package install/update in the ActionGate repo rewrites the hook runtime (node_modules)',
      };
    }
    return v;
  }

  // Scheduled runs (cron, cloud triggers, scheduled tasks) re-run prompts outside the session.
  if (SCHEDULE_TOOL_RE.test(toolName)) {
    const act = input?.tool_input?.action;
    if (toolName === 'RemoteTrigger' && typeof act === 'string' && REMOTE_TRIGGER_READ.has(act)) {
      return { decision: 'allow', rule: 'scheduled-task-read', reason: `RemoteTrigger ${act} only reads` };
    }
    return {
      decision: 'ask',
      rule: 'scheduled-task',
      reason: `${toolName} creates or changes a scheduled run that survives the session`,
    };
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
export function evaluateHookInput(
  input: any,
  policyPath: string = POLICY_PATH,
  settingsFiles: string[] = claudeSettingsFiles(typeof input?.cwd === 'string' ? input.cwd : undefined),
): HookEvaluation {
  // Scripts other hooks run are persistence surfaces too (derived, not listed in YAML).
  let extra: RegExp[] = [];
  try {
    extra = hookScriptPatterns(hookScriptPaths(settingsFiles));
  } catch {
    // derivation is best-effort; static ~/.claude/hooks/** etc. still apply
  }
  let policy: ShellPolicy;
  try {
    policy = withPersistencePaths(loadPolicyFromFile(policyPath), extra);
  } catch (err) {
    const loadError = String(err);
    const v = decide(input, withPersistencePaths(FALLBACK_POLICY, extra));
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
    // Never fail open: an unexpected error routes to human confirm, not allow.
    outputDecision('ask', `[ActionGate L4] hook error, confirm manually: ${err} (rule: hook-error)`);
  });
}
