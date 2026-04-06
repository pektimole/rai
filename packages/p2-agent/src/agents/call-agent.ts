/**
 * Shared Claude API call for P2 agents.
 * Each agent provides its prompt template; this handles the API call and JSON parsing.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { AgentVerdict, P2Input } from '../types.js';

const MODEL_DEFAULT = 'claude-haiku-4-5-20251001';
const MODEL_ESCALATION = 'claude-sonnet-4-5-20241022';
const CONFIDENCE_ESCALATION_THRESHOLD = 0.5;

export async function callAgent(
  agentName: AgentVerdict['agent'],
  systemPrompt: string,
  input: P2Input,
  apiKey: string,
): Promise<AgentVerdict> {
  const client = new Anthropic({ apiKey });

  const userMessage = buildUserMessage(input);

  // First call with Haiku
  let result = await makeCall(client, MODEL_DEFAULT, systemPrompt, userMessage);
  const parsed = parseAgentResponse(agentName, result);

  // Escalate to Sonnet if confidence is too low
  if (parsed.confidence > 0 && parsed.confidence < CONFIDENCE_ESCALATION_THRESHOLD) {
    const escalated = await makeCall(client, MODEL_ESCALATION, systemPrompt, userMessage);
    return parseAgentResponse(agentName, escalated);
  }

  return parsed;
}

async function makeCall(
  client: Anthropic,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const response = await client.messages.create({
    model,
    max_tokens: 512,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const block = response.content[0];
  if (block.type !== 'text') {
    throw new Error(`Unexpected response type: ${block.type}`);
  }
  return block.text;
}

function buildUserMessage(input: P2Input): string {
  const parts = [
    `Claim: "${input.claim}"`,
    `Channel: ${input.channel}`,
    `Timestamp: ${input.timestamp}`,
    `P1 verdict: ${input.p1_verdict} (confidence: ${input.p1_confidence})`,
  ];

  if (input.source_url) {
    parts.push(`Source URL: ${input.source_url}`);
  }

  if (input.p1_threat_layers.length > 0) {
    const layers = input.p1_threat_layers
      .map(l => `${l.layer} (${l.label}): ${l.signal} [${l.severity}]`)
      .join('; ');
    parts.push(`Threat layers: ${layers}`);
  }

  return parts.join('\n');
}

function parseAgentResponse(
  agentName: AgentVerdict['agent'],
  raw: string,
): AgentVerdict {
  // Extract JSON from response (may be wrapped in markdown code blocks)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      agent: agentName,
      verdict: 'uncertain',
      confidence: 0,
      reasoning: `Failed to parse agent response: ${raw.slice(0, 200)}`,
      evidence: [],
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      agent: agentName,
      verdict: parsed.verdict ?? 'uncertain',
      confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0)),
      reasoning: parsed.reasoning ?? '',
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
    };
  } catch {
    return {
      agent: agentName,
      verdict: 'uncertain',
      confidence: 0,
      reasoning: `JSON parse error: ${raw.slice(0, 200)}`,
      evidence: [],
    };
  }
}
