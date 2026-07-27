/**
 * contract-recorder.ts — Learn-and-lock phase 1: observe (OL-461)
 *
 * The flight recorder is the OBSERVE phase of the four-phase learn-and-lock
 * pipeline (docs/33-rai-l1-hotreload-spec.md Part A). An agent runs in capture
 * mode; every destination it reaches and every tool it calls accumulates here
 * as a tamper-evident, hash-chained JSONL log, one file per session. The
 * compile phase reads these logs to infer a behavioral contract; nothing here
 * enforces or blocks — observation only.
 *
 * Tamper-evidence uses the same discipline as the L1 manifest chain: each
 * record's `hash` is a SHA-256 over the canonical form of {seq, prev_hash,
 * entry}, and each record's `prev_hash` is the prior record's `hash`. The first
 * record is a header anchored to a fixed GENESIS marker. A single flipped byte
 * anywhere breaks the chain from that point forward, so a compile step can
 * refuse to learn from a log that was edited after the fact.
 *
 * Privacy floor (spec Part B "Privacy" carries over): the recorder captures
 * traffic SHAPE only — scheme/host/port/method/path, mcp server/tool. It never
 * records request bodies, response bodies, headers, query strings, or any
 * secret content. Path normalization (collapsing /users/123 → /users/<id>) is
 * the compile phase's job; the recorder stores the raw path verbatim so the
 * compiler can do frequency-weighted bucketing over ground truth.
 *
 * Spec: docs/33-rai-l1-hotreload-spec.md (Part A, phase 1: observe).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { canonicalize } from './l1-manifest.js';

// ---------------------------------------------------------------------------
// Event shapes (traffic the compile phase infers rules from)
// ---------------------------------------------------------------------------

export type FlightEventKind = 'http_destination' | 'mcp_tool_call';

interface FlightEventBase {
  kind: FlightEventKind;
}

/** An outbound HTTP destination the agent reached. Rule kinds
 *  `http_destination` / `http_action` are compiled from these. */
export interface HttpDestinationEvent extends FlightEventBase {
  kind: 'http_destination';
  scheme: string; // "https"
  host: string; // "api.example.com" (no port)
  port: number; // explicit; caller resolves 443/80 defaults
  method: string; // "GET" (uppercased by the caller's convention)
  path: string; // raw path, verbatim — normalization happens at compile time
}

/** An MCP tool invocation. Rule kind `mcp_tool_call` is compiled from these. */
export interface McpToolCallEvent extends FlightEventBase {
  kind: 'mcp_tool_call';
  server: string; // MCP server id / name
  tool: string; // tool name within the server
}

export type FlightEvent = HttpDestinationEvent | McpToolCallEvent;

// ---------------------------------------------------------------------------
// On-disk record shape (hash-chained JSONL line)
// ---------------------------------------------------------------------------

export const FLIGHT_SCHEMA_VERSION = 1 as const;

/** The genesis marker: the `prev_hash` of the very first (header) record. */
export const GENESIS = 'sha256:genesis' as const;

export type FlightEntry =
  | {
      type: 'header';
      session_id: string;
      agent: string; // selector scope: contracts are per-agent
      created_at: string; // RFC3339
      schema_version: typeof FLIGHT_SCHEMA_VERSION;
    }
  | {
      type: 'event';
      ts: string; // RFC3339 capture time
      event: FlightEvent;
    };

export interface FlightRecord {
  seq: number; // 0-based, strictly increasing, header is seq 0
  prev_hash: string; // prior record's hash; GENESIS for seq 0
  entry: FlightEntry;
  hash: string; // sha256 over canonicalize({seq, prev_hash, entry})
}

function sha256hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf-8').digest('hex');
}

/** The content hash of a record: everything except the hash field itself. */
export function recordHash(r: Omit<FlightRecord, 'hash'>): string {
  return 'sha256:' + sha256hex(canonicalize({ seq: r.seq, prev_hash: r.prev_hash, entry: r.entry }));
}

// ---------------------------------------------------------------------------
// Recorder (append side)
// ---------------------------------------------------------------------------

const FILE_RE = /^(.+)\.jsonl$/;

export interface RecorderOptions {
  /** Injectable clock for deterministic tests. Defaults to Date. */
  now?: () => Date;
}

/**
 * A per-session append-only hash-chained flight recorder.
 *
 * Construct one per session. If the session file already exists (process
 * restarted mid-capture), the recorder resumes the chain from the last valid
 * record — but only if the existing chain verifies. A broken chain on an
 * existing file is fail-closed: the constructor throws rather than appending
 * onto tampered history.
 */
export class FlightRecorder {
  private readonly filePath: string;
  private readonly now: () => Date;
  private seq: number;
  private prevHash: string;

  constructor(
    private readonly dir: string,
    readonly sessionId: string,
    readonly agent: string,
    opts: RecorderOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, `${sessionId}.jsonl`);

