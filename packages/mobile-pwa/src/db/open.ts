/**
 * Shared IndexedDB opener for the mobile PWA.
 *
 * Stores:
 *   - `pending_shares` (v1): inbound payloads from the OS share-sheet, keyed
 *     by share id. Read-and-delete on pickup.
 *   - `corpus` (v2): scan + judgment rows for the labelled-corpus export.
 *     v1 created this with `keyPath: 'scan_id'` which collides between scan
 *     and judgment rows for the same scan; v2 drops and recreates with
 *     autoIncrement + a `scan_id` index so multiple rows per scan are fine.
 *
 * Schema parity target (rows match extension `chrome.storage.local.corpus`
 * + Telegram lab-bot JSONL): `type: 'scan' | 'judgment'`, joined by `scan_id`.
 */

const DB_NAME = 'rai-mobile';
export const DB_VERSION = 2;
export const PENDING_SHARES_STORE = 'pending_shares';
export const CORPUS_STORE = 'corpus';
export const CORPUS_SCAN_ID_INDEX = 'by_scan_id';

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;

      if (!db.objectStoreNames.contains(PENDING_SHARES_STORE)) {
        db.createObjectStore(PENDING_SHARES_STORE, { keyPath: 'id' });
      }

      if (oldVersion < 2 && db.objectStoreNames.contains(CORPUS_STORE)) {
        db.deleteObjectStore(CORPUS_STORE);
      }

      if (!db.objectStoreNames.contains(CORPUS_STORE)) {
        const corpus = db.createObjectStore(CORPUS_STORE, { autoIncrement: true });
        corpus.createIndex(CORPUS_SCAN_ID_INDEX, 'scan_id', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
