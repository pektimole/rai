/**
 * stats.ts — Metrics tracker for @RAISecuritybot.
 *
 * Persists to ~/.rai/telegram-stats.json (same dir as scan-log).
 * Tracks: total users, total scans, total threats, daily breakdown,
 * per-user stats (scans, threats, first/last seen).
 *
 * No PII stored — chat_id is a Telegram-internal number, not a name.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface UserStats {
  scans: number;
  threats: number;
  first_seen: string;
  last_seen: string;
}

export interface DayStats {
  scans: number;
  threats: number;
  unique_users: number;
  user_ids: number[];
}

export interface GlobalStats {
  total_users: number;
  total_scans: number;
  total_threats: number;
  first_scan: string;
  last_scan: string;
}

export interface StatsData {
  global: GlobalStats;
  daily: Record<string, DayStats>;
  users: Record<string, UserStats>;
}

function statsPath(): string {
  const home = process.env.HOME || '/tmp';
  return path.join(home, '.rai', 'telegram-stats.json');
}

function emptyStats(): StatsData {
  return {
    global: { total_users: 0, total_scans: 0, total_threats: 0, first_scan: '', last_scan: '' },
    daily: {},
    users: {},
  };
}

export function loadStats(): StatsData {
  const p = statsPath();
  if (!fs.existsSync(p)) return emptyStats();
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as StatsData;
  } catch {
    return emptyStats();
  }
}

function saveStats(data: StatsData): void {
  const p = statsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Record a scan. Call after every scanForChat().
 */
export function recordScan(chatId: number, verdict: string): void {
  const data = loadStats();
  const now = new Date().toISOString();
  const day = today();
  const isThreat = verdict === 'blocked' || verdict === 'flagged';
  const uid = String(chatId);

  // Global
  data.global.total_scans += 1;
  if (isThreat) data.global.total_threats += 1;
  if (!data.global.first_scan) data.global.first_scan = now;
  data.global.last_scan = now;

  // User
  if (!data.users[uid]) {
    data.users[uid] = { scans: 0, threats: 0, first_seen: now, last_seen: now };
    data.global.total_users += 1;
  }
  data.users[uid].scans += 1;
  if (isThreat) data.users[uid].threats += 1;
  data.users[uid].last_seen = now;

  // Daily
  if (!data.daily[day]) {
    data.daily[day] = { scans: 0, threats: 0, unique_users: 0, user_ids: [] };
  }
  data.daily[day].scans += 1;
  if (isThreat) data.daily[day].threats += 1;
  if (!data.daily[day].user_ids.includes(chatId)) {
    data.daily[day].user_ids.push(chatId);
    data.daily[day].unique_users += 1;
  }

  saveStats(data);
}

/**
 * Format global stats as Telegram-Markdown reply for /stats command.
 */
export function formatStatsReply(): string {
  const data = loadStats();
  const g = data.global;
  const day = data.daily[today()];

  if (g.total_scans === 0) {
    return `*RAI Stats*\n\nNo scans yet. Forward a message to get started.`;
  }

  const lines = [
    `*RAI Stats*`,
    ``,
    `*All time:*`,
    `• Users: ${g.total_users}`,
    `• Scans: ${g.total_scans}`,
    `• Threats detected: ${g.total_threats}`,
    `• Detection rate: ${g.total_scans > 0 ? ((g.total_threats / g.total_scans) * 100).toFixed(1) : '0'}%`,
  ];

  if (day) {
    lines.push(
      ``,
      `*Today:*`,
      `• Scans: ${day.scans}`,
      `• Threats: ${day.threats}`,
      `• Active users: ${day.unique_users}`,
    );
  }

  lines.push(``, `_Updated: ${g.last_scan.slice(0, 16).replace('T', ' ')} UTC_`);
  return lines.join('\n');
}
