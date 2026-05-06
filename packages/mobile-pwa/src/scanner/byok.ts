/**
 * BYOK key access for the mobile PWA.
 *
 * Step 5: only `getAnthropicKey()` is consumed — main.ts uses presence to
 * decide whether to escalate from P0 to P1. The setter + clearer ship now so
 * step 6's settings UI has a stable surface to call into.
 *
 * Storage: `localStorage` under a single key. Shared origin = shared key, so
 * a future origin-scoped corpus migration would carry the BYOK key along.
 */

const STORAGE_KEY = 'rai-mobile-anthropic-key';

export function getAnthropicKey(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function setAnthropicKey(key: string): void {
  localStorage.setItem(STORAGE_KEY, key);
}

export function clearAnthropicKey(): void {
  localStorage.removeItem(STORAGE_KEY);
}
