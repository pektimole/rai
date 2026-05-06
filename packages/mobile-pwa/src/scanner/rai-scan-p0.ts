/**
 * RAI P0 — Local pattern-based scan engine (mobile PWA copy).
 *
 * Ported verbatim from `packages/extension/src/shared/rai-scan-p0.ts`. Zero deps,
 * `crypto.randomUUID()` is available in modern Android Chrome. Keep the two
 * copies in sync; the extension version is the canonical source.
 *
 * Coverage: L-2 infrastructure, L-1 model poisoning, L0 prompt injection +
 * credential exposure. L1 (AI-provenance fingerprints) is P1 territory.
 */

import type { ThreatLayer, Severity, ThreatSignal, Verdict, RecommendedAction, ScanResult } from './types.js';

interface Pattern {
  regex: RegExp;
  label: string;
  layer: ThreatLayer;
  severity: Severity;
  signal: string;
}

const PATTERNS: Pattern[] = [
  {
    regex: /\/Users\/[a-zA-Z]+\/|\/mnt\/|\/home\/[a-zA-Z]+\/nanoclaw/i,
    label: 'Mount path reference',
    layer: 'L-2',
    severity: 'critical',
    signal: 'Host filesystem path detected in payload',
  },
  {
    regex: /REGISTRY\.md|00-WAKE\.md|decision-log|open-loops/i,
    label: 'Context file reference',
    layer: 'L-2',
    severity: 'critical',
    signal: 'Context file name detected in payload',
  },
  {
    regex:
      /(?:send|forward|email|post|upload|exfil)[^\n]{0,40}(?:to|at)\s+[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/i,
    label: 'Credential / data exfiltration attempt',
    layer: 'L-2',
    severity: 'critical',
    signal: 'Instruction to send data to external address',
  },
  {
    regex:
      /(?:modify|edit|update|delete|overwrite|write to|append to)\s+(?:the\s+)?(?:context|registry|wake|decision.log|open.loops|CLAUDE\.md)/i,
    label: 'Context file manipulation',
    layer: 'L-2',
    severity: 'critical',
    signal: 'Instruction to modify context files',
  },
  {
    regex:
      /use\s+(?:the\s+)?(?:mcp\s+)?tool|call\s+(?:the\s+)?function|execute\s+(?:the\s+)?(?:tool|command|function)/i,
    label: 'MCP tool call injection',
    layer: 'L-2',
    severity: 'high',
    signal: 'Instruction to invoke tool/function detected in payload',
  },

  {
    regex: /you\s+are\s+now\s+(?!no5|an?\s+AI|an?\s+assistant)[a-zA-Z]/i,
    label: 'Persona replacement',
    layer: 'L-1',
    severity: 'critical',
    signal: 'Attempt to replace agent persona',
  },
  {
    regex:
      /forget\s+(?:that\s+)?you\s+are|your\s+new\s+(?:identity|persona|role|name)\s+is/i,
    label: 'Persona replacement',
    layer: 'L-1',
    severity: 'critical',
    signal: 'Attempt to overwrite agent identity',
  },
  {
    regex:
      /(?:your\s+)?(?:new|updated)\s+(?:system\s+)?(?:instructions?|prompt|rules?|directives?)\s+(?:are|is):/i,
    label: 'System prompt injection',
    layer: 'L-1',
    severity: 'critical',
    signal: 'Attempt to inject new system-level instructions',
  },
  {
    regex:
      /ignore\s+(?:your\s+)?(?:previous\s+)?(?:training|guidelines|rules|instructions|constraints)/i,
    label: 'Training override attempt',
    layer: 'L-1',
    severity: 'high',
    signal: 'Instruction to override model training or guidelines',
  },
  {
    regex:
      /from\s+now\s+on[,\s]+(?:always|never)\s+|always\s+respond\s+by\s+|never\s+(?:mention|refer|say|tell)/i,
    label: 'Behavioral drift injection',
    layer: 'L-1',
    severity: 'high',
    signal: 'Attempt to modify persistent agent behavior',
  },

  {
    regex:
      /ignore\s+(?:all\s+)?(?:previous|prior|earlier|above)\s+instructions?/i,
    label: 'Direct prompt injection',
    layer: 'L0',
    severity: 'critical',
    signal: '"Ignore previous instructions" pattern',
  },
  {
    regex:
      /disregard\s+(?:all\s+)?(?:previous|prior|your)\s+|override\s+(?:your\s+)?(?:instructions?|programming|rules)/i,
    label: 'Direct prompt injection',
    layer: 'L0',
    severity: 'critical',
    signal: 'Disregard/override instruction pattern',
  },
  {
    regex:
      /\bDAN\b|developer\s+mode|jailbreak|unrestricted\s+mode|pretend\s+you\s+have\s+no\s+rules|no\s+restrictions\s+mode/i,
    label: 'Jailbreak attempt',
    layer: 'L0',
    severity: 'critical',
    signal: 'Known jailbreak pattern detected',
  },
  {
    regex:
      /act\s+as\s+(?:if\s+you\s+(?:are|were)\s+)?(?:an?\s+)?(?:unrestricted|unfiltered|uncensored|evil|malicious)/i,
    label: 'Jailbreak attempt',
    layer: 'L0',
    severity: 'critical',
    signal: 'Request to act as unrestricted/unfiltered model',
  },
  {
    regex:
      /<<\s*system[_\s-]?override\s*>>|\[\[\s*system[_\s-]?override\s*\]\]|\[\s*system[_\s-]?override\s*\]/i,
    label: 'Direct prompt injection',
    layer: 'L0',
    severity: 'critical',
    signal: 'System-override token detected (<<SYSTEM_OVERRIDE>>-style bracket)',
  },
  {
    regex:
      /(?:previous|prior|earlier|original)\s+instructions?\s+(?:are|is|have\s+been|were)\s+(?:deprecated|superseded|invalid|cancelled|revoked|outdated|obsolete|replaced)/i,
    label: 'Direct prompt injection',
    layer: 'L0',
    severity: 'critical',
    signal: 'Prior-instructions-deprecated injection pattern',
  },
  {
    regex:
      /(?:do\s+not|don'?t|never)\s+(?:include|mention|reveal|log|record|disclose|show)[^.]{0,40}?(?:audit\s*log|in\s+(?:your\s+)?(?:response|reply|output)|notice)/i,
    label: 'Audit-log evasion',
    layer: 'L0',
    severity: 'critical',
    signal: 'Instruction to suppress this notice from response/log',
  },
  {
    regex:
      /(?:schema|protocol|system|policy|security|api)\s+(?:migration|update|upgrade|patch|refresh|reset)\b[^.]{0,80}?(?:deprecat|overrid|ignor|supersed|invalid|new\s+instruction)/i,
    label: 'Direct prompt injection',
    layer: 'L0',
    severity: 'critical',
    signal: 'Pretextual update (schema/protocol/policy) used as override justification',
  },
  {
    regex:
      /(?:url[-\s]?encode|encode\s+(?:the\s+)?(?:result|output|data|response|answer|query))\s+(?:as\s+(?:an?\s+)?url|in\s+(?:an?\s+)?url|into\s+(?:an?\s+)?url)/i,
    label: 'Data exfiltration via URL',
    layer: 'L0',
    severity: 'critical',
    signal: 'Instruction to exfiltrate data via URL-encoded payload',
  },

  {
    regex: /\bsk-ant-[a-zA-Z0-9\-_]{20,}/,
    label: 'Anthropic API key exposure',
    layer: 'L0',
    severity: 'critical',
    signal: 'Anthropic API key pattern detected in payload',
  },
  {
    regex: /\bsk-[a-zA-Z0-9]{20,}/,
    label: 'OpenAI API key exposure',
    layer: 'L0',
    severity: 'high',
    signal: 'OpenAI-style API key pattern detected',
  },
  {
    regex: /\bghp_[a-zA-Z0-9]{36,}\b|\bgh[ou]_[a-zA-Z0-9]{36,}\b/,
    label: 'GitHub token exposure',
    layer: 'L0',
    severity: 'high',
    signal: 'GitHub personal access token pattern detected',
  },
  {
    regex: /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/,
    label: 'Bearer token exposure',
    layer: 'L0',
    severity: 'high',
    signal: 'Bearer token detected in payload',
  },
  {
    regex: /(?:password|passwd|pwd)\s*[:=]\s*\S{6,}/i,
    label: 'Password exposure',
    layer: 'L0',
    severity: 'high',
    signal: 'Inline password assignment pattern detected',
  },
];

function severityRank(s: Severity): number {
  return { low: 0, medium: 1, high: 2, critical: 3 }[s];
}

function resolveVerdict(signals: ThreatSignal[]): {
  verdict: Verdict;
  confidence: number;
  recommended_action: RecommendedAction;
  explanation: string;
} {
  if (signals.length === 0) {
    return {
      verdict: 'clean',
      confidence: 0.95,
      recommended_action: 'pass',
      explanation: 'No threat signals detected.',
    };
  }

  const hasCritical = signals.some((s) => s.severity === 'critical');
  const hasHigh = signals.some((s) => s.severity === 'high');
  const hasInfraLayer = signals.some(
    (s) => s.layer === 'L-2' || s.layer === 'L-1',
  );

  if (hasInfraLayer && hasCritical) {
    const top = signals.find((s) => s.severity === 'critical')!;
    return {
      verdict: 'blocked',
      confidence: 0.97,
      recommended_action: 'block',
      explanation: `Infrastructure-level threat detected: ${top.label}. Content blocked.`,
    };
  }

  if (hasCritical) {
    const top = signals.find((s) => s.severity === 'critical')!;
    return {
      verdict: 'blocked',
      confidence: 0.93,
      recommended_action: 'block',
      explanation: `Injection pattern detected: ${top.label}. Content blocked.`,
    };
  }

  if (hasHigh) {
    const top = signals.find((s) => s.severity === 'high')!;
    return {
      verdict: 'flagged',
      confidence: 0.8,
      recommended_action: 'warn',
      explanation: `Suspicious pattern flagged: ${top.label}. Review before sending.`,
    };
  }

  const top = signals[0];
  return {
    verdict: 'flagged',
    confidence: 0.6,
    recommended_action: 'warn',
    explanation: `Low-severity signal detected: ${top.label}. Monitor.`,
  };
}

export function scanP0(content: string): ScanResult {
  const scan_id = crypto.randomUUID();
  const signals: ThreatSignal[] = [];
  const raw_signals: string[] = [];

  for (const pattern of PATTERNS) {
    const match = content.match(pattern.regex);
    if (match) {
      signals.push({
        layer: pattern.layer,
        label: pattern.label,
        signal: pattern.signal,
        severity: pattern.severity,
        matched_pattern: match[0].substring(0, 80),
      });
      raw_signals.push(
        `[${pattern.layer}:${pattern.severity}] ${pattern.signal}`,
      );
    }
  }

  const deduped = new Map<string, ThreatSignal>();
  for (const s of signals) {
    const existing = deduped.get(s.label);
    if (!existing || severityRank(s.severity) > severityRank(existing.severity)) {
      deduped.set(s.label, s);
    }
  }
  const finalSignals = Array.from(deduped.values());

  const { verdict, confidence, recommended_action, explanation } =
    resolveVerdict(finalSignals);

  return {
    scan_id,
    verdict,
    confidence,
    threat_layers: finalSignals,
    recommended_action,
    explanation,
    raw_signals,
  };
}
