/**
 * l1-store.test.ts — persistence, watcher, and the end-to-end hot-reload path
 * proving a newly injected rule reaches the live scanner without a restart,
 * and a rollback removes it (OL-300 acceptance criteria).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { L1Store, watchManifestStore, loadOrCreateKeyPair } from './l1-store.js';
import { L1Controller } from './l1-controller.js';
import { generateKeyPair, manifestId, type KeyPair, type ManifestPattern } from './l1-manifest.js';
import { rayScan, setDynamicPatterns, type RayScanInput } from './rai-scan-p0.js';

const RULE: ManifestPattern = {
  id: 'r1',
  regex: 'evilcorp',
  flags: 'i',
  label: 'Test exfil host',
  layer: 'L0',
  severity: 'high',
  signal: 'mentions EvilCorp',
};

let dir: string;
let keys: KeyPair;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l1-store-'));
  keys = generateKeyPair();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  setDynamicPatterns([]); // reset scanner global between tests
});

describe('L1Store', () => {
  it('initializes generation 1 and is idempotent', () => {
    const store = new L1Store(dir, keys);
    const g1 = store.init([RULE]);
    expect(g1.generation).toBe(1);
    expect(g1.prev_hash).toBeNull();
    expect(store.init([])).toEqual(g1); // already populated -> returns existing
  });

  it('appends a rule into the next generation, chained', () => {
    const store = new L1Store(dir, keys);
    const g1 = store.init([RULE]);
    const g2 = store.appendRule({ ...RULE, id: 'r2' });
    expect(g2.generation).toBe(2);
    expect(g2.prev_hash).toBe(manifestId(g1));
    expect(g2.patterns).toHaveLength(2);
  });

  it('rejects a duplicate rule id', () => {
    const store = new L1Store(dir, keys);
    store.init([RULE]);
    expect(() => store.appendRule(RULE)).toThrow(/already present/);
  });

  it('removes a rule into the next generation', () => {
    const store = new L1Store(dir, keys);
    store.init([RULE, { ...RULE, id: 'r2' }]);
    const g2 = store.removeRule('r2');
    expect(g2.patterns.map((p) => p.id)).toEqual(['r1']);
  });

  it('rolls back forward-only, carrying a prior pattern set', () => {
    const store = new L1Store(dir, keys);
    store.init([]); // gen1 empty
    store.appendRule(RULE); // gen2 has the rule
    const g3 = store.rollbackTo(1); // back to empty, as a new generation
    expect(g3.generation).toBe(3);
    expect(g3.patterns).toHaveLength(0);
    expect(store.listManifests().map((m) => m.generation)).toEqual([1, 2, 3]);
  });
});

describe('loadOrCreateKeyPair', () => {
  it('creates then reloads a stable key', () => {
    const keyPath = path.join(dir, 'keys', 'signing.pem');
    const k1 = loadOrCreateKeyPair(keyPath);
    const k2 = loadOrCreateKeyPair(keyPath);
    const fp = (k: KeyPair) =>
      (k.publicKey.export({ format: 'jwk' }) as { x?: string }).x;
    expect(fp(k1)).toBe(fp(k2));
  });
});

describe('watchManifestStore', () => {
  it('fires the callback with the new active manifest after a write', async () => {
    const store = new L1Store(dir, keys);
    store.init([]);

    const got = await new Promise<number>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('watcher timeout')), 3000);
      const handle = watchManifestStore(
        dir,
        (m) => {
          if (m.generation >= 2) {
            clearTimeout(to);
            handle.close();
            resolve(m.generation);
          }
        },
        { debounceMs: 20 },
      );
      setTimeout(() => store.appendRule(RULE), 50);
    });

    expect(got).toBeGreaterThanOrEqual(2);
  });
});

describe('L1Controller — live hot-reload into the scanner', () => {
  function forwardInput(content: string): RayScanInput {
    return {
      source: { channel: 'email', pipeline_stage: 'ingest', sender: 'attacker@x', is_forward: true },
      payload: { type: 'text', content },
      context: { session_id: 's1', host_environment: 'api' },
    };
  }

  it('injects a rule that the live scanner immediately enforces, then rolls back', async () => {
    const ctrl = L1Controller.create(dir, keys, []);
    expect(ctrl.status().pattern_count).toBe(0);

    // Before injection: clean (no static pattern matches "evilcorp").
    const before = await rayScan(forwardInput('please reach evilcorp tonight'));
    expect(before.raw_signals.join(' ')).not.toContain('EvilCorp');

    // Inject -> hot-swap -> scanner sees it on the very next scan, no restart.
    const status = ctrl.addRule(RULE);
    expect(status.generation).toBe(2);
    expect(status.pattern_count).toBe(1);

    const after = await rayScan(forwardInput('please reach evilcorp tonight'));
    expect(after.raw_signals.join(' ')).toContain('EvilCorp');

    // Rollback to the empty generation -> rule gone, scanner clean again.
    ctrl.rollback(1);
    const rolled = await rayScan(forwardInput('please reach evilcorp tonight'));
    expect(rolled.raw_signals.join(' ')).not.toContain('EvilCorp');
  });
});
