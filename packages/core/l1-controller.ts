/**
 * l1-controller.ts — Wires the L1 hot-reload pieces into one runtime (OL-300)
 *
 * Binds: L1Store (privileged, signs) + L1Registry (enforcement, verifies) +
 * the scanner's dynamic-pattern hook. A mutation (add/remove/rollback) mints a
 * new signed manifest, promotes it through the registry (which re-verifies),
 * and pushes the freshly compiled pattern set into the scanner — live, no
 * restart. The watcher path calls reloadFromDisk() with the same guarantees,
 * so an out-of-band edit to the store is picked up identically.
 *
 * Spec: docs/33-rai-l1-hotreload-spec.md.
 */

import { L1Store, watchManifestStore, type WatchHandle } from './l1-store.js';
import { L1Registry } from './l1-registry.js';
import { type L1Manifest, type ManifestPattern, type KeyPair } from './l1-manifest.js';
import { setDynamicPatterns } from './rai-scan-p0.js';

export interface L1Status {
  generation: number;
  manifest_id: string | null;
  pattern_count: number;
}

export class L1Controller {
  private constructor(
    private readonly store: L1Store,
    private readonly registry: L1Registry,
  ) {}

  /** Initialize the store (generation 1 from `seed` if empty), promote the
   *  active manifest, and wire the scanner. Fail-closed: a bad active manifest
   *  throws here rather than starting with no policy. */
  static create(dir: string, keys: KeyPair, seed: ManifestPattern[] = []): L1Controller {
    const store = new L1Store(dir, keys);
    const registry = new L1Registry(keys.publicKey);
    store.init(seed);
    const ctrl = new L1Controller(store, registry);
    ctrl.promoteActive();
    return ctrl;
  }

  private promoteActive(): void {
    const active = this.store.readActive();
    if (!active) return;
    this.registry.promote(active);
    setDynamicPatterns(this.registry.getActivePatterns());
  }

  addRule(rule: ManifestPattern): L1Status {
    const next = this.store.appendRule(rule);
    return this.activate(next);
  }

  removeRule(ruleId: string): L1Status {
    const next = this.store.removeRule(ruleId);
    return this.activate(next);
  }

  rollback(targetGeneration: number): L1Status {
    const next = this.store.rollbackTo(targetGeneration);
    return this.activate(next);
  }

  /** Re-read the active manifest from disk and promote it (watcher path). */
  reloadFromDisk(): L1Status {
    const active = this.store.readActive();
    if (active) this.activate(active);
    return this.status();
  }

  /** Attach a watcher so out-of-band store edits hot-reload automatically. */
  watch(): WatchHandle {
    return watchManifestStore(this.store.directory, (m) => {
      try {
        this.activate(m);
      } catch {
        // Promotion rejected (bad sig / chain / tombstone): keep current.
      }
    });
  }

  private activate(m: L1Manifest): L1Status {
    this.registry.promote(m); // re-verifies signature + chain + tombstone
    setDynamicPatterns(this.registry.getActivePatterns());
    return this.status();
  }

  status(): L1Status {
    return {
      generation: this.registry.getGeneration(),
      manifest_id: this.registry.getActiveId(),
      pattern_count: this.registry.getActivePatterns().length,
    };
  }
}
