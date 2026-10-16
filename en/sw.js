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
    // Pass-through: handle network errors gracefully to prevent uncaught promise rejection
    event.respondWith(
        fetch(event.request).catch(() => {
            return new Response('', { status: 408, statusText: 'Request Timeout' });
        })
    );
});
