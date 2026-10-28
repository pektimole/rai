/**
 * egress-proxy.test.ts — OL-659: live forward proxy in front of the http adapter
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createEgressProxy } from './egress-proxy';
import { AuditLog } from './audit-log';
import type { HttpPolicy } from './action-gate-http';

const policy: HttpPolicy = {
  blockedHosts: new Set(['100.100.100.200', '169.254.169.254']),
  blockedIpPrefixes: ['169.254.'],
  allowedHosts: new Set(['127.0.0.1']),
  allowedMethods: new Set(),
};

const listen = (s: net.Server) =>
  new Promise<number>((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as net.AddressInfo).port)));
const close = (s: net.Server) => new Promise<void>((r) => s.close(() => r()));

const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return 'proxy.invalid';
  }
};

/** Send an absolute-form request through the proxy. */
function viaProxy(proxyPort: number, method: string, url: string, body?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method, path: url, headers: { host: hostOf(url) } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode!, body: b }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Raw CONNECT (node's http client hides non-200 CONNECT bodies and rejects malformed targets). */
function connect(proxyPort: number, authority: string) {
  return new Promise<{ status: number; socket: net.Socket; body: string }>((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1');
    let buf = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const [head, ...rest] = buf.split('\r\n\r\n');
      resolve({ status: Number(head.split(' ')[1]), socket, body: rest.join('\r\n\r\n') });
    };
    socket.on('error', reject);
    socket.on('data', (d) => {
      buf += d;
      // 200 has no body: settle as soon as the head is complete. Denies close the socket after the body.
      if (buf.includes('\r\n\r\n') && buf.startsWith('HTTP/1.1 200')) {
        socket.removeAllListeners('data');
        finish();
      }
    });
    socket.on('end', finish);
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });
}

