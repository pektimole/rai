/**
 * @rai/core barrel — public API of the RAI core package.
 *
 * Scanners:
 *   rayScan / rayCheck     - P0 regex scanner (sync, local)
 *   scanP1 / runP1Async    - P1 Claude API scanner
 *   shouldEscalateToP1     - P0 → P1 trigger logic
 *
 * Adaptive threat model (Phantom):
 *   threat-weights         - JSON weight loader
 *   scan-log               - Verdict JSONL logger
 *   phantom                - 6-step retrain loop
 *   corrections            - Cross-tier + user override detection
 *
 * ActionGate:
 *   action-gate, action-gate-shell, action-gate-mcp, policy-loader, audit-log, mcp-proxy
 */

export * from './rai-scan-p0.js';
export {
  scanP1,
  runP1Async,
  shouldEscalateToP1,
  type ScanInput,
  type ScanOutput,
  type ThreatLayerResult,
} from './rai-scan-p1.js';
export * from './threat-weights.js';
export * from './scan-log.js';
export * from './phantom.js';
export * from './corrections.js';

// ActionGate — L4 action firewall (MCP adapter for inbound connector)
export * from './action-gate-mcp.js';

// Network Architecture — Phase 1: Private Layer
export * from './threat-signature.js';
export * from './private-layer.js';
export { runDreamPhase, distillScanLog, type DreamPhaseResult, type DreamPhaseOptions } from './dream-phase.js';
export { createIngestServer } from './ingest-server.js';

// L1 hot-reload — signed, versioned pattern manifests (OL-300)
export * from './l1-manifest.js';
export * from './l1-registry.js';
export * from './l1-store.js';
export * from './l1-controller.js';
