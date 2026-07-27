const CACHE_NAME = 'pancreasys-lab-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/css/style.css',
  '/css/consumables-app.css',
  '/js/script.js',
  '/js/loader.js',
  '/js/consumables-app.js',
  '/images/icon-192.svg',
  '/images/icon-512.svg',
  '/sections/hero.html',
  '/sections/about.html',
  '/sections/research.html',
  '/sections/team.html',
  '/sections/publications.html',
  '/sections/resources.html',
  '/sections/contact.html'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(event.request.url);

  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(event.request)
        .then(networkResponse => {
          if (!networkResponse || networkResponse.status !== 200 || requestUrl.origin !== self.location.origin) {
            return networkResponse;
          }

          const clonedResponse = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clonedResponse));
          return networkResponse;
        })
        .catch(() => {
          if (event.request.mode === 'navigate' || event.request.destination === 'document') {
            return caches.match('/index.html');
          }
          if (event.request.destination === 'image') {
            return caches.match('/images/icon-192.svg');
          }
          return null;
        });
    })
  );
});
