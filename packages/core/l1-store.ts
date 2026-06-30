/**
 * l1-store.ts — Disk persistence + signing + watcher for L1 manifests (OL-300)
 *
 * The store is the PRIVILEGED zone: it is the only component that holds the
 * signing key. It mints new signed manifests (append a rule, remove a rule,
 * roll back) and persists them content-addressed by generation. The runtime
 * watches the store directory and re-loads on change. The watcher itself never
 * signs and never trusts a file's mere presence — every loaded manifest is
 * verified by the registry before it can go live.
 *
 * Storage layout (one immutable file per accepted generation):
 *   <dir>/manifest-<generation>.json
 * The active manifest is simply the highest generation present. Writes are
 * atomic (write temp + rename).
 *
 * Spec: docs/33-rai-l1-hotreload-spec.md (signed active manifest, fsnotify
 * reload, two-phase promote, rollback).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  type L1Manifest,
  type ManifestPattern,
  type KeyPair,
  manifestId,
  signManifest,
  generateKeyPair,
} from './l1-manifest.js';

const FILE_RE = /^manifest-(\d+)\.json$/;

export class L1Store {
  constructor(
    private readonly dir: string,
    private readonly keys: KeyPair,
  ) {
    fs.mkdirSync(dir, { recursive: true });
  }

  /** The store directory (for wiring a watcher). */
  get directory(): string {
    return this.dir;
  }

  // -- read -----------------------------------------------------------------

  /** All accepted manifests on disk, ascending by generation. */
  listManifests(): L1Manifest[] {
    if (!fs.existsSync(this.dir)) return [];
    const gens = fs
      .readdirSync(this.dir)
      .map((f) => FILE_RE.exec(f))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => parseInt(m[1], 10))
      .sort((a, b) => a - b);
    return gens.map((g) => this.readGeneration(g));
  }

  readGeneration(generation: number): L1Manifest {
    const raw = fs.readFileSync(this.filePath(generation), 'utf-8');
    return JSON.parse(raw) as L1Manifest;
  }

  /** Highest-generation manifest, or null if the store is empty. */
  readActive(): L1Manifest | null {
    const all = this.listManifests();
    return all.length ? all[all.length - 1] : null;
  }

  currentGeneration(): number {
    const active = this.readActive();
    return active ? active.generation : 0;
  }

  // -- write ----------------------------------------------------------------

  /** Initialize generation 1 from a seed pattern set, or return the existing
   *  active manifest if the store is already populated. */
  init(seed: ManifestPattern[] = []): L1Manifest {
    const existing = this.readActive();
    if (existing) return existing;
    const m = this.build(seed, 1, null);
    this.write(m);
    return m;
  }

  /** Append one rule, producing the next generation. */
  appendRule(rule: ManifestPattern): L1Manifest {
    const active = this.requireActive();
    if (active.patterns.some((p) => p.id === rule.id)) {
      throw new Error(`rule id "${rule.id}" already present in generation ${active.generation}`);
    }
    const next = this.build(
      [...active.patterns, rule],
      active.generation + 1,
      manifestId(active),
    );
    this.write(next);
    return next;
  }

  /** Remove one rule by id, producing the next generation. */
  removeRule(ruleId: string): L1Manifest {
    const active = this.requireActive();
    const patterns = active.patterns.filter((p) => p.id !== ruleId);
    if (patterns.length === active.patterns.length) {
      throw new Error(`rule id "${ruleId}" not found in generation ${active.generation}`);
    }
    const next = this.build(patterns, active.generation + 1, manifestId(active));
    this.write(next);
    return next;
  }

  /** Roll back to a prior generation's pattern set. Implemented forward: a new
   *  generation is minted carrying the target's patterns, so the chain stays
   *  monotonic and append-only (no history is rewritten). */
  rollbackTo(targetGeneration: number): L1Manifest {
    const active = this.requireActive();
    const target = this.listManifests().find((m) => m.generation === targetGeneration);
    if (!target) throw new Error(`generation ${targetGeneration} not found`);
    const next = this.build(
      target.patterns,
      active.generation + 1,
      manifestId(active),
    );
    this.write(next);
    return next;
  }

  // -- internals ------------------------------------------------------------

  private requireActive(): L1Manifest {
    const active = this.readActive();
    if (!active) throw new Error('store is empty; call init() first');
    return active;
  }

  private build(patterns: ManifestPattern[], generation: number, prevHash: string | null): L1Manifest {
    const m: L1Manifest = {
      kind: 'rai_l1_manifest',
      schema_version: 1,
      generation,
      prev_hash: prevHash,
      created_at: new Date().toISOString(),
      key_fingerprint: '',
      patterns,
      signature: '',
    };
    return signManifest(m, this.keys);
  }

  private write(m: L1Manifest): void {
    const target = this.filePath(m.generation);
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf-8');
    fs.renameSync(tmp, target); // atomic on same filesystem
  }

  private filePath(generation: number): string {
    return path.join(this.dir, `manifest-${generation}.json`);
  }
}

