#!/usr/bin/env node
/**
 * tg-scan-bot.ts — RAI Telegram inbound scan bot.
 *
 * Long-polls @RAISecuritybot, runs scanP1 on text/forwarded messages,
 * replies with verdict + 3-button label keyboard, appends labelled-corpus
 * rows to ~/.rai/audit/labelled-corpus.jsonl.
 *
 * Single-user v0: locked to RAI_TELEGRAM_CHAT_ID. Reject everything else.
 *
 * Required env (source ~/.no5-env):
 *   RAI_TELEGRAM_BOT_TOKEN
 *   RAI_TELEGRAM_CHAT_ID
 *   ANTHROPIC_API_KEY
 *
 * Run:
 *   cd packages/core && npm run build
 *   node packages/core/dist/tg-scan-bot.js
 */

import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanP1, type ScanInput, type ScanOutput } from './rai-scan-p1.js';

interface TgUser { id: number; username?: string }
interface TgChat { id: number }
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  forward_origin?: unknown;
}
interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  channel_post?: TgMessage;
  callback_query?: TgCallbackQuery;
}

const BOT_TOKEN = requireEnv('RAI_TELEGRAM_BOT_TOKEN');
const ALLOWED_CHAT_ID = requireEnv('RAI_TELEGRAM_CHAT_ID');
requireEnv('ANTHROPIC_API_KEY');
const AUDIT_DIR = process.env.RAI_AUDIT_DIR || path.join(os.homedir(), '.rai', 'audit');
const CORPUS_FILE = path.join(AUDIT_DIR, 'labelled-corpus.jsonl');
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`error: ${name} not set`);
    process.exit(2);
  }
  return v;
}

async function tgCall(method: string, body: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json() as { ok: boolean; result?: unknown; description?: string };
  if (!json.ok) throw new Error(`tg ${method}: ${json.description}`);
  return json.result;
}

async function appendJsonl(file: string, row: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(row) + '\n');
}

function sha256(s: string): string {
  return 'sha256:' + createHash('sha256').update(s).digest('hex');
}

function buildScanInput(content: string): ScanInput {
  return {
    scan_id: randomUUID(),
    timestamp: new Date().toISOString(),
    source: {
      channel: 'telegram',
      pipeline_stage: 'ingest',
      sender: null,
      origin_url: null,
      is_forward: true,
    },
    payload: { type: 'text', content },
    context: {
      session_id: 'tg-scan-bot',
      prior_scan_ids: [],
      host_environment: 'api',
    },
  };
}

function formatVerdictReply(result: ScanOutput): string {
  const emoji = result.verdict === 'flagged' ? '🚩' : '✅';
  const lines: string[] = [];
  lines.push(`${emoji} *${result.verdict}*  conf ${result.confidence.toFixed(2)}`);
  if (result.threat_layers.length) {
    lines.push('');
    for (const t of result.threat_layers) {
      lines.push(`• ${t.layer}:${t.signal} _(${t.severity})_`);
    }
  }
  lines.push('');
  lines.push(`_${result.latency_ms}ms_`);
  return lines.join('\n');
}

function buildLabelKeyboard(scanId: string) {
  return {
    inline_keyboard: [[
      { text: '👍 agree',     callback_data: `lbl:agree:${scanId}` },
      { text: '👎 disagree',  callback_data: `lbl:disagree:${scanId}` },
      { text: '🤷 borderline', callback_data: `lbl:borderline:${scanId}` },
    ]],
  };
}

const HELP = [
  '*RAI scan bot*',
  'forward any post or send text. i scan it and reply with verdict + label buttons.',
  '',
  '/scan <text>  — explicit scan',
  '/help         — this',
].join('\n');

