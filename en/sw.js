const CACHE_NAME = 'embyx-v1';

// Install: skip waiting, keep lightweight
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

// Activate: claim clients immediately
self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

// Fetch handler required to trigger Android Chrome install banner
self.addEventListener('fetch', (event) => {
    // Pass-through: no offline cache to save space and avoid stale content
    event.respondWith(fetch(event.request));
});
