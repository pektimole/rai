/**
 * ingest-server.ts — RAI cross-surface scan event ingest endpoint
 *
 * Receives scan verdicts from remote surfaces (browser extension, mobile PWA)
 * and writes them to the local ScanLog so dream-phase can merge across surfaces.
 *
 * Phase 1: Tim-only. Single bearer token auth via RAI_INGEST_TOKEN env var.
 * Phase 2 will add: multi-tenant tokens, rate limiting, differential privacy.
 *
 * Routes:
 *   POST /ingest/scan-event  — accept a ScanLogEntry, 204 on success
 *   GET  /ingest/health      — liveness check, 200 JSON
 *
 * Environment:
 *   RAI_INGEST_TOKEN  — required bearer token (if empty, auth is disabled)
 *   RAI_INGEST_PORT   — TCP port (default 3847)
 */

import * as http from 'http';
import { getDefaultScanLog, type ScanLog, type ScanLogEntry } from './scan-log.js';
import { type L1Controller } from './l1-controller.js';
import { type ManifestPattern } from './l1-manifest.js';

const THREAT_LAYERS = ['L-2', 'L-1', 'L0', 'L1', 'L2', 'L3'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];

/** Validate an inbound L1 rule (POST /rules body). Returns null on any
 *  malformation — fail-closed before anything reaches the signed store. */
function validateRule(body: unknown): ManifestPattern | null {
  if (typeof body !== 'object' || body === null) return null;
  const r = body as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) return null;
  if (typeof r.regex !== 'string' || r.regex.length === 0) return null;
  if (typeof r.label !== 'string' || r.label.length === 0) return null;
  if (typeof r.signal !== 'string') return null;
  if (typeof r.layer !== 'string' || !THREAT_LAYERS.includes(r.layer)) return null;
  if (typeof r.severity !== 'string' || !SEVERITIES.includes(r.severity)) return null;
  const flags = r.flags === undefined ? '' : r.flags;
  if (typeof flags !== 'string') return null;
  if (r.state !== undefined && r.state !== 'enforce' && r.state !== 'capture_only') return null;
  try {
    new RegExp(r.regex, flags); // reject an uncompilable regex up front
  } catch {
    return null;
  }
  return {
    id: r.id,
    regex: r.regex,
    flags,
    label: r.label,
    layer: r.layer as ManifestPattern['layer'],
    severity: r.severity as ManifestPattern['severity'],
    signal: r.signal,
    state: r.state as ManifestPattern['state'] | undefined,
  };
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

function validateEntry(body: unknown): ScanLogEntry | null {
  if (typeof body !== 'object' || body === null) return null;
  const e = body as Record<string, unknown>;
  if (typeof e.timestamp !== 'string') return null;
  if (typeof e.scan_id !== 'string') return null;
  if (!['p0', 'p1', 'p2'].includes(e.tier as string)) return null;
  if (typeof e.channel !== 'string') return null;
  if (typeof e.verdict !== 'string') return null;
  if (typeof e.confidence !== 'number') return null;
  if (typeof e.recommended_action !== 'string') return null;
  if (!Array.isArray(e.threat_layers)) return null;
  return e as unknown as ScanLogEntry;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createIngestServer(
  scanLog?: ScanLog,
  token?: string,
  l1?: L1Controller,
): http.Server {
  const log = scanLog ?? getDefaultScanLog();
  const tok = token !== undefined ? token : (process.env.RAI_INGEST_TOKEN ?? '');

  const authed = (req: http.IncomingMessage): boolean =>
    !tok || (req.headers['authorization'] ?? '') === `Bearer ${tok}`;

  const readJson = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    cb: (parsed: unknown) => void,
  ): void => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        cb(JSON.parse(body));
      } catch {
        res.writeHead(400);
        res.end();
      }
    });
  };

  const sendJson = (res: http.ServerResponse, code: number, obj: unknown): void => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  return http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === '/ingest/health') {
      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', ts: new Date().toISOString() }));
      return;
    }

    // -- L1 hot-reload rule injection (OL-300) --------------------------------
    if (req.url === '/rules' || req.url === '/rules/rollback') {
      if (!l1) {
        res.writeHead(503);
        res.end();
        return;
      }
      if (!authed(req)) {
        res.writeHead(401);
        res.end();
        return;
      }

      // GET /rules — active manifest status (never returns pattern bodies).
      if (req.url === '/rules' && req.method === 'GET') {
        sendJson(res, 200, l1.status());
        return;
      }

      // POST /rules — inject a new L1 rule, promote, hot-swap live.
      if (req.url === '/rules' && req.method === 'POST') {
        readJson(req, res, (parsed) => {
          const rule = validateRule(parsed);
          if (!rule) {
            res.writeHead(400);
            res.end();
            return;
          }
          try {
            sendJson(res, 200, l1.addRule(rule));
          } catch (e) {
            sendJson(res, 409, { error: (e as Error).message });
          }
        });
        return;
      }

      // POST /rules/rollback — roll back to a prior generation.
      if (req.url === '/rules/rollback' && req.method === 'POST') {
        readJson(req, res, (parsed) => {
          const p = parsed as { to_generation?: unknown };
          if (typeof p.to_generation !== 'number') {
            res.writeHead(400);
            res.end();
            return;
          }
          try {
            sendJson(res, 200, l1.rollback(p.to_generation));
          } catch (e) {
            sendJson(res, 409, { error: (e as Error).message });
          }
        });
        return;
      }

      res.writeHead(405);
      res.end();
      return;
    }

    if (req.url !== '/ingest/scan-event') {
      res.writeHead(404);
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }

    // Bearer token auth (skipped when tok is empty, e.g. in tests)
    if (tok) {
      const authHeader = req.headers['authorization'] ?? '';
      if (authHeader !== `Bearer ${tok}`) {
        res.writeHead(401);
        res.end();
        return;
      }
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      const entry = validateEntry(parsed);
      if (!entry) {
        res.writeHead(400);
        res.end();
        return;
      }
      log.logScan(entry);
      res.writeHead(204);
      res.end();
    });
  });
}

// ---------------------------------------------------------------------------
// CLI entry — npx tsx packages/core/ingest-server.ts
// ---------------------------------------------------------------------------

const runningAsCli =
  typeof process !== 'undefined' &&
  process.argv[1] != null &&
  (process.argv[1].endsWith('ingest-server.ts') ||
    process.argv[1].endsWith('ingest-server.js'));

if (runningAsCli) {
  const port = parseInt(process.env.RAI_INGEST_PORT ?? '3847', 10);
  const server = createIngestServer();
  server.listen(port, () => {
    process.stdout.write(`[rai-ingest] listening on port ${port}\n`);
  });
  process.on('SIGTERM', () => server.close());
  process.on('SIGINT', () => server.close());
}
