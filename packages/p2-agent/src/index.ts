/**
 * RAI P2 — Multi-agent consensus for epistemic verification
 *
 * Trigger conditions (from 26-rai-p2-spec.md):
 * - P1 verdict is flagged with confidence < 0.70
 * - P1 detects L1 (misinformation) or L2 (cascade) threat layer
 * - Claim involves verifiable facts
 * - Explicit /rai-deep command
 */

export { mergeVerdicts } from './consensus.js';
export { runProvenanceAgent } from './agents/provenance.js';
export { runCrossRefAgent } from './agents/cross-ref.js';
export { runTemporalAgent } from './agents/temporal.js';
export { runCredibilityAgent, lookupCredibility, CREDIBILITY_SEED } from './agents/credibility.js';
export type { P2Input, P2Result, P2Weights, AgentVerdict, CredibilityTier, SourceCredibility, ScanHistoryEntry } from './types.js';

import type { P2Input, P2Result, P2Weights } from './types.js';
import { runProvenanceAgent } from './agents/provenance.js';
import { runCrossRefAgent } from './agents/cross-ref.js';
import { runTemporalAgent } from './agents/temporal.js';
import { runCredibilityAgent } from './agents/credibility.js';
import { mergeVerdicts } from './consensus.js';

/**
 * Run full P2 multi-agent consensus scan.
 * All 4 agents run in parallel, results merged via consensus layer.
 * Optional weights parameter for Phantom adaptive weighting.
 */
export async function scanP2(input: P2Input, apiKey: string, weights?: P2Weights): Promise<P2Result> {
  const [provenance, crossRef, temporal, credibility] = await Promise.all([
    runProvenanceAgent(input, apiKey),
    runCrossRefAgent(input, apiKey),
    runTemporalAgent(input, apiKey),
    runCredibilityAgent(input, apiKey),
  ]);

  return mergeVerdicts(input.scan_id, [provenance, crossRef, temporal, credibility], weights);
}
