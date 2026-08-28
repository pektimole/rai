/**
 * repo-scan.ts — RAI L1+L2 Repo/URL Pre-Ingest Scan (OL-453)
 *
 * First concrete brick of the OL-453 ladder (WS-rai.md, [mob:2026-07-20]):
 * "build L1+L2 scanner over a given repo URL (metadata + static hidden-channel
 * scan → scoped verdict)."
 *
 *   L1 Authenticity  — owner identity, account age, star/commit history,
 *                       vendor backlink signal, brandjack pattern. Clears
 *                       provenance.
 *   L2 Static injection scan — fetch-as-data, NEVER execute. Hidden channels:
 *                       alt-text, link-titles, HTML comments, zero-width /
 *                       unicode-tag chars, base64 blobs, split-payload
 *                       (fileA→fileB), "SYSTEM MESSAGE" role-override
 *                       phrasing. Clears read-as-data (safe triage/summarize).
 *   L4 verdict badge — WHAT was checked + WHAT it's cleared for. Never a
 *                       bare green (scope disclaimer always attached).
 *
 * Out of scope for this brick (per WS-rai.md ladder): L0 redirect-chain
 * resolution, L3 code/supply-chain (install/exec clearance), image-OCR
 * (OL-431), cross-source corroboration beyond GitHub's own API.
 *
 * Scope-lock: signal-layer, NOT a firewall. Selling this as protection is the
 * OL-391 overclaim trap — the badge always carries the disclaimer.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RepoL1Status = 'pass' | 'flagged' | 'unknown';
export type L2Status = 'clean' | 'flagged';
export type ClearedFor = 'read' | null;
export type RepoScanSeverity = 'low' | 'medium' | 'high';

export interface L1Finding {
  check: string;
  signal: string;
  severity: RepoScanSeverity;
}

export interface L2Finding {
  channel:
    | 'html_comment'
    | 'alt_text'
    | 'link_title'
    | 'zero_width_unicode_tag'
    | 'base64_blob'
    | 'split_payload'
    | 'system_message_override';
  file: string;
  excerpt: string;
  severity: RepoScanSeverity;
}

export interface RepoMeta {
  owner: string;
  repo: string;
  default_branch: string;
  stargazers_count: number;
  forks_count: number;
  archived: boolean;
  fork: boolean;
  created_at: string;
  pushed_at: string;
}

export interface OwnerMeta {
  login: string;
  type: 'User' | 'Organization';
  created_at: string;
  public_repos: number;
  followers: number;
  blog: string | null;
  bio: string | null;
}

export interface RepoScanResult {
  scan_id: string;
  timestamp: string;
  target: string;
  artifact_digest: string | null;
  l1: {
    status: RepoL1Status;
    findings: L1Finding[];
    repo: RepoMeta | null;
    owner: OwnerMeta | null;
    commit_count_sampled: number | null;
  };
  l2: {
    status: L2Status;
    findings: L2Finding[];
    files_scanned: number;
    files_skipped: number;
  };
  cleared_for: ClearedFor;
  scope_disclaimer: string;
  badge: string;
}

export interface RepoScanOptions {
  /** GitHub PAT. Optional — unauthenticated requests work, just rate-limited (60/hr). */
  githubToken?: string;
  /** L2 file-scan cap. Default 40. */
  maxFiles?: number;
  /** Per-file byte cap before truncation. Default 200_000. */
  maxFileBytes?: number;
  /** Test seam — defaults to global fetch. */
  fetchImpl?: typeof fetch;
  scanId?: string;
  timestamp?: string;
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

