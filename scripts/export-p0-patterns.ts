// OL-660: dump the static P0 pattern floor as JSON for the Open WebUI Python port.
// Usage: npx tsx scripts/export-p0-patterns.ts > integrations/open-webui/p0-patterns.json
import { getStaticPatterns } from '../packages/core/rai-scan-p0.js';
const out = getStaticPatterns().map((p) => ({
  source: p.regex.source,
  flags: p.regex.flags,
  label: p.label,
  layer: p.layer,
  severity: p.severity,
  signal: p.signal,
}));
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
