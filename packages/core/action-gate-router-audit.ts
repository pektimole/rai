/**
 * action-gate-router-audit.ts — RAI ActionGate router-audit surface adapter (L4)
 *
 * Audits the hybrid-inference routing decision: when an on-device classifier
 * decides, task-by-task and invisibly, what stays local vs. goes to the cloud.
 *
 * Spec: docs/28-rai-actiongate-spec.md § Surface Adapter: router-audit (OL-370)
 * Anchor case: Computex 2026-06 convergence — NVIDIA/Apple/Microsoft/Perplexity.
 *
 * v0 design contract:
 *   - Verdicts: allow | warn | escalate  (no 'block' — racy without OS hook)
 *   - fail_closed: false — observe-only, never silently drop a route
 *   - First-matching-rule-wins, same as other ActionGate adapters
 *
 * Constitution Rule 4: RAI audits the routing decision without profiting from it.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RouterAuditDecision = 'allow' | 'warn' | 'escalate';

export interface RouterAuditVerdict {
  decision: RouterAuditDecision;
  rule: string;
  reason: string;
}

export interface RouterAuditAction {
  adapter: 'router-audit';
  /** Where the host classifier is sending this task. */
  routed_to: 'local' | 'cloud';
  /** Host classifier label, stored verbatim — no normalisation. */
  classified_as: string;
  /** ISO8601 timestamp of user consent, or null when no consent was captured. */
  consent_timestamp: string | null;
  /** Vendor policy or rule ID that drove the routing decision. Null = not disclosed. */
  policy_ref: string | null;
  /** RAI-side PII detection result, independent of the host label. */
  contains_pii?: boolean;
  /** SHA-256 of the routed payload — no content stored, audit-friendly. */
  task_digest: string;
  /** ISO8601 of the routing event. */
  ts: string;
}

/**
 * A single policy rule. Rules are evaluated in declaration order; first match wins.
 * All `when` fields that are present must match for the rule to fire.
 */
export interface RouterAuditRule {
  id: string;
  when: {
    routed_to?: 'local' | 'cloud';
    consent_timestamp?: null;
    contains_pii?: boolean;
  };
  verdict: RouterAuditDecision;
  reason: string;
}

export interface RouterAuditPolicy {
  /** Rules evaluated in order; first match wins. */
  rules: RouterAuditRule[];
  /**
   * Verdict when no rule matches.
   * v0 default: 'allow' (observe-only, fail-open on no-match).
   */
  defaultVerdict: RouterAuditDecision;
}

// ---------------------------------------------------------------------------
// Default policy (mirrors the YAML in policies/router-audit.yaml)
// ---------------------------------------------------------------------------

export function defaultRouterAuditPolicy(): RouterAuditPolicy {
  return {
    rules: [
      {
        id: 'escalate-unconsented-pii-to-cloud',
        when: { routed_to: 'cloud', consent_timestamp: null, contains_pii: true },
        verdict: 'escalate',
        reason: 'PII routed to cloud with no captured consent. The classifier decided for you.',
      },
      {
        id: 'warn-cloud-route-no-consent',
        when: { routed_to: 'cloud', consent_timestamp: null },
        verdict: 'warn',
        reason: 'Task left this machine without an explicit consent record.',
      },
      {
        id: 'allow-local',
        when: { routed_to: 'local' },
        verdict: 'allow',
        reason: 'Task routed to local inference — no cross-boundary data movement.',
      },
    ],
    defaultVerdict: 'allow',
  };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Pure function. Evaluates a routing event against the policy.
 * First-matching-rule-wins. No I/O. Never throws.
 *
 * v0 does not produce 'block' verdicts. The spec documents 'block' as racy
 * without host/OS hook cooperation; shipping a fake block would be worse than
 * honest 'escalate'. Downstream callers are responsible for notification.
 */
export function evaluateRouterAudit(
  action: RouterAuditAction,
  policy: RouterAuditPolicy,
): RouterAuditVerdict {
  for (const rule of policy.rules) {
    if (ruleMatches(rule.when, action)) {
      return { decision: rule.verdict, rule: rule.id, reason: rule.reason };
    }
  }
  return {
    decision: policy.defaultVerdict,
    rule: 'default',
    reason: 'No policy rule matched; default verdict applied.',
  };
}

function ruleMatches(
  when: RouterAuditRule['when'],
  action: RouterAuditAction,
): boolean {
  if (when.routed_to !== undefined && action.routed_to !== when.routed_to) return false;
  if (when.consent_timestamp === null && action.consent_timestamp !== null) return false;
  if (when.contains_pii !== undefined && action.contains_pii !== when.contains_pii) return false;
  return true;
}
