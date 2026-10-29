// OL-660 parity helper: run the TS P0 floor over the Open WebUI fixtures and
// print {name: [labels]} so the Python side can diff against it.
import { readFileSync } from 'node:fs';
import { rayScan } from '../packages/core/rai-scan-p0.js';
const fx = JSON.parse(readFileSync(process.argv[2], 'utf-8'));
async function main() {
const out: Record<string, string[]> = {};
for (const group of ['injected', 'clean']) {
  for (const f of fx[group]) {
    const r = await rayScan({
      source: { channel: 'api', pipeline_stage: 'ingest', is_forward: true, sender: 'parity' },
      payload: { type: 'text', content: f.text },
      context: { session_id: 'parity', host_environment: 'api' },
    } as any);
    out[f.name] = r.threat_layers.map((s: any) => s.label).sort();
  }
}
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
}
main();
