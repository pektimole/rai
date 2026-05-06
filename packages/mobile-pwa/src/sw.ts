/// <reference lib="webworker" />
/**
 * Mobile PWA service worker.
 *
 * Step 3 wires the /share POST handler:
 *   - intercepts the multipart payload from the OS share-sheet
 *   - extracts the first image and opportunistic source_url / title / text
 *   - stages it in IndexedDB under a fresh share_id
 *   - redirects to /?share=<id> so the SPA shell can pick it up
 *
 * OCR + scanner pipeline (steps 4-5) live in the SPA after pickup, so the
 * service worker stays small and the heavy WASM stays out of the SW bundle.
 */

import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { extractShareFromFormData } from './share/extract';
import { stagePendingShare } from './share/staging';

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);

// Tesseract.js pulls its worker bundle + core wasm from jsDelivr and
// `eng.traineddata.gz` from tessdata.projectnaptha.com. Cache them aggressively
// so the first OCR is the only network hit. Spec: docs/29-rai-mobile-spec.md §5.
registerRoute(
  ({ url }) =>
    url.hostname === 'tessdata.projectnaptha.com' ||
    (url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('tesseract')),
  new CacheFirst({
    cacheName: 'rai-mobile-tesseract-v1',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 16,
        maxAgeSeconds: 60 * 60 * 24 * 90,
        purgeOnQuotaError: true,
      }),
    ],
  }),
);

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});

async function handleShare(request: Request): Promise<Response> {
  try {
    const form = await request.formData();
    const pending = await extractShareFromFormData(form);
    if (!pending) {
      return Response.redirect('/?share=empty', 303);
    }
    await stagePendingShare(pending);
    return Response.redirect(`/?share=${encodeURIComponent(pending.id)}`, 303);
  } catch (err) {
    console.error('[rai-mobile] /share handler failed', err);
    return Response.redirect('/?share=error', 303);
  }
}

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === '/share') {
    event.respondWith(handleShare(event.request));
  }
});
