#!/usr/bin/env node
/**
 * action-gate-native-messaging-host-runner.ts
 *
 * Tails ~/.rai/vcce-watch.jsonl produced by rai-vcce-watch.sh, normalises
 * each event into a NativeMessagingHostAction, runs it through the NMH
 * ActionGate policy, and appends the verdict to ~/.rai/audit/rai-actiongate.jsonl.
 *
 * This is Phase A of OL-140 Option 2 -- the thin bridge that lifts the
 * VCCE watcher output into ActionGate's canonical audit stream.
 *
 * Usage:
 *   node action-gate-native-messaging-host-runner.ts         # tail mode (default)
 *   node action-gate-native-messaging-host-runner.ts --once  # process then exit
 *
 * Design:
 *   - No SQLite, no database. State is a single byte-offset file so restarts
 *     pick up where they left off.
 *   - File rotation (watcher truncates the log) is detected by a stat check;
 *     on shrink we reset the offset to 0.
 *   - Heartbeat and parse_error events are logged to run log, not audit log.
 *   - Per-vendor baseline snapshots (sha256 + allowed_origins) are tracked
 *     in-memory so modified events can compute allowed_origins_diff.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

import {
  normaliseEvent,
  evaluateNativeMessagingHost,
  defaultNmhPolicy,
  actionSummary,
  syntheticScanId,
  type VcceWatchEvent,
  type NmhVerdict,
  type NativeMessagingHostAction,
} from './action-gate-native-messaging-host.js';

import { AuditLog } from './audit-log.js';

// ---------------------------------------------------------------------------
// Paths + config
// ---------------------------------------------------------------------------

const HOME = os.homedir();
const WATCH_LOG = path.join(HOME, '.rai', 'vcce-watch.jsonl');
const STATE_FILE = path.join(HOME, '.rai', 'action-gate-nmh.state');
const AUDIT_DIR = path.join(HOME, '.rai', 'audit');
const RUN_LOG = path.join(HOME, '.rai', 'action-gate-nmh.run.log');
const POLL_MS = 2_000;

// ---------------------------------------------------------------------------
// State: byte offset + per-(path) baseline snapshot
// ---------------------------------------------------------------------------

interface BaselineSnapshot {
  sha256?: string;
  allowed_origins?: string[];
}

const baseline = new Map<string, BaselineSnapshot>();

function readState(): number {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8').trim();
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeState(offset: number): void {
  fs.writeFileSync(STATE_FILE, String(offset));
}

function runLog(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    fs.appendFileSync(RUN_LOG, line);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Core processing
// ---------------------------------------------------------------------------

const policy = defaultNmhPolicy();
const audit = new AuditLog(AUDIT_DIR);

/**
 * Optional notify hook. If RAI_NOTIFY_CMD is set in env, the runner forks+execs
 * the command on every non-allow verdict with a JSON payload on stdin.
 * The hook is fire-and-forget: we do not block the tail loop on delivery.
 *
 * Payload shape:
 *   { adapter, decision, rule, reason, vendor, browser, path, scan_id, ts }
 *
 * Stub script lives at ~/no5-scripts/rai-notify.sh -- replace body to wire
 * WhatsApp, Telegram, Slack, NanoClaw webhook, or macOS notification.
 */
function notify(
  action: NativeMessagingHostAction,
  verdict: NmhVerdict,
  scanId: string,
  ts: string,
): void {
  if (!verdict.notify) return;
  const cmd = process.env.RAI_NOTIFY_CMD;
  if (!cmd) return;

  const payload = JSON.stringify({
    adapter: 'native-messaging-host',
    decision: verdict.decision,
    rule: verdict.rule,
    reason: verdict.reason,
    vendor: action.vendor,
    browser: action.browser,
    path: action.path,
    scan_id: scanId,
    ts,
  });

  try {
    const child = spawn('/bin/sh', ['-c', cmd], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    });
    child.stdin.write(payload);
    child.stdin.end();
    child.unref();
  } catch (err) {
    runLog(`notify-error cmd=${cmd} err=${String(err).slice(0, 200)}`);
  }
}

