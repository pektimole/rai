/**
 * regen-architecture.ts — generate docs/30-rai-architecture-live.md
 *
 * Reads architecture.json (source of truth) + package.json files +
 * current git HEAD, emits a single markdown view with:
 *   - Mermaid layer diagram (engine vertical + surface horizontal)
 *   - Module index table
 *   - Threat-layer × engine-module coverage matrix
 *   - Tier gating table
 *   - Deck link
 *   - Generation timestamp + commit hash + dirty-tree warning
 *
 * Trigger paths:
 *   - Manual:   npm run regen-arch
 *   - Cron:     launchd plist 3x/week (Mon/Wed/Fri 09:00)
 *   - Optional: git post-commit hook on spec changes
 *
 * Convention: the output file has a "DO NOT EDIT" banner. Source of truth
 * is architecture.json — edit that and re-run.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const ARCH_JSON = resolve(REPO_ROOT, 'architecture.json');
const OUTPUT = resolve(REPO_ROOT, 'docs', '30-rai-architecture-live.md');

interface ThreatLayer { id: string; label: string; covered_by: string[]; }
interface EngineModule {
  id: string;
  name: string;
  kind: 'engine';
  status: 'shipped' | 'shipped-engine' | 'in-flight' | 'spec' | 'planned';
  package: string;
  files: string[];
  what: string;
  ol_refs: string[];
}
interface Surface {
  id: string;
  name: string;
  status: string;
  package: string;
  what: string;
  ol_refs?: string[];
}
interface Architecture {
  version: string;
  last_manual_edit: string;
  threat_layers: ThreatLayer[];
  engine_modules: EngineModule[];
  surfaces: Surface[];
  data_flow: string[];
  tier_gating: Record<string, Record<string, boolean | string>>;
  deck: { latest_html: string; version: string; appendix_a1: string };
}

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function statusBadge(s: EngineModule['status'] | Surface['status']): string {
  switch (s) {
    case 'shipped': return '✓ shipped';
    case 'shipped-engine': return '✓ engine shipped';
    case 'in-flight': return '◐ in-flight';
    case 'built': return '◐ built (test pending)';
    case 'spec': return '○ spec';
    case 'planned': return '○ planned';
    default: return s;
  }
}

function mermaid(arch: Architecture): string {
  const lines = ['```mermaid', 'graph LR'];
  lines.push('  subgraph Surfaces');
  for (const s of arch.surfaces) {
    lines.push(`    S_${s.id}["${s.name}"]`);
  }
  lines.push('  end');
  lines.push('  subgraph Engine');
  for (const e of arch.engine_modules) {
    lines.push(`    E_${e.id}["${e.id} — ${e.name}"]`);
  }
  lines.push('  end');
  // All surfaces flow into P0
  for (const s of arch.surfaces) {
    lines.push(`  S_${s.id} --> E_P0`);
  }
  // Engine vertical chain
  lines.push('  E_P0 -->|flagged| E_P1');
  lines.push('  E_P1 -->|low conf or L1| E_P2');
  lines.push('  E_P0 -.->|all verdicts| E_M');
  lines.push('  E_P1 -.->|all verdicts| E_M');
  lines.push('  E_P2 -.->|all verdicts| E_M');
  lines.push('  E_M -.->|distilled patterns| E_P0');
  lines.push('  E_P2 -->|action attempt| E_L4');
  lines.push('  classDef shipped fill:#0c2818,stroke:#2a8a4a,color:#e0ffe0;');
  lines.push('  classDef inflight fill:#28220c,stroke:#a08a2a,color:#fff7e0;');
  lines.push('  classDef spec fill:#1c1c2a,stroke:#5a5aa0,color:#e0e0ff;');
  for (const e of arch.engine_modules) {
    const cls = e.status === 'shipped' || e.status === 'shipped-engine' ? 'shipped'
              : e.status === 'in-flight' ? 'inflight'
              : 'spec';
    lines.push(`  class E_${e.id} ${cls};`);
  }
  lines.push('```');
  return lines.join('\n');
}

function coverageMatrix(arch: Architecture): string {
  const engines = arch.engine_modules.map(e => e.id);
  const rows: string[] = [];
  rows.push(`| Threat Layer | Label | ${engines.join(' | ')} |`);
  rows.push(`|---|---|${engines.map(() => '---').join('|')}|`);
  for (const t of arch.threat_layers) {
    const covers = engines.map(e => t.covered_by.includes(e) ? '●' : '·');
    rows.push(`| ${t.id} | ${t.label} | ${covers.join(' | ')} |`);
  }
  return rows.join('\n');
}

function engineTable(arch: Architecture): string {
  const rows: string[] = [];
  rows.push('| ID | Name | Status | Package | OLs | What |');
  rows.push('|---|---|---|---|---|---|');
  for (const e of arch.engine_modules) {
    const ols = e.ol_refs.length ? e.ol_refs.join(', ') : '—';
    rows.push(`| ${e.id} | ${e.name} | ${statusBadge(e.status)} | \`${e.package}\` | ${ols} | ${e.what} |`);
  }
  return rows.join('\n');
}

function surfaceTable(arch: Architecture): string {
  const rows: string[] = [];
  rows.push('| ID | Surface | Status | Package | OLs | What |');
  rows.push('|---|---|---|---|---|---|');
  for (const s of arch.surfaces) {
    const ols = s.ol_refs?.length ? s.ol_refs.join(', ') : '—';
    rows.push(`| ${s.id} | ${s.name} | ${statusBadge(s.status)} | \`${s.package}\` | ${ols} | ${s.what} |`);
  }
  return rows.join('\n');
}

function tierTable(arch: Architecture): string {
  const tiers = Object.keys(arch.tier_gating);
  const modules = Object.keys(arch.tier_gating[tiers[0]] ?? {});
  const rows: string[] = [];
  rows.push(`| Tier | ${modules.join(' | ')} |`);
  rows.push(`|---|${modules.map(() => '---').join('|')}|`);
  for (const t of tiers) {
    const cells = modules.map(m => {
      const v = arch.tier_gating[t][m];
      if (v === true) return '✓';
      if (v === false) return '—';
      return String(v);
    });
    rows.push(`| ${t} | ${cells.join(' | ')} |`);
  }
  return rows.join('\n');
}

function fileList(arch: Architecture): string {
  const lines: string[] = [];
  for (const e of arch.engine_modules) {
    if (e.files.length === 0) continue;
    lines.push(`**${e.id} — ${e.name}** (\`${e.package}\`)`);
    for (const f of e.files) {
      const exists = existsSync(resolve(REPO_ROOT, f));
      lines.push(`  - ${exists ? '' : '⚠ missing: '}\`${f}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function dataFlow(arch: Architecture): string {
  return arch.data_flow.map((step, i) => `${i + 1}. ${step}`).join('\n');
}

function buildMarkdown(arch: Architecture): string {
  const commit = git('rev-parse --short HEAD');
  const branch = git('rev-parse --abbrev-ref HEAD');
  const dirty = git('status --porcelain').length > 0;
  const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  return `# RAI Architecture — Live View

> **Auto-generated. Do not edit.**
> Source of truth: \`architecture.json\` · Regenerate: \`npm run regen-arch\`
> Generated: ${now} · Commit: \`${commit}\` (\`${branch}\`)${dirty ? ' · ⚠ working tree dirty' : ''}
> Schema version: ${arch.version} · Last manual edit to source: ${arch.last_manual_edit}

---

## Diagram

${mermaid(arch)}

---

## Engine modules

${engineTable(arch)}

### Files per module

${fileList(arch)}

---

## Surfaces

${surfaceTable(arch)}

---

## Threat-layer × engine-module coverage

${coverageMatrix(arch)}

\`●\` = covered, \`·\` = not covered

---

## Tier gating

${tierTable(arch)}

---

## Data flow

${dataFlow(arch)}

---

## Deck

- Latest version: **${arch.deck.version}** — [\`${arch.deck.latest_html}\`](../${arch.deck.latest_html.replace(/ /g, '%20')})
- Appendix A1: ${arch.deck.appendix_a1}

---

_To update the architecture model, edit \`architecture.json\` at the repo root and run \`npm run regen-arch\`. A launchd plist regenerates this file Mon/Wed/Fri at 09:00 local._
`;
}

function main(): void {
  const arch = JSON.parse(readFileSync(ARCH_JSON, 'utf-8')) as Architecture;
  const md = buildMarkdown(arch);
  writeFileSync(OUTPUT, md);
  const bytes = Buffer.byteLength(md);
  console.log(`regen-architecture: wrote ${OUTPUT} (${bytes} bytes, ${md.split('\n').length} lines)`);
}

main();
