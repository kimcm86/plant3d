/* PLANT 3D 서비스 워커 — 오프라인 실행 + 새 버전 감지
   버전은 version.js 에서만 관리합니다. */
importScripts('version.js');
const CACHE = 'plant3d-' + self.P3D_VERSION;
const FILES = [
  './', 'index.html', 'version.js', 'pwa.js', 'manifest.webmanifest',
  'iso2d3d.js', 'isovec.js', 'vendor/three.min.js', 'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/xlsx.full.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('plant3d-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'update-now') self.skipWaiting(); });
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // 화면(HTML)은 네트워크 우선 → 실패하면 저장본, 나머지는 저장본 우선
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});
