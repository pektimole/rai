/**
 * First-scan batch input (OL-661).
 *
 * A batch is what the user brings in session 1: pasted text or shared
 * screenshots. `receivedAt` comes from item metadata only (a `Date:` line in
 * pasted text, `File.lastModified` on a shared image). When an item carries
 * no date it stays null. It never falls back to scan time.
 */

export interface BatchItem {
  id: string;
  text: string;
  /** Channel or sender as given by the user or the share. Empty string if unknown. */
  source: string;
  /** ISO timestamp from item metadata, or null when the item has none. */
  receivedAt: string | null;
}

const SEPARATOR = /^\s*-{3,}\s*$/;
const DATE_KEYS = /^(?:date|received|sent)\s*:\s*(.+)$/i;
const SOURCE_KEYS = /^(?:source|from|channel)\s*:\s*(.+)$/i;

export function toIsoOrNull(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '' || value === 0) return null;
  const t = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

/**
 * Split pasted text into items on lines of `---`. Each item may start with
 * metadata lines (`Date:`, `From:` / `Source:` / `Channel:`); the rest is the body.
 */
export function parsePastedBatch(raw: string): BatchItem[] {
  const blocks: string[][] = [[]];
  for (const line of raw.split(/\r?\n/)) {
    if (SEPARATOR.test(line)) blocks.push([]);
    else blocks[blocks.length - 1].push(line);
  }

  const items: BatchItem[] = [];
  for (const lines of blocks) {
    let receivedAt: string | null = null;
    let source = '';
    let i = 0;
    for (; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '') {
        if (i === 0) continue;
        break;
      }
      const d = DATE_KEYS.exec(line);
      const s = SOURCE_KEYS.exec(line);
      if (d) receivedAt = toIsoOrNull(d[1].trim());
      else if (s) source = s[1].trim();
      else break;
    }
    const text = lines.slice(i).join('\n').trim();
    if (text === '') continue;
    items.push({ id: `item-${items.length + 1}`, text, source, receivedAt });
  }
  return items;
}

/** One OCR'd screenshot as a batch item. The date is the file's own metadata. */
export function itemFromImage(args: {
  id: string;
  text: string;
  source?: string;
  fileLastModified?: number | null;
}): BatchItem {
  return {
    id: args.id,
    text: args.text,
    source: args.source ?? '',
    receivedAt: toIsoOrNull(args.fileLastModified ?? null),
  };
}