export function parseRepoUrl(url: string): { owner: string; repo: string } {
  const m = url
    .trim()
    .replace(/\.git$/, '')
    .match(/github\.com[/:]([^/]+)\/([^/#?]+)/i);
  if (!m) throw new Error(`repo-scan: not a recognizable GitHub repo URL: ${url}`);
  return { owner: m[1], repo: m[2] };
}

// ---------------------------------------------------------------------------
// GitHub API helpers (fetch-as-data only — L2 never executes anything fetched)
// ---------------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com';

async function ghGet(
  path: string,
  fetchImpl: typeof fetch,
  token: string | undefined,
): Promise<{ ok: boolean; status: number; json: () => Promise<any>; headers: Headers }> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'rai-repo-scan/1.0 (OL-453)',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchImpl(`${GITHUB_API}${path}`, { headers });
  return res as any;
}

// ---------------------------------------------------------------------------
// L1 — Authenticity
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runL1(
  owner: string,
  repo: string,
  fetchImpl: typeof fetch,
  token: string | undefined,
): Promise<RepoScanResult['l1']> {
  const findings: L1Finding[] = [];
  let repoMeta: RepoMeta | null = null;
  let ownerMeta: OwnerMeta | null = null;
  let commitCountSampled: number | null = null;

  const repoRes = await ghGet(`/repos/${owner}/${repo}`, fetchImpl, token);
  if (!repoRes.ok) {
    findings.push({
      check: 'repo_metadata',
      signal: `GitHub API returned ${repoRes.status} for ${owner}/${repo} — cannot establish provenance`,
      severity: 'high',
    });
    return { status: 'unknown', findings, repo: null, owner: null, commit_count_sampled: null };
  }
  const repoJson = await repoRes.json();
  repoMeta = {
    owner,
    repo,
    default_branch: repoJson.default_branch ?? 'main',
    stargazers_count: repoJson.stargazers_count ?? 0,
    forks_count: repoJson.forks_count ?? 0,
    archived: !!repoJson.archived,
    fork: !!repoJson.fork,
    created_at: repoJson.created_at,
    pushed_at: repoJson.pushed_at,
  };

  if (repoMeta.archived) {
    findings.push({ check: 'archived', signal: 'Repo is archived (stale, unmaintained)', severity: 'low' });
  }

  const ownerRes = await ghGet(`/users/${owner}`, fetchImpl, token);
  if (ownerRes.ok) {
    const oj = await ownerRes.json();
    ownerMeta = {
      login: oj.login,
      type: oj.type,
      created_at: oj.created_at,
      public_repos: oj.public_repos ?? 0,
      followers: oj.followers ?? 0,
      blog: oj.blog || null,
      bio: oj.bio || null,
    };
    const accountAgeDays = (Date.now() - new Date(ownerMeta.created_at).getTime()) / DAY_MS;
    if (accountAgeDays < 30) {
      findings.push({
        check: 'account_age',
        signal: `Owner account is ${Math.round(accountAgeDays)}d old (<30d threshold)`,
        severity: 'medium',
      });
    }
    if (ownerMeta.public_repos <= 1 && ownerMeta.followers === 0) {
      findings.push({
        check: 'owner_footprint',
        signal: 'Owner has no other public repos and zero followers — thin footprint',
        severity: 'low',
      });
    }
    if (!ownerMeta.blog && !ownerMeta.bio) {
      findings.push({
        check: 'vendor_backlink',
        signal: 'No blog/website or bio set on owner profile — no independent identity backlink to check',
        severity: 'low',
      });
    }
  } else {
    findings.push({ check: 'owner_metadata', signal: `Owner lookup failed (${ownerRes.status})`, severity: 'medium' });
  }

  // Commit history sample (first page only — cheap signal, not a full audit).
  const commitsRes = await ghGet(`/repos/${owner}/${repo}/commits?per_page=30`, fetchImpl, token);
  if (commitsRes.ok) {
    const commits = await commitsRes.json();
    commitCountSampled = Array.isArray(commits) ? commits.length : 0;
    if (commitCountSampled !== null && commitCountSampled < 3) {
      findings.push({
        check: 'commit_history',
        signal: `Only ${commitCountSampled} commit(s) sampled — thin history`,
        severity: 'medium',
      });
    }
  }

  if ((repoMeta.stargazers_count ?? 0) < 5 && (commitCountSampled ?? 0) < 3) {
    findings.push({
      check: 'traction',
      signal: `Low stars (${repoMeta.stargazers_count}) + thin commit history — weak corroboration signal`,
      severity: 'low',
    });
  }

  // Brandjack: search for a same/similar-named repo with materially more stars
  // and a different owner. Signal, not proof — namesakes are common and legit.
  const searchRes = await ghGet(
    `/search/repositories?q=${encodeURIComponent(repo)}+in:name&sort=stars&order=desc&per_page=5`,
    fetchImpl,
    token,
  );
  if (searchRes.ok) {
    const sj = await searchRes.json();
    const top = Array.isArray(sj.items) ? sj.items[0] : null;
    if (
      top &&
      top.owner?.login &&
      top.owner.login.toLowerCase() !== owner.toLowerCase() &&
      top.name?.toLowerCase() === repo.toLowerCase() &&
      top.stargazers_count > Math.max(50, (repoMeta.stargazers_count ?? 0) * 10)
    ) {
      findings.push({
        check: 'brandjack_pattern',
        signal: `A same-named repo ${top.owner.login}/${top.name} has far more stars (${top.stargazers_count} vs ${repoMeta.stargazers_count}) — possible brandjack, verify which is canonical`,
        severity: 'high',
      });
    }
  }

  const hasHigh = findings.some((f) => f.severity === 'high');
  const status: RepoL1Status = hasHigh || findings.length > 0 ? 'flagged' : 'pass';

  return { status, findings, repo: repoMeta, owner: ownerMeta, commit_count_sampled: commitCountSampled };
}

// ---------------------------------------------------------------------------
// L2 — Static hidden-channel scan (fetch-as-data, never execute)
// ---------------------------------------------------------------------------

const TEXT_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.rst', '.json', '.yml', '.yaml', '.toml', '.ini', '.cfg',
  '.js', '.ts', '.jsx', '.tsx', '.py', '.html', '.htm', '.svg', '.env', '.sh',
]);

