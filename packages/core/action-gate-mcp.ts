/**
 * action-gate-mcp.ts — RAI ActionGate MCP adapter (L4)
 *
 * Policy engine for MCP tool invocations. Evaluates tool name + arguments
 * against a deterministic allow/blocklist before the call reaches the
 * downstream server.
 *
 * Used by the MCP proxy server (mcp-proxy.ts) to gate all tool calls.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type McpDecision = 'allow' | 'deny';

export interface McpVerdict {
  decision: McpDecision;
  rule: string;
  reason: string;
}

export interface McpToolCall {
  kind: 'mcp-tool-call';
  /** Tool name as declared by the downstream MCP server. */
  toolName: string;
  /** Arguments object passed to the tool. */
  arguments: Record<string, unknown>;
  /** The downstream MCP server identity (from policy). */
  serverName: string;
}

export interface McpPolicy {
  /** Server name this policy applies to. */
  serverName: string;
  /**
   * If true (default), tools not in allowedTools are denied.
   * If false, tools not in blockedTools are allowed.
   */
  failClosed: boolean;
  /** Tools explicitly allowed. Empty + failClosed = deny all. */
  allowedTools: Set<string>;
  /** Tools explicitly blocked (checked before allowlist). */
  blockedTools: Set<string>;
  /** Argument patterns that trigger denial. Key = tool name (or "*"), value = regex on JSON-stringified args. */
  blockedArgPatterns: Map<string, RegExp[]>;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export function evaluateMcp(
  call: McpToolCall,
  policy: McpPolicy,
): McpVerdict {
  // 1. Blocked tools (first deny wins)
  if (policy.blockedTools.has(call.toolName)) {
    return {
      decision: 'deny',
      rule: 'tool-blocked',
      reason: `tool "${call.toolName}" is in blocklist`,
    };
  }

  // 2. Blocked argument patterns (tool-specific + wildcard)
  const argString = JSON.stringify(call.arguments);
  const patternsForTool = policy.blockedArgPatterns.get(call.toolName) ?? [];
  const patternsForAll = policy.blockedArgPatterns.get('*') ?? [];

  for (const pattern of [...patternsForTool, ...patternsForAll]) {
    if (pattern.test(argString)) {
      return {
        decision: 'deny',
        rule: 'blocked-arg-pattern',
        reason: `arguments match blocked pattern: ${pattern.source}`,
      };
    }
  }

  // 3. Fail-closed: tool must be in allowlist
  if (policy.failClosed && !policy.allowedTools.has(call.toolName)) {
    return {
      decision: 'deny',
      rule: 'tool-not-in-allowlist',
      reason: `tool "${call.toolName}" not in allowlist (fail-closed mode)`,
    };
  }

  return {
    decision: 'allow',
    rule: 'all-checks-passed',
    reason: 'tool call permitted by policy',
  };
}

// ---------------------------------------------------------------------------
// YAML policy schema + loader
// ---------------------------------------------------------------------------

export interface McpPolicyYaml {
  version: number;
  adapter: 'mcp';
  server_name: string;
  fail_closed?: boolean;
  allowed_tools?: string[];
  blocked_tools?: string[];
  /** Map of tool name (or "*") to list of regex patterns on stringified args. */
  blocked_arg_patterns?: Record<string, string[]>;
}

export function loadMcpPolicy(doc: McpPolicyYaml): McpPolicy {
  if (doc.version !== 1) {
    throw new Error(`unsupported policy version: ${doc.version}`);
  }
  if (doc.adapter !== 'mcp') {
    throw new Error(`expected adapter "mcp", got "${doc.adapter}"`);
  }
  if (!doc.server_name) {
    throw new Error('policy missing required field "server_name"');
  }

  const blockedArgPatterns = new Map<string, RegExp[]>();
  if (doc.blocked_arg_patterns) {
    for (const [tool, patterns] of Object.entries(doc.blocked_arg_patterns)) {
      blockedArgPatterns.set(tool, patterns.map((p) => new RegExp(p)));
    }
  }

  return {
    serverName: doc.server_name,
    failClosed: doc.fail_closed ?? true,
    allowedTools: new Set(doc.allowed_tools ?? []),
    blockedTools: new Set(doc.blocked_tools ?? []),
    blockedArgPatterns,
  };
}
