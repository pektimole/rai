import { describe, expect, it } from 'vitest';
import { extractShareFromFormData, harvestSourceUrl } from '../src/share/extract';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function imageFile(name = 'screenshot.png', mime = 'image/png'): File {
  return new File([PNG_BYTES], name, { type: mime });
}

describe('harvestSourceUrl', () => {
  it('returns the url field when present', () => {
    expect(harvestSourceUrl('https://linkedin.com/posts/abc', null)).toBe(
      'https://linkedin.com/posts/abc',
    );
  });

  it('falls back to text only when it parses as a URL', () => {
    expect(harvestSourceUrl(null, 'https://x.com/foo/status/1')).toBe(
      'https://x.com/foo/status/1',
    );
    expect(harvestSourceUrl(null, 'cool post worth sharing')).toBeUndefined();
  });

  it('trims whitespace from the url field', () => {
    expect(harvestSourceUrl('  https://example.com  ', null)).toBe('https://example.com');
  });

  it('prefers url over text when both are URL-shaped', () => {
    expect(harvestSourceUrl('https://canonical.com', 'https://other.com')).toBe(
      'https://canonical.com',
    );
  });

  it('returns undefined when nothing is provided', () => {
    expect(harvestSourceUrl(null, null)).toBeUndefined();
    expect(harvestSourceUrl(undefined, undefined)).toBeUndefined();
    expect(harvestSourceUrl('', '')).toBeUndefined();
  });
});

describe('extractShareFromFormData', () => {
  it('extracts an image from the screenshot field', async () => {
    const fd = new FormData();
    fd.set('screenshot', imageFile());
    const result = await extractShareFromFormData(fd);
    expect(result).not.toBeNull();
    expect(result!.image.type).toBe('image/png');
    expect(result!.image.size).toBe(PNG_BYTES.byteLength);
    expect(result!.imageName).toBe('screenshot.png');
    expect(result!.imageType).toBe('image/png');
    expect(typeof result!.id).toBe('string');
    expect(result!.id.length).toBeGreaterThan(0);
  });

  it('falls back to image/file fields when screenshot is missing', async () => {
    const fd = new FormData();
    fd.set('image', imageFile('photo.jpg', 'image/jpeg'));
    const result = await extractShareFromFormData(fd);
    expect(result!.image.type).toBe('image/jpeg');
  });

  it('scans all entries when no canonical field carries the image', async () => {
    const fd = new FormData();
    fd.set('mystery_field', imageFile('weird.png'));
    const result = await extractShareFromFormData(fd);
    expect(result).not.toBeNull();
    expect(result!.image.type).toBe('image/png');
  });

  it('returns null when no image is present', async () => {
    const fd = new FormData();
    fd.set('title', 'no image');
    fd.set('text', 'nothing to scan here');
    expect(await extractShareFromFormData(fd)).toBeNull();
  });

  it('skips non-image files', async () => {
    const fd = new FormData();
    fd.set('screenshot', new File(['hello'], 'note.txt', { type: 'text/plain' }));
    expect(await extractShareFromFormData(fd)).toBeNull();
  });

  it('harvests source_url from the url field', async () => {
    const fd = new FormData();
    fd.set('screenshot', imageFile());
    fd.set('url', 'https://linkedin.com/posts/123');
    const result = await extractShareFromFormData(fd);
    expect(result!.source_url).toBe('https://linkedin.com/posts/123');
  });

  it('harvests source_url from text when url is empty', async () => {
    const fd = new FormData();
    fd.set('screenshot', imageFile());
    fd.set('text', 'https://x.com/foo');
    const result = await extractShareFromFormData(fd);
    expect(result!.source_url).toBe('https://x.com/foo');
  });

  it('captures title and text fields', async () => {
    const fd = new FormData();
    fd.set('screenshot', imageFile());
    fd.set('title', 'A LinkedIn Post');
    fd.set('text', 'Some preview text');
    const result = await extractShareFromFormData(fd);
    expect(result!.title).toBe('A LinkedIn Post');
    expect(result!.text).toBe('Some preview text');
    expect(result!.source_url).toBeUndefined();
  });
});
