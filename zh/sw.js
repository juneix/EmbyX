const CACHE_NAME = 'embyx-v1';

// 安装阶段：不强制缓存大量资源，保持轻量
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

// activate 阶段：清理旧缓存
self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
    // 网络失败保持网络错误语义，不可伪造成 HTTP 状态码
    event.respondWith(
        fetch(event.request).catch(() => Response.error())
    );
});
