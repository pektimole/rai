/**
 * l1-registry.ts — In-memory active L1 manifest with atomic hot-swap (OL-300)
 *
 * The registry is the ENFORCEMENT zone: it holds only the public key and is
 * verify-only. It never signs. This mirrors the capability-separation
 * primitive (docs/28-rai-actiongate-spec.md): the component that decides what
 * is active holds no secret that could forge a new active set.
 *
 * Promotion is atomic and gated:
 *   1. signature verifies against the trusted public key,
 *   2. generation strictly increases (monotonic),
 *   3. prev_hash chains to the currently-active manifest (compare-and-swap),
 *   4. the manifest id is not tombstoned,
 *   5. every pattern compiles.
 * If any check fails, the previous manifest stays active (fail-closed swap).
 *
 * Spec: docs/33-rai-l1-hotreload-spec.md (activation safety).
 */

import * as crypto from 'crypto';
import {
  type L1Manifest,
  manifestId,
  verifyManifest,
  compileManifest,
} from './l1-manifest.js';
import type { P0Pattern } from './rai-scan-p0.js';

export class PromotionError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'bad_signature'
      | 'non_monotonic'
      | 'chain_mismatch'
      | 'tombstoned'
      | 'compile_failed',
  ) {
    super(message);
    this.name = 'PromotionError';
  }
}

interface ActiveState {
  manifest: L1Manifest;
  id: string;
  compiled: P0Pattern[];
}

export class L1Registry {
  private active: ActiveState | null = null;
  private readonly accepted = new Map<string, L1Manifest>(); // id -> manifest
  private readonly tombstones = new Set<string>(); // dead manifest ids

  constructor(private readonly publicKey: crypto.KeyObject) {}

  /** Validate and atomically swap in a new manifest. Throws PromotionError on
   *  any failure, leaving the previous manifest active. */
  promote(m: L1Manifest): void {
    if (!verifyManifest(m, this.publicKey)) {
      throw new PromotionError('signature does not verify', 'bad_signature');
    }

    const id = manifestId(m);
    if (this.tombstones.has(id)) {
      throw new PromotionError(`manifest ${id} is tombstoned`, 'tombstoned');
    }

    if (this.active === null) {
      if (m.prev_hash !== null) {
        throw new PromotionError('first manifest must have prev_hash null', 'chain_mismatch');
      }
    } else {
      if (m.generation <= this.active.manifest.generation) {
        throw new PromotionError(
          `generation ${m.generation} not greater than active ${this.active.manifest.generation}`,
          'non_monotonic',
        );
      }
      if (m.prev_hash !== this.active.id) {
        throw new PromotionError(
          `prev_hash ${m.prev_hash} does not chain to active ${this.active.id}`,
          'chain_mismatch',
        );
      }
    }

    // Compile last: an invalid regex must reject the whole manifest.
    let compiled: P0Pattern[];
    try {
      compiled = compileManifest(m);
    } catch (e) {
      throw new PromotionError(`pattern compile failed: ${(e as Error).message}`, 'compile_failed');
    }

    // Atomic swap — only reached if every check passed.
    this.active = { manifest: m, id, compiled };
    this.accepted.set(id, m);
  }

  /** Patterns the scanner should apply, on top of its static floor. Empty when
   *  no manifest has been promoted. */
  getActivePatterns(): P0Pattern[] {
    return this.active ? this.active.compiled : [];
  }

  getActive(): L1Manifest | null {
    return this.active ? this.active.manifest : null;
  }

  getActiveId(): string | null {
    return this.active ? this.active.id : null;
  }

  getGeneration(): number {
    return this.active ? this.active.manifest.generation : 0;
  }

  /** Mark a manifest id operationally dead. A tombstoned id can never be
   *  promoted again, even by replaying its signed envelope. */
  tombstone(id: string): void {
    this.tombstones.add(id);
  }

  isTombstoned(id: string): boolean {
    return this.tombstones.has(id);
  }
}
