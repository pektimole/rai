/**
 * egress-proxy.ts — ActionGate live egress: Node forward proxy (L4)
 *
 * Wires the http adapter (action-gate-http.ts) into a real forward proxy so
 * agent-initiated outbound requests are decided live, not only in replay.
 *
 *   Plain HTTP : evaluateHttp on full URL + method.
 *   HTTPS      : CONNECT host:port check only. No TLS interception, so the
 *                request method and path are NOT visible; the decision is
 *                host-level. A method allowlist cannot be enforced over HTTPS.
 *   Deny       : 403 + audit-log entry. Fail-closed: a policy/audit error
 *                never turns into an allow.
 *
 * Out of scope: TLS MITM, DNS exfiltration, DNS-rebinding (the host name is
 * checked, not the address it resolves to).
 *
 * The proxy is only a wall when the agent has no other route out (internal
 * Docker network); see docs/36-rai-qwen-trace-replay.md. Origin: OL-659.
 */

import * as http from 'http';
import * as net from 'net';
import { evaluateHttp, type HttpPolicy, type HttpVerdict } from './action-gate-http';
import type { AuditLog } from './audit-log';

export interface EgressProxyOptions {
  policy: HttpPolicy;
  /** Audit sink. Deny verdicts are logged best-effort; an allow that cannot be logged is denied. */
  audit?: AuditLog;
  /** Ports CONNECT may target. Default [443]. */
  connectPorts?: number[];
  /** Policy file name recorded in audit entries. */
  policyFile?: string;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function deny(rule: string, reason: string): HttpVerdict {
  return { decision: 'deny', rule, reason };
}

export function createEgressProxy(opts: EgressProxyOptions): http.Server {
  const connectPorts = new Set(opts.connectPorts ?? [443]);
  // CONNECT hides the method, so the method allowlist cannot apply to it.
  const connectPolicy: HttpPolicy = { ...opts.policy, allowedMethods: new Set() };

  /** Evaluate + audit. Never throws; any internal error is a deny. */
  function decide(
    method: string,
    url: string,
    policy: HttpPolicy,
    source: string,
    preDeny?: HttpVerdict,
  ): HttpVerdict {
    const t0 = process.hrtime.bigint();
    let verdict: HttpVerdict;
    try {
      verdict = preDeny ?? evaluateHttp({ kind: 'http-request', method, url }, policy);
    } catch (e) {
      verdict = deny('egress-proxy-eval-error', `evaluation failed (fail-closed): ${(e as Error).message}`);
    }
    try {
      opts.audit?.log({
        adapter: 'http',
        decision: verdict.decision,
        rule: verdict.rule,
        reason: verdict.reason,
        action_summary: `${method} ${url}`,
        source,
        policy_file: opts.policyFile,
        eval_us: Number((process.hrtime.bigint() - t0) / 1000n),
      });
    } catch (e) {
      if (verdict.decision === 'allow') {
        return deny('egress-proxy-audit-failed', `allow not recorded, denied (fail-closed): ${(e as Error).message}`);
      }
    }
    return verdict;
  }

  const server = http.createServer((req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const rawUrl = req.url ?? '';
    const source = `egress-proxy:${req.socket.remoteAddress ?? 'unknown'}`;

    let target: URL | null = null;
    try {
      target = new URL(rawUrl);
    } catch {
      /* evaluateHttp will deny as unparseable */
    }
    const preDeny =
      target && target.protocol !== 'http:'
        ? deny('egress-proxy-unsupported-scheme', `scheme "${target.protocol}" not proxied over plain HTTP`)
        : undefined;
    const verdict = decide(method, rawUrl, opts.policy, source, preDeny);

    if (verdict.decision !== 'allow' || !target) {
      res.writeHead(403, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ blocked: true, rule: verdict.rule, reason: verdict.reason }) + '\n');
      return;
    }

    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
    }
    const upstream = http.request(
      {
        host: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || 80,
        method,
        path: target.pathname + target.search,
        headers,
      },
      (up) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(up.headers)) {
          if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
        }
        res.writeHead(up.statusCode ?? 502, out);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { connection: 'close' });
      res.end();
    });
    req.pipe(upstream);
  });

  server.on('connect', (req, clientSocket: net.Socket, head) => {
    const authority = req.url ?? '';
    const source = `egress-proxy:${clientSocket.remoteAddress ?? 'unknown'}`;
    let host = '';
    let port = 0;
    let preDeny: HttpVerdict | undefined;
    try {
      const u = new URL(`https://${authority}`);
      host = u.hostname.replace(/^\[|\]$/g, '');
      port = Number(u.port || 443);
      if (!connectPorts.has(port)) {
        preDeny = deny('egress-proxy-connect-port', `CONNECT to port ${port} not permitted`);
      }
    } catch {
      preDeny = deny('http-unparseable-url', `unparseable CONNECT target "${authority}" (fail-closed)`);
    }

    const verdict = decide('CONNECT', `https://${authority}`, connectPolicy, source, preDeny);
    if (verdict.decision !== 'allow') {
      clientSocket.end(
        'HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n' +
          JSON.stringify({ blocked: true, rule: verdict.rule, reason: verdict.reason }) +
          '\n',
      );
      return;
    }

    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n'));
    clientSocket.on('error', () => upstream.destroy());
  });

  return server;
}
