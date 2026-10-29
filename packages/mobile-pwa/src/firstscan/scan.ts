/**
 * Per-item scanner for the first-scan batch. Same pipeline as a single share:
 * P0 always, P1 when a BYOK key is set and P0 asks for escalation. No new detection.
 */

import { scanP0 } from '../scanner/rai-scan-p0';
import { scanP1, shouldEscalateToP1, mergeVerdicts } from '../scanner/rai-scan-p1';
import type { ItemScanner } from './report';

export function makeItemScanner(apiKey: string | null): ItemScanner {
  return async (item) => {
    const p0 = scanP0(item.text);
    if (apiKey && shouldEscalateToP1(p0.verdict, p0.confidence)) {
      const p1 = await scanP1(
        apiKey,
        item.text,
        'share',
        p0.verdict,
        p0.threat_layers.map((t) => t.label),
      );
      const merged = mergeVerdicts(p0, p1);
      return {
        confidence: merged.confidence,
        signals: merged.threat_layers,
        explanation: merged.explanation,
        deepScanned: true,
      };
    }
    return {
      confidence: p0.confidence,
      signals: p0.threat_layers,
      explanation: p0.explanation,
    };
  };
}
