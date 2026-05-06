import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../src/ui/render';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml('<script>alert("x") & "y" \'z\'</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;) &amp; &quot;y&quot; &#39;z&#39;&lt;/script&gt;',
    );
  });

  it('passes through plain text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('escapes ampersands before other entities so double-escape does not happen', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});
