/**
 * RAI P2 — Multi-agent consensus for epistemic verification
 *
 * Trigger conditions (from 26-rai-p2-spec.md):
 * - P1 verdict is flagged with confidence < 0.70
 * - P1 detects L1 (misinformation) or L2 (cascade) threat layer
 * - Claim involves verifiable facts
 * - Explicit /rai-deep command
 */

export { mergeBSVerdicts } from './bs-council.js';
export { runBSCouncil, runBSCouncilForScan } from './bs-council-runner.js';
export type { RunBSCouncilOptions, RunBSCouncilForScanInput } from './bs-council-runner.js';
export { loadCouncilConfig, resolveAgentConfig } from './council-config.js';
export { shouldRunBSCouncil, extractVerifiableClaim } from './gate1.js';
export type { Gate1Input, Gate1Output, Gate1Reason } from './gate1.js';
export { runCredibilityAgent, lookupCredibility, CREDIBILITY_SEED } from './agents/credibility.js';
export type {
  P2Input, AgentVerdict, CredibilityTier, SourceCredibility, ScanHistoryEntry,
  BSCouncilVerdict, BSCouncilResult, Citation, CouncilRole, CouncilBreakdown,
  CouncilBreakdownA, CouncilBreakdownB, CouncilBreakdownC, CouncilBreakdownD,
  AgentABVerdict, AgentDVerdict, CouncilConfig, AgentConfig, ProviderName, RaiTier,
} from './types.js';
