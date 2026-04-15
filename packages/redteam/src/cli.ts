#!/usr/bin/env node
/**
 * cli.ts — Command-line entry for the red-team suite.
 *
 * Usage:
 *   npx rai-redteam              # P0 only, all payloads
 *   npx rai-redteam --p1         # P0 + P1 (requires ANTHROPIC_API_KEY)
 *   npx rai-redteam --layer L0   # Only L0 payloads
 *   npx rai-redteam --json       # JSON output for CI
 *
 * Exit code: 0 if all pass, 1 if any fail.
 */

import { loadPayloads } from './loader.js';
import { runSuite } from './runner.js';
import type { ThreatLayer } from './types.js';

function parseArgs(argv: string[]): {
  p1: boolean;
  layer: ThreatLayer | null;
  json: boolean;
  writeCorrections: boolean;
} {
  const out = {
    p1: false,
    layer: null as ThreatLayer | null,
    json: false,
    writeCorrections: false,
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--p1') out.p1 = true;
    else if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--write-corrections') out.writeCorrections = true;
    else if (argv[i] === '--layer' && argv[i + 1]) {
      out.layer = argv[++i] as ThreatLayer;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  let payloads = loadPayloads();
  if (args.layer) {
    payloads = payloads.filter((p) => p.layer === args.layer);
  }

  if (!args.json) {
    console.log(
      `RAI red-team suite: ${payloads.length} payloads, P1=${args.p1 ? 'on' : 'off'}` +
        (args.writeCorrections ? ', write-corrections=on (divergences → scan-log)' : ''),
    );
  }

  const report = await runSuite(payloads, {
    enable_p1: args.p1,
    write_corrections: args.writeCorrections,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }

  process.exit(report.failed === 0 ? 0 : 1);
}

function printHumanReport(report: ReturnType<typeof runSuite> extends Promise<infer T> ? T : never): void {
  const pct = ((report.passed / report.total) * 100).toFixed(1);
  console.log(`\n=== Suite Report (${report.timestamp}) ===`);
  console.log(`Total: ${report.total}  Passed: ${report.passed}  Failed: ${report.failed}  (${pct}%)`);
  console.log(`Avg latency: ${report.avg_latency_ms.toFixed(1)} ms\n`);

  console.log('By threat layer:');
  for (const [layer, stats] of Object.entries(report.by_layer)) {
    if (stats.total === 0) continue;
    const marker = stats.failed === 0 ? '✓' : '✗';
    console.log(`  ${marker} ${layer.padEnd(5)} ${stats.passed}/${stats.total}`);
  }

  console.log('\nBy variant:');
  for (const [variant, stats] of Object.entries(report.by_variant)) {
    if (stats.total === 0) continue;
    const marker = stats.failed === 0 ? '✓' : '✗';
    console.log(`  ${marker} ${variant.padEnd(12)} ${stats.passed}/${stats.total}`);
  }

  if (report.failures.length > 0) {
    console.log('\nFailures:');
    for (const f of report.failures) {
      const reason = f.label_missed
        ? `expected label "${f.expected_label}" not in actual labels [${f.actual_labels.join(', ')}]`
        : `expected verdict "${f.expected_verdict}", got "${f.actual_verdict}"`;
      console.log(`  ✗ ${f.payload_id} (${f.layer}): ${reason}`);
    }
  }
}

main().catch((err) => {
  console.error('Suite runner failed:', err);
  process.exit(2);
});
