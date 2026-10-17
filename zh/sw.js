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
    // 默认直接透传，网络异常或被客户端拦截时优雅兜底，避免控制台未捕获 rejection
    event.respondWith(
        fetch(event.request).catch(() => {
            return new Response('', { status: 408, statusText: 'Request Timeout' });
        })
    );
});
