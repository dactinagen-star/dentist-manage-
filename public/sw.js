const CACHE_NAME = 'app-shell-v20260812';
const ASSETS_TO_CACHE = [
  '/',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// 🎯 ФІКС БІЛОГО ЕКРАНА: Network-First для навігації (HTML)
self.addEventListener('fetch', (event) => {
  // Якщо це відкриття сторінки/додатка (запит index.html)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          // Оновлюємо кеш свіжим index.html з мережі
          return caches.open(CACHE_NAME).then((cache) => {
            cache.put('/index.html', networkResponse.clone());
            return networkResponse;
          });
        })
        .catch(() => {
          // Якщо немає інтернету — віддаємо закешований index.html
          return caches.match('/index.html');
        })
    );
    return;
  }

  // Для решти static-файлів залишаємо Cache-First або мережу
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});