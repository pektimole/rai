/**
 * l1-manifest.ts — Signed, versioned L1 pattern manifest (OL-300)
 *
 * The L1 regex layer historically baked its patterns into source (see the
 * PATTERNS const in rai-scan-p0.ts). A new threat pattern meant a release
 * cycle. This module lifts patterns into a portable, signed, hash-chained
 * manifest so they can be hot-swapped at runtime with versioning + rollback.
 *
 * Spec: docs/33-rai-l1-hotreload-spec.md (Part A, activation safety).
 * Signing primitive shared with docs/32-rai-clinical-audit-spec.md:
 * Ed25519 PureEdDSA over a JCS-style canonicalization of the manifest with
 * the signature value zeroed. Fail-closed: an unverifiable manifest is never
 * promoted.
 */

import * as crypto from 'crypto';
import type { ThreatLayer, Severity, P0Pattern } from './rai-scan-p0.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A pattern as stored on disk (regex is a string, so it is serializable). */
export interface ManifestPattern {
  id: string; // stable rule id, unique within a manifest
  regex: string; // RegExp source
  flags: string; // RegExp flags, e.g. "i"
  label: string;
  layer: ThreatLayer;
  severity: Severity;
  signal: string; // human-readable description emitted on match
  state?: 'enforce' | 'capture_only'; // default enforce; capture_only never blocks
}

export interface L1Manifest {
  kind: 'rai_l1_manifest';
  schema_version: 1;
  generation: number; // monotonic; strictly increases across accepted manifests
  prev_hash: string | null; // manifestId of the prior accepted manifest (chain)
  created_at: string; // RFC3339
  key_fingerprint: string; // "sha256:" + sha256(raw 32-byte ed25519 pubkey)
  patterns: ManifestPattern[];
  signature: string; // base64 ed25519 over the signing preimage
}

// ---------------------------------------------------------------------------
// Canonicalization (simplified RFC 8785 / JCS)
// ---------------------------------------------------------------------------
//
// Sufficient for our controlled object: sorted keys, no floats with exotic
// representations, no surrogate-pair edge cases expected in pattern bodies.

export function canonicalize(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  const obj = v as Record<string, unknown>;
  // Skip undefined-valued keys so an object survives a JSON disk round-trip
  // with an identical canonical form (JSON.stringify drops them on write).
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

function sha256hex(s: string | Buffer): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** The bytes that get signed: the manifest with its signature value zeroed. */
export function signingPreimage(m: L1Manifest): string {
  return canonicalize({ ...m, signature: '' });
}

/** Content id of an accepted manifest (includes the signature). Used for the
 *  chain (prev_hash) and for tombstones. */
export function manifestId(m: L1Manifest): string {
  return sha256hex(canonicalize(m));
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export interface KeyPair {
  publicKey: crypto.KeyObject;
  privateKey: crypto.KeyObject;
}

export function generateKeyPair(): KeyPair {
  return crypto.generateKeyPairSync('ed25519');
}

/** "sha256:" + sha256 over the raw 32-byte ed25519 public key. */
export function keyFingerprint(publicKey: crypto.KeyObject): string {
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('not an ed25519 public key');
  const raw = Buffer.from(jwk.x, 'base64url');
  return 'sha256:' + sha256hex(raw);
}

// ---------------------------------------------------------------------------
// Sign / verify
// ---------------------------------------------------------------------------

/** Sign in place: stamps key_fingerprint + signature, returns the same object. */
export function signManifest(m: L1Manifest, keys: KeyPair): L1Manifest {
  m.key_fingerprint = keyFingerprint(keys.publicKey);
  const sig = crypto.sign(null, Buffer.from(signingPreimage(m), 'utf-8'), keys.privateKey);
  m.signature = sig.toString('base64');
  return m;
}

/** Fail-closed signature check. Returns false on any malformation. */
export function verifyManifest(m: L1Manifest, publicKey: crypto.KeyObject): boolean {
  try {
    if (m.kind !== 'rai_l1_manifest' || m.schema_version !== 1) return false;
    if (typeof m.signature !== 'string' || m.signature.length === 0) return false;
    if (m.key_fingerprint !== keyFingerprint(publicKey)) return false;
    const sig = Buffer.from(m.signature, 'base64');
    return crypto.verify(null, Buffer.from(signingPreimage(m), 'utf-8'), publicKey, sig);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

/** Compile manifest patterns into the runtime P0Pattern shape the scanner
 *  consumes. capture_only patterns are excluded (they observe, never block).
 *  Throws on an invalid regex — the caller must treat that as fail-closed and
 *  reject the whole manifest rather than promote a partial set. */
export function compileManifest(m: L1Manifest): P0Pattern[] {
  const out: P0Pattern[] = [];
  for (const p of m.patterns) {
    if (p.state === 'capture_only') continue;
    out.push({
      regex: new RegExp(p.regex, p.flags),
      label: p.label,
      layer: p.layer,
      severity: p.severity,
      signal: p.signal,
    });
  }
  return out;
}
