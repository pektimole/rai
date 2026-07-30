/**
 * contract-capture.ts — Learn-and-lock phase 2a: live capture wiring (OL-461)
 *
 * Bridges the live enforcement seams to the phase-1 flight recorder so a real
 * agent, running under the ActionGate, accumulates the traffic the compile
 * phase later infers a behavioral contract from. Today the one live seam that
 * carries agent traffic is the MCP proxy (mcp-proxy.ts, tools/call); the HTTP
 * destination seam attaches here too via httpEventFromUrl once the http adapter
 * lands (action-gate.ts lists it as planned).
 *
 * Two invariants govern this module:
 *
 *   1. Default OFF. Capture is opt-in per deployment (RAI_CAPTURE=1). A gate
 *      that has not opted in creates no files and pays no cost — every capture
 *      call is a no-op.
 *
 *   2. Observation must NEVER affect enforcement. Every capture call is
 *      best-effort and swallows its own errors: a broken recorder, a full disk,
 *      a tampered resume target must never turn an allowed action into a failed
 *      one. This is the deliberate inverse of the recorder's read-side
 *      fail-closed discipline — on the live write path we fail OPEN, because the
 *      recorder is a passive observer of the security boundary, not part of it.
 *      The first error disables capture for the rest of the process (so we never
 *      append onto history we could not verify) and is reported once.
 *
 * Privacy floor carries over from the recorder: httpEventFromUrl records shape
 * only — scheme/host/port/method/path — and DROPS query string, fragment, and
 * any embedded credentials before the event is ever constructed.
 *
 * Spec: docs/33-rai-l1-hotreload-spec.md (Part A, phase 2a: live capture).
 */

import * as path from 'path';
import {
  FlightRecorder,
  type HttpDestinationEvent,
  type McpToolCallEvent,
} from './contract-recorder.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CaptureConfig {
  /** Master switch. Everything is a no-op unless this is true. */
  enabled: boolean;
  /** Directory holding per-session flight logs. */
  dir: string;
  /** Selector scope: contracts are compiled per-agent. */
  agent: string;
  /** One flight log per session; a restart with the same id resumes the chain. */
  session: string;
}

/** Default recorder directory: ~/.rai/flight (matches the ~/.rai audit-log idiom). */
export function defaultCaptureDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.HOME ?? '.', '.rai', 'flight');
}

/**
 * Read capture configuration from the environment. OFF unless RAI_CAPTURE is
 * "1" or "true". Deployment supplies RAI_AGENT (selector scope) and RAI_SESSION
 * (one log per session); both fall back to stable per-process defaults so a
 * misconfigured deployment still produces a coherent, if generic, log rather
 * than crashing.
 */
export function captureConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CaptureConfig {
  return {
    enabled: env.RAI_CAPTURE === '1' || env.RAI_CAPTURE === 'true',
    dir: env.RAI_CAPTURE_DIR || defaultCaptureDir(env),
    agent: env.RAI_AGENT || 'default',
    session: env.RAI_SESSION || `proc-${process.pid}`,
  };
}

// ---------------------------------------------------------------------------
// URL → event (privacy-preserving; used by the HTTP seam)
// ---------------------------------------------------------------------------

/**
 * Reduce an outbound URL + method to a shape-only HTTP destination event.
 * DROPS query string, fragment, username, and password — only scheme, host,
 * port, method, and path survive. Returns null for an unparseable URL so a
 * caller can skip capture without a try/catch. Default ports are resolved
 * explicitly (https→443, http→80) so the compiler buckets consistently.
 */
export function httpEventFromUrl(
  rawUrl: string,
  method: string,
): Omit<HttpDestinationEvent, 'kind'> | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(/:$/, '');
  const port = u.port
    ? parseInt(u.port, 10)
    : scheme === 'https'
      ? 443
      : scheme === 'http'
        ? 80
        : 0;
  // pathname only — query string and fragment are deliberately discarded.
  return { scheme, host: u.hostname, port, method: method.toUpperCase(), path: u.pathname };
}

// ---------------------------------------------------------------------------
// Capture session (fail-open live-side wrapper around the recorder)
// ---------------------------------------------------------------------------

export interface CaptureOptions {
  /** Injectable clock, forwarded to the recorder (deterministic tests). */
  now?: () => Date;
  /** Called once, the first time capture disables itself on an error. */
  onError?: (err: Error) => void;
}

/**
 * A per-process capture session. Owns a lazily-created FlightRecorder and
 * guarantees that no capture call can throw into the enforcement path. When
 * disabled (config off) or after any error, every capture method is a silent
 * no-op.
 */
export class CaptureSession {
  private recorder?: FlightRecorder;
  /** Set once the first error fires; capture stays off for the process after. */
  private broken = false;

  constructor(
    private readonly cfg: CaptureConfig,
    private readonly opts: CaptureOptions = {},
  ) {}

  /** True only while capture is configured on and no error has disabled it. */
  get active(): boolean {
    return this.cfg.enabled && !this.broken;
  }

  /** Record an observed HTTP destination. No-op when inactive; never throws. */
  captureHttp(e: Omit<HttpDestinationEvent, 'kind'>): void {
    this.safe((r) => r.recordHttp(e));
  }

  /** Record an observed MCP tool call. No-op when inactive; never throws. */
  captureMcp(e: Omit<McpToolCallEvent, 'kind'>): void {
    this.safe((r) => r.recordMcp(e));
  }

  private ensure(): FlightRecorder | undefined {
    if (!this.active) return undefined;
    if (!this.recorder) {
      try {
        this.recorder = new FlightRecorder(this.cfg.dir, this.cfg.session, this.cfg.agent, {
          now: this.opts.now,
        });
      } catch (err) {
        // A tampered resume target or an unwritable dir disables capture; the
        // recorder refused to append onto unverifiable history — correct.
        this.fail(err as Error);
        return undefined;
      }
    }
    return this.recorder;
  }

  private safe(fn: (r: FlightRecorder) => void): void {
    const r = this.ensure();
    if (!r) return;
    try {
      fn(r);
    } catch (err) {
      this.fail(err as Error);
    }
  }

  private fail(err: Error): void {
    if (this.broken) return; // report exactly once
    this.broken = true;
    this.opts.onError?.(err);
  }
}

// ---------------------------------------------------------------------------
// Process-default session (so each seam shares one recorder)
// ---------------------------------------------------------------------------

let _default: CaptureSession | undefined;

/**
 * The process-wide capture session, built from the environment on first use.
 * Live seams (the MCP proxy, and the HTTP gate when it lands) call this so all
 * of a process's observed traffic lands in one session log. Disabled unless
 * RAI_CAPTURE is set.
 */
export function defaultCaptureSession(): CaptureSession {
  if (!_default) {
    _default = new CaptureSession(captureConfigFromEnv(), {
      onError: (err) =>
        process.stderr.write(`[rai-capture] disabled for this process after error: ${err.message}\n`),
    });
  }
  return _default;
}

/** Test seam: drop the cached process-default session. */
export function resetDefaultCaptureSession(): void {
  _default = undefined;
}
