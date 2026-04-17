import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadStats, recordScan, formatStatsReply } from './stats.js';

const origHome = process.env.HOME;

describe('stats', () => {
  beforeEach(() => {
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-stats-'));
  });

  afterEach(() => {
    process.env.HOME = origHome;
  });

  it('starts empty', () => {
    const s = loadStats();
    expect(s.global.total_scans).toBe(0);
    expect(s.global.total_users).toBe(0);
  });

  it('records a clean scan', () => {
    recordScan(111, 'clean');
    const s = loadStats();
    expect(s.global.total_scans).toBe(1);
    expect(s.global.total_threats).toBe(0);
    expect(s.global.total_users).toBe(1);
  });

  it('records a threat (blocked)', () => {
    recordScan(222, 'blocked');
    const s = loadStats();
    expect(s.global.total_threats).toBe(1);
    expect(s.users['222'].threats).toBe(1);
  });

  it('records a threat (flagged)', () => {
    recordScan(333, 'flagged');
    const s = loadStats();
    expect(s.global.total_threats).toBe(1);
  });

  it('counts unique users', () => {
    recordScan(100, 'clean');
    recordScan(200, 'clean');
    recordScan(100, 'blocked');
    const s = loadStats();
    expect(s.global.total_users).toBe(2);
    expect(s.global.total_scans).toBe(3);
    expect(s.users['100'].scans).toBe(2);
  });

  it('tracks daily breakdown', () => {
    recordScan(100, 'clean');
    recordScan(200, 'blocked');
    const s = loadStats();
    const today = new Date().toISOString().slice(0, 10);
    expect(s.daily[today].scans).toBe(2);
    expect(s.daily[today].threats).toBe(1);
    expect(s.daily[today].unique_users).toBe(2);
  });

  it('formats stats reply with data', () => {
    recordScan(100, 'clean');
    recordScan(100, 'blocked');
    recordScan(200, 'flagged');
    const reply = formatStatsReply();
    expect(reply).toContain('Users: 2');
    expect(reply).toContain('Scans: 3');
    expect(reply).toContain('Threats detected: 2');
  });

  it('formats stats reply when empty', () => {
    const reply = formatStatsReply();
    expect(reply).toContain('No scans yet');
  });

  it('persists across reloads', () => {
    recordScan(100, 'blocked');
    const s1 = loadStats();
    const s2 = loadStats();
    expect(s1.global.total_scans).toBe(s2.global.total_scans);
    expect(s1.users['100'].threats).toBe(1);
  });
});
