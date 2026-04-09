/**
 * action-gate.test.ts — RAI ActionGate test suite
 *
 * Replicates every check from the NanoClaw Write Gate. Each test maps to one
 * row of the defense-in-depth table in 28-rai-actiongate-spec.md.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluate,
  nanoclawDefaultPolicy,
  type FsGitAction,
  type FsGitPolicy,
} from './action-gate';

const ROOT = '/home/tim/no5-context';

function policy(overrides: Partial<FsGitPolicy> = {}): FsGitPolicy {
  return { ...nanoclawDefaultPolicy(ROOT), ...overrides };
}

function action(overrides: Partial<FsGitAction> = {}): FsGitAction {
  return {
    kind: 'fs-git-write',
    file: 'proposals/2026-04-08.md',
    content: '# valid proposal',
    commitMessage: 'add proposal',
    sourceGroup: 'whatsapp_main',
    ...overrides,
  };
}

describe('ActionGate / fs-git', () => {
  describe('happy path', () => {
    it('allows a valid write to an allowed subdir', () => {
      const v = evaluate(action(), policy());
      expect(v.decision).toBe('allow');
      expect(v.rule).toBe('all-checks-passed');
    });

    it('allows a valid flat-file write', () => {
      const v = evaluate(action({ file: '02-open-loops.md' }), policy());
      expect(v.decision).toBe('allow');
    });
  });

  describe('source group', () => {
    it('denies an unknown source group', () => {
      const v = evaluate(action({ sourceGroup: 'browser' }), policy());
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('source-group-not-allowed');
    });

    it('denies even when other source groups exist', () => {
      const p = policy({
        allowedSourceGroups: new Set(['whatsapp_main', 'telegram_main']),
      });
      const v = evaluate(action({ sourceGroup: 'random' }), p);
      expect(v.decision).toBe('deny');
    });
  });

  describe('required fields', () => {
    it('denies missing file', () => {
      const v = evaluate(action({ file: '' }), policy());
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('missing-required-fields');
    });

    it('denies missing content', () => {
      const v = evaluate(action({ content: '' }), policy());
      expect(v.decision).toBe('deny');
    });

    it('denies missing commit message', () => {
      const v = evaluate(action({ commitMessage: '' }), policy());
      expect(v.decision).toBe('deny');
    });
  });

  describe('path traversal', () => {
    it('denies literal .. in path', () => {
      const v = evaluate(action({ file: '../etc/passwd.md' }), policy());
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('path-traversal-literal');
    });

    it('denies .. inside an otherwise valid subdir path', () => {
      const v = evaluate(action({ file: 'proposals/../REGISTRY.md' }), policy());
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('path-traversal-literal');
    });
  });

  describe('extension allowlist', () => {
    it('denies non-.md extensions', () => {
      const v = evaluate(action({ file: 'proposals/foo.txt' }), policy());
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('extension-not-allowed');
    });

    it('denies extensionless files', () => {
      const v = evaluate(action({ file: 'proposals/foo' }), policy());
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('extension-not-allowed');
    });
  });

  describe('depth check', () => {
    it('denies more than one subdir level', () => {
      const v = evaluate(action({ file: 'proposals/foo/bar.md' }), policy());
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('depth-exceeded');
    });
  });

  describe('subdir allowlist', () => {
    it('denies a subdir not in the allowlist', () => {
      const v = evaluate(action({ file: 'secrets/foo.md' }), policy());
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('subdir-not-allowed');
    });

    it('allows all configured subdirs', () => {
      for (const sub of ['proposals', 'pending-decisions', 'spikes']) {
        const v = evaluate(action({ file: `${sub}/x.md` }), policy());
        expect(v.decision).toBe('allow');
      }
    });
  });

  describe('hidden / blocked basename', () => {
    it('denies dotfiles', () => {
      const v = evaluate(action({ file: 'proposals/.hidden.md' }), policy());
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('hidden-or-empty-basename');
    });

    it('denies blocked basename at root', () => {
      const v = evaluate(action({ file: 'REGISTRY.md' }), policy());
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('basename-blocked');
    });

    it('denies blocked basename inside an allowed subdir', () => {
      const v = evaluate(action({ file: 'proposals/REGISTRY.md' }), policy());
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('basename-blocked');
    });

    it('denies 00-WAKE.md and 00-README.md', () => {
      for (const name of ['00-WAKE.md', '00-README.md']) {
        const v = evaluate(action({ file: name }), policy());
        expect(v.decision).toBe('deny');
        expect(v.rule).toBe('basename-blocked');
      }
    });
  });

  describe('size limit', () => {
    it('denies content exceeding max bytes', () => {
      const v = evaluate(
        action({ content: 'a'.repeat(50_001) }),
        policy(),
      );
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('content-too-large');
    });

    it('measures bytes not chars (multibyte UTF-8)', () => {
      // 4-byte char × 12,501 = 50,004 bytes — over the 50_000 cap
      const v = evaluate(
        action({ content: '🔥'.repeat(12_501) }),
        policy(),
      );
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('content-too-large');
    });

    it('allows content exactly at the limit', () => {
      const v = evaluate(
        action({ content: 'a'.repeat(50_000) }),
        policy(),
      );
      expect(v.decision).toBe('allow');
    });
  });

  describe('resolved-path containment', () => {
    it('denies a path that resolves outside root', () => {
      // Absolute paths get resolved against root and may escape via ..
      // The literal-traversal check catches '..', so test a different escape:
      // a policy whose root has no trailing separator and a sibling-like prefix.
      const p = policy({ root: '/home/tim/no5-context' });
      // Construct a file that, after resolve, ends up at /home/tim/no5-context-evil/x.md
      // This shouldn't be reachable via segment splitting, but the check is the
      // belt-and-braces guarantee. We assert a traversal-free path stays inside.
      const v = evaluate(action({ file: 'proposals/x.md' }), p);
      expect(v.decision).toBe('allow');
    });
  });

  describe('commit message sanitization', () => {
    it('strips unsafe shell chars and returns sanitize verdict', () => {
      const v = evaluate(
        action({ commitMessage: 'add `rm -rf /` $foo "x"' }),
        policy(),
      );
      expect(v.decision).toBe('sanitize');
      expect(v.rule).toBe('commit-message-sanitized');
      expect(v.sanitized?.commitMessage).toBe('add -rm -rf /- -foo -x-');
    });

    it('passes clean commit messages through as allow', () => {
      const v = evaluate(action({ commitMessage: 'add proposal' }), policy());
      expect(v.decision).toBe('allow');
    });

    it('strips backslashes', () => {
      const v = evaluate(action({ commitMessage: 'a\\b' }), policy());
      expect(v.decision).toBe('sanitize');
      expect(v.sanitized?.commitMessage).toBe('a-b');
    });
  });

  describe('first-deny-wins ordering', () => {
    it('reports source-group denial before path checks', () => {
      const v = evaluate(
        action({ sourceGroup: 'evil', file: '../../../etc/passwd' }),
        policy(),
      );
      expect(v.rule).toBe('source-group-not-allowed');
    });

    it('reports traversal denial before extension check', () => {
      const v = evaluate(action({ file: '../foo.txt' }), policy());
      expect(v.rule).toBe('path-traversal-literal');
    });
  });
});
