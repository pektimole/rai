/**
 * arch-preview.ts — render docs/30-rai-architecture-live.md as a
 * standalone HTML page with Mermaid + GFM tables, then open it.
 *
 * Usage: npx tsx scripts/arch-preview.ts
 * Output: /tmp/rai-arch-preview.html (auto-opens in default browser)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SRC = resolve(REPO_ROOT, 'docs', '30-rai-architecture-live.md');
const OUT = '/tmp/rai-arch-preview.html';

const md = readFileSync(SRC, 'utf-8');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>RAI Architecture — Live View</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
         background: #0b0d12; color: #e8eaf0; margin: 0; padding: 2rem 3rem; max-width: 1100px; }
  h1, h2, h3 { color: #f6f8fb; letter-spacing: -0.01em; }
  h1 { font-size: 1.7rem; border-bottom: 1px solid #2a2f3a; padding-bottom: .5rem; }
  h2 { font-size: 1.25rem; margin-top: 2.2rem; }
  h3 { font-size: 1.05rem; color: #c8d0e0; }
  hr { border: 0; border-top: 1px solid #2a2f3a; margin: 1.5rem 0; }
  code { background: #1a1e28; padding: 1px 5px; border-radius: 3px; font-size: 0.9em; }
  pre code { display: block; padding: .8rem 1rem; overflow-x: auto; }
  table { border-collapse: collapse; margin: 1rem 0; font-size: 13px; }
  th, td { border: 1px solid #2a2f3a; padding: 6px 10px; vertical-align: top; }
  th { background: #161a23; text-align: left; font-weight: 600; }
  tr:nth-child(even) td { background: #11141c; }
  a { color: #6aa6ff; }
  blockquote { border-left: 3px solid #2a8a4a; background: #0c1d14; padding: .6rem 1rem;
               margin: 1rem 0; color: #c8d8c8; }
  .mermaid { background: #0f1218; border: 1px solid #2a2f3a; border-radius: 6px;
             padding: 1rem; margin: 1rem 0; }
  ul { padding-left: 1.4rem; }
  li { margin: .15rem 0; }
</style>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
</head>
<body>
<div id="content"></div>
<script>
  const raw = ${JSON.stringify(md)};
  // Extract mermaid blocks, replace with placeholders, render markdown, then re-inject
  const mermaidBlocks = [];
  const stripped = raw.replace(/\`\`\`mermaid\\n([\\s\\S]*?)\\n\`\`\`/g, (_m, code) => {
    const i = mermaidBlocks.length;
    mermaidBlocks.push(code);
    return '<<MERMAID_' + i + '>>';
  });
  let html = marked.parse(stripped, { gfm: true, breaks: false });
  html = html.replace(/&lt;&lt;MERMAID_(\\d+)&gt;&gt;/g, (_m, i) =>
    '<div class="mermaid">' + mermaidBlocks[+i] + '</div>'
  );
  document.getElementById('content').innerHTML = html;
  mermaid.initialize({ startOnLoad: true, theme: 'dark',
    themeVariables: { background: '#0f1218', primaryColor: '#1a1e28',
      primaryTextColor: '#e8eaf0', lineColor: '#5a6478' } });
  mermaid.run();
</script>
</body>
</html>`;

writeFileSync(OUT, html);
console.log(`wrote ${OUT}`);
try {
  execSync(`open ${OUT}`);
} catch {
  /* ignore */
}