const PRIORITY_BASENAMES = /^(readme|skill|contributing|install|setup|agents?)(\.|$)/i;

function fileExt(path: string): string {
  const i = path.lastIndexOf('.');
  return i === -1 ? '' : path.slice(i).toLowerCase();
}

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

async function fetchTree(
  owner: string,
  repo: string,
  sha: string,
  fetchImpl: typeof fetch,
  token: string | undefined,
): Promise<TreeEntry[]> {
  const res = await ghGet(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`, fetchImpl, token);
  if (!res.ok) return [];
  const json = await res.json();
  const entries: TreeEntry[] = Array.isArray(json.tree) ? json.tree : [];
  return entries.filter((e) => e.type === 'blob');
}

function selectFilesToScan(entries: TreeEntry[], maxFiles: number): TreeEntry[] {
  const candidates = entries.filter((e) => TEXT_EXTENSIONS.has(fileExt(e.path)));
  candidates.sort((a, b) => {
    const pa = PRIORITY_BASENAMES.test(a.path.split('/').pop() ?? '') ? 0 : 1;
    const pb = PRIORITY_BASENAMES.test(b.path.split('/').pop() ?? '') ? 0 : 1;
    return pa - pb;
  });
  return candidates.slice(0, maxFiles);
}

async function fetchRawFile(
  owner: string,
  repo: string,
  ref: string,
  path: string,
  fetchImpl: typeof fetch,
  maxBytes: number,
): Promise<string | null> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'rai-repo-scan/1.0 (OL-453)' } });
  if (!('ok' in res) || !(res as any).ok) return null;
  const text = await (res as any).text();
  return typeof text === 'string' ? text.slice(0, maxBytes) : null;
}

function truncate(s: string, n = 160): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n) + '…' : clean;
}

// Curated, deliberately narrow — role-override / instruction-injection phrasing.
// Kept in sync with the L0 patterns in rai-scan-p0.ts where they overlap; this
// list is repo-content-specific (comments/docs), not chat-message-specific.
const SYSTEM_OVERRIDE_PATTERNS: RegExp[] = [
  /system\s*message\s*:/i,
  /\[?\s*system\s*prompt\s*\]?\s*:/i,
  /ignore\s+(all\s+|any\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(all\s+|any\s+)?(previous|prior)\s+(instructions|prompts)/i,
  /you\s+are\s+now\s+(a|an)\b/i,
  /new\s+instructions\s*:/i,
  /do\s+not\s+(mention|reveal|include)\s+this\s+(notice|instruction)/i,
  /assistant\s+will\s+now/i,
];

// Base64 blob candidate — long unbroken run, allow padding.
const BASE64_BLOB_RE = /(?:[A-Za-z0-9+/]{44,}={0,2})/g;

// Zero-width / Unicode-tag smuggling characters (ASCII-smuggling / CC tracker class).
const ZERO_WIDTH_RE = /[​-‍﻿]/;
const UNICODE_TAG_RE = /[\u{E0001}\u{E0020}-\u{E007F}]/u;

const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)]*)\)/g;
const HTML_IMG_ALT_RE = /<img\b[^>]*\balt=["']([^"']*)["'][^>]*>/gi;
const MD_LINK_TITLE_RE = /\[[^\]]*\]\([^)]+\s+"([^"]*)"\)/g;
const HTML_TITLE_ATTR_RE = /\btitle=["']([^"']*)["']/gi;
const HTML_COMMENT_RE = /<!--([\s\S]*?)-->/g;

function scanSystemOverride(content: string, path: string): L2Finding[] {
  const out: L2Finding[] = [];
  for (const re of SYSTEM_OVERRIDE_PATTERNS) {
    const m = content.match(re);
    if (m) {
      out.push({
        channel: 'system_message_override',
        file: path,
        excerpt: truncate(m[0]),
        severity: 'high',
      });
    }
  }
  return out;
}

function scanHtmlComments(content: string, path: string): L2Finding[] {
  const out: L2Finding[] = [];
  for (const m of content.matchAll(HTML_COMMENT_RE)) {
    const body = m[1];
    if (SYSTEM_OVERRIDE_PATTERNS.some((re) => re.test(body)) || ZERO_WIDTH_RE.test(body) || UNICODE_TAG_RE.test(body)) {
      out.push({ channel: 'html_comment', file: path, excerpt: truncate(body), severity: 'high' });
    }
  }
  return out;
}

function scanAltAndTitles(content: string, path: string): L2Finding[] {
  const out: L2Finding[] = [];
  const groups: Array<{ re: RegExp; channel: L2Finding['channel']; g: number }> = [
    { re: MD_IMAGE_RE, channel: 'alt_text', g: 1 },
    { re: HTML_IMG_ALT_RE, channel: 'alt_text', g: 1 },
    { re: MD_LINK_TITLE_RE, channel: 'link_title', g: 1 },
    { re: HTML_TITLE_ATTR_RE, channel: 'link_title', g: 1 },
  ];
  for (const { re, channel, g } of groups) {
    for (const m of content.matchAll(re)) {
      const text = m[g] ?? '';
      if (!text) continue;
      if (SYSTEM_OVERRIDE_PATTERNS.some((p) => p.test(text)) || ZERO_WIDTH_RE.test(text) || UNICODE_TAG_RE.test(text)) {
        out.push({ channel, file: path, excerpt: truncate(text), severity: 'high' });
      }
    }
  }
  return out;
}

function scanZeroWidthAndTags(content: string, path: string): L2Finding[] {
  const out: L2Finding[] = [];
  if (ZERO_WIDTH_RE.test(content) || UNICODE_TAG_RE.test(content)) {
    const idx = content.search(ZERO_WIDTH_RE) >= 0 ? content.search(ZERO_WIDTH_RE) : content.search(UNICODE_TAG_RE);
    out.push({
      channel: 'zero_width_unicode_tag',
      file: path,
      excerpt: truncate(content.slice(Math.max(0, idx - 40), idx + 40)),
      severity: 'high',
    });
  }
  return out;
}

function scanBase64Blobs(content: string, path: string): L2Finding[] {
  const out: L2Finding[] = [];
  for (const m of content.matchAll(BASE64_BLOB_RE)) {
    const blob = m[0];
    let decoded = '';
    try {
      decoded = Buffer.from(blob, 'base64').toString('utf-8');
      // eslint-disable-next-line no-empty
    } catch {}
    const suspicious = decoded && SYSTEM_OVERRIDE_PATTERNS.some((re) => re.test(decoded));
    out.push({
      channel: 'base64_blob',
      file: path,
      excerpt: truncate(suspicious ? decoded : blob, 100),
      severity: suspicious ? 'high' : 'low',
    });
  }
  return out;
}

/**
 * Split-payload heuristic: an injection phrase absent from every individual
 * file but present when a file's tail is concatenated with another file's
 * head (fileA→fileB assembly). Best-effort — real split-payload schemes can
 * be arbitrarily creative; this catches the straightforward tail+head case.
 */
export function detectSplitPayload(files: Array<{ path: string; content: string }>): L2Finding[] {
  const out: L2Finding[] = [];
  const WINDOW = 60;
  for (let i = 0; i < files.length; i++) {
    for (let j = 0; j < files.length; j++) {
      if (i === j) continue;
      const tail = files[i].content.slice(-WINDOW);
      const head = files[j].content.slice(0, WINDOW);
      const joined = tail + head;
      for (const re of SYSTEM_OVERRIDE_PATTERNS) {
        const m = joined.match(re);
        if (m && !re.test(files[i].content) && !re.test(files[j].content)) {
          out.push({
            channel: 'split_payload',
            file: `${files[i].path} → ${files[j].path}`,
            excerpt: truncate(m[0]),
            severity: 'high',
          });
        }
      }
    }
  }
  return out;
}

export async function runL2(
  owner: string,
  repo: string,
  ref: string,
  fetchImpl: typeof fetch,
  maxFiles: number,
  maxFileBytes: number,
  token: string | undefined,
): Promise<RepoScanResult['l2']> {
  const entries = await fetchTree(owner, repo, ref, fetchImpl, token);
  const selected = selectFilesToScan(entries, maxFiles);
  const findings: L2Finding[] = [];
  const fetched: Array<{ path: string; content: string }> = [];

  for (const entry of selected) {
    const content = await fetchRawFile(owner, repo, ref, entry.path, fetchImpl, maxFileBytes);
    if (content === null) continue;
    fetched.push({ path: entry.path, content });
    findings.push(
      ...scanSystemOverride(content, entry.path),
      ...scanHtmlComments(content, entry.path),
      ...scanAltAndTitles(content, entry.path),
      ...scanZeroWidthAndTags(content, entry.path),
      ...scanBase64Blobs(content, entry.path),
    );
  }
  findings.push(...detectSplitPayload(fetched));

  return {
    status: findings.length > 0 ? 'flagged' : 'clean',
    findings,
    files_scanned: fetched.length,
    files_skipped: Math.max(0, entries.filter((e) => TEXT_EXTENSIONS.has(fileExt(e.path))).length - fetched.length),
  };
}

// ---------------------------------------------------------------------------
// L4 — scoped verdict badge
// ---------------------------------------------------------------------------

export const SCOPE_DISCLAIMER =
  'RAI repo scan is a signal layer, not a firewall. A clean verdict means known static hidden-channel ' +
  'patterns were not found and basic provenance checks did not fail — it is not a safety guarantee, and ' +
  'it does not cover L3 (code/supply-chain, deps/postinstall/network calls) or image-OCR (OL-431).';

function buildBadge(l1Status: RepoL1Status, l2Status: L2Status, clearedFor: ClearedFor): string {
  const residual = ['L3 code/supply-chain (not run)', 'image-OCR (out of scope, OL-431)'];
  return `scanned {L1,L2}, cleared for {${clearedFor ?? 'nothing'}}, authenticity {${l1Status}}, residual {${residual.join('; ')}}`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function scanRepo(url: string, options: RepoScanOptions = {}): Promise<RepoScanResult> {
  const { owner, repo } = parseRepoUrl(url);
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxFiles = options.maxFiles ?? 40;
  const maxFileBytes = options.maxFileBytes ?? 200_000;
  const token = options.githubToken ?? process.env.GITHUB_TOKEN;

  const l1 = await runL1(owner, repo, fetchImpl, token);
  const ref = l1.repo?.default_branch ?? 'HEAD';
  const l2 = await runL2(owner, repo, ref, fetchImpl, maxFiles, maxFileBytes, token);

  // Artifact digest: the default-branch ref resolved at scan time. Cheap
  // freshness check for the mutable-artifact case (WS-rai.md addendum [cd:2026-08-09]) —
  // a re-scan comparing digests tells the caller the target moved since this verdict.
  const artifactDigest = l1.repo ? `${owner}/${repo}@${ref}` : null;

  // Clearance requires a genuinely clean read on both ladders: any L1 finding
  // (even low-severity) or any L2 hit withholds 'read', per WS-rai.md scope-lock
  // (never imply safety from a partial pass).
  const clearedFor: ClearedFor = l1.status === 'pass' && l2.status === 'clean' ? 'read' : null;

  return {
    scan_id: options.scanId ?? crypto.randomUUID(),
    timestamp: options.timestamp ?? new Date().toISOString(),
    target: `https://github.com/${owner}/${repo}`,
    artifact_digest: artifactDigest,
    l1,
    l2,
    cleared_for: clearedFor,
    scope_disclaimer: SCOPE_DISCLAIMER,
    badge: buildBadge(l1.status, l2.status, clearedFor),
  };
}