function processLine(line: string): NmhVerdict | null {
  if (!line.trim()) return null;

  let raw: VcceWatchEvent;
  try {
    raw = JSON.parse(line) as VcceWatchEvent;
  } catch {
    runLog(`bad-json: ${line.slice(0, 120)}`);
    return null;
  }

  // Heartbeats are Phase B territory; runner just notes them in run log.
  if (raw.event === 'heartbeat') {
    runLog(`heartbeat ts=${raw.ts}`);
    return null;
  }

  // 'removed' events: record as audit entry but skip policy evaluation.
  if (raw.event === 'removed' && raw.path) {
    audit.log({
      adapter: 'native-messaging-host',
      decision: 'allow',
      rule: 'manifest-removed',
      reason: `manifest removed: ${raw.path}`,
      action_summary: `removed ${raw.browser ?? 'unknown'}:${raw.vendor ?? 'unknown'}`,
      source: `vendor:${raw.vendor ?? 'unknown'}`,
    });
    baseline.delete(raw.path);
    return null;
  }

  const prev = raw.path ? baseline.get(raw.path) : undefined;
  const action = normaliseEvent(raw, prev);
  if (!action) {
    if (raw.parse_error) {
      runLog(`parse_error path=${raw.path ?? 'unknown'} sha=${raw.sha256 ?? 'none'}`);
    }
    return null;
  }

  const t0 = process.hrtime.bigint();
  const verdict = evaluateNativeMessagingHost(action, policy);
  const evalUs = Number((process.hrtime.bigint() - t0) / 1_000n);

  const scanId = syntheticScanId(action, raw.ts);
  audit.log({
    adapter: 'native-messaging-host',
    decision: verdict.decision,
    rule: verdict.rule,
    reason: verdict.reason,
    action_summary: actionSummary(action),
    source: `vendor:${action.vendor}`,
    scan_id: scanId,
    eval_us: evalUs,
  });

  // Suppress notify when a `modified` event carries no actual delta vs the
  // last seen baseline (sha unchanged). Vendor installers (e.g. Claude
  // Desktop autoupdate) rewrite manifests with identical bytes; firing 7
  // alerts per such no-op burst is noise. Audit log still records every
  // event — this only silences the user-facing channel.
  const isNoOpModify =
    action.event === 'modified' && !action.sha256_previous;
  if (!isNoOpModify) {
    notify(action, verdict, scanId, raw.ts);
  }

  // Update baseline snapshot after evaluation so next modify gets correct diff.
  baseline.set(action.path, {
    sha256: action.sha256,
    allowed_origins: action.allowed_origins,
  });

  return verdict;
}

// ---------------------------------------------------------------------------
// File reading loop
// ---------------------------------------------------------------------------

/**
 * Read new lines from WATCH_LOG starting at `offset`. Returns the new offset.
 * Handles truncation (file shrunk -> reset to 0).
 */
function readNewLines(offset: number): number {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(WATCH_LOG);
  } catch {
    return offset;
  }

  if (stat.size < offset) {
    runLog(`log truncated (${offset} -> ${stat.size}); resetting offset`);
    offset = 0;
    baseline.clear();
  }
  if (stat.size === offset) return offset;

  const fd = fs.openSync(WATCH_LOG, 'r');
  try {
    const length = stat.size - offset;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, offset);
    let text = buf.toString('utf-8');

    // Keep any incomplete trailing line for next tick.
    const lastNl = text.lastIndexOf('\n');
    let nextOffset = offset + length;
    if (lastNl === -1) {
      return offset; // no complete line yet
    }
    const complete = text.slice(0, lastNl + 1);
    nextOffset = offset + Buffer.byteLength(complete, 'utf-8');

    for (const line of complete.split('\n')) {
      processLine(line);
    }
    return nextOffset;
  } finally {
    fs.closeSync(fd);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const resetState = args.includes('--reset');

  fs.mkdirSync(AUDIT_DIR, { recursive: true });

  let offset = resetState ? 0 : readState();
  if (resetState) {
    try {
      fs.unlinkSync(STATE_FILE);
    } catch {
      /* nothing */
    }
  }

  runLog(`runner start offset=${offset} once=${once} audit=${audit.getPath()}`);

  const tick = () => {
    const next = readNewLines(offset);
    if (next !== offset) {
      offset = next;
      writeState(offset);
    }
  };

  tick();

  if (once) {
    runLog(`runner exit (--once) final_offset=${offset}`);
    return;
  }

  setInterval(tick, POLL_MS);
  runLog(`runner tailing every ${POLL_MS}ms`);
}

main();
