/**
 * Pure FormData → PendingShare extractor.
 *
 * Lives outside the service worker so the unit tests can exercise the
 * multipart parsing logic without standing up a SW context. The SW imports
 * this module and adds the IndexedDB staging side-effect.
 */

export interface PendingShare {
  id: string;
  image: Blob;
  imageName?: string;
  imageType: string;
  title?: string;
  text?: string;
  source_url?: string;
  receivedAt: number;
}

const IMAGE_FIELD_CANDIDATES = ['screenshot', 'image', 'file', 'files'];

export function generateShareId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `share-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function harvestSourceUrl(
  url: string | null | undefined,
  text: string | null | undefined,
): string | undefined {
  const fromUrl = url?.trim();
  if (fromUrl) return fromUrl;
  const fromText = text?.trim();
  if (fromText && /^https?:\/\/\S+$/i.test(fromText)) return fromText;
  return undefined;
}

function pickImageFromForm(form: FormData): File | null {
  for (const name of IMAGE_FIELD_CANDIDATES) {
    const value = form.get(name);
    if (value instanceof File && value.type.startsWith('image/')) {
      return value;
    }
  }
  for (const [, value] of form.entries()) {
    if (value instanceof File && value.type.startsWith('image/')) {
      return value;
    }
  }
  return null;
}

function readString(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function extractShareFromFormData(form: FormData): Promise<PendingShare | null> {
  const image = pickImageFromForm(form);
  if (!image) return null;

  const title = readString(form, 'title');
  const text = readString(form, 'text');
  const url = readString(form, 'url');
  const source_url = harvestSourceUrl(url, text);

  return {
    id: generateShareId(),
    image,
    imageName: image.name || undefined,
    imageType: image.type || 'application/octet-stream',
    title,
    text,
    source_url,
    receivedAt: Date.now(),
  };
}
