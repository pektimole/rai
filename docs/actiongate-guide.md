# ActionGate: Agent Action Firewall

Deterministic, fail-closed policy engine that gates what AI agents are allowed to **do**, not just what they say.

## Quick start

### Claude Code (shell adapter)

Already wired if you installed the RAI hook. Every Bash tool call passes through ActionGate.

**Settings** (`~/.claude/settings.json`):
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "npx tsx /path/to/rai/packages/core/hooks/rai-shell-gate.ts"
      }]
    }]
  }
}
```

**Policy** (`packages/core/policies/claude-code-shell.yaml`):
```yaml
version: 1
adapter: shell
fail_closed: false  # blocklist mode

blocked_commands:
  - shutdown
  - reboot
  - mkfs
  - dd

blocked_patterns:
  - "git push --force"
  - "git reset --hard"
  - "--no-verify"
  - "rm -rf /"
```

Edit the YAML to change policy. No code changes needed.

### MCP proxy

Gate any MCP server by running it through the ActionGate proxy:

```json
{
  "mcpServers": {
    "gated-filesystem": {
      "command": "npx",
      "args": [
        "tsx", "/path/to/rai/packages/core/mcp-proxy.ts",
        "--policy", "/path/to/policy.yaml",
        "--", "node", "/path/to/fs-server.js"
      ]
    }
  }
}
```

**Policy** (`packages/core/policies/example-mcp.yaml`):
```yaml
version: 1
adapter: mcp
server_name: filesystem
fail_closed: false

blocked_tools:
  - delete_file
  - drop_database

blocked_arg_patterns:
  "*":
    - "\\.env"
    - "/etc/shadow"
  read_file:
    - "\\.ssh/"
```

### fs-git adapter (NanoClaw)

For file write + git operations (used in NanoClaw production):

```typescript
import { evaluate, nanoclawDefaultPolicy } from './action-gate';

const action = {
  kind: 'fs-git-write' as const,
  file: 'proposals/my-file.md',
  content: '# content',
  commitMessage: 'add proposal',
  sourceGroup: 'whatsapp_main',
};

const verdict = evaluate(action, nanoclawDefaultPolicy('/path/to/root'));

if (verdict.decision === 'deny') {
  console.log(`Blocked: ${verdict.reason} (rule: ${verdict.rule})`);
} else if (verdict.decision === 'sanitize') {
  // Use verdict.sanitized instead of original action
}
```

## YAML policy loader

Load policies from YAML instead of constructing in code:

```typescript
import { loadFsGitPolicyFile } from './policy-loader';

const policy = loadFsGitPolicyFile('./policy.yaml', 'whatsapp_main');
if (!policy) {
  // Source group not in policy = deny
}
```

## Audit log

Every verdict is logged to `~/.rai/audit/rai-actiongate.jsonl` (JSON Lines format).

```bash
# View all denied actions
cat ~/.rai/audit/rai-actiongate.jsonl | jq 'select(.decision == "deny")'

# View shell adapter verdicts
cat ~/.rai/audit/rai-actiongate.jsonl | jq 'select(.adapter == "shell")'

# Count by decision
cat ~/.rai/audit/rai-actiongate.jsonl | jq -r '.decision' | sort | uniq -c
```

Programmatic access:

```typescript
import { getDefaultAuditLog } from './audit-log';

const log = getDefaultAuditLog();
const denied = log.query(e => e.decision === 'deny');
const recent = log.query(e => new Date(e.timestamp) > new Date('2026-04-09'));
```

Each entry includes:
- `audit_id`: unique entry ID
- `scan_id`: links to originating P0/P1/P2 scan (when available)
- `adapter`: which surface (fs-git, shell, mcp)
- `decision`: allow, deny, or sanitize
- `rule`: which policy check fired
- `eval_us`: evaluation time in microseconds

## Architecture

```
LLM output (tool call or shell command)
  |
  v
[ActionGate]
  ├── Resolve action target
  ├── Apply policy chain (fail-closed, first deny wins)
  ├── Verdict: allow | deny | sanitize
  └── Audit log entry
```

Three adapters, one engine:

| Adapter | Host | Tests |
|---|---|---|
| `fs-git` | NanoClaw write-back | 27 |
| `shell` | Claude Code, Cursor, Aider | 26 |
| `mcp` | Any MCP server (proxy) | 22 |

All adapters share the same principles:
- **Fail-closed**: denied unless explicitly allowed
- **First deny wins**: check order is deterministic
- **Zero LLM calls**: pure policy evaluation, microseconds
- **YAML config**: expand by editing policy, never code

## Test counts

| Module | Tests |
|---|---|
| action-gate.ts (fs-git) | 27 |
| action-gate-shell.ts | 26 |
| action-gate-mcp.ts | 16 |
| mcp-proxy.ts (integration) | 6 |
| policy-loader.ts | 12 |
| audit-log.ts | 8 |
| **Total** | **95** |
