#!/usr/bin/env node
/**
 * repo-scan-cli.ts -- Local CLI for the OL-453 L1+L2 repo pre-ingest scanner.
 *
 * Usage:
 *   node packages/core/dist/repo-scan-cli.js https://github.com/owner/repo
 *   GITHUB_TOKEN=... node packages/core/dist/repo-scan-cli.js https://github.com/owner/repo
 *
 * No spend, no auth required (GitHub REST API works unauthenticated within
 * rate limits; GITHUB_TOKEN just raises the ceiling). Fetch-as-data only --
 * this scanner never executes anything it reads.
 */

import { readOptionalEnv } from './env.js';
import { scanRepo } from './repo-scan.js';

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: repo-scan-cli.js <github-repo-url>');
    process.exit(2);
  }

  const { GITHUB_TOKEN } = readOptionalEnv(['GITHUB_TOKEN']);
  const result = await scanRepo(url, { githubToken: GITHUB_TOKEN });

  console.log(JSON.stringify(result, null, 2));

  console.error(`\n${result.badge}`);
  console.error(`scope: ${result.scope_disclaimer}`);
  console.error(
    `L1 findings: ${result.l1.findings.length ? result.l1.findings.map((f) => `${f.check}(${f.severity})`).join(', ') : 'none'}`,
  );
  console.error(
    `L2 findings: ${result.l2.findings.length ? result.l2.findings.map((f) => `${f.channel}:${f.file}(${f.severity})`).join(', ') : 'none'}`,
  );
  console.error(`digest: ${result.artifact_digest ?? 'n/a'} @ ${result.timestamp}`);
}

main().catch((err) => {
  console.error('repo-scan-cli failed:', err);
  process.exit(1);
});
