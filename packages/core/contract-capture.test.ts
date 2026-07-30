/**
 * contract-capture.test.ts — live capture wiring (OL-461, phase 2a)
 *
 * Proves the two invariants of the capture bridge: it is OFF unless opted in,
 * and it can never throw into the enforcement path (fail-open). Plus the
 * privacy-preserving URL→event reduction the HTTP seam relies on.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CaptureSession,
  captureConfigFromEnv,
  defaultCaptureDir,
  httpEventFromUrl,
  type CaptureConfig,
} from './contract-capture.js';
import { loadFlightSession, readFlightLog } from './contract-recorder.js';

let dir: string;
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-'));
  tick = 0;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function cfg(over: Partial<CaptureConfig> = {}): CaptureConfig {
  return { enabled: true, dir, agent: 'agent-a', session: 's1', ...over };
}

// --- config ----------------------------------------------------------------

describe('captureConfigFromEnv', () => {
  it('is disabled by default', () => {
    expect(captureConfigFromEnv({}).enabled).toBe(false);
    expect(captureConfigFromEnv({ RAI_CAPTURE: '0' }).enabled).toBe(false);
  });

  it('enables on RAI_CAPTURE=1 or true and reads agent/session/dir', () => {
    const c = captureConfigFromEnv({
      RAI_CAPTURE: '1',
      RAI_CAPTURE_DIR: '/tmp/flight',
      RAI_AGENT: 'agent-x',
      RAI_SESSION: 'sess-9',
    });
    expect(c).toEqual({ enabled: true, dir: '/tmp/flight', agent: 'agent-x', session: 'sess-9' });
    expect(captureConfigFromEnv({ RAI_CAPTURE: 'true' }).enabled).toBe(true);
  });

  it('defaults the dir under ~/.rai/flight', () => {
    expect(defaultCaptureDir({ HOME: '/home/tim' })).toBe('/home/tim/.rai/flight');
  });
});

// --- default OFF -----------------------------------------------------------

describe('CaptureSession — default off', () => {
  it('writes nothing and creates no file when disabled', () => {
    const s = new CaptureSession(cfg({ enabled: false }), { now: clock });
    s.captureMcp({ server: 'gmail', tool: 'search' });
    s.captureHttp({ scheme: 'https', host: 'api.example.com', port: 443, method: 'GET', path: '/x' });
    expect(s.active).toBe(false);
    expect(fs.existsSync(path.join(dir, 's1.jsonl'))).toBe(false);
  });
});

// --- enabled capture -------------------------------------------------------

describe('CaptureSession — enabled', () => {
  it('lazily creates a log and records http + mcp for the compile phase', () => {
    const s = new CaptureSession(cfg(), { now: clock });
    // No file until the first event (lazy).
    expect(fs.existsSync(path.join(dir, 's1.jsonl'))).toBe(false);

    s.captureHttp({ scheme: 'https', host: 'api.example.com', port: 443, method: 'GET', path: '/users/1' });
    s.captureMcp({ server: 'slack', tool: 'send_message' });

    const session = loadFlightSession(path.join(dir, 's1.jsonl'));
    expect(session.agent).toBe('agent-a');
    expect(session.events).toHaveLength(2);
    expect(session.events[0].event.kind).toBe('http_destination');
    expect(session.events[1].event.kind).toBe('mcp_tool_call');
  });

  it('shares one chained log across many calls', () => {
    const s = new CaptureSession(cfg(), { now: clock });
    for (let i = 0; i < 5; i++) s.captureMcp({ server: 'gmail', tool: 'search' });
    const records = readFlightLog(path.join(dir, 's1.jsonl'));
    expect(records).toHaveLength(6); // header + 5 events
    expect(records.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

// --- fail-open (invariant 2) ----------------------------------------------

describe('CaptureSession — fail-open, never breaks enforcement', () => {
  it('swallows a construction error, disables itself, and reports once', () => {
    // Pre-seed the session path with a tampered chain so the recorder's
    // resume verification throws on construction.
    fs.mkdirSync(dir, { recursive: true });
    const bogus =
      JSON.stringify({ seq: 0, prev_hash: 'sha256:genesis', entry: { type: 'header' }, hash: 'sha256:wrong' }) + '\n';
    fs.writeFileSync(path.join(dir, 's1.jsonl'), bogus);

    const errors: Error[] = [];
    const s = new CaptureSession(cfg(), { now: clock, onError: (e) => errors.push(e) });

    // Must NOT throw — the enforcement path calls this and must be unaffected.
    expect(() => s.captureMcp({ server: 'gmail', tool: 'search' })).not.toThrow();
    expect(s.active).toBe(false); // disabled after the error
    expect(errors).toHaveLength(1);

    // A second call stays a silent no-op — reported exactly once.
    expect(() => s.captureMcp({ server: 'gmail', tool: 'send' })).not.toThrow();
    expect(errors).toHaveLength(1);
  });
});

// --- URL → event privacy ---------------------------------------------------

describe('httpEventFromUrl — shape only', () => {
  it('drops query string, fragment, and credentials', () => {
    const e = httpEventFromUrl('https://alice:hunter2@api.example.com/v1/users/42?token=secret#frag', 'get');
    expect(e).toEqual({ scheme: 'https', host: 'api.example.com', port: 443, method: 'GET', path: '/v1/users/42' });
    // No credentials, query, or fragment survive (path's own "users" is fine).
    expect(JSON.stringify(e)).not.toMatch(/alice|hunter2|secret|token=|[?#@]/);
  });

  it('resolves default ports and preserves explicit ones', () => {
    expect(httpEventFromUrl('http://x.test/a', 'POST')!.port).toBe(80);
    expect(httpEventFromUrl('https://x.test/a', 'POST')!.port).toBe(443);
    expect(httpEventFromUrl('https://x.test:8443/a', 'POST')!.port).toBe(8443);
  });

  it('returns null for an unparseable URL', () => {
    expect(httpEventFromUrl('not a url', 'GET')).toBeNull();
  });
});
