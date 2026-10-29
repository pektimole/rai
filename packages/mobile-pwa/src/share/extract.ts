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
  /** Item metadata date (the image file's lastModified, ms). Not the time the share arrived. */
  itemDate?: number;
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

function allImagesFromForm(form: FormData): File[] {
  const out: File[] = [];
  for (const [, value] of form.entries()) {
    if (value instanceof File && value.type.startsWith('image/')) out.push(value);
  }
  return out;
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
    itemDate: image.lastModified || undefined,
    receivedAt: Date.now(),
  };
}

/**
 * Every image in the multipart payload as its own PendingShare (OL-661 batch).
 * Text, title and url describe the share as a whole and attach to the first item only.
 */
export async function extractAllSharesFromFormData(form: FormData): Promise<PendingShare[]> {
  const images = allImagesFromForm(form);
  if (images.length === 0) return [];
  const title = readString(form, 'title');
  const text = readString(form, 'text');
  const source_url = harvestSourceUrl(readString(form, 'url'), text);
  const receivedAt = Date.now();
  return images.map((image, i) => ({
    id: generateShareId(),
    image,
    imageName: image.name || undefined,
    imageType: image.type || 'application/octet-stream',
    title: i === 0 ? title : undefined,
    text: i === 0 ? text : undefined,
    source_url: i === 0 ? source_url : undefined,
    itemDate: image.lastModified || undefined,
    receivedAt,
  }));
}
