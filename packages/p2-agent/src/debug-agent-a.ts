/**
 * Direct debug: run Agent A in isolation with error surfacing.
 * Usage: env $(grep -E "^ANTHROPIC" /Users/ich/.no5.env | xargs) npx tsx packages/p2-agent/src/debug-agent-a.ts
 */

import { getProvider } from './providers/index.js';
import { loadCouncilConfig, resolveAgentConfig } from './council-config.js';

const apiKey = process.env.ANTHROPIC_API_KEY;
const cfg = loadCouncilConfig();
const agentA = resolveAgentConfig('A', cfg, 'premium');

console.log('Agent A config:', JSON.stringify(agentA));
console.log('API key present:', Boolean(apiKey));

if (!agentA) { console.error('Agent A gated off'); process.exit(1); }

const provider = getProvider(agentA.provider);
console.log('Provider:', provider.name, '| supportsWebSearch:', provider.supportsWebSearch());

const t0 = Date.now();
try {
  const result = await provider.call({
    systemPrompt: 'You are Agent A. Given a claim, output: {"verdict":"supports"|"contradicts"|"no_signal","reasoning":"one sentence","citation_indices":[]}',
    userMessage: 'Claim: "CVE-2024-99999 was disclosed by CISA affecting 187 npm packages at CVSS 9.6." Verify it.',
    model: agentA.model,
    useWebSearch: agentA.web_search ?? false,
    config: { apiKey },
    maxTokens: 512,
  });
  console.log(`Done in ${Date.now() - t0}ms`);
  console.log('Text:', result.text.slice(0, 400));
  console.log('Citations:', result.citations.length);
} catch (e) {
  console.error(`Failed in ${Date.now() - t0}ms:`, (e as Error).message);
  console.error((e as Error).stack?.split('\n').slice(0, 5).join('\n'));
}
