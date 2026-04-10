/**
 * audit-log.test.ts — Audit log tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuditLog, type AuditEntry } from './audit-log';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let tmpDir: string;
let log: AuditLog;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-audit-test-'));
  log = new AuditLog(tmpDir);
});

afterEach(() => {
  log.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('AuditLog', () => {
  describe('write + read', () => {
    it('writes and reads entries', () => {
      const entry: AuditEntry = {
        timestamp: '2026-04-09T12:00:00.000Z',
        audit_id: 'test-001',
        adapter: 'fs-git',
        decision: 'deny',
        rule: 'path-traversal-literal',
        reason: 'path contains ".." segment',
        action_summary: 'write proposals/../etc/passwd.md',
        source: 'whatsapp_main',
      };

      log.write(entry);
      log.close(); // flush

      const entries = log.readAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].audit_id).toBe('test-001');
      expect(entries[0].decision).toBe('deny');
      expect(entries[0].adapter).toBe('fs-git');
    });

    it('appends multiple entries', () => {
      log.log({
        adapter: 'shell',
        decision: 'allow',
        rule: 'all-checks-passed',
        reason: 'command permitted',
        action_summary: 'git status',
        source: 'claude-code',
      });

      log.log({
        adapter: 'shell',
        decision: 'deny',
        rule: 'blocked-pattern',
        reason: 'matches --force',
        action_summary: 'git push --force',
        source: 'claude-code',
      });

      log.close();

      const entries = log.readAll();
      expect(entries).toHaveLength(2);
      expect(entries[0].decision).toBe('allow');
      expect(entries[1].decision).toBe('deny');
    });
  });

  describe('log() convenience method', () => {
    it('auto-generates timestamp and audit_id', () => {
      const entry = log.log({
        adapter: 'mcp',
        decision: 'deny',
        rule: 'tool-blocked',
        reason: 'tool "delete_all" is in blocklist',
        action_summary: 'tools/call delete_all',
        source: 'test-server',
      });

      expect(entry.timestamp).toBeDefined();
      expect(entry.audit_id).toBeDefined();
      expect(entry.audit_id.length).toBeGreaterThan(10);
    });

    it('includes optional scan_id', () => {
      const entry = log.log({
        adapter: 'fs-git',
        decision: 'allow',
        rule: 'all-checks-passed',
        reason: 'action permitted',
        action_summary: 'write proposals/x.md',
        source: 'whatsapp_main',
        scan_id: 'scan-abc-123',
      });

      log.close();
      const entries = log.readAll();
      expect(entries[0].scan_id).toBe('scan-abc-123');
    });

    it('includes policy_file and eval_us', () => {
      const entry = log.log({
        adapter: 'shell',
        decision: 'allow',
        rule: 'all-checks-passed',
        reason: 'ok',
        action_summary: 'npm test',
        source: 'claude-code',
        policy_file: '/path/to/policy.yaml',
        eval_us: 42,
      });

      log.close();
      const entries = log.readAll();
      expect(entries[0].policy_file).toBe('/path/to/policy.yaml');
      expect(entries[0].eval_us).toBe(42);
    });
  });

  describe('query', () => {
    it('filters entries', () => {
      log.log({
        adapter: 'shell',
        decision: 'allow',
        rule: 'all-checks-passed',
        reason: 'ok',
        action_summary: 'git status',
        source: 'claude-code',
      });
      log.log({
        adapter: 'shell',
        decision: 'deny',
        rule: 'blocked-pattern',
        reason: 'nope',
        action_summary: 'git push --force',
        source: 'claude-code',
      });
      log.log({
        adapter: 'mcp',
        decision: 'deny',
        rule: 'tool-blocked',
        reason: 'blocked',
        action_summary: 'delete_all',
        source: 'fs-server',
      });

      log.close();

      const denied = log.query((e) => e.decision === 'deny');
      expect(denied).toHaveLength(2);

      const shellOnly = log.query((e) => e.adapter === 'shell');
      expect(shellOnly).toHaveLength(2);

      const mcpDenied = log.query(
        (e) => e.adapter === 'mcp' && e.decision === 'deny',
      );
      expect(mcpDenied).toHaveLength(1);
    });
  });

  describe('empty log', () => {
    it('readAll returns empty array when log does not exist', () => {
      const freshLog = new AuditLog(path.join(tmpDir, 'nonexistent'));
      expect(freshLog.readAll()).toEqual([]);
    });
  });

  describe('JSONL format', () => {
    it('writes one JSON object per line', () => {
      log.log({
        adapter: 'fs-git',
        decision: 'allow',
        rule: 'all-checks-passed',
        reason: 'ok',
        action_summary: 'write x.md',
        source: 'test',
      });
      log.log({
        adapter: 'shell',
        decision: 'deny',
        rule: 'blocked-command',
        reason: 'rm blocked',
        action_summary: 'rm file.txt',
        source: 'test',
      });

      log.close();

      const raw = fs.readFileSync(log.getPath(), 'utf-8');
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(2);

      // Each line is valid JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });
});
