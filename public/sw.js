var CACHE = 'street-gallery-v1';

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(['/css/style.css', '/js/main.js', '/manifest.json']);
    })
  );
});

self.addEventListener('fetch', function (e) {
  e.respondWith(
    caches.match(e.request).then(function (r) {
      return r || fetch(e.request).catch(function () {
        return new Response('Offline', { status: 503 });
      });
    })
  );
});
