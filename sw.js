// sw.js: makes Postmatch work offline after the first visit, and receives
// screenshots shared from Android's share sheet. It never contacts any other site.
// Bump VERSION whenever any file changes, so phones fetch the new set.
const VERSION = 'postmatch-v1';
const SHARE_CACHE = 'postmatch-share';
const SHELL = [
  './', 'index.html', 'guide.html', 'styles.css', 'manifest.webmanifest',
  'app.js', 'db.js', 'model.js', 'importer.js', 'reader.js', 'stats.js', 'heroes.js', 'backup.js',
  'barlow-sc-500.woff2', 'barlow-sc-600.woff2', 'barlow-sc-700.woff2',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
  'tesseract.min.js', 'worker.min.js', 'eng.traineddata.gz',
];
// The reading engine comes in three builds; each phone loads only the one it supports,
// so it is cached the first time it is used rather than downloading all three.
const ON_USE = /tesseract-core-[a-z-]*\.wasm\.js$/;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('postmatch-') && k !== VERSION && k !== SHARE_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function fromCache(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  if (req.mode === 'navigate') {
    const page = await cache.match('index.html');
    if (page) return page;
  }
  const res = await fetch(req);
  if (res.ok && ON_USE.test(new URL(req.url).pathname)) cache.put(req, res.clone());
  return res;
}

// Android share sheet: keep the picture briefly, then open the app to read it.
async function receiveShare(req) {
  try {
    const form = await req.formData();
    const file = form.get('image');
    if (file && typeof file === 'object' && file.size > 0 && file.size <= 30 * 1024 * 1024 && /^image\//.test(file.type)) {
      const cache = await caches.open(SHARE_CACHE);
      await cache.put('shared-image', new Response(file, { headers: { 'content-type': file.type } }));
    }
  } catch (_) { /* fall through: the app opens with nothing to read */ }
  return Response.redirect(new URL('./#shared', self.registration.scope).href, 303);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) { e.respondWith(receiveShare(req)); return; }
  if (req.method !== 'GET') return;
  e.respondWith(fromCache(req));
});
