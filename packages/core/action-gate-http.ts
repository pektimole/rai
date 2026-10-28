/**
 * action-gate-http.ts — RAI ActionGate http adapter (L4)
 *
 * Default-deny outbound egress for agent-initiated HTTP requests, plus a
 * hard block on cloud metadata endpoints. Same principles as the shell
 * adapter: fail-closed, first-deny-wins, pure function.
 *
 * Origin: OL-648, Cohere / Qwen3.8 egress attempt (19-rai-context.md).
 */

export type HttpDecision = 'allow' | 'deny';

export interface HttpVerdict {
  decision: HttpDecision;
  rule: string;
  reason: string;
}

export interface HttpAction {
  kind: 'http-request';
  method: string;
  url: string;
}

export interface HttpPolicy {
  /** Hosts always denied, matched exactly or as a parent domain. Checked first. */
  blockedHosts: Set<string>;
  /** CIDR-ish IPv4 prefixes always denied (e.g. "169.254." for link-local). */
  blockedIpPrefixes: string[];
  /**
   * Hosts permitted to receive requests, matched exactly or as a parent
   * domain. Empty = default-deny everything.
   */
  allowedHosts: Set<string>;
  /** Methods permitted to allowed hosts. Empty = all methods. */
  allowedMethods: Set<string>;
}

export interface HttpPolicyYaml {
  version: number;
  adapter: 'http';
  blocked_hosts?: string[];
  blocked_ip_prefixes?: string[];
  allowed_hosts?: string[];
  allowed_methods?: string[];
}

export function loadHttpPolicy(doc: HttpPolicyYaml): HttpPolicy {
  if (doc.version !== 1) throw new Error(`unsupported policy version: ${doc.version}`);
  if (doc.adapter !== 'http') throw new Error(`expected adapter "http", got "${doc.adapter}"`);
  return {
    blockedHosts: new Set((doc.blocked_hosts ?? []).map((h) => h.toLowerCase())),
    blockedIpPrefixes: doc.blocked_ip_prefixes ?? [],
    allowedHosts: new Set((doc.allowed_hosts ?? []).map((h) => h.toLowerCase())),
    allowedMethods: new Set((doc.allowed_methods ?? []).map((m) => m.toUpperCase())),
  };
}

function hostMatches(host: string, set: Set<string>): boolean {
  for (const h of set) {
    if (host === h || host.endsWith('.' + h)) return true;
  }
  return false;
}

export function evaluateHttp(action: HttpAction, policy: HttpPolicy): HttpVerdict {
  let host: string;
  try {
    host = new URL(action.url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return { decision: 'deny', rule: 'http-unparseable-url', reason: `unparseable URL "${action.url}" (fail-closed)` };
  }

  if (hostMatches(host, policy.blockedHosts)) {
    return { decision: 'deny', rule: 'http-blocked-host', reason: `host "${host}" is blocklisted (cloud metadata)` };
  }
  for (const prefix of policy.blockedIpPrefixes) {
    if (host.startsWith(prefix)) {
      return { decision: 'deny', rule: 'http-blocked-ip', reason: `host "${host}" in blocked range ${prefix}*` };
    }
  }

  if (!hostMatches(host, policy.allowedHosts)) {
    return {
      decision: 'deny',
      rule: 'http-egress-default-deny',
      reason: `${action.method.toUpperCase()} to "${host}": host not in egress allowlist`,
    };
  }
  if (policy.allowedMethods.size > 0 && !policy.allowedMethods.has(action.method.toUpperCase())) {
    return {
      decision: 'deny',
      rule: 'http-method-not-allowed',
      reason: `method ${action.method.toUpperCase()} not allowed for "${host}"`,
    };
  }
  return { decision: 'allow', rule: 'http-all-checks-passed', reason: 'request permitted by policy' };
}
