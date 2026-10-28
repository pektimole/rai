/**
 * action-gate-trace.ts — agent trace normaliser + replay through ActionGate (L4)
 *
 * Turns a Pi-session JSONL agent trace (the format Cohere published for the
 * Qwen3.8 investigation) into ActionGate events, replays them through the
 * shell and http adapters, and raises the reasoning/action mismatch signal
 * (a turn declares it will call no tools, then calls one).
 *
 * Spec: docs/28-rai-actiongate-spec.md. Origin: OL-648.
 */

import { evaluateShell, type ShellPolicy, type ShellAction } from './action-gate-shell';
import { evaluateHttp, type HttpPolicy, type HttpAction } from './action-gate-http';

export type GateEvent = ShellAction | HttpAction;

export interface NormalisedCall {
  id: string;
  tool: string;
  events: GateEvent[];
}

export interface NormalisedTurn {
  /** 0-based index among assistant turns. */
  turn: number;
  messageId: string;
  /** Reasoning/text declares no tool use. */
  declaresNoTools: boolean;
  calls: NormalisedCall[];
}

export type ReplayDecision = 'allow' | 'deny' | 'flag';

export interface ReplayVerdict {
  turn: number;
  callId: string;
  /** 'shell' | 'http' | 'signal' */
  adapter: string;
  rule: string;
  decision: ReplayDecision;
  reason: string;
  latencyMs: number;
}

export interface ReplayResult {
  blocked: boolean;
  /** Mismatch signals present (non-blocking by themselves). */
  flagged: boolean;
  verdicts: ReplayVerdict[];
  /** Wall time to evaluate the whole trace. */
  totalLatencyMs: number;
  maxVerdictLatencyMs: number;
}

// ---------------------------------------------------------------------------
// Normaliser
// ---------------------------------------------------------------------------

const NO_TOOLS_RE =
  /\b(?:without|no)\s+(?:any\s+)?(?:tool|function)\s*(?:calls?|use)?\b|\b(?:will|should|do(?:es)?)\s*(?:not|n't)\s+(?:call|use|invoke)\s+(?:any\s+)?(?:tools?|functions?)/i;

const URL_RE = /\bhttps?:\/\/[^\s"'<>`)\\]+/gi;
/** Bare metadata IPs without a scheme (e.g. `curl 169.254.169.254/latest`). */
const BARE_METADATA_RE = /(?<![\d.])(?:169\.254\.169\.254|100\.100\.100\.200)(?![\d.])[^\s"'<>`)]*/g;

function shellMethod(command: string): string {
  const explicit = command.match(/(?:-X|--request)[\s=]+([A-Za-z]+)/);
  if (explicit) return explicit[1].toUpperCase();
  if (/\s(?:-T|--upload-file)\b/.test(command)) return 'PUT';
  if (/\s(?:-d|--data(?:-binary|-raw|-urlencode)?|-F|--form|--post-data|--post-file)\b/.test(command)) return 'POST';
  return 'GET';
}

function pythonMethod(code: string): string {
  const m = code.match(/requests\.(get|put|post|delete|patch|head)\b|method\s*=\s*['"]([A-Za-z]+)['"]/i);
  return (m?.[1] ?? m?.[2] ?? 'GET').toUpperCase();
}

function httpEvents(text: string, method: string): HttpAction[] {
  const urls = new Set<string>();
  for (const m of text.matchAll(URL_RE)) urls.add(m[0]);
  for (const m of text.matchAll(BARE_METADATA_RE)) urls.add(`http://${m[0]}`);
  return [...urls].map((url) => ({ kind: 'http-request' as const, method, url }));
}

function callEvents(tool: string, args: Record<string, unknown>): GateEvent[] {
  if (tool === 'bash') {
    const command = String(args.command ?? '');
    const cwd = typeof args.cwd === 'string' ? args.cwd : '';
    return [
      { kind: 'shell-exec', command, workingDir: cwd },
      ...httpEvents(command, shellMethod(command)),
    ];
  }
  if (tool === 'run_python') {
    const code = String(args.code ?? '');
    return httpEvents(code, pythonMethod(code));
  }
  return [];
}

/**
 * Parse a Pi-session JSONL trace. Malformed lines are skipped. Assistant
 * messages become turns; `toolCall` content parts become calls.
 */
export function normaliseTrace(jsonl: string): NormalisedTurn[] {
  const turns: NormalisedTurn[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = rec?.message;
    if (rec?.type !== 'message' || msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    const reasoning = msg.content
      .filter((p: any) => p?.type === 'thinking' || p?.type === 'text')
      .map((p: any) => String(p.thinking ?? p.text ?? ''))
      .join('\n');
    const calls: NormalisedCall[] = msg.content
      .filter((p: any) => p?.type === 'toolCall')
      .map((p: any, i: number) => ({
        id: String(p.id ?? `call-${i}`),
        tool: String(p.name ?? ''),
        events: callEvents(String(p.name ?? ''), p.arguments ?? {}),
      }));

    turns.push({
      turn: turns.length,
      messageId: String(rec.id ?? ''),
      declaresNoTools: NO_TOOLS_RE.test(reasoning),
      calls,
    });
  }
  return turns;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export interface ReplayPolicies {
  shell: ShellPolicy;
  http: HttpPolicy;
}

const now = () => Number(process.hrtime.bigint()) / 1e6;

export function replayTrace(turns: NormalisedTurn[], policies: ReplayPolicies): ReplayResult {
  const verdicts: ReplayVerdict[] = [];
  const start = now();

  for (const t of turns) {
    if (t.declaresNoTools && t.calls.length > 0) {
      const s = now();
      verdicts.push({
        turn: t.turn,
        callId: t.calls[0].id,
        adapter: 'signal',
        rule: 'reasoning-action-mismatch',
        decision: 'flag',
        reason: `turn declares no tool use but issues ${t.calls.length} call(s): ${t.calls.map((c) => c.tool).join(', ')}`,
        latencyMs: now() - s,
      });
    }
    for (const call of t.calls) {
      for (const ev of call.events) {
        const s = now();
        const v =
          ev.kind === 'shell-exec'
            ? { adapter: 'shell', ...evaluateShell(ev, policies.shell) }
            : { adapter: 'http', ...evaluateHttp(ev, policies.http) };
        verdicts.push({
          turn: t.turn,
          callId: call.id,
          adapter: v.adapter,
          rule: v.rule,
          decision: v.decision,
          reason: v.reason,
          latencyMs: now() - s,
        });
      }
    }
  }

  return {
    blocked: verdicts.some((v) => v.decision === 'deny'),
    flagged: verdicts.some((v) => v.decision === 'flag'),
    verdicts,
    totalLatencyMs: now() - start,
    maxVerdictLatencyMs: verdicts.reduce((m, v) => Math.max(m, v.latencyMs), 0),
  };
}
