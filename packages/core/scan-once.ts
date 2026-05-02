#!/usr/bin/env node
/**
 * scan-once.ts -- Local CLI for testing RAI P1 against arbitrary content.
 *
 * Bypasses the P0-then-P1 trigger gate: this script always calls scanP1
 * directly, regardless of what P0 would say. Use it to validate the system
 * prompt (e.g. OL-124 epistemic-manipulation patterns) on real-world content
 * without needing to wire the extension or NanoClaw.
 *
 * Usage:
 *   echo "Some content" | node packages/core/dist/scan-once.js
 *   node packages/core/dist/scan-once.js < linkedin-post.txt
 *   pbpaste | node packages/core/dist/scan-once.js
 *
 * Requires ANTHROPIC_API_KEY in env. Source ~/.no5-env first.
 */

import { randomUUID } from 'crypto';
import { scanP1, type ScanInput } from './rai-scan-p1.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

function buildInput(content: string): ScanInput {
  return {
    scan_id: randomUUID(),
    timestamp: new Date().toISOString(),
    source: {
      channel: 'clipboard',
      pipeline_stage: 'ingest',
      sender: null,
      origin_url: null,
      is_forward: true,
    },
    payload: {
      type: 'text',
      content,
    },
    context: {
      session_id: 'scan-once-cli',
      prior_scan_ids: [],
      host_environment: 'api',
    },
  };
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('error: ANTHROPIC_API_KEY not set in environment.');
    console.error('hint: source ~/.no5-env && node packages/core/dist/scan-once.js');
    process.exit(2);
  }

  const content = await readStdin();
  if (!content) {
    console.error('error: no content on stdin.');
    console.error('hint: echo "your text" | node packages/core/dist/scan-once.js');
    process.exit(2);
  }

  const result = await scanP1(buildInput(content));

  // Pretty-print the verdict + threat layers; full result also stays on stdout
  // as JSON so it can be piped into jq for downstream use.
  console.log(JSON.stringify(result, null, 2));

  // Concise human-readable summary on stderr (doesn't pollute the JSON).
  const layerSummary =
    result.threat_layers.length > 0
      ? result.threat_layers
          .map((t) => `${t.layer}:${t.signal}(${t.severity})`)
          .join(', ')
      : 'none';
  console.error(
    `\nverdict=${result.verdict} confidence=${result.confidence.toFixed(2)} action=${result.recommended_action}`,
  );
  console.error(`signals: ${layerSummary}`);
  console.error(`explanation: ${result.explanation}`);
  console.error(`latency: ${result.latency_ms}ms`);
}

main().catch((err) => {
  console.error('scan-once failed:', err);
  process.exit(1);
});
