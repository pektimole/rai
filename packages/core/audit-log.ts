/**
 * audit-log.ts — RAI ActionGate audit log
 *
 * Append-only structured log for all ActionGate verdicts across surfaces.
 * Each entry links to the originating scan_id (P0/P1/P2) for full traceability.
 *
 * Storage: JSON Lines (.jsonl) file. One JSON object per line.
 * Designed for grep, jq, and log aggregation (Loki, SIEM export).
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditAdapter =
  | 'fs-git'
  | 'shell'
  | 'mcp'
  | 'http'
  | 'browser-dom'
  | 'native-messaging-host';

export interface AuditEntry {
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Unique ID for this audit entry. */
  audit_id: string;
  /** Originating scan_id from P0/P1/P2, if available. */
  scan_id?: string;
  /** Which ActionGate adapter produced this verdict. */
  adapter: AuditAdapter;
  /** The verdict decision. */
  decision: 'allow' | 'deny' | 'sanitize' | 'warn';
  /** The rule that produced the verdict. */
  rule: string;
  /** Human-readable reason. */
  reason: string;
  /** The action that was evaluated (adapter-specific summary). */
  action_summary: string;
  /** Source identity (source group, agent name, tool name, etc.). */
  source: string;
  /** Policy file used, if applicable. */
  policy_file?: string;
  /** Latency of the evaluation in microseconds. */
  eval_us?: number;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export class AuditLog {
  private logPath: string;
  private dirEnsured = false;

  /**
   * Create an audit log writer.
   * @param logDir Directory to write log files to.
   * @param filename Log file name (default: rai-actiongate.jsonl).
   */
  constructor(logDir: string, filename = 'rai-actiongate.jsonl') {
    this.logPath = path.join(logDir, filename);
  }

  private ensureDir(): void {
    if (!this.dirEnsured) {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      this.dirEnsured = true;
    }
  }

  /**
   * Append an audit entry to the log. Synchronous append for reliability.
   */
  write(entry: AuditEntry): void {
    this.ensureDir();
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(this.logPath, line);
  }

  /**
   * Convenience: build and write an entry from common fields.
   */
  log(fields: {
    adapter: AuditAdapter;
    decision: 'allow' | 'deny' | 'sanitize' | 'warn';
    rule: string;
    reason: string;
    action_summary: string;
    source: string;
    scan_id?: string;
    policy_file?: string;
    eval_us?: number;
  }): AuditEntry {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      audit_id: crypto.randomUUID(),
      ...fields,
    };
    this.write(entry);
    return entry;
  }

  /**
   * Read all entries from the log (for querying/reporting).
   * Returns empty array if log doesn't exist.
   */
  readAll(): AuditEntry[] {
    if (!fs.existsSync(this.logPath)) return [];
    const content = fs.readFileSync(this.logPath, 'utf-8');
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as AuditEntry);
  }

  /**
   * Query entries by filter function.
   */
  query(filter: (entry: AuditEntry) => boolean): AuditEntry[] {
    return this.readAll().filter(filter);
  }

  /**
   * Get the log file path.
   */
  getPath(): string {
    return this.logPath;
  }

  /**
   * No-op for API compatibility. Writes are synchronous.
   */
  close(): void {
    // Synchronous writes, nothing to flush.
  }
}

// ---------------------------------------------------------------------------
// Singleton for CLI/server usage
// ---------------------------------------------------------------------------

let defaultLog: AuditLog | null = null;

/**
 * Get or create the default audit log.
 * Default location: ~/.rai/audit/rai-actiongate.jsonl
 */
export function getDefaultAuditLog(): AuditLog {
  if (!defaultLog) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
    defaultLog = new AuditLog(path.join(homeDir, '.rai', 'audit'));
  }
  return defaultLog;
}
