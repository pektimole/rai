import { describe, it, expect } from 'vitest';
import { lookupCredibility } from '../agents/credibility.js';

describe('lookupCredibility', () => {
  it('returns official for CVE database', () => {
    expect(lookupCredibility('https://cve.org/CVERecord?id=CVE-2026-1234')).toBe('official');
  });

  it('returns official for NIST NVD', () => {
    expect(lookupCredibility('https://nvd.nist.gov/vuln/detail/CVE-2026-1234')).toBe('official');
  });

  it('returns established for TechCrunch', () => {
    expect(lookupCredibility('https://techcrunch.com/2026/04/01/some-article')).toBe('established');
  });

  it('returns community for HackerNews', () => {
    expect(lookupCredibility('https://news.ycombinator.com/item?id=12345')).toBe('community');
  });

  it('returns social for Twitter/X', () => {
    expect(lookupCredibility('https://x.com/user/status/123')).toBe('social');
    expect(lookupCredibility('https://twitter.com/user/status/123')).toBe('social');
  });

  it('returns anonymous for pastebin', () => {
    expect(lookupCredibility('https://pastebin.com/abc123')).toBe('anonymous');
  });

  it('defaults to anonymous for unknown sources', () => {
    expect(lookupCredibility('https://random-blog.example.com/post')).toBe('anonymous');
  });
});