// ---------------------------------------------------------------------------
// Key material (lives OUTSIDE the manifest dir — capability separation)
// ---------------------------------------------------------------------------

/** Load an ed25519 keypair from a PEM file, creating one if absent. */
export function loadOrCreateKeyPair(keyPath: string): KeyPair {
  if (fs.existsSync(keyPath)) {
    const pem = fs.readFileSync(keyPath, 'utf-8');
    const privateKey = crypto.createPrivateKey(pem);
    const publicKey = crypto.createPublicKey(privateKey);
    return { publicKey, privateKey };
  }
  const keys = generateKeyPair();
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  const pem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  fs.writeFileSync(keyPath, pem, { mode: 0o600 });
  return keys;
}

// ---------------------------------------------------------------------------
// Watcher (fsnotify reload)
// ---------------------------------------------------------------------------

export interface WatchHandle {
  close(): void;
}

export interface WatchOptions {
  debounceMs?: number; // settle window after the last change (default 100)
  maxDebounceMs?: number; // hard cap so a busy store still reloads (default 2000)
}

/**
 * Watch a manifest store directory. On any change, after the debounce settles,
 * read the active (highest-generation) manifest and hand it to `onManifest`.
 * The callback is where verification + promotion happens; the watcher itself
 * makes no trust decision.
 *
 * Fail-closed initial load is the CALLER's job: load + promote once explicitly
 * at startup and let a bad manifest throw, rather than starting with no policy.
 */
export function watchManifestStore(
  dir: string,
  onManifest: (m: L1Manifest) => void,
  opts: WatchOptions = {},
): WatchHandle {
  const debounceMs = opts.debounceMs ?? 100;
  const maxDebounceMs = opts.maxDebounceMs ?? 2000;

  let settleTimer: NodeJS.Timeout | null = null;
  let capTimer: NodeJS.Timeout | null = null;

  const fire = () => {
    if (settleTimer) clearTimeout(settleTimer);
    if (capTimer) clearTimeout(capTimer);
    settleTimer = null;
    capTimer = null;
    try {
      const store = new L1StoreReader(dir);
      const active = store.readActive();
      if (active) onManifest(active);
    } catch {
      // Unreadable mid-write: keep the previous active manifest (fail-closed).
    }
  };

  const onChange = () => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(fire, debounceMs);
    if (!capTimer) capTimer = setTimeout(fire, maxDebounceMs);
  };

  const watcher = fs.watch(dir, { persistent: false }, onChange);

  return {
    close() {
      if (settleTimer) clearTimeout(settleTimer);
      if (capTimer) clearTimeout(capTimer);
      watcher.close();
    },
  };
}

/** Read-only view of a store dir (no key, used by the watcher). */
class L1StoreReader {
  constructor(private readonly dir: string) {}
  readActive(): L1Manifest | null {
    if (!fs.existsSync(this.dir)) return null;
    const gens = fs
      .readdirSync(this.dir)
      .map((f) => FILE_RE.exec(f))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => parseInt(m[1], 10))
      .sort((a, b) => a - b);
    if (!gens.length) return null;
    const raw = fs.readFileSync(path.join(this.dir, `manifest-${gens[gens.length - 1]}.json`), 'utf-8');
    return JSON.parse(raw) as L1Manifest;
  }
}
