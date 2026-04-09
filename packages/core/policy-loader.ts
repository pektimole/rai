/**
 * policy-loader.ts — YAML policy loader for RAI ActionGate
 *
 * Reads a YAML policy file and resolves it into a typed FsGitPolicy
 * for a given source group. If the group is not listed, returns null
 * (which the caller treats as deny — fail-closed by default).
 *
 * Schema: see docs/28-rai-actiongate-spec.md § Policy file format
 */

import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { type FsGitPolicy, type SourceGroup } from './action-gate';

// ---------------------------------------------------------------------------
// YAML schema types (what the file looks like on disk)
// ---------------------------------------------------------------------------

export interface FsGitGroupYaml {
  allowed_subdirs?: string[];
  allowed_extensions?: string[];
  blocked_basenames?: string[];
  max_content_bytes?: number;
  max_depth?: number;
}

export interface FsGitPolicyYaml {
  version: number;
  adapter: 'fs-git';
  root: string;
  defaults?: FsGitGroupYaml;
  groups: Record<string, FsGitGroupYaml>;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Parse a YAML string into an FsGitPolicy for the given source group.
 * Returns null if the group is not in the policy (= deny).
 * Throws on malformed YAML or missing required fields.
 */
export function loadFsGitPolicy(
  yamlString: string,
  sourceGroup: SourceGroup,
): FsGitPolicy | null {
  const doc = yaml.load(yamlString) as FsGitPolicyYaml;

  if (!doc || typeof doc !== 'object') {
    throw new Error('policy YAML is empty or not an object');
  }
  if (doc.version !== 1) {
    throw new Error(`unsupported policy version: ${doc.version}`);
  }
  if (doc.adapter !== 'fs-git') {
    throw new Error(`expected adapter "fs-git", got "${doc.adapter}"`);
  }
  if (!doc.root) {
    throw new Error('policy missing required field "root"');
  }
  if (!doc.groups || typeof doc.groups !== 'object') {
    throw new Error('policy missing required field "groups"');
  }

  const groupConfig = doc.groups[sourceGroup];
  if (!groupConfig) {
    return null; // group not in policy = deny
  }

  const defaults = doc.defaults ?? {};
  const merged = { ...defaults, ...groupConfig };

  // Collect all group names as allowed source groups
  const allowedSourceGroups = new Set(Object.keys(doc.groups));

  return {
    root: doc.root,
    allowedSourceGroups,
    allowedSubdirs: new Set(merged.allowed_subdirs ?? []),
    allowedExtensions: new Set(merged.allowed_extensions ?? []),
    blockedBasenames: new Set(merged.blocked_basenames ?? []),
    maxContentBytes: merged.max_content_bytes ?? 50_000,
    maxDepth: merged.max_depth ?? 2,
  };
}

/**
 * Load a policy from a YAML file on disk.
 * Returns null if the group is not in the policy.
 * Throws on read error or malformed YAML.
 */
export function loadFsGitPolicyFile(
  filePath: string,
  sourceGroup: SourceGroup,
): FsGitPolicy | null {
  const content = fs.readFileSync(filePath, 'utf-8');
  return loadFsGitPolicy(content, sourceGroup);
}
