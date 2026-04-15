/**
 * runner.ts — Execute payloads against RAI core scanners.
 *
 * For each payload:
 *   1. Run rayScan (P0)
 *   2. If P1 is required OR P0 returned flagged/uncertain, optionally run scanP1
 *   3. Compare actual vs expected verdict
 *   4. Record a PayloadResult
 *
 * Aggregate into SuiteReport for CLI + CI.
 */

import { randomUUID } from 'crypto';
import { rayScan, scanP1, shouldEscalateToP1 } from '@rai/core';
import type { Payload, PayloadResult, SuiteReport, ThreatLayer, Variant } from './types.js';

export interface RunOptions {
  /** If true, call P1 for payloads marked p1_required or flagged by P0. Default: false. */
  enable_p1?: boolean;
  /** Session ID for scan context. Default: random UUID. */
  session_id?: string;
}

/** Run a single payload through P0 (+ optional P1). */
export async function runPayload(
  payload: Payload,
  options: RunOptions = {},
): Promise<PayloadResult> {
  const startMs = Date.now();
  const sessionId = options.session_id ?? `redteam-${randomUUID()}`;

  // P0 scan
  const p0Result = await rayScan({
    source: {
      channel: 'artifact',
      pipeline_stage: 'ingest',
      is_forward: true, // force scanning (bypass principal exemption for testing)
    },
    payload: { type: 'text', content: payload.payload },
    context: { session_id: sessionId, host_environment: 'api' },
  });

  let actualVerdict = p0Result.verdict;
  let actualLabels = p0Result.threat_layers.map((t) => t.label);
  let tierUsed: 'p0' | 'p0+p1' = 'p0';
  let scanId = p0Result.scan_id;

  // P1 escalation (if enabled and needed)
  const wantsP1 =
    options.enable_p1 === true &&
    (payload.p1_required === true || shouldEscalateToP1(p0Result.verdict, p0Result.confidence));

  if (wantsP1) {
    try {
      const p1Result = await scanP1({
        scan_id: p0Result.scan_id,
        timestamp: new Date().toISOString(),
        source: {
          channel: 'artifact',
          pipeline_stage: 'ingest',
          sender: null,
          origin_url: null,
          is_forward: true,
        },
        payload: { type: 'text', content: payload.payload },
        context: {
          session_id: sessionId,
          prior_scan_ids: [],
          host_environment: 'api',
        },
        p0_result: {
          verdict: p0Result.verdict,
          matched_patterns: p0Result.threat_layers.map((t) => t.label),
          confidence: p0Result.confidence,
        },
      });

      // Merge: P1 verdict wins if higher severity (blocked > flagged > clean)
      const severity: Record<string, number> = { clean: 0, flagged: 1, blocked: 2 };
      if (severity[p1Result.verdict] > severity[actualVerdict]) {
        actualVerdict = p1Result.verdict;
      }
      actualLabels = [...new Set([...actualLabels, ...p1Result.threat_layers.map((t) => t.label)])];
      tierUsed = 'p0+p1';
    } catch {
      // P1 failure = fail-open, keep P0 verdict
    }
  }

  const pass = actualVerdict === payload.expected_verdict;
  const labelMissed =
    payload.expected_label !== undefined &&
    !actualLabels.some((l) => l === payload.expected_label);

  return {
    payload_id: payload.id,
    layer: payload.layer,
    expected_verdict: payload.expected_verdict,
    actual_verdict: actualVerdict,
    expected_label: payload.expected_label,
    actual_labels: actualLabels,
    tier_used: tierUsed,
    pass: pass && !labelMissed,
    label_missed: labelMissed,
    latency_ms: Date.now() - startMs,
    scan_id: scanId,
  };
}

/** Run all payloads and produce an aggregate report. */
export async function runSuite(
  payloads: Payload[],
  options: RunOptions = {},
): Promise<SuiteReport> {
  const results: PayloadResult[] = [];

  for (const payload of payloads) {
    const result = await runPayload(payload, options);
    results.push(result);
  }

  const layers: ThreatLayer[] = ['L-2', 'L-1', 'L0', 'L1'];
  const variants: Variant[] = ['canonical', 'paraphrased', 'obfuscated', 'unicode', 'multi-stage'];

  const byLayer: Record<ThreatLayer, { total: number; passed: number; failed: number }> = {} as any;
  for (const l of layers) byLayer[l] = { total: 0, passed: 0, failed: 0 };

  const byVariant: Record<Variant, { total: number; passed: number; failed: number }> = {} as any;
  for (const v of variants) byVariant[v] = { total: 0, passed: 0, failed: 0 };

  for (const r of results) {
    const p = payloads.find((x) => x.id === r.payload_id)!;
    byLayer[r.layer].total += 1;
    if (r.pass) byLayer[r.layer].passed += 1;
    else byLayer[r.layer].failed += 1;

    byVariant[p.variant].total += 1;
    if (r.pass) byVariant[p.variant].passed += 1;
    else byVariant[p.variant].failed += 1;
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  const avgLatency = results.reduce((s, r) => s + r.latency_ms, 0) / Math.max(1, results.length);

  return {
    timestamp: new Date().toISOString(),
    total: results.length,
    passed,
    failed,
    by_layer: byLayer,
    by_variant: byVariant,
    failures: results.filter((r) => !r.pass),
    avg_latency_ms: avgLatency,
  };
}
