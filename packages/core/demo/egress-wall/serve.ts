/**
 * serve.ts — run the ActionGate egress proxy for the OL-659 container demo.
 * Policy: policies/agent-egress-http.yaml (default-deny, metadata blocked).
 * EGRESS_ALLOW (comma-separated) layers extra allowed hosts on top for the demo.
 */
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { loadHttpPolicy, type HttpPolicyYaml } from './action-gate-http';
import { createEgressProxy } from './egress-proxy';
import { AuditLog } from './audit-log';

const policyFile = 'policies/agent-egress-http.yaml';
const doc = yaml.load(fs.readFileSync(policyFile, 'utf8')) as HttpPolicyYaml;
const extra = (process.env.EGRESS_ALLOW ?? '').split(',').map((h) => h.trim()).filter(Boolean);
doc.allowed_hosts = [...(doc.allowed_hosts ?? []), ...extra];

const policy = loadHttpPolicy(doc);
const audit = new AuditLog(process.env.AUDIT_DIR ?? '/var/log/rai');
const port = Number(process.env.PORT ?? 3128);

createEgressProxy({ policy, audit, policyFile: 'agent-egress-http.yaml' }).listen(port, '0.0.0.0', () => {
  console.log(`egress-proxy listening :${port}, allowed_hosts=[${[...policy.allowedHosts].join(', ')}]`);
});
