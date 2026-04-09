/**
 * policy-loader.test.ts — YAML policy loader tests
 */

import { describe, it, expect } from 'vitest';
import { loadFsGitPolicy } from './policy-loader';

const VALID_YAML = `
version: 1
adapter: fs-git
root: /home/tim/no5-context
defaults:
  max_content_bytes: 50000
  max_depth: 2
  allowed_extensions: [.md]
groups:
  whatsapp_main:
    allowed_subdirs: [proposals, pending-decisions, spikes]
    blocked_basenames: [00-WAKE.md, 00-README.md, REGISTRY.md]
  telegram_main:
    allowed_subdirs: [proposals]
    blocked_basenames: [00-WAKE.md, REGISTRY.md]
    max_content_bytes: 10000
`;

describe('loadFsGitPolicy', () => {
  describe('happy path', () => {
    it('loads a policy for whatsapp_main', () => {
      const p = loadFsGitPolicy(VALID_YAML, 'whatsapp_main');
      expect(p).not.toBeNull();
      expect(p!.root).toBe('/home/tim/no5-context');
      expect(p!.allowedSourceGroups).toEqual(
        new Set(['whatsapp_main', 'telegram_main']),
      );
      expect(p!.allowedSubdirs).toEqual(
        new Set(['proposals', 'pending-decisions', 'spikes']),
      );
      expect(p!.allowedExtensions).toEqual(new Set(['.md']));
      expect(p!.blockedBasenames).toEqual(
        new Set(['00-WAKE.md', '00-README.md', 'REGISTRY.md']),
      );
      expect(p!.maxContentBytes).toBe(50_000);
      expect(p!.maxDepth).toBe(2);
    });

    it('loads telegram_main with group-level override', () => {
      const p = loadFsGitPolicy(VALID_YAML, 'telegram_main');
      expect(p).not.toBeNull();
      // Group override: max_content_bytes = 10000
      expect(p!.maxContentBytes).toBe(10_000);
      // Group override: only proposals
      expect(p!.allowedSubdirs).toEqual(new Set(['proposals']));
      // Inherited from defaults
      expect(p!.allowedExtensions).toEqual(new Set(['.md']));
      expect(p!.maxDepth).toBe(2);
    });
  });

  describe('group not found', () => {
    it('returns null for unknown source group', () => {
      const p = loadFsGitPolicy(VALID_YAML, 'browser');
      expect(p).toBeNull();
    });
  });

  describe('defaults inheritance', () => {
    it('uses defaults when group omits fields', () => {
      const yaml = `
version: 1
adapter: fs-git
root: /tmp/test
defaults:
  allowed_extensions: [.md, .txt]
  max_content_bytes: 25000
  max_depth: 3
groups:
  test_group:
    allowed_subdirs: [drafts]
`;
      const p = loadFsGitPolicy(yaml, 'test_group');
      expect(p).not.toBeNull();
      expect(p!.allowedExtensions).toEqual(new Set(['.md', '.txt']));
      expect(p!.maxContentBytes).toBe(25_000);
      expect(p!.maxDepth).toBe(3);
      expect(p!.allowedSubdirs).toEqual(new Set(['drafts']));
    });

    it('works with no defaults section', () => {
      const yaml = `
version: 1
adapter: fs-git
root: /tmp/test
groups:
  minimal:
    allowed_subdirs: [inbox]
    allowed_extensions: [.md]
    blocked_basenames: []
`;
      const p = loadFsGitPolicy(yaml, 'minimal');
      expect(p).not.toBeNull();
      expect(p!.maxContentBytes).toBe(50_000); // hardcoded fallback
      expect(p!.maxDepth).toBe(2); // hardcoded fallback
      expect(p!.allowedSubdirs).toEqual(new Set(['inbox']));
    });
  });

  describe('validation errors', () => {
    it('throws on wrong version', () => {
      const yaml = `
version: 2
adapter: fs-git
root: /tmp
groups:
  x: {}
`;
      expect(() => loadFsGitPolicy(yaml, 'x')).toThrow('unsupported policy version');
    });

    it('throws on wrong adapter', () => {
      const yaml = `
version: 1
adapter: shell
root: /tmp
groups:
  x: {}
`;
      expect(() => loadFsGitPolicy(yaml, 'x')).toThrow('expected adapter "fs-git"');
    });

    it('throws on missing root', () => {
      const yaml = `
version: 1
adapter: fs-git
groups:
  x: {}
`;
      expect(() => loadFsGitPolicy(yaml, 'x')).toThrow('missing required field "root"');
    });

    it('throws on missing groups', () => {
      const yaml = `
version: 1
adapter: fs-git
root: /tmp
`;
      expect(() => loadFsGitPolicy(yaml, 'x')).toThrow('missing required field "groups"');
    });

    it('throws on empty YAML', () => {
      expect(() => loadFsGitPolicy('', 'x')).toThrow('empty or not an object');
    });
  });

  describe('integration with evaluate', () => {
    it('produces a policy that evaluate() accepts', async () => {
      const { evaluate } = await import('./action-gate');
      const p = loadFsGitPolicy(VALID_YAML, 'whatsapp_main')!;
      const v = evaluate(
        {
          kind: 'fs-git-write',
          file: 'proposals/test.md',
          content: '# test',
          commitMessage: 'test commit',
          sourceGroup: 'whatsapp_main',
        },
        p,
      );
      expect(v.decision).toBe('allow');
    });

    it('denies via YAML-loaded policy for blocked basename', async () => {
      const { evaluate } = await import('./action-gate');
      const p = loadFsGitPolicy(VALID_YAML, 'whatsapp_main')!;
      const v = evaluate(
        {
          kind: 'fs-git-write',
          file: 'REGISTRY.md',
          content: '# nope',
          commitMessage: 'sneaky',
          sourceGroup: 'whatsapp_main',
        },
        p,
      );
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('basename-blocked');
    });
  });
});
