#!/usr/bin/env node
/**
 * bundle.ts — emit a single JSON file with all YAML payloads.
 *
 * Output: dist/payloads-bundle.json
 *
 * This bundle is consumed by the standalone VPS-side runner which has no
 * js-yaml dependency. Run as part of build.
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadPayloads, defaultPayloadDir } from './loader.js';

function main(): void {
  const payloads = loadPayloads(defaultPayloadDir());
  const outPath = path.resolve(path.dirname(process.argv[1]), 'payloads-bundle.json');

  fs.writeFileSync(
    outPath,
    JSON.stringify({ generated_at: new Date().toISOString(), count: payloads.length, payloads }, null, 2),
  );

  console.log(`Bundled ${payloads.length} payloads → ${outPath}`);
}

main();
