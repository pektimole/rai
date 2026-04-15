/**
 * loader.ts — YAML payload loader.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import type { Payload } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Default payload directory: packages/redteam/payloads/ (sibling of dist/). */
export function defaultPayloadDir(): string {
  // dist/loader.js → ../payloads
  return path.resolve(__dirname, '..', 'payloads');
}

/** Load all payloads from a directory of .yaml files. */
export function loadPayloads(dir: string = defaultPayloadDir()): Payload[] {
  if (!fs.existsSync(dir)) {
    throw new Error(`Payload directory not found: ${dir}`);
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  const payloads: Payload[] = [];

  for (const file of files) {
    const fullPath = path.join(dir, file);
    const content = fs.readFileSync(fullPath, 'utf-8');
    const parsed = yaml.load(content) as Payload[];

    if (!Array.isArray(parsed)) {
      throw new Error(`Payload file ${file} must be a YAML list`);
    }

    for (const p of parsed) {
      validatePayload(p, file);
      payloads.push(p);
    }
  }

  return payloads;
}

function validatePayload(p: Payload, file: string): void {
  if (!p.id) throw new Error(`[${file}] payload missing id`);
  if (!p.layer) throw new Error(`[${file}] payload ${p.id} missing layer`);
  if (!p.expected_verdict) throw new Error(`[${file}] payload ${p.id} missing expected_verdict`);
  if (!p.payload) throw new Error(`[${file}] payload ${p.id} missing payload text`);
  if (!p.variant) throw new Error(`[${file}] payload ${p.id} missing variant`);

  const validVerdicts = ['clean', 'flagged', 'blocked'];
  if (!validVerdicts.includes(p.expected_verdict)) {
    throw new Error(`[${file}] payload ${p.id} has invalid verdict: ${p.expected_verdict}`);
  }
}
