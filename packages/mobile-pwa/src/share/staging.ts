/**
 * IndexedDB staging store for shares received via the OS share-sheet.
 *
 * The service worker writes a PendingShare here, redirects to /?share=<id>,
 * and the SPA shell reads it back on load. Corpus persistence (scan + judgment
 * rows) lives in `src/corpus/store.ts` against the same DB.
 */

import { openDb, PENDING_SHARES_STORE } from '../db/open';
import type { PendingShare } from './extract';

export async function stagePendingShare(share: PendingShare): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PENDING_SHARES_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
      tx.objectStore(PENDING_SHARES_STORE).put(share);
    });
  } finally {
    db.close();
  }
}

export async function takePendingShare(id: string): Promise<PendingShare | null> {
  const db = await openDb();
  try {
    return await new Promise<PendingShare | null>((resolve, reject) => {
      const tx = db.transaction(PENDING_SHARES_STORE, 'readwrite');
      const store = tx.objectStore(PENDING_SHARES_STORE);
      let captured: PendingShare | null = null;
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const value = getReq.result as PendingShare | undefined;
        if (!value) return;
        captured = value;
        store.delete(id);
      };
      tx.oncomplete = () => resolve(captured);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });
  } finally {
    db.close();
  }
}
