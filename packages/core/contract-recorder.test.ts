/**
 * contract-recorder.test.ts — observe phase (OL-461)
 *
 * Proves the flight recorder is an append-only, tamper-evident, per-session
 * hash chain that the compile phase can trust: intact chains verify, edited
 * chains break at the edited record, restart resumes the chain, and a tampered
 * file is fail-closed at both resume and load.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FlightRecorder,
  readFlightLog,
  verifyFlightChain,
  loadFlightSession,
  listFlightSessions,
  recordHash,
  GENESIS,
  type FlightRecord,
} from './contract-recorder.js';

let dir: string;
// Deterministic clock so record hashes are stable across a test run.
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-'));
  tick = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function newRecorder(session = 's1', agent = 'agent-a') {
  return new FlightRecorder(dir, session, agent, { now: clock });
}

describe('FlightRecorder — append + header', () => {
  it('writes a header as seq 0 anchored to GENESIS', () => {
    const rec = newRecorder();
    const records = readFlightLog(rec.path);
    expect(records).toHaveLength(1);
    expect(records[0].seq).toBe(0);
    expect(records[0].prev_hash).toBe(GENESIS);
    expect(records[0].entry.type).toBe('header');
    if (records[0].entry.type === 'header') {
      expect(records[0].entry.agent).toBe('agent-a');
      expect(records[0].entry.session_id).toBe('s1');
    }
  });

  it('appends http + mcp events, chained', () => {
    const rec = newRecorder();
    rec.recordHttp({ scheme: 'https', host: 'api.example.com', port: 443, method: 'GET', path: '/v1/users/42' });
    rec.recordMcp({ server: 'gmail', tool: 'search_threads' });

    const records = readFlightLog(rec.path);
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.seq)).toEqual([0, 1, 2]);
    // Each prev_hash links to the prior record's hash.
    expect(records[1].prev_hash).toBe(records[0].hash);
    expect(records[2].prev_hash).toBe(records[1].hash);
    expect(verifyFlightChain(records).ok).toBe(true);
  });

  it('captures traffic shape only (no bodies/headers on the record)', () => {
    const rec = newRecorder();
    rec.recordHttp({ scheme: 'https', host: 'api.example.com', port: 443, method: 'POST', path: '/v1/send' });
    const evt = readFlightLog(rec.path)[1];
    expect(JSON.stringify(evt)).not.toMatch(/authorization|cookie|body|secret/i);
  });
});

describe('verifyFlightChain — tamper evidence', () => {
  it('detects a mutated event field', () => {
    const rec = newRecorder();
    rec.recordHttp({ scheme: 'https', host: 'good.example.com', port: 443, method: 'GET', path: '/a' });
    const records = readFlightLog(rec.path);

    // Flip the host on the event record without recomputing its hash.
    const tampered = structuredClone(records);
    if (tampered[1].entry.type === 'event' && tampered[1].entry.event.kind === 'http_destination') {
      tampered[1].entry.event.host = 'evil.example.com';
    }
    const check = verifyFlightChain(tampered);
    expect(check.ok).toBe(false);
    expect(check.brokenAt).toBe(1);
  });

  it('detects a dropped (truncated) record via seq gap', () => {
    const rec = newRecorder();
    rec.recordHttp({ scheme: 'https', host: 'a', port: 443, method: 'GET', path: '/1' });
    rec.recordHttp({ scheme: 'https', host: 'b', port: 443, method: 'GET', path: '/2' });
    const records = readFlightLog(rec.path);
    const withHole = [records[0], records[2]]; // drop seq 1
    const check = verifyFlightChain(withHole);
    expect(check.ok).toBe(false);
    expect(check.brokenAt).toBe(1);
  });

  it('rejects a reordered chain (prev_hash mismatch)', () => {
    const rec = newRecorder();
    rec.recordHttp({ scheme: 'https', host: 'a', port: 443, method: 'GET', path: '/1' });
    rec.recordHttp({ scheme: 'https', host: 'b', port: 443, method: 'GET', path: '/2' });
    const r = readFlightLog(rec.path);
    // Swap the two event records but keep seq contiguous by relabeling.
    const swapped: FlightRecord[] = [
      r[0],
      { ...r[2], seq: 1 },
      { ...r[1], seq: 2 },
    ];
    const check = verifyFlightChain(swapped);
    expect(check.ok).toBe(false);
  });

  it('rejects a forged header not anchored to GENESIS', () => {
    const rec = newRecorder();
    const records = readFlightLog(rec.path);
    const forged = structuredClone(records);
    forged[0].prev_hash = 'sha256:somethingelse';
    forged[0].hash = recordHash({ seq: forged[0].seq, prev_hash: forged[0].prev_hash, entry: forged[0].entry });
    const check = verifyFlightChain(forged);
    expect(check.ok).toBe(false);
    expect(check.brokenAt).toBe(0);
  });

  it('an empty log verifies vacuously', () => {
    expect(verifyFlightChain([]).ok).toBe(true);
  });
});

describe('FlightRecorder — restart / resume', () => {
  it('resumes the chain on a second recorder over the same session file', () => {
    const rec1 = newRecorder('s-resume', 'agent-a');
    rec1.recordHttp({ scheme: 'https', host: 'a', port: 443, method: 'GET', path: '/1' });

    // Process "restart": new recorder, same session id + file.
    const rec2 = new FlightRecorder(dir, 's-resume', 'agent-a', { now: clock });
    rec2.recordHttp({ scheme: 'https', host: 'b', port: 443, method: 'GET', path: '/2' });

    const records = readFlightLog(rec2.path);
    expect(records.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(verifyFlightChain(records).ok).toBe(true); // one unbroken chain across the restart
  });

  it('is fail-closed: refuses to resume onto a tampered file', () => {
    const rec = newRecorder('s-bad', 'agent-a');
    rec.recordHttp({ scheme: 'https', host: 'a', port: 443, method: 'GET', path: '/1' });

    // Corrupt the file on disk between runs.
    const records = readFlightLog(rec.path);
    if (records[1].entry.type === 'event' && records[1].entry.event.kind === 'http_destination') {
      records[1].entry.event.path = '/tampered';
    }
    fs.writeFileSync(rec.path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

    expect(() => new FlightRecorder(dir, 's-bad', 'agent-a', { now: clock })).toThrow(/chain verification/);
  });
});

describe('loadFlightSession — compile-ready view', () => {
  it('returns header selector + ordered events', () => {
    const rec = newRecorder('s2', 'agent-x');
    rec.recordHttp({ scheme: 'https', host: 'api.example.com', port: 443, method: 'GET', path: '/users/1' });
    rec.recordMcp({ server: 'slack', tool: 'send_message' });

    const session = loadFlightSession(rec.path);
    expect(session.agent).toBe('agent-x');
    expect(session.session_id).toBe('s2');
    expect(session.events).toHaveLength(2);
    expect(session.events[0].event.kind).toBe('http_destination');
    expect(session.events[1].event.kind).toBe('mcp_tool_call');
  });

  it('throws on a tampered log (compile never learns from bad data)', () => {
    const rec = newRecorder('s3', 'agent-x');
    rec.recordHttp({ scheme: 'https', host: 'a', port: 443, method: 'GET', path: '/1' });
    const records = readFlightLog(rec.path);
    records[1].hash = 'sha256:0000';
    fs.writeFileSync(rec.path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    expect(() => loadFlightSession(rec.path)).toThrow(/verification/);
  });
});

describe('listFlightSessions', () => {
  it('lists session logs sorted', () => {
    newRecorder('s-b', 'a');
    newRecorder('s-a', 'a');
    const found = listFlightSessions(dir).map((p) => path.basename(p));
    expect(found).toEqual(['s-a.jsonl', 's-b.jsonl']);
  });

  it('is empty for a missing dir', () => {
    expect(listFlightSessions(path.join(dir, 'nope'))).toEqual([]);
  });
});
