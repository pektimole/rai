/**
 * private-layer.ts — RAI Network Architecture: Phase 1 Private Layer
 *
 * Manages the local threat-signature store for a single RAI instance (Tim's
 * NanoClaw). All data is local-only and never leaves the device in Phase 1.
 *
 * Storage: ~/.rai/private-layer/signatures.json
 * Test override: pass storePath to constructor.
 *
 * The store is an append-on-first-write, merge-on-update JSON file.
 * dream-phase.ts is the only writer; this class handles raw CRUD.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { ThreatSignature, ThreatSignatureStore } from './threat-signature.js';

const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// PrivateLayer
// ---------------------------------------------------------------------------

export class PrivateLayer {
  private storePath: string;
  private _store: ThreatSignatureStore | null = null;

  constructor(storePath?: string) {
    this.storePath = storePath ?? defaultStorePath();
  }

  // --- Internal ---

  private load(): ThreatSignatureStore {
    if (this._store) return this._store;
    if (fs.existsSync(this.storePath)) {
      this._store = JSON.parse(
        fs.readFileSync(this.storePath, 'utf-8'),
      ) as ThreatSignatureStore;
    } else {
      this._store = {
        schema_version: SCHEMA_VERSION,
        instance_id: randomUUID(),
        created: new Date().toISOString(),
        last_dream_phase: null,
        dream_phase_count: 0,
        signatures: [],
      };
    }
    return this._store;
  }

  private persist(): void {
    const dir = path.dirname(this.storePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      this.storePath,
      JSON.stringify(this._store, null, 2) + '\n',
    );
  }

  // --- Public API ---

  getAllSignatures(): ThreatSignature[] {
    return this.load().signatures;
  }

  getSignature(id: string): ThreatSignature | null {
    return this.load().signatures.find((s) => s.id === id) ?? null;
  }

  upsertSignature(sig: ThreatSignature): void {
    const store = this.load();
    const idx = store.signatures.findIndex((s) => s.id === sig.id);
    if (idx >= 0) {
      store.signatures[idx] = sig;
    } else {
      store.signatures.push(sig);
    }
    this.persist();
  }

  getLastDreamPhase(): string | null {
    return this.load().last_dream_phase;
  }

  /** Called by dream-phase after a successful run to stamp the timestamp. */
  recordDreamPhase(): void {
    const store = this.load();
    store.last_dream_phase = new Date().toISOString();
    store.dream_phase_count += 1;
    this.persist();
  }

  getInstanceId(): string {
    return this.load().instance_id;
  }

  summarize(): {
    total: number;
    by_layer: Record<string, number>;
    dream_phase_count: number;
  } {
    const store = this.load();
    const by_layer: Record<string, number> = {};
    for (const sig of store.signatures) {
      by_layer[sig.layer] = (by_layer[sig.layer] ?? 0) + 1;
    }
    return {
      total: store.signatures.length,
      by_layer,
      dream_phase_count: store.dream_phase_count,
    };
  }

  /** Wipe all signatures. Preserves instance_id and created timestamp. */
  clear(): void {
    const existing = this._store;
    this._store = {
      schema_version: SCHEMA_VERSION,
      instance_id: existing?.instance_id ?? randomUUID(),
      created: existing?.created ?? new Date().toISOString(),
      last_dream_phase: null,
      dream_phase_count: 0,
      signatures: [],
    };
    this.persist();
  }

  getStorePath(): string {
    return this.storePath;
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function defaultStorePath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return path.join(home, '.rai', 'private-layer', 'signatures.json');
}

let _default: PrivateLayer | null = null;

export function getDefaultPrivateLayer(): PrivateLayer {
  if (!_default) _default = new PrivateLayer();
  return _default;
}
