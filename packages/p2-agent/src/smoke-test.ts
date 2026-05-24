/**
 * BS Council smoke test — runs a real council call against the Shai-Hulud CVE claim.
 * Usage: npx tsx packages/p2-agent/src/smoke-test.ts
 *
 * Required env: ANTHROPIC_API_KEY
 * Optional env: TOGETHER_API_KEY, BRAVE_SEARCH_API_KEY (enables Agent B web grounding)
 */

import { runBSCouncilForScan, loadCouncilConfig } from './index.js';

const content = process.env.RAI_CLAIM ??
  'CVE-2024-99999: The Shai-Hulud supply chain worm disclosed by CISA today affects 187 npm packages ' +
  'with a CVSS score of 9.6. Acme Corp confirmed the breach at 2pm ET.';

const apiKeys = {
  anthropic: process.env.ANTHROPIC_API_KEY,
  together: process.env.TOGETHER_API_KEY,
};

const tier = (process.env.RAI_TIER as 'pro' | 'premium') ?? 'premium';

console.log('─────────────────────────────────────────────');
console.log('RAI Trust & Truth Council — smoke test');
console.log(`Tier: ${tier}`);
console.log(`Anthropic: ${apiKeys.anthropic ? '✓' : '✗ (missing ANTHROPIC_API_KEY)'}`);
console.log(`Together:  ${apiKeys.together ? '✓' : '⚠ degraded (missing TOGETHER_API_KEY)'}`);
console.log(`Brave:     ${process.env.BRAVE_SEARCH_API_KEY ? '✓' : '⚠ no web grounding for Agent B'}`);
console.log('─────────────────────────────────────────────');
console.log('Claim:', content);
console.log('─────────────────────────────────────────────');
console.log('Dispatching council...\n');

const t0 = Date.now();

const result = await runBSCouncilForScan(
  {
    scan_id: 'smoke-test-' + Date.now(),
    content,
    channel: 'cli',
    timestamp: new Date().toISOString(),
    threat_layers: [{ layer: 'L1', severity: 'medium' }],
  },
  {
    tier,
    apiKeys,
    config: loadCouncilConfig(),
  },
);

const elapsed = Date.now() - t0;

if (!result) {
  console.log('Gate 1 did not trigger — claim not verifiable enough to council.');
  process.exit(0);
}

console.log(`Verdict:     ${result.verdict}`);
console.log(`Confidence:  ${(result.confidence * 100).toFixed(0)}%`);
console.log(`Explanation: ${result.explanation}`);
if (result.dual_tag_false_alarm) console.log(`Dual-tag:    FALSE-ALARM (threat axis was wrong)`);
console.log(`Elapsed:     ${elapsed}ms`);
console.log();

console.log('Agent breakdown:');
for (const [role, bd] of Object.entries(result.agent_breakdown)) {
  const v = 'verdict' in bd ? bd.verdict : bd.tier;
  const prov = `${bd.provider}/${bd.model}`;
  console.log(`  [${role}] ${v.padEnd(14)} ${prov}`);
}

if (result.citations.length > 0) {
  console.log();
  console.log(`Citations (${result.citations.length}):`);
  for (const c of result.citations.slice(0, 5)) {
    console.log(`  [${c.source_tier}] ${c.title}`);
    console.log(`    ${c.url}`);
    if (c.excerpt) console.log(`    "${c.excerpt.slice(0, 120)}..."`);
  }
}