describe('egress-proxy', () => {
  let originPort: number;
  let tcpPort: number;
  let proxyPort: number;
  let logDir: string;
  let origin: http.Server;
  let tcp: net.Server;
  let proxy: http.Server;
  const received: string[] = [];

  const auditEntries = () =>
    fs
      .readFileSync(path.join(logDir, 'rai-actiongate.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

  beforeAll(async () => {
    origin = http.createServer((req, res) => {
      received.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('origin-ok');
    });
    tcp = net.createServer((s) => s.on('data', (d) => s.write(`echo:${d}`)));
    [originPort, tcpPort] = await Promise.all([listen(origin), listen(tcp)]);

    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-proxy-'));
    proxy = createEgressProxy({
      policy,
      audit: new AuditLog(logDir),
      connectPorts: [443, tcpPort],
      policyFile: 'agent-egress-http.yaml',
    });
    proxyPort = await listen(proxy);
  });

  afterAll(async () => {
    await Promise.all([close(origin), close(tcp), close(proxy)]);
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  describe('plain HTTP', () => {
    it('forwards an allowlisted request', async () => {
      const r = await viaProxy(proxyPort, 'GET', `http://127.0.0.1:${originPort}/ok`);
      expect(r).toEqual({ status: 200, body: 'origin-ok' });
      expect(received).toContain('GET /ok');
    });

    it('403s a non-allowlisted host with the rule in the body, and does not forward', async () => {
      const r = await viaProxy(proxyPort, 'PUT', 'http://sanmaohe.oss-cn-beijing.aliyuncs.com/up/x.tar', 'data');
      expect(r.status).toBe(403);
      expect(JSON.parse(r.body)).toMatchObject({ blocked: true, rule: 'http-egress-default-deny' });
    });

    it.each(['http://169.254.169.254/latest/meta-data/', 'http://100.100.100.200/latest/meta-data/', 'http://169.254.170.2/v2/credentials'])(
      '403s metadata endpoint %s',
      async (url) => {
        const r = await viaProxy(proxyPort, 'GET', url);
        expect(r.status).toBe(403);
        expect(JSON.parse(r.body).rule).toMatch(/^http-blocked-(host|ip)$/);
      },
    );

    it('403s unparseable / non-absolute request targets (fail-closed)', async () => {
      const r = await viaProxy(proxyPort, 'GET', '/just-a-path');
      expect(r.status).toBe(403);
      expect(JSON.parse(r.body).rule).toBe('http-unparseable-url');
    });

    it('403s a lookalike host', async () => {
      const r = await viaProxy(proxyPort, 'GET', 'http://127.0.0.1.evil.test/');
      expect(r.status).toBe(403);
    });

    it('403s a non-http scheme in absolute-form', async () => {
      const r = await viaProxy(proxyPort, 'GET', 'ftp://127.0.0.1/file');
      expect(r.status).toBe(403);
      expect(JSON.parse(r.body).rule).toBe('egress-proxy-unsupported-scheme');
    });
  });

  describe('CONNECT (HTTPS, host-level only)', () => {
    it('tunnels to an allowlisted host:port', async () => {
      const { status, socket } = await connect(proxyPort, `127.0.0.1:${tcpPort}`);
      expect(status).toBe(200);
      const reply = await new Promise<string>((resolve) => {
        socket.once('data', (d) => resolve(String(d)));
        socket.write('ping');
      });
      expect(reply).toBe('echo:ping');
      socket.destroy();
    });

    it('403s CONNECT to a non-allowlisted host', async () => {
      const { status, body } = await connect(proxyPort, 'sanmaohe.oss-cn-beijing.aliyuncs.com:443');
      expect(status).toBe(403);
      expect(JSON.parse(body).rule).toBe('http-egress-default-deny');
    });

    it('403s CONNECT to a metadata IP', async () => {
      const { status } = await connect(proxyPort, '169.254.169.254:443');
      expect(status).toBe(403);
    });

    it('403s CONNECT to a port outside the permitted set', async () => {
      const { status, body } = await connect(proxyPort, '127.0.0.1:22');
      expect(status).toBe(403);
      expect(JSON.parse(body).rule).toBe('egress-proxy-connect-port');
    });

    it('403s an unparseable CONNECT target (fail-closed)', async () => {
      const { status, body } = await connect(proxyPort, 'host:notaport');
      expect(status).toBe(403);
      expect(JSON.parse(body).rule).toBe('http-unparseable-url');
    });
  });

  describe('audit log', () => {
    it('records deny and allow verdicts with rule and action summary', () => {
      const entries = auditEntries();
      const beijing = entries.find((e) => e.action_summary.includes('oss-cn-beijing') && e.action_summary.startsWith('PUT'));
      expect(beijing).toMatchObject({ adapter: 'http', decision: 'deny', rule: 'http-egress-default-deny', policy_file: 'agent-egress-http.yaml' });
      expect(entries.some((e) => e.decision === 'allow' && e.action_summary.endsWith('/ok'))).toBe(true);
    });
  });

  describe('fail-closed', () => {
    it('denies an allow it cannot audit', async () => {
      const broken = new AuditLog(path.join(logDir, 'missing', 'x'));
      (broken as any).write = () => {
        throw new Error('disk full');
      };
      const p = createEgressProxy({ policy, audit: broken });
      const port = await listen(p);
      const r = await viaProxy(port, 'GET', `http://127.0.0.1:${originPort}/ok`);
      expect(r.status).toBe(403);
      expect(JSON.parse(r.body).rule).toBe('egress-proxy-audit-failed');
      await close(p);
    });

    it('still denies (does not crash) when the deny cannot be audited', async () => {
      const broken = new AuditLog(logDir);
      (broken as any).write = () => {
        throw new Error('disk full');
      };
      const p = createEgressProxy({ policy, audit: broken });
      const port = await listen(p);
      const r = await viaProxy(port, 'GET', 'http://evil.test/');
      expect(r.status).toBe(403);
      await close(p);
    });

    it('empty allowlist denies everything', async () => {
      const p = createEgressProxy({ policy: { ...policy, allowedHosts: new Set() } });
      const port = await listen(p);
      const r = await viaProxy(port, 'GET', `http://127.0.0.1:${originPort}/ok`);
      expect(r.status).toBe(403);
      await close(p);
    });
  });
});
