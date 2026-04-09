/**
 * action-gate-mcp.test.ts — MCP adapter tests
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateMcp,
  loadMcpPolicy,
  type McpToolCall,
  type McpPolicy,
} from './action-gate-mcp';

function policy(overrides: Partial<McpPolicy> = {}): McpPolicy {
  return {
    serverName: 'test-server',
    failClosed: true,
    allowedTools: new Set(['read_file', 'list_files', 'search']),
    blockedTools: new Set(['delete_all', 'drop_table']),
    blockedArgPatterns: new Map([
      ['read_file', [/\/etc\/shadow/, /\.env/]],
      ['*', [/password.*admin/i]],
    ]),
    ...overrides,
  };
}

function call(overrides: Partial<McpToolCall> = {}): McpToolCall {
  return {
    kind: 'mcp-tool-call',
    toolName: 'read_file',
    arguments: { path: '/home/tim/notes.md' },
    serverName: 'test-server',
    ...overrides,
  };
}

describe('evaluateMcp', () => {
  describe('happy path', () => {
    it('allows a tool in the allowlist', () => {
      const v = evaluateMcp(call(), policy());
      expect(v.decision).toBe('allow');
    });

    it('allows different allowed tools', () => {
      for (const toolName of ['read_file', 'list_files', 'search']) {
        const v = evaluateMcp(call({ toolName }), policy());
        expect(v.decision).toBe('allow');
      }
    });
  });

  describe('blocked tools', () => {
    it('denies a blocked tool', () => {
      const v = evaluateMcp(call({ toolName: 'delete_all' }), policy());
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('tool-blocked');
    });

    it('denies blocked tool even in open mode', () => {
      const v = evaluateMcp(
        call({ toolName: 'drop_table' }),
        policy({ failClosed: false }),
      );
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('tool-blocked');
    });
  });

  describe('blocked argument patterns', () => {
    it('denies tool-specific arg pattern', () => {
      const v = evaluateMcp(
        call({ arguments: { path: '/etc/shadow' } }),
        policy(),
      );
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('blocked-arg-pattern');
    });

    it('denies .env file access', () => {
      const v = evaluateMcp(
        call({ arguments: { path: '/app/.env' } }),
        policy(),
      );
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('blocked-arg-pattern');
    });

    it('denies wildcard pattern across all tools', () => {
      const v = evaluateMcp(
        call({
          toolName: 'search',
          arguments: { query: 'password admin credentials' },
        }),
        policy(),
      );
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('blocked-arg-pattern');
    });

    it('allows clean arguments', () => {
      const v = evaluateMcp(
        call({ arguments: { path: '/home/tim/readme.md' } }),
        policy(),
      );
      expect(v.decision).toBe('allow');
    });
  });

  describe('fail-closed mode', () => {
    it('denies unknown tool when fail_closed is true', () => {
      const v = evaluateMcp(
        call({ toolName: 'unknown_tool' }),
        policy(),
      );
      expect(v.decision).toBe('deny');
      expect(v.rule).toBe('tool-not-in-allowlist');
    });

    it('allows unknown tool when fail_closed is false', () => {
      const v = evaluateMcp(
        call({ toolName: 'unknown_tool' }),
        policy({ failClosed: false }),
      );
      expect(v.decision).toBe('allow');
    });
  });

  describe('first-deny-wins ordering', () => {
    it('reports blocked-tool before arg pattern check', () => {
      const v = evaluateMcp(
        call({
          toolName: 'delete_all',
          arguments: { path: '/etc/shadow' },
        }),
        policy(),
      );
      expect(v.rule).toBe('tool-blocked');
    });

    it('reports blocked-arg-pattern before allowlist check', () => {
      const v = evaluateMcp(
        call({
          toolName: 'read_file',
          arguments: { path: '/etc/shadow' },
        }),
        policy(),
      );
      expect(v.rule).toBe('blocked-arg-pattern');
    });
  });
});

describe('loadMcpPolicy', () => {
  it('loads a valid policy', () => {
    const p = loadMcpPolicy({
      version: 1,
      adapter: 'mcp',
      server_name: 'filesystem',
      fail_closed: true,
      allowed_tools: ['read_file', 'list_files'],
      blocked_tools: ['delete_file'],
      blocked_arg_patterns: {
        read_file: ['\\.env', '/etc/shadow'],
        '*': ['password'],
      },
    });
    expect(p.serverName).toBe('filesystem');
    expect(p.failClosed).toBe(true);
    expect(p.allowedTools).toEqual(new Set(['read_file', 'list_files']));
    expect(p.blockedTools).toEqual(new Set(['delete_file']));
    expect(p.blockedArgPatterns.get('read_file')).toHaveLength(2);
    expect(p.blockedArgPatterns.get('*')).toHaveLength(1);
  });

  it('defaults fail_closed to true', () => {
    const p = loadMcpPolicy({
      version: 1,
      adapter: 'mcp',
      server_name: 'test',
    });
    expect(p.failClosed).toBe(true);
  });

  it('throws on wrong version', () => {
    expect(() =>
      loadMcpPolicy({ version: 2, adapter: 'mcp', server_name: 'x' }),
    ).toThrow('unsupported policy version');
  });

  it('throws on missing server_name', () => {
    expect(() =>
      loadMcpPolicy({ version: 1, adapter: 'mcp', server_name: '' }),
    ).toThrow('missing required field');
  });
});
