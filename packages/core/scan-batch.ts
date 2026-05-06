#!/usr/bin/env node
/**
 * scan-batch.ts -- OL-157 batch scanner around scanP1.
 *
 * Reads a jsonl manifest of posts ({id, path, ground_truth?}), runs scanP1 N
 * times per post with bounded concurrency, retries on transient API errors,
 * resumable via a state file, and writes one jsonl record per post to the
 * output file (or stdout).
 *
 * Designed for OL-158 study scale (50-200 posts). Determinism telemetry baked
 * in via N=2 default — agreement flag in output surfaces post-level variance
 * without requiring a separate determinism pass.
 *
 * Usage (from repo root):
 *   source ~/.no5-env
 *   cd packages/core && npm run build
 *   node packages/core/dist/scan-batch.js \
 *     --input scratch/validation-posts/manifest.jsonl \
 *     --output scratch/validation-posts/results.jsonl \
 *     --state  scratch/validation-posts/state.jsonl \
 *     --concurrency 5 --n 2 --verbose
 */

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { scanP1, type ScanInput, type ScanOutput } from './rai-scan-p1.js';

interface ManifestEntry {
  id: string;
  path: string;
  ground_truth?: string;
}

interface RunRecord {
  verdict: string;
  confidence: number;
  signals: string[];
  raw_layers: ScanOutput['threat_layers'];
  latency_ms: number;
  attempts: number;
  error?: string;
}

interface PostResult {
  id: string;
  path: string;
  ground_truth?: string;
  runs: RunRecord[];
  agreement: {
    verdict_consistent: boolean;
    verdicts_seen: string[];
    confidence_mean: number;
    confidence_std: number;
    signal_jaccard: number;
  };
  completed_at: string;
}

interface CliOpts {
  input?: string;
  output?: string;
  state?: string;
  concurrency: number;
  n: number;
  verbose: boolean;
  maxRetries: number;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    concurrency: 5,
    n: 2,
    verbose: false,
    maxRetries: 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--input': opts.input = next(); break;
      case '--output': opts.output = next(); break;
      case '--state': opts.state = next(); break;
      case '--concurrency': opts.concurrency = parseInt(next(), 10); break;
      case '--n': opts.n = parseInt(next(), 10); break;
      case '--max-retries': opts.maxRetries = parseInt(next(), 10); break;
      case '--verbose': opts.verbose = true; break;
      case '-h': case '--help':
        printHelp();
        process.exit(0);
      default:
        console.error(`unknown arg: ${a}`);
        process.exit(2);
    }
  }
  return opts;
}

