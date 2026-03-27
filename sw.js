const CACHE_NAME = 'inspection-map-v2';

const urlsToCache = [
  './',
  './index.html',
  './manifest.json',

  // icons
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',

  // splash
  './splash.png'
];

/* インストール */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(urlsToCache);
    })
  );
  self.skipWaiting();
});

/* アクティベート */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

/* fetch */
self.addEventListener('fetch', event => {
  // ナビゲーションは常にキャッシュ優先
  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then(res => res || fetch(event.request))
    );
    return;
  }

  // その他は cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      return (
        cached ||
        fetch(event.request).then(response => {
          // 同一オリジンのみキャッシュ
          if (event.request.url.startsWith(self.location.origin)) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, clone);
            });
          }
          return response;
        })
      );
    })
  );
});
``