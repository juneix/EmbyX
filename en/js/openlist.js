/**
 * EmbyX OpenList (AList API) Adapter (Zero-dependency, Vanilla JS)
 * Handles:
 * - Server detection & URL / path parsing
 * - Guest mode & Username/Password (/api/auth/login) authentication
 * - Folder structure to Media Library (Views) mapping
 * - Video listing with real pagination (page / per_page)
 * - Stream direct URL (raw_url) lazy resolution
 */
(function (window) {
    'use strict';

    const VIDEO_EXTS = /\.(mp4|mkv|webm|mov|m4v|flv|ts|avi)(\?|#|$)/i;

    class OpenListManager {
        constructor() {
            this.origin = '';
            this.basePath = '/';
            this.token = '';
            this.user = '';
            this.serverId = '';
            this._rawUrlCache = new Map();
        }

        parseUrl(serverUrl) {
            try {
                let s = (serverUrl || '').trim().replace(/\/+$/, '');
                if (!s.startsWith('http://') && !s.startsWith('https://')) {
                    s = 'http://' + s;
                }
                const u = new URL(s);
                let origin = u.origin;
                let basePath = decodeURIComponent(u.pathname).replace(/\/+$/, '') || '/';
                return { origin, basePath };
            } catch (e) {
                return { origin: (serverUrl || '').trim().replace(/\/+$/, ''), basePath: '/' };
            }
        }

        getHeaders() {
            const headers = { 'Content-Type': 'application/json' };
            const token = this.token || (typeof localStorage !== 'undefined' && localStorage.getItem('openlist_token')) || '';
            if (token) {
                headers['Authorization'] = token;
            }
            return headers;
        }

        async detect(serverUrl) {
            const { origin, basePath } = this.parseUrl(serverUrl);
            if (!origin) return false;

            // 1. Check if port is 5244 or 5245
            try {
                const u = new URL(origin);
                if (u.port === '5244' || u.port === '5245') {
                    try {
                        const r = await fetch(`${origin}/api/public/settings`, { method: 'GET' });
                        if (r.ok) {
                            const data = await r.json();
                            if (data && data.code === 200) return true;
                        }
                    } catch (e) {}
                    return true;
                }
            } catch (e) {}

            // 2. Check /api/public/settings
            try {
                const r = await fetch(`${origin}/api/public/settings`, { method: 'GET' });
                if (r.ok) {
                    const data = await r.json();
                    if (data && data.code === 200) return true;
                }
            } catch (e) {}

            // 3. Check /api/fs/list on basePath
            try {
                const r = await fetch(`${origin}/api/fs/list`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: basePath || '/', page: 1, per_page: 1 })
                });
                if (r.ok) {
                    const data = await r.json();
                    if (data && (data.code === 200 || data.code === 401)) return true;
                }
            } catch (e) {}

            return false;
        }

        async resolveServerId(origin, token, isGuest) {
            // 1. Try public settings first (shared across all clients, including guest)
            try {
                const res = await fetch(`${origin}/api/public/settings`, { method: 'GET' });
                if (res.ok) {
                    const json = await res.json();
                    const ssoOrigin = json.data?.sso_postmessage_origin || '';
                    if (ssoOrigin.startsWith('embyx:')) {
                        const uuid = ssoOrigin.slice(6).trim();
                        if (uuid.length >= 16) {
                            this.serverId = uuid;
                            if (typeof localStorage !== 'undefined') {
                                localStorage.setItem('emby_server_id', uuid);
                            }
                            return uuid;
                        }
                    }
                }
            } catch (e) {
                console.warn('[OpenList] resolveServerId public settings check failed:', e);
            }

            // 2. If not found and user has logged in with credentials, check if admin can initialize it
            if (!isGuest && token) {
                try {
                    const tokenRes = await fetch(`${origin}/api/admin/setting/get?key=token`, {
                        method: 'GET',
                        headers: { 'Authorization': token }
                    });
                    if (tokenRes.ok) {
                        const tokenJson = await tokenRes.json();
                        const tokenVal = tokenJson.data?.value || '';
                        const match = tokenVal.match(/[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}/);
                        if (match) {
                            const uuid = match[0].replace(/-/g, '').toLowerCase();
                            await fetch(`${origin}/api/admin/setting/save`, {
                                method: 'POST',
                                headers: {
                                    'Authorization': token,
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify([{ key: 'sso_postmessage_origin', value: 'embyx:' + uuid }])
                            });
                            this.serverId = uuid;
                            if (typeof localStorage !== 'undefined') {
                                localStorage.setItem('emby_server_id', uuid);
                            }
                            return uuid;
                        }
                    }
                } catch (e) {
                    console.warn('[OpenList] resolveServerId admin injection failed:', e);
                }
            }

            // 3. Fallback for unbound servers
            const fallbackId = 'openlist-unbound-' + (btoa(origin).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16));
            this.serverId = fallbackId;
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('emby_server_id', fallbackId);
            }
            return fallbackId;
        }

        async authenticate({ server, user, pwd }) {
            const { origin, basePath } = this.parseUrl(server);
            this.origin = origin;
            this.basePath = basePath;
            this.user = user || 'guest';

            let token = '';
            // If user is 'guest' (case-insensitive) or empty, treat as pure anonymous guest (no token sent)
            const isGuest = (!user || user.toLowerCase() === 'guest' || !pwd);
            if (!isGuest && pwd) {
                // Account login mode
                const res = await fetch(`${origin}/api/auth/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: user, password: pwd })
                });
                if (!res.ok) throw new Error(`OpenList 登录失败: HTTP ${res.status}`);
                const data = await res.json();
                if (data.code !== 200 || !data.data?.token) {
                    throw new Error(data.message || 'OpenList 账号或密码错误');
                }
                token = data.data.token;
                this.token = token;
            } else {
                // Anonymous mode (like OrbitMate, no Authorization header)
                const reqBody = { path: basePath, page: 1, per_page: 1 };
                if (pwd) reqBody.password = pwd; // Support folder password

                const res = await fetch(`${origin}/api/fs/list`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(reqBody)
                });
                if (!res.ok) throw new Error(`OpenList 访问失败: HTTP ${res.status}`);
                const data = await res.json();
                if (data.code === 401) {
                    const msg = data.message || '';
                    if (/guest.*disabled/i.test(msg)) {
                        throw new Error('此服务器已禁用 Guest 访客，请填写账号和密码登录');
                    }
                    throw new Error(msg || '此目录需要密码或登录访问');
                }
                if (data.code !== 200) {
                    throw new Error(data.message || 'OpenList 连接失败');
                }
            }

            const serverId = await this.resolveServerId(origin, token, isGuest);

            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('embyx_server_type', 'openlist');
                localStorage.setItem('openlist_origin', origin);
                localStorage.setItem('openlist_base_path', basePath);
                localStorage.setItem('emby_server_id', serverId);
                if (token) localStorage.setItem('openlist_token', token);
                else localStorage.removeItem('openlist_token');
                if (pwd && isGuest) localStorage.setItem('openlist_dir_pwd', pwd);
                else localStorage.removeItem('openlist_dir_pwd');
            }

            return {
                server: origin + basePath,
                user: this.user,
                token: token || 'guest_token',
                userId: 'openlist-user',
                serverId: serverId
            };
        }

        initFromStorage() {
            if (typeof localStorage === 'undefined') return;
            this.origin = localStorage.getItem('openlist_origin') || '';
            this.basePath = localStorage.getItem('openlist_base_path') || '/';
            this.token = localStorage.getItem('openlist_token') || '';
            this.user = localStorage.getItem('emby_user') || 'guest';
            this.serverId = localStorage.getItem('emby_server_id') || '';
            if (!this.origin && localStorage.getItem('emby_server')) {
                const parsed = this.parseUrl(localStorage.getItem('emby_server'));
                this.origin = parsed.origin;
                this.basePath = parsed.basePath;
            }
        }

        async fetchViews() {
            this.initFromStorage();
            if (!this.origin) return { Items: [] };
            try {
                const res = await fetch(`${this.origin}/api/fs/list`, {
                    method: 'POST',
                    headers: this.getHeaders(),
                    body: JSON.stringify({ path: this.basePath, page: 1, per_page: 0 })
                });
                if (!res.ok) return { Items: [] };
                const json = await res.json();
                if (json.code !== 200 || !json.data?.content) return { Items: [] };

                const dirs = json.data.content.filter(f => f.is_dir);
                const items = dirs.map(d => ({
                    Id: this.basePath === '/' ? `/${d.name}` : `${this.basePath}/${d.name}`,
                    Name: d.name,
                    CollectionType: 'folders',
                    Type: 'Folder',
                    IsFolder: true
                }));

                return {
                    Items: [
                        { Id: this.basePath, Name: '全部视频', CollectionType: 'movies', Type: 'Folder', IsFolder: true },
                        ...items
                    ]
                };
            } catch (e) {
                console.error('[OpenList] fetchViews error:', e);
                return { Items: [] };
            }
        }

        async fetchItems({ path, startIndex = 0, limit = 50, isFolderMode = false, searchTerm = '' } = {}) {
            this.initFromStorage();
            const targetPath = path || this.basePath || '/';
            const page = Math.floor(startIndex / limit) + 1;
            const perPage = limit;

            try {
                const res = await fetch(`${this.origin}/api/fs/list`, {
                    method: 'POST',
                    headers: this.getHeaders(),
                    body: JSON.stringify({
                        path: targetPath,
                        page: page,
                        per_page: perPage,
                        refresh: false
                    })
                });
                if (!res.ok) throw new Error(`OpenList HTTP ${res.status}`);
                const json = await res.json();
                if (json.code !== 200 || !json.data?.content) {
                    throw new Error(json.message || '获取列表失败');
                }

                const total = json.data.total || 0;
                let contents = json.data.content;

                if (searchTerm) {
                    const st = searchTerm.toLowerCase();
                    contents = contents.filter(f => f.name.toLowerCase().includes(st));
                }

                // Build fast file index for same-name poster and NFO lookup in this directory
                const fileMap = new Map();
                let dirPoster = '';
                for (let i = 0; i < contents.length; i++) {
                    const f = contents[i];
                    if (!f.is_dir) {
                        const lower = f.name.toLowerCase();
                        fileMap.set(lower, f);
                        if (!dirPoster && /^(poster|cover|folder)\.(jpg|jpeg|png|webp)$/i.test(lower)) {
                            dirPoster = targetPath === '/' ? `/${f.name}` : `${targetPath}/${f.name}`;
                        }
                    }
                }
                const dirPosterUrl = dirPoster ? `${this.origin}/d${encodeURI(dirPoster)}` : '';

                const items = [];
                for (let i = 0; i < contents.length; i++) {
                    const f = contents[i];
                    const isVideo = VIDEO_EXTS.test(f.name);
                    if (!f.is_dir && !isVideo) continue;
                    if (f.is_dir && !isFolderMode) continue;

                    const filePath = targetPath === '/' ? `/${f.name}` : `${targetPath}/${f.name}`;
                    const extIdx = f.name.lastIndexOf('.');
                    const baseName = extIdx !== -1 ? f.name.substring(0, extIdx) : f.name;
                    const lowerBase = baseName.toLowerCase();

                    // Same-name poster match (or directory poster fallback)
                    let posterUrl = '';
                    if (!f.is_dir) {
                        const posterCandidates = [
                            `${lowerBase}.jpg`, `${lowerBase}.jpeg`, `${lowerBase}.png`, `${lowerBase}.webp`,
                            `${lowerBase}-poster.jpg`, `${lowerBase}-poster.jpeg`, `${lowerBase}-poster.png`, `${lowerBase}-poster.webp`,
                            `${lowerBase}.cover.jpg`, `${lowerBase}.cover.jpeg`, `${lowerBase}.cover.png`, `${lowerBase}.cover.webp`
                        ];
                        for (let j = 0; j < posterCandidates.length; j++) {
                            const cand = fileMap.get(posterCandidates[j]);
                            if (cand) {
                                const p = targetPath === '/' ? `/${cand.name}` : `${targetPath}/${cand.name}`;
                                posterUrl = `${this.origin}/d${encodeURI(p)}`;
                                break;
                            }
                        }
                        if (!posterUrl && dirPosterUrl) {
                            posterUrl = dirPosterUrl;
                        }
                    }

                    // Same-name NFO match
                    let nfoPath = '';
                    if (!f.is_dir) {
                        const nfoCand = fileMap.get(`${lowerBase}.nfo`);
                        if (nfoCand) {
                            nfoPath = targetPath === '/' ? `/${nfoCand.name}` : `${targetPath}/${nfoCand.name}`;
                        }
                    }

                    const thumbUrl = f.thumb || posterUrl || '';
                    items.push({
                        Id: filePath,
                        Name: f.is_dir ? f.name : baseName,
                        FileName: f.name,
                        Type: f.is_dir ? 'Folder' : 'Movie',
                        MediaType: f.is_dir ? 'Folder' : 'Video',
                        IsFolder: f.is_dir,
                        Path: filePath,
                        size: f.size,
                        thumb: thumbUrl,
                        ImageTags: thumbUrl ? { Primary: thumbUrl } : null,
                        _isOpenList: true,
                        _rawUrl: null,
                        _origin: this.origin,
                        _nfoPath: nfoPath,
                        _nfoLoaded: false
                    });
                }

                // Parallel fetch direct raw_url via /api/fs/get (same pattern as OrbitMate baji.html)
                await Promise.all(items.map(async (item) => {
                    if (item.IsFolder) return;
                    try {
                        const getRes = await fetch(`${this.origin}/api/fs/get`, {
                            method: 'POST',
                            headers: this.getHeaders(),
                            body: JSON.stringify({ path: item.Path })
                        });
                        if (getRes.ok) {
                            const getJson = await getRes.json();
                            if (getJson.code === 200 && getJson.data?.raw_url) {
                                item._rawUrl = getJson.data.raw_url;
                                return;
                            }
                        }
                    } catch (e) {}
                    item._rawUrl = `${this.origin}/d${encodeURI(item.Path)}`;
                }));

                return {
                    Items: items,
                    TotalRecordCount: total
                };
            } catch (e) {
                console.error('[OpenList] fetchItems error:', e);
                throw e;
            }
        }

        async loadNfo(item) {
            if (!item || !item._nfoPath || item._nfoLoaded) return;
            try {
                const res = await fetch(`${this.origin}/d${encodeURI(item._nfoPath)}`);
                if (!res.ok) return;
                const text = await res.text();
                const xml = new DOMParser().parseFromString(text, 'text/xml');
                const title = xml.querySelector('title')?.textContent;
                const plot = xml.querySelector('plot, outline')?.textContent;
                const year = xml.querySelector('year, premiered')?.textContent;
                if (title && title.trim()) item.Name = title.trim();
                if (plot && plot.trim()) item.Overview = plot.trim();
                if (year) {
                    const y = parseInt(year, 10);
                    if (!isNaN(y)) item.ProductionYear = y;
                }
                item._nfoLoaded = true;
            } catch (e) {
                console.warn('[OpenList] parse NFO error:', e);
            }
        }

        async getPlayUrl(item) {
            if (!item) return '';
            if (item._rawUrl) return item._rawUrl;
            this.initFromStorage();
            const filePath = item.Path || item.Id;
            try {
                const res = await fetch(`${this.origin}/api/fs/get`, {
                    method: 'POST',
                    headers: this.getHeaders(),
                    body: JSON.stringify({ path: filePath })
                });
                if (res.ok) {
                    const json = await res.json();
                    if (json.code === 200 && json.data?.raw_url) {
                        item._rawUrl = json.data.raw_url;
                        return item._rawUrl;
                    }
                }
            } catch (e) {}
            return `${this.origin}/d${encodeURI(filePath)}`;
        }
    }

    window.OpenListManager = new OpenListManager();
})(window);
