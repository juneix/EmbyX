/**
 * EmbyX Common Utilities (Zero-dependency, Vanilla JS)
 * 1. Server URL normalization and authentication (Jellyfin 10.x & 12 compatible)
 * 2. Media library Views fetching and caching
 * 3. Favorites synchronization and toggling
 * 4. Media item deletion
 * 5. Poster and person avatar URL builder
 * 6. GitHub release update checker
 */
(function (window) {
    'use strict';

    const SERVER_TYPE_KEY = 'embyx_server_type';

    function getServerType() {
        return (typeof localStorage !== 'undefined' && localStorage.getItem(SERVER_TYPE_KEY)) || 'emby';
    }

    function setServerType(type) {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(SERVER_TYPE_KEY, type || 'emby');
        }
    }

    // 1. Jellyfin authentication and route compatibility interceptor
    function enableJellyfinFetchProxy() {
        if (window._jellyfinProxyEnabled) return;
        const origFetch = window.fetch;
        window.fetch = function (url, options) {
            let isTargetReq = false;
            if (getServerType() === 'jellyfin' && typeof url === 'string') {
                const savedServer = localStorage.getItem('emby_server');
                if (savedServer) {
                    try {
                        const target = new URL(savedServer, location.href);
                        const request = new URL(url, location.href);
                        const basePath = target.pathname.replace(/\/+$/, '');
                        isTargetReq = request.origin === target.origin &&
                            (request.pathname === basePath || request.pathname.startsWith(basePath + '/'));
                    } catch (e) {}
                }
            }
            if (isTargetReq) {
                // 1. URL normalization (strip /emby/, rewrite lowercase api_key to ApiKey, inject required Client param for DisplayPreferences)
                if (url.includes('/emby/')) {
                    url = url.replace(/\/emby(?=\/|\?|$)/, '');
                }
                url = url.replace(/([?&])api_key=/i, '$1ApiKey=');
                if (url.includes('/DisplayPreferences/') && !/[?&]client=/i.test(url)) {
                    url += (url.includes('?') ? '&' : '?') + 'Client=EmbyX';
                }

                options = options ? Object.assign({}, options) : {};
                let headers = options.headers;

                let token = (typeof localStorage !== 'undefined' && localStorage.getItem('emby_token')) || '';
                let deviceName = (typeof localStorage !== 'undefined' && localStorage.getItem('emby_device_name')) || 'Web Browser';
                let deviceId = (typeof localStorage !== 'undefined' && localStorage.getItem('emby_device_id')) || '';
                let appVersion = (typeof localStorage !== 'undefined' && localStorage.getItem('emby_app_version')) || '1.1';

                // 检查传入的 headers 中是否已有 token 或 deviceId 信息
                let existingAuth = '';
                if (headers) {
                    if (typeof headers.get === 'function') {
                        existingAuth = headers.get('Authorization') || headers.get('X-Emby-Authorization') || '';
                    } else if (typeof headers === 'object') {
                        existingAuth = headers['Authorization'] || headers['authorization'] || headers['X-Emby-Authorization'] || headers['x-emby-authorization'] || '';
                    }
                }

                if (existingAuth) {
                    const tokenMatch = existingAuth.match(/Token="([^"]+)"/i);
                    if (tokenMatch) token = tokenMatch[1];
                    const deviceMatch = existingAuth.match(/Device="([^"]+)"/i);
                    if (deviceMatch) deviceName = deviceMatch[1];
                    const deviceIdMatch = existingAuth.match(/DeviceId="([^"]+)"/i);
                    if (deviceIdMatch) deviceId = deviceIdMatch[1];
                    const verMatch = existingAuth.match(/Version="([^"]+)"/i);
                    if (verMatch) appVersion = verMatch[1];
                }

                const standardAuth = buildAuthHeader({ client: 'EmbyX', deviceName, deviceId, appVersion, token });

                if (headers && typeof headers.set === 'function') {
                    headers.set('Authorization', standardAuth);
                    headers.set('X-Emby-Authorization', standardAuth);
                } else {
                    headers = Object.assign({}, headers);
                    headers['Authorization'] = standardAuth;
                    headers['X-Emby-Authorization'] = standardAuth;
                    options.headers = headers;
                }
            }
            return origFetch.call(this, url, options);
        };
        window._jellyfinProxyEnabled = true;
    }

    // 2. Media and image URL path normalization
    function normalizeUrl(url) {
        if (typeof url === 'string' && getServerType() === 'jellyfin') {
            return url.replace(/\/emby(?=\/|\?|$)/, '').replace(/([?&])api_key=/i, '$1ApiKey=');
        }
        return url;
    }
    const fixUrlForJellyfin = normalizeUrl;

    // 3. Detect fnOS Video /v endpoint
    async function detectFnOS(server) {
        try {
            const res = await fetch(`${server}/v/api/v1/sys/version`, {
                headers: { 'Accept': 'application/json' }
            });
            if (!res.ok) return false;
            const data = await res.json();
            return data?.code === 0 && !!data?.data?.version;
        } catch (e) {
            return false;
        }
    }

    // 4. Server URL auto-completion and normalization
    function normalizeServerUrl(rawServer) {
        let server = (rawServer || '').trim().replace(/\/+$/, '');
        let isAutoFilled = false;
        if (server && !server.startsWith('http')) {
            const host = server.split(':')[0];
            const isIP = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(host) || host === 'localhost' || host === '127.0.0.1';

            if (location.protocol === 'https:' && isIP) {
                server = location.origin + '/app/juneix-embyx/proxy/8096';
                isAutoFilled = true;
            } else if (isIP && !server.includes(':')) {
                server = `http://${server}:8096`;
                isAutoFilled = true;
            } else {
                server = (isIP ? 'http://' : 'https://') + server;
            }
        }
        return { server, isAutoFilled };
    }

    // Build standard and Jellyfin 12 / Emby compatible Authorization header
    function buildAuthHeader({ client = 'EmbyX', deviceName = '', deviceId = '', appVersion = '', token = '' } = {}) {
        const c = client || 'EmbyX';
        const d = deviceName || (typeof localStorage !== 'undefined' && localStorage.getItem('emby_device_name')) || 'Web Browser';
        const id = deviceId || (typeof localStorage !== 'undefined' && localStorage.getItem('emby_device_id')) || ('EmbyX-' + Math.random().toString(36).slice(2, 10));
        const v = appVersion || (typeof localStorage !== 'undefined' && localStorage.getItem('emby_app_version')) || '1.1';
        let header = `MediaBrowser Client="${c}", Device="${d}", DeviceId="${id}", Version="${v}"`;
        if (token) header += `, Token="${token}"`;
        return header;
    }

    // Convenient helper to generate dual-auth headers object
    function getAuthHeaders(config = {}, token = '') {
        const t = token || config.token || (typeof localStorage !== 'undefined' && localStorage.getItem('emby_token')) || '';
        const header = buildAuthHeader({
            client: 'EmbyX',
            deviceName: config.deviceName,
            deviceId: config.deviceId,
            appVersion: config.appVersion,
            token: t
        });
        return {
            'Authorization': header,
            'X-Emby-Authorization': header
        };
    }

    // 5. Core authentication flow with fallback handling
    async function authenticate({ server, user, pwd, deviceName, deviceId, appVersion, isAutoFilled }) {
        const performAuth = async (targetServer) => {
            const fnOS = await detectFnOS(targetServer);

            // Determine server type (Priority: fnOS > Jellyfin > Default Emby)
            let serverType = 'emby';
            if (fnOS) {
                serverType = 'fnos';
            } else {
                for (const path of ['/System/Info/Public', '/emby/System/Info/Public']) {
                    try {
                        const res = await fetch(`${targetServer}${path}`);
                        if (!res.ok) continue;
                        const d = await res.json();
                        const prod = (d.ProductName || '').toLowerCase();
                        if (prod.includes('jellyfin')) {
                            serverType = 'jellyfin';
                            break;
                        }
                    } catch (e) {}
                }
            }

            setServerType(serverType);
            if (serverType === 'jellyfin') {
                enableJellyfinFetchProxy();
            }

            const authHeader = buildAuthHeader({ client: 'EmbyX', deviceName, deviceId, appVersion });
            const headers = {
                'Content-Type': 'application/json',
                'X-Emby-Authorization': authHeader,
                'Authorization': authHeader
            };
            const reqBody = JSON.stringify({
                Username: user,
                Pw: pwd || '',
                Password: pwd || ''
            });

            // Jellyfin 12 completely removed the /emby/ route; prefer root path for Jellyfin and fallback on 404
            const primaryPath = serverType === 'jellyfin' ? '/Users/AuthenticateByName' : '/emby/Users/AuthenticateByName';
            const fallbackPath = serverType === 'jellyfin' ? '/emby/Users/AuthenticateByName' : '/Users/AuthenticateByName';

            let res = await fetch(`${targetServer}${primaryPath}`, {
                method: 'POST',
                headers,
                body: reqBody
            });

            // If primary path returns 404, try alternative path
            if (res.status === 404) {
                try {
                    const fallbackRes = await fetch(`${targetServer}${fallbackPath}`, {
                        method: 'POST',
                        headers,
                        body: reqBody
                    });
                    if (fallbackRes.ok) {
                        res = fallbackRes;
                    }
                } catch (e) {}
            }

            if (!res.ok) {
                throw { status: res.status };
            }

            const data = await res.json();
            if (!data.AccessToken) {
                throw { status: 'NO_TOKEN' };
            }

            const userId = (data.SessionInfo && data.SessionInfo.UserId) || (data.User && data.User.Id) || (data.SessionInfo && data.SessionInfo.Id) || '';

            return { data, userId, serverType, fnOS: serverType === 'fnos' };
        };

        try {
            const auth = await performAuth(server);
            return { ...auth, finalServer: server };
        } catch (err) {
            if (isAutoFilled && server.endsWith(':8096')) {
                const fallbackServer = server.replace(/:8096$/, ':8090');
                try {
                    const auth = await performAuth(fallbackServer);
                    return { ...auth, finalServer: fallbackServer };
                } catch (fallbackErr) {
                    throw err;
                }
            } else if (isAutoFilled && server.endsWith('/proxy/8096')) {
                const fallbackServer = server.replace(/\/proxy\/8096$/, '');
                try {
                    const auth = await performAuth(fallbackServer);
                    return { ...auth, finalServer: fallbackServer };
                } catch (fallbackErr) {
                    throw err;
                }
            } else {
                throw err;
            }
        }
    }

    // 6. Media library Views and Playlists fetching
    async function fetchLibrariesData({ server, token, userId, deviceName, deviceId, appVersion }) {
        if (!server || !token || !userId) return { playlistsData: { Items: [] }, viewsDataRaw: { Items: [] } };
        const headers = getAuthHeaders({ deviceName, deviceId, appVersion, token });

        let playlistsData = { Items: [] };
        try {
            const playlistsRes = await fetch(`${server}/emby/Users/${userId}/Items?Recursive=true&IncludeItemTypes=Playlist&api_key=${token}`, {
                headers
            });
            if (playlistsRes.ok) {
                playlistsData = await playlistsRes.json();
            }
        } catch (e) {}

        const viewsRes = await fetch(`${server}/emby/Users/${userId}/Views?api_key=${token}`, {
            headers
        });
        const viewsDataRaw = viewsRes.ok ? await viewsRes.json() : { Items: [] };

        // Cache full views and playlists data
        localStorage.setItem('emby_views_cache', JSON.stringify({ playlists: playlistsData, views: viewsDataRaw }));

        return { playlistsData, viewsDataRaw };
    }

    // 7. Favorites management
    async function fetchFavorites({ server, token, userId, deviceName, deviceId, appVersion }) {
        if (!server || !token || !userId) return null;
        const headers = getAuthHeaders({ deviceName, deviceId, appVersion, token });
        const res = await fetch(`${server}/emby/Users/${userId}/Items?api_key=${token}&Recursive=true&Filters=IsFavorite&Fields=Id`, {
            headers
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const favIds = (data && data.Items) ? data.Items.map(i => String(i.Id)) : [];
        localStorage.setItem('emby_favorites', JSON.stringify(favIds));
        return new Set(favIds);
    }

    async function syncFavoriteStatus({ server, token, userId, itemId, isFav, deviceName, deviceId, appVersion }) {
        if (!server || !token || !userId || !itemId) return false;
        const method = isFav ? 'POST' : 'DELETE';
        const headers = getAuthHeaders({ deviceName, deviceId, appVersion, token });
        const res = await fetch(`${server}/emby/Users/${userId}/FavoriteItems/${itemId}?api_key=${token}`, {
            method,
            headers
        });
        return res.ok;
    }

    // 8. Delete media item
    async function deleteMediaItem({ server, token, itemId, deviceName, deviceId, appVersion }) {
        if (!server || !token || !itemId) return { ok: false, status: 400 };
        const headers = getAuthHeaders({ deviceName, deviceId, appVersion, token });
        const res = await fetch(`${server}/emby/Items/${itemId}?api_key=${token}`, {
            method: 'DELETE',
            headers
        });
        return { ok: res.ok, status: res.status };
    }

    // 9. Poster and avatar URL builder
    function getItemImageUrl(server, item, token, fallback = 'img/poster.webp') {
        if (item && item.ImageTags && item.ImageTags.Primary) {
            return fixUrlForJellyfin(`${server}/emby/Items/${item.Id}/Images/Primary?api_key=${token}`);
        }
        return fallback;
    }

    function getPersonImageUrl(server, personName) {
        if (!server || !personName) return 'img/avatar.webp';
        return fixUrlForJellyfin(`${server}/emby/Persons/${encodeURIComponent(personName)}/Images/Primary`);
    }

    // 10. GitHub update check
    async function checkGitHubUpdate(currentVersion) {
        const lastCheck = localStorage.getItem('embyx_last_update_check');
        const now = Date.now();
        if (lastCheck && now - parseInt(lastCheck) < 24 * 60 * 60 * 1000) return null;

        try {
            const response = await fetch('https://api.github.com/repos/juneix/EmbyX/releases/latest');
            if (!response.ok) return null;
            const data = await response.json();
            localStorage.setItem('embyx_last_update_check', now.toString());

            const latestTag = data.tag_name || '';
            const latestVersion = latestTag.replace('v', '').trim();

            const isNewer = (latest, current) => {
                const l = latest.split('.').map(Number);
                const c = current.split('.').map(Number);
                for (let i = 0; i < Math.max(l.length, c.length); i++) {
                    if ((l[i] || 0) > (c[i] || 0)) return true;
                    if ((l[i] || 0) < (c[i] || 0)) return false;
                }
                return false;
            };

            return {
                hasUpdate: isNewer(latestVersion, currentVersion),
                latestVersion,
                releaseUrl: data.html_url
            };
        } catch (e) {
            return null;
        }
    }

    // Enable fetch proxy on startup if server type is Jellyfin
    try {
        if (getServerType() === 'jellyfin') {
            enableJellyfinFetchProxy();
        }
    } catch (e) {}

    // 检测 iOS PWA (主屏幕应用) 并为 <html> 注入 .ios-pwa 标记
    // 用于精确区分 iOS 状态栏强制避让与其他设备（常规浏览器、Android APK）的自然间距
    try {
        const isIOS = /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 && /Mobile/i.test(navigator.userAgent));
        const isStandalone = window.navigator.standalone === true ||
            (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
        if (isIOS && isStandalone && document.documentElement) {
            document.documentElement.classList.add('ios-pwa');
        }
    } catch (e) {}

    // Mount to global window
    window.EmbyXCommon = {
        getServerType,
        setServerType,
        normalizeUrl,
        enableFetchProxy: enableJellyfinFetchProxy,
        enableJellyfinFetchProxy,
        fixUrlForJellyfin,
        detectFnOS,
        normalizeServerUrl,
        buildAuthHeader,
        getAuthHeaders,
        authenticate,
        fetchLibrariesData,
        fetchFavorites,
        syncFavoriteStatus,
        deleteMediaItem,
        getItemImageUrl,
        getPersonImageUrl,
        checkGitHubUpdate
    };

    // Direct exports for compatibility
    window.enableJellyfinFetchProxy = enableJellyfinFetchProxy;
    window.fixUrlForJellyfin = fixUrlForJellyfin;
    window.normalizeUrl = normalizeUrl;
})(window);