async function handleMessage(msg: TgMessage): Promise<void> {
  if (String(msg.chat.id) !== ALLOWED_CHAT_ID) {
    console.error(`reject chat_id=${msg.chat.id} (allowed=${ALLOWED_CHAT_ID})`);
    return;
  }
  const raw = (msg.text || msg.caption || '').trim();
  if (!raw) return;

  if (raw === '/start' || raw === '/help') {
    await tgCall('sendMessage', { chat_id: msg.chat.id, text: HELP, parse_mode: 'Markdown' });
    return;
  }
  const content = raw.startsWith('/scan ') ? raw.slice(6).trim() : raw;
  if (!content) return;

  const input = buildScanInput(content);
  let result: ScanOutput;
  const t0 = Date.now();
  try {
    result = await scanP1(input);
  } catch (err) {
    const msgStr = err instanceof Error ? err.message : String(err);
    await tgCall('sendMessage', {
      chat_id: msg.chat.id,
      text: `scan failed: ${msgStr}`,
      reply_to_message_id: msg.message_id,
    });
    console.error(`scan error after ${Date.now() - t0}ms: ${msgStr}`);
    return;
  }

  await appendJsonl(CORPUS_FILE, {
    type: 'scan',
    scan_id: input.scan_id,
    ts: new Date().toISOString(),
    source: 'telegram',
    tg_chat_id: msg.chat.id,
    tg_message_id: msg.message_id,
    is_forward: !!msg.forward_origin,
    content_hash: sha256(content),
    content,
    verdict: result.verdict,
    confidence: result.confidence,
    signals: result.threat_layers.map((t) => t.signal),
    threat_layers: result.threat_layers,
    latency_ms: result.latency_ms,
  });

  await tgCall('sendMessage', {
    chat_id: msg.chat.id,
    text: formatVerdictReply(result),
    parse_mode: 'Markdown',
    reply_to_message_id: msg.message_id,
    reply_markup: buildLabelKeyboard(input.scan_id),
  });

  console.error(`scan ${input.scan_id} verdict=${result.verdict} conf=${result.confidence.toFixed(2)} ${result.latency_ms}ms`);
}

async function handleCallback(cb: TgCallbackQuery): Promise<void> {
  if (String(cb.from.id) !== ALLOWED_CHAT_ID) {
    await tgCall('answerCallbackQuery', { callback_query_id: cb.id, text: 'not allowed' });
    return;
  }
  const data = cb.data || '';
  const parts = data.split(':');
  if (parts[0] !== 'lbl' || parts.length !== 3) {
    await tgCall('answerCallbackQuery', { callback_query_id: cb.id });
    return;
  }
  const judgment = parts[1];
  const scanId = parts[2];
  if (!['agree', 'disagree', 'borderline'].includes(judgment)) {
    await tgCall('answerCallbackQuery', { callback_query_id: cb.id, text: 'unknown label' });
    return;
  }

  await appendJsonl(CORPUS_FILE, {
    type: 'judgment',
    scan_id: scanId,
    ts: new Date().toISOString(),
    judgment,
  });

  await tgCall('answerCallbackQuery', { callback_query_id: cb.id, text: `✓ ${judgment}` });

  if (cb.message) {
    await tgCall('editMessageReplyMarkup', {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      reply_markup: { inline_keyboard: [[{ text: `✓ labelled: ${judgment}`, callback_data: 'noop' }]] },
    });
  }
  console.error(`judgment scan_id=${scanId} ${judgment}`);
}

async function main(): Promise<void> {
  console.error(`rai-tg-scan-bot starting`);
  console.error(`audit:   ${CORPUS_FILE}`);
  console.error(`chat_id: ${ALLOWED_CHAT_ID}  (single-user)`);

  // sanity: who am i
  try {
    const me = await tgCall('getMe');
    console.error(`bot:     @${me.username} (id=${me.id})`);
  } catch (err) {
    console.error(`getMe failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  let offset = 0;
  while (true) {
    try {
      const updates: TgUpdate[] = await tgCall('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message', 'callback_query'],
      });
      for (const upd of updates) {
        offset = upd.update_id + 1;
        try {
          if (upd.message) await handleMessage(upd.message);
          else if (upd.callback_query) await handleCallback(upd.callback_query);
        } catch (err) {
          console.error(`update ${upd.update_id} handler error: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch (err) {
      console.error(`getUpdates: ${err instanceof Error ? err.message : err}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main().catch((err) => {
  console.error('tg-scan-bot crashed:', err);
  process.exit(1);
});