    if (fs.existsSync(this.filePath) && fs.statSync(this.filePath).size > 0) {
      // Resume: verify the existing chain, then continue from its tail.
      const records = readFlightLog(this.filePath);
      const check = verifyFlightChain(records);
      if (!check.ok) {
        throw new Error(
          `flight log ${this.filePath} failed chain verification at seq ${check.brokenAt}: ${check.reason}`,
        );
      }
      const tail = records[records.length - 1];
      this.seq = tail.seq + 1;
      this.prevHash = tail.hash;
    } else {
      // Fresh session: write the header as seq 0.
      this.seq = 0;
      this.prevHash = GENESIS;
      this.append({
        type: 'header',
        session_id: sessionId,
        agent,
        created_at: this.now().toISOString(),
        schema_version: FLIGHT_SCHEMA_VERSION,
      });
    }
  }

  /** The session log path (for handing to the compile phase). */
  get path(): string {
    return this.filePath;
  }

  /** Record an observed HTTP destination. */
  recordHttp(e: Omit<HttpDestinationEvent, 'kind'>): FlightRecord {
    return this.recordEvent({ kind: 'http_destination', ...e });
  }

  /** Record an observed MCP tool call. */
  recordMcp(e: Omit<McpToolCallEvent, 'kind'>): FlightRecord {
    return this.recordEvent({ kind: 'mcp_tool_call', ...e });
  }

  /** Record any flight event, stamping capture time. */
  recordEvent(event: FlightEvent): FlightRecord {
    return this.append({ type: 'event', ts: this.now().toISOString(), event });
  }

  private append(entry: FlightEntry): FlightRecord {
    const base = { seq: this.seq, prev_hash: this.prevHash, entry };
    const record: FlightRecord = { ...base, hash: recordHash(base) };
    fs.appendFileSync(this.filePath, JSON.stringify(record) + '\n');
    this.seq += 1;
    this.prevHash = record.hash;
    return record;
  }
}

// ---------------------------------------------------------------------------
// Reader / verifier (compile side)
// ---------------------------------------------------------------------------

/** Read every record from a session log, in order. Empty if the file is absent. */
export function readFlightLog(filePath: string): FlightRecord[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as FlightRecord);
}

export interface ChainCheck {
  ok: boolean;
  brokenAt?: number; // seq (== index) of the first bad record
  reason?: string;
}

/**
 * Verify a flight log is an intact hash chain: seq 0 is a header anchored to
 * GENESIS, sequence numbers are contiguous, every prev_hash links to the prior
 * record's hash, and every stored hash matches a recomputation. A single edited
 * byte breaks it from that record on. Returns the first break.
 */
export function verifyFlightChain(records: FlightRecord[]): ChainCheck {
  if (records.length === 0) return { ok: true };

  const head = records[0];
  if (head.seq !== 0) return { ok: false, brokenAt: head.seq, reason: 'first record seq is not 0' };
  if (head.entry.type !== 'header')
    return { ok: false, brokenAt: 0, reason: 'first record is not a header' };
  if (head.prev_hash !== GENESIS)
    return { ok: false, brokenAt: 0, reason: 'header prev_hash is not GENESIS' };

  let expectedPrev: string = GENESIS;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.seq !== i) return { ok: false, brokenAt: i, reason: `seq ${r.seq} out of order (expected ${i})` };
    if (i > 0 && r.entry.type === 'header')
      return { ok: false, brokenAt: i, reason: 'unexpected second header' };
    if (r.prev_hash !== expectedPrev)
      return { ok: false, brokenAt: i, reason: 'prev_hash does not chain to prior record' };
    const recomputed = recordHash({ seq: r.seq, prev_hash: r.prev_hash, entry: r.entry });
    if (recomputed !== r.hash)
      return { ok: false, brokenAt: i, reason: 'stored hash does not match content' };
    expectedPrev = r.hash;
  }
  return { ok: true };
}

/** The header of a verified session log (selector scope + metadata). */
export interface FlightSession {
  session_id: string;
  agent: string;
  created_at: string;
  events: Array<{ ts: string; event: FlightEvent }>;
}

/**
 * Load a session log as a compile-ready {header, events} view. Fail-closed: a
 * log that does not verify throws, so the compile phase can never learn rules
 * from tampered or truncated observation data.
 */
export function loadFlightSession(filePath: string): FlightSession {
  const records = readFlightLog(filePath);
  if (records.length === 0) throw new Error(`flight log ${filePath} is empty or absent`);
  const check = verifyFlightChain(records);
  if (!check.ok)
    throw new Error(`flight log ${filePath} failed verification at seq ${check.brokenAt}: ${check.reason}`);

  const head = records[0].entry;
  if (head.type !== 'header') throw new Error('verified log without a header (unreachable)');

  const events: FlightSession['events'] = [];
  for (const r of records.slice(1)) {
    if (r.entry.type === 'event') events.push({ ts: r.entry.ts, event: r.entry.event });
  }
  return { session_id: head.session_id, agent: head.agent, created_at: head.created_at, events };
}

/** List session log file paths in a recorder directory, sorted by session id. */
export function listFlightSessions(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}
