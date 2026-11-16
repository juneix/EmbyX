const CACHE_NAME = 'embyx-v1';

// Install: skip waiting, keep lightweight
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

// Activate: claim clients immediately
self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
    // Keep network failures as network errors; never fake an HTTP status
    event.respondWith(
        fetch(event.request).catch(() => Response.error())
    );
});