function printHelp(): void {
  console.error(`scan-batch -- OL-157 batch scanner

Required:
  --input  <path>   jsonl manifest, one {id, path, ground_truth?} per line
                    (or read from stdin if omitted)

Optional:
  --output <path>   jsonl output (default: stdout)
  --state  <path>   state file for resumable runs
  --concurrency N   in-flight scans (default: 5)
  --n N             scans per post (default: 2)
  --max-retries N   per-scan retries on 429/5xx (default: 3)
  --verbose         per-post progress on stderr
`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function loadManifest(opts: CliOpts): Promise<ManifestEntry[]> {
  const raw = opts.input
    ? await fs.readFile(opts.input, 'utf-8')
    : await readStdin();
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.map((l, i) => {
    try {
      const obj = JSON.parse(l);
      if (!obj.id || !obj.path) {
        throw new Error(`line ${i + 1}: missing id or path`);
      }
      return obj as ManifestEntry;
    } catch (e: any) {
      throw new Error(`bad manifest line ${i + 1}: ${e.message}`);
    }
  });
}

async function loadCompletedIds(stateFile?: string): Promise<Set<string>> {
  const seen = new Set<string>();
  if (!stateFile) return seen;
  try {
    const raw = await fs.readFile(stateFile, 'utf-8');
    for (const line of raw.split('\n').map((l) => l.trim()).filter(Boolean)) {
      try {
        const obj = JSON.parse(line);
        if (obj.id) seen.add(obj.id);
      } catch { /* skip malformed lines */ }
    }
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  return seen;
}

function buildInput(content: string): ScanInput {
  return {
    scan_id: randomUUID(),
    timestamp: new Date().toISOString(),
    source: {
      channel: 'clipboard',
      pipeline_stage: 'ingest',
      sender: null,
      origin_url: null,
      is_forward: true,
    },
    payload: { type: 'text', content },
    context: {
      session_id: 'scan-batch',
      prior_scan_ids: [],
      host_environment: 'api',
    },
  };
}

function isRetryable(err: any): boolean {
  // Anthropic SDK exposes status; raw fetch errors do not. Cover both.
  const status = err?.status ?? err?.response?.status;
  if (typeof status === 'number') {
    return status === 429 || (status >= 500 && status < 600);
  }
  // Network-level transient errors.
  const code = err?.code ?? err?.cause?.code;
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND';
}

async function runOnce(
  content: string,
  maxRetries: number,
): Promise<RunRecord> {
  let attempt = 0;
  let lastErr: any;
  while (attempt <= maxRetries) {
    attempt++;
    try {
      const result = await scanP1(buildInput(content));
      return {
        verdict: result.verdict,
        confidence: result.confidence,
        signals: result.threat_layers.map((t) => t.signal).filter(Boolean),
        raw_layers: result.threat_layers,
        latency_ms: result.latency_ms ?? 0,
        attempts: attempt,
      };
    } catch (err: any) {
      lastErr = err;
      if (!isRetryable(err) || attempt > maxRetries) break;
      const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
      await sleep(backoffMs);
    }
  }
  return {
    verdict: 'error',
    confidence: 0,
    signals: [],
    raw_layers: [],
    latency_ms: 0,
    attempts: attempt,
    error: String(lastErr?.message ?? lastErr ?? 'unknown'),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jaccardOnSignalSets(runs: RunRecord[]): number {
  // Pairwise mean Jaccard over signal sets. Returns 1.0 for n<2 or all-empty.
  if (runs.length < 2) return 1;
  const sets = runs.map((r) => new Set(r.signals.filter(Boolean)));
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i];
      const b = sets[j];
      const inter = [...a].filter((x) => b.has(x)).length;
      const uni = new Set([...a, ...b]).size;
      total += uni === 0 ? 1 : inter / uni;
      pairs++;
    }
  }
  return pairs === 0 ? 1 : total / pairs;
}

function summarize(runs: RunRecord[]): PostResult['agreement'] {
  const verdicts = runs.map((r) => r.verdict);
  const verdictsSeen = [...new Set(verdicts)];
  const confs = runs.map((r) => r.confidence);
  const mean = confs.reduce((a, b) => a + b, 0) / Math.max(confs.length, 1);
  const variance = confs.reduce((a, c) => a + (c - mean) ** 2, 0) / Math.max(confs.length, 1);
  return {
    verdict_consistent: verdictsSeen.length === 1,
    verdicts_seen: verdictsSeen,
    confidence_mean: Number(mean.toFixed(3)),
    confidence_std: Number(Math.sqrt(variance).toFixed(3)),
    signal_jaccard: Number(jaccardOnSignalSets(runs).toFixed(3)),
  };
}

async function processPost(
  entry: ManifestEntry,
  opts: CliOpts,
): Promise<PostResult> {
  const content = (await fs.readFile(entry.path, 'utf-8')).trim();
  const runs: RunRecord[] = [];
  for (let i = 0; i < opts.n; i++) {
    runs.push(await runOnce(content, opts.maxRetries));
  }
  return {
    id: entry.id,
    path: entry.path,
    ground_truth: entry.ground_truth,
    runs,
    agreement: summarize(runs),
    completed_at: new Date().toISOString(),
  };
}

async function appendJsonl(file: string, record: unknown): Promise<void> {
  await fs.appendFile(file, JSON.stringify(record) + '\n');
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('error: ANTHROPIC_API_KEY not set. run: source ~/.no5-env');
    process.exit(2);
  }
  const opts = parseArgs(process.argv.slice(2));
  const manifest = await loadManifest(opts);
  const completed = await loadCompletedIds(opts.state);
  const todo = manifest.filter((e) => !completed.has(e.id));

  if (opts.verbose) {
    console.error(
      `scan-batch: ${manifest.length} entries (${completed.size} already done, ${todo.length} pending), concurrency=${opts.concurrency}, n=${opts.n}`,
    );
  }

  if (opts.output) {
    // Ensure parent directory exists; create empty file only if missing so
    // resumed runs append rather than truncate.
    await fs.mkdir(path.dirname(opts.output), { recursive: true });
    try { await fs.access(opts.output); } catch { await fs.writeFile(opts.output, ''); }
  }

  let inFlight = 0;
  let cursor = 0;
  let okCount = 0;
  let flagCount = 0;
  let inconsistentCount = 0;
  let errCount = 0;

  await new Promise<void>((resolve, reject) => {
    const tryLaunch = (): void => {
      while (inFlight < opts.concurrency && cursor < todo.length) {
        const entry = todo[cursor++];
        inFlight++;
        processPost(entry, opts)
          .then(async (result) => {
            okCount++;
            if (result.agreement.verdicts_seen.includes('flagged')) flagCount++;
            if (!result.agreement.verdict_consistent) inconsistentCount++;
            if (result.runs.some((r) => r.verdict === 'error')) errCount++;

            const line = JSON.stringify(result);
            if (opts.output) {
              await appendJsonl(opts.output, result);
            } else {
              process.stdout.write(line + '\n');
            }
            if (opts.state) {
              await appendJsonl(opts.state, { id: result.id, completed_at: result.completed_at });
            }
            if (opts.verbose) {
              const tag = result.agreement.verdict_consistent
                ? result.agreement.verdicts_seen[0]
                : `MIXED(${result.agreement.verdicts_seen.join('/')})`;
              console.error(
                `  [${okCount}/${todo.length}] ${entry.id.padEnd(40)} ${tag.padEnd(14)} conf=${result.agreement.confidence_mean.toFixed(2)} jacc=${result.agreement.signal_jaccard.toFixed(2)}`,
              );
            }
            inFlight--;
            if (cursor >= todo.length && inFlight === 0) resolve();
            else tryLaunch();
          })
          .catch((err) => {
            // processPost reads files; this is the only non-API failure path.
            errCount++;
            inFlight--;
            console.error(`  [ERR] ${entry.id}: ${err?.message ?? err}`);
            if (cursor >= todo.length && inFlight === 0) resolve();
            else tryLaunch();
          });
      }
      if (todo.length === 0) resolve();
    };
    tryLaunch();
  });

  if (opts.verbose) {
    console.error('');
    console.error(`===== scan-batch summary =====`);
    console.error(`processed:        ${okCount}/${todo.length}`);
    console.error(`flagged at least once: ${flagCount}`);
    console.error(`verdict-inconsistent (n=${opts.n}): ${inconsistentCount}`);
    console.error(`runs with errors: ${errCount}`);
    if (opts.output) console.error(`output: ${opts.output}`);
    if (opts.state) console.error(`state:  ${opts.state}`);
  }
}

main().catch((err) => {
  console.error('scan-batch failed:', err);
  process.exit(1);
});
