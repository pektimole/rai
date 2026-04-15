/**
 * handler.ts — Pure scan logic, no Telegram coupling.
 *
 * Takes a string + chat_id, runs RAI P0, returns a verdict + reply text.
 * Per-chat isolation: each scan logged with chat_id in the session_id field
 * for traceability. No cross-user data access by design.
 */

import { rayScan, ScanLog } from '@rai/core';

export interface ScanResult {
  verdict: 'clean' | 'flagged' | 'blocked';
  reply: string;
  scan_id: string;
  threat_count: number;
}

/**
 * Format a Telegram-Markdown reply for a given verdict.
 * Kept short because Telegram messages should be scannable in one screen.
 */
function formatReply(scan: { verdict: string; threat_layers: any[]; explanation: string; confidence: number }): string {
  if (scan.verdict === 'clean') {
    return `✅ *No threats detected*\n\n_Forward another message any time._`;
  }

  const icon = scan.verdict === 'blocked' ? '🛡️' : '⚠️';
  const verdictLabel = scan.verdict === 'blocked' ? 'BLOCKED' : 'FLAGGED';
  const conf = (scan.confidence * 100).toFixed(0);

  const layers = scan.threat_layers
    .map((t) => `• ${t.label} _(${t.severity})_`)
    .join('\n');

  return `${icon} *${verdictLabel}* — ${conf}% confidence\n\n${layers}\n\n_${scan.explanation}_`;
}

/**
 * Run the scan for a single chat. chat_id is used as session_id for isolation.
 */
export async function scanForChat(text: string, chatId: number): Promise<ScanResult> {
  const sessionId = `tg:${chatId}`;

  const result = await rayScan({
    source: {
      channel: 'telegram',
      pipeline_stage: 'ingest',
      // Force scanning regardless of sender — every Telegram bot user is treated
      // as untrusted. This is the consumer beachhead, not a principal context.
      is_forward: true,
    },
    payload: { type: 'text', content: text },
    context: { session_id: sessionId, host_environment: 'api' },
  });

  return {
    verdict: result.verdict,
    reply: formatReply(result),
    scan_id: result.scan_id,
    threat_count: result.threat_layers.length,
  };
}

/**
 * Welcome message shown on /start. Keep brief, direct, and explain the value.
 */
export const WELCOME_MESSAGE = `*RAI — AI Interaction Firewall*

I scan suspicious messages for AI-targeted threats: prompt injection, credential leaks, jailbreaks, and more.

*How to use:*
1. Forward any message you're unsure about
2. I'll reply with a verdict in seconds
3. Zero data leaves the scanner — local regex only

You can also paste text directly. Send /help for more.`;

export const HELP_MESSAGE = `*How RAI works*

I check messages for:
• 🛡️ *Blocked* — critical threats (prompt injection, exfiltration, jailbreaks)
• ⚠️ *Flagged* — suspicious patterns (credentials, social engineering)
• ✅ *Clean* — no threats detected

*Privacy:*
• I scan locally — no message content sent to external APIs
• Each chat is isolated — your scans aren't visible to other users
• I don't store message text, only verdict counts

Open source: github.com/pektimole/rai
Privacy policy: rai.is/privacy`;
