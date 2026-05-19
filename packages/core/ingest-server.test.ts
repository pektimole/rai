/**
 * ingest-server.test.ts — unit tests for createIngestServer
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createIngestServer } from './ingest-server.js';
import { ScanLog } from './scan-log.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    scan_id: `test-${Math.random().toString(36).slice(2)}`,
    tier: 'p0',
    channel: 'browser',
    surface: 'browser_extension',
    verdict: 'blocked',
    confidence: 0.97,
    recommended_action: 'block',
    threat_layers: [{ layer: 'L0', label: 'Direct prompt injection', severity: 'critical' }],
    ...overrides,
  };
}

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      { hostname: '127.0.0.1', port, method, path, headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload).toString() } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let scanLog: ScanLog;
let server: http.Server;
let port: number;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-ingest-test-'));
  scanLog = new ScanLog(tmpDir);
  server = createIngestServer(scanLog, ''); // no auth required
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe('GET /ingest/health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(port, 'GET', '/ingest/health');
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body) as { status: string; ts: string };
    expect(json.status).toBe('ok');
    expect(() => new Date(json.ts)).not.toThrow();
  });

  it('405 on non-GET method', async () => {
    const res = await request(port, 'POST', '/ingest/health');
    expect(res.status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe('routing', () => {
  it('404 for unknown paths', async () => {
    const res = await request(port, 'GET', '/unknown');
    expect(res.status).toBe(404);
  });

  it('405 for non-POST on /ingest/scan-event', async () => {
    const res = await request(port, 'GET', '/ingest/scan-event');
    expect(res.status).toBe(405);
  });

  it('204 OPTIONS (CORS preflight)', async () => {
    const res = await request(port, 'OPTIONS', '/ingest/scan-event');
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Auth — token set via env before server creation
// ---------------------------------------------------------------------------

describe('auth', () => {
  let authServer: http.Server;
  let authPort: number;

  beforeEach(async () => {
    authServer = createIngestServer(scanLog, 'secret-test-token');
    await new Promise<void>((resolve) => authServer.listen(0, '127.0.0.1', resolve));
    authPort = (authServer.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      authServer.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('401 when Authorization header is missing', async () => {
    const res = await request(authPort, 'POST', '/ingest/scan-event', makeEntry());
    expect(res.status).toBe(401);
  });

  it('401 when token is wrong', async () => {
    const res = await request(authPort, 'POST', '/ingest/scan-event', makeEntry(), {
      Authorization: 'Bearer wrong-token',
    });
    expect(res.status).toBe(401);
  });

  it('204 when token is correct', async () => {
    const res = await request(authPort, 'POST', '/ingest/scan-event', makeEntry(), {
      Authorization: 'Bearer secret-test-token',
    });
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// POST /ingest/scan-event (no token required in default test server)
// ---------------------------------------------------------------------------

describe('POST /ingest/scan-event', () => {
  it('204 on valid entry and writes to scan log', async () => {
    const entry = makeEntry();
    const res = await request(port, 'POST', '/ingest/scan-event', entry);
    expect(res.status).toBe(204);
    const scans = scanLog.readScans();
    expect(scans).toHaveLength(1);
    expect(scans[0].scan_id).toBe(entry.scan_id);
  });

  it('400 on invalid JSON', async () => {
    const req = await new Promise<{ status: number }>((resolve, reject) => {
      const payload = 'not-json{{{';
      const r = http.request(
        { hostname: '127.0.0.1', port, method: 'POST', path: '/ingest/scan-event',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload).toString() } },
        (res) => resolve({ status: res.statusCode ?? 0 }),
      );
      r.on('error', reject);
      r.write(payload);
      r.end();
    });
    expect(req.status).toBe(400);
  });

  it('400 when required field is missing', async () => {
    const entry = makeEntry();
    delete (entry as Record<string, unknown>)['scan_id'];
    const res = await request(port, 'POST', '/ingest/scan-event', entry);
    expect(res.status).toBe(400);
  });

  it('400 when tier is invalid', async () => {
    const res = await request(port, 'POST', '/ingest/scan-event', makeEntry({ tier: 'p9' }));
    expect(res.status).toBe(400);
  });

  it('preserves surface field on written entry', async () => {
    await request(port, 'POST', '/ingest/scan-event', makeEntry({ surface: 'mobile_pwa' }));
    const scans = scanLog.readScans();
    expect(scans[0].surface).toBe('mobile_pwa');
  });

  it('accumulates multiple entries', async () => {
    await request(port, 'POST', '/ingest/scan-event', makeEntry());
    await request(port, 'POST', '/ingest/scan-event', makeEntry());
    await request(port, 'POST', '/ingest/scan-event', makeEntry());
    expect(scanLog.readScans()).toHaveLength(3);
  });
});
