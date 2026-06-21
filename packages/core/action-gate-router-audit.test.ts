/**
 * action-gate-router-audit.test.ts — RAI ActionGate router-audit adapter tests
 *
 * Spec: docs/28-rai-actiongate-spec.md § Surface Adapter: router-audit (OL-370)
 *
 * Coverage map (one test per spec enforcement rule):
 *   1. PII → cloud, no consent                    → escalate (rule: escalate-unconsented-pii-to-cloud)
 *   2. no-PII → cloud, no consent                 → warn     (rule: warn-cloud-route-no-consent)
 *   3. PII → cloud, consent present               → allow    (default, no matching rule)
 *   4. no-PII → local, no consent                 → allow    (rule: allow-local)
 *   5. PII → local, no consent                    → allow    (rule: allow-local, local wins)
 *   6. First-rule-wins ordering (escalate before warn)
 *   7. No 'block' verdict emitted by the default policy (v0 contract)
 *   8. Custom policy override
 *   9. Unknown classified_as values pass through without error
 *  10. defaultVerdict fires when no rule matches a bespoke policy
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateRouterAudit,
  defaultRouterAuditPolicy,
  type RouterAuditAction,
  type RouterAuditPolicy,
} from './action-gate-router-audit';

const TS = '2026-06-21T14:00:00Z';
const DIGEST = 'abc123def456';
const CONSENT_TS = '2026-06-01T09:00:00Z';

function action(overrides: Partial<RouterAuditAction> = {}): RouterAuditAction {
  return {
    adapter: 'router-audit',
    routed_to: 'cloud',
    classified_as: 'complex',
    consent_timestamp: null,
    policy_ref: null,
    contains_pii: false,
    task_digest: DIGEST,
    ts: TS,
    ...overrides,
  };
}

function policy(overrides: Partial<RouterAuditPolicy> = {}): RouterAuditPolicy {
  return { ...defaultRouterAuditPolicy(), ...overrides };
}

describe('evaluateRouterAudit — enforcement rules', () => {
  it('cloud + no consent + PII → escalate', () => {
    const v = evaluateRouterAudit(action({ routed_to: 'cloud', consent_timestamp: null, contains_pii: true }), policy());
    expect(v.decision).toBe('escalate');
    expect(v.rule).toBe('escalate-unconsented-pii-to-cloud');
  });

  it('cloud + no consent + no PII → warn', () => {
    const v = evaluateRouterAudit(action({ routed_to: 'cloud', consent_timestamp: null, contains_pii: false }), policy());
    expect(v.decision).toBe('warn');
    expect(v.rule).toBe('warn-cloud-route-no-consent');
  });

  it('cloud + consent present + PII → allow (consent grants permission)', () => {
    const v = evaluateRouterAudit(action({ routed_to: 'cloud', consent_timestamp: CONSENT_TS, contains_pii: true }), policy());
    expect(v.decision).toBe('allow');
  });

  it('cloud + consent present + no PII → allow', () => {
    const v = evaluateRouterAudit(action({ routed_to: 'cloud', consent_timestamp: CONSENT_TS, contains_pii: false }), policy());
    expect(v.decision).toBe('allow');
  });

  it('local + no consent + no PII → allow (local wins, no boundary crossing)', () => {
    const v = evaluateRouterAudit(action({ routed_to: 'local', consent_timestamp: null, contains_pii: false }), policy());
    expect(v.decision).toBe('allow');
    expect(v.rule).toBe('allow-local');
  });

  it('local + no consent + PII → allow (local inference, PII stays on-device)', () => {
    const v = evaluateRouterAudit(action({ routed_to: 'local', consent_timestamp: null, contains_pii: true }), policy());
    expect(v.decision).toBe('allow');
    expect(v.rule).toBe('allow-local');
  });
});

describe('evaluateRouterAudit — v0 contract', () => {
  it('default policy never emits block (block is racy without OS hook)', () => {
    const allCombinations: RouterAuditAction[] = [
      action({ routed_to: 'cloud', consent_timestamp: null, contains_pii: true }),
      action({ routed_to: 'cloud', consent_timestamp: null, contains_pii: false }),
      action({ routed_to: 'cloud', consent_timestamp: CONSENT_TS }),
      action({ routed_to: 'local', consent_timestamp: null }),
    ];
    for (const a of allCombinations) {
      const v = evaluateRouterAudit(a, policy());
      expect(v.decision).not.toBe('block');
    }
  });

  it('rule ordering: escalate fires before warn for cloud+no-consent+PII', () => {
    const v = evaluateRouterAudit(
      action({ routed_to: 'cloud', consent_timestamp: null, contains_pii: true }),
      policy(),
    );
    expect(v.rule).toBe('escalate-unconsented-pii-to-cloud');
    expect(v.rule).not.toBe('warn-cloud-route-no-consent');
  });

  it('contains_pii undefined is not treated as true (no false escalation)', () => {
    const a = action({ routed_to: 'cloud', consent_timestamp: null });
    delete (a as Partial<RouterAuditAction>).contains_pii;
    const v = evaluateRouterAudit(a, policy());
    expect(v.decision).toBe('warn');
    expect(v.rule).toBe('warn-cloud-route-no-consent');
  });

  it('arbitrary classified_as string does not throw', () => {
    const v = evaluateRouterAudit(action({ classified_as: 'vendor-proprietary-tag-v42' }), policy());
    expect(['allow', 'warn', 'escalate']).toContain(v.decision);
  });
});

describe('evaluateRouterAudit — custom policy', () => {
  it('custom policy override: escalate all cloud routes regardless of consent', () => {
    const strictPolicy: RouterAuditPolicy = {
      rules: [
        { id: 'block-all-cloud', when: { routed_to: 'cloud' }, verdict: 'escalate', reason: 'No cloud routes permitted.' },
      ],
      defaultVerdict: 'allow',
    };
    const v = evaluateRouterAudit(action({ routed_to: 'cloud', consent_timestamp: CONSENT_TS }), strictPolicy);
    expect(v.decision).toBe('escalate');
    expect(v.rule).toBe('block-all-cloud');
  });

  it('defaultVerdict fires when no rule matches', () => {
    const minimalPolicy: RouterAuditPolicy = {
      rules: [],
      defaultVerdict: 'warn',
    };
    const v = evaluateRouterAudit(action(), minimalPolicy);
    expect(v.decision).toBe('warn');
    expect(v.rule).toBe('default');
  });
});
