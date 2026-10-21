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
    const PHOTO_EXTS = /\.(jpg|jpeg|png|gif|webp|bmp|avif|heic|heif|tif|tiff)(\?|#|$)/i;

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
                        { Id: this.basePath, Name: '全部', CollectionType: 'photos', Type: 'Folder', IsFolder: true },
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
                if (json.code !== 200) {
                    throw new Error(json.message || '获取列表失败');
                }
                // 越界页码时 OpenList 返回 content: null 而非空数组，视为空页
                const total = json.data?.total || 0;
                let contents = json.data?.content || [];

                if (searchTerm) {
                    const st = searchTerm.toLowerCase();
                    contents = contents.filter(f => f.name.toLowerCase().includes(st));
                }

                // Build fast file index for same-name poster and NFO lookup in this directory
                const fileMap = new Map();
                let dirPosterFile = null;
                for (let i = 0; i < contents.length; i++) {
                    const f = contents[i];
                    if (!f.is_dir) {
                        const lower = f.name.toLowerCase();
                        fileMap.set(lower, f);
                        if (!dirPosterFile && /^(poster|cover|folder)\.(jpg|jpeg|png|webp)$/i.test(lower)) {
                            dirPosterFile = f;
                        }
                    }
                }
                const dirPosterUrl = dirPosterFile ? this._imageUrl(dirPosterFile) : '';

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
                                posterUrl = this._imageUrl(cand);
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

                    // OpenList 不为视频提供可用的缩略图：条目的 f.thumb 是 ffmpeg 抽帧快照，
                    // 服务端未装 ffprobe 时直接 500。这里绝不取 f.thumb，只用同名/目录封面；
                    // 封面缺失就留空，由页面回退到本地占位图，不产生任何 5xx 请求。
                    const thumbUrl = f.is_dir ? '' : posterUrl;
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
                        _signedUrl: f.is_dir ? '' : this._imageUrl(f),
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
                    // 降级：复用列表条目自带的签名直链（裸 /d/ 无 sign 会被 401）
                    item._rawUrl = item._signedUrl || `${this.origin}/d${encodeURI(item.Path)}`;
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

        /**
         * Photo listing for the gallery (pic.html).
         * Unlike fetchItems (video / folder drill-down), this keeps only image files,
         * resolves the direct image URL as `thumb`, and maps it onto EmbyX's photo model.
         */
        async fetchPhotos({ path, startIndex = 0, limit = 150, ids = null, searchTerm = '' } = {}) {
            this.initFromStorage();

            // Favorites (client-side only): Id is the absolute path, so resolve each one
            // independently instead of listing a single directory.
            if (ids) {
                const paths = String(ids).split(',').map(s => s.trim()).filter(Boolean);
                const resolved = await Promise.all(paths.map(async (filePath) => {
                    try {
                        const getRes = await fetch(`${this.origin}/api/fs/get`, {
                            method: 'POST',
                            headers: this.getHeaders(),
                            body: JSON.stringify({ path: filePath })
                        });
                        if (!getRes.ok) return null;
                        const getJson = await getRes.json();
                        if (getJson.code !== 200 || !getJson.data) return null;
                        const d = getJson.data;
                        const name = d.name || filePath.split('/').pop() || filePath;
                        if (d.is_dir || !PHOTO_EXTS.test(name)) return null;
                        return this._makePhotoItem(filePath, name, d.size, d.modified, '', d);
                    } catch (e) {
                        return null;
                    }
                }));
                const items = resolved.filter(Boolean);
                await this._resolvePhotoUrls(items.filter(it => !it._photoUrl));
                return { Items: items, TotalRecordCount: items.length };
            }

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
                if (json.code !== 200) {
                    throw new Error(json.message || '获取照片列表失败');
                }
                // 越界页码时 OpenList 返回 content: null 而非空数组，视为空页
                const total = json.data?.total || 0;
                let contents = json.data?.content || [];

                if (searchTerm) {
                    const st = searchTerm.toLowerCase();
                    contents = contents.filter(f => f.name.toLowerCase().includes(st));
                }

                // Fast index of sibling files for same-name metadata sidecars
                const fileMap = new Map();
                for (let i = 0; i < contents.length; i++) {
                    if (!contents[i].is_dir) fileMap.set(contents[i].name.toLowerCase(), contents[i]);
                }

                const items = [];
                for (let i = 0; i < contents.length; i++) {
                    const f = contents[i];
                    if (f.is_dir || !PHOTO_EXTS.test(f.name)) continue;

                    const filePath = targetPath === '/' ? `/${f.name}` : `${targetPath}/${f.name}`;
                    const extIdx = f.name.lastIndexOf('.');
                    const baseName = extIdx !== -1 ? f.name.substring(0, extIdx) : f.name;
                    const lowerBase = baseName.toLowerCase();

                    // Same-name sidecars are still useful for the info drawer / EXIF hint
                    const nfoCand = fileMap.get(`${lowerBase}.nfo`);
                    const nfoPath = nfoCand ? (targetPath === '/' ? `/${nfoCand.name}` : `${targetPath}/${nfoCand.name}`) : '';

                    items.push(this._makePhotoItem(filePath, f.name, f.size, f.modified, nfoPath, f));
                }

                // 列表条目的 thumb 已带签名，无需逐张再请求 /api/fs/get
                await this._resolvePhotoUrls(items.filter(it => !it._photoUrl));

                return {
                    Items: items,
                    TotalRecordCount: total
                };
            } catch (e) {
                console.error('[OpenList] fetchPhotos error:', e);
                throw e;
            }
        }

        /**
         * 服务端签好的直链：`thumb` 字段形如 `/d/<path>?type=thumb&sign=...`。
         * 去掉 type=thumb 即得同签名原文件直链（图片是原图，视频是原始码流），
         * 不额外发请求，也避开了 `/d/<path>` 裸路径在签名校验下的 401。
         *
         * 仅用于**图片条目**：视频条目的 thumb 指向 ffmpeg 抽帧快照，
         * 服务端未装 ffprobe 时会 500，因此视频一律不取该字段。
         */
        _imageUrl(file) {
            if (!file || !file.thumb) return '';
            return this._stripThumbFlag(file.thumb);
        }

        _stripThumbFlag(url) {
            if (!url) return '';
            return url.replace(/([?&])type=thumb&?/, '$1').replace(/[?&]$/, '');
        }

        _makePhotoItem(filePath, fileName, size, modified, nfoPath, file) {
            const extIdx = fileName.lastIndexOf('.');
            const baseName = extIdx !== -1 ? fileName.substring(0, extIdx) : fileName;
            const url = file ? this._imageUrl(file) : '';
            // 服务端缩略图（type=thumb 管线）仅图片可用；实例未开启 thumbnail 时会回退原图
            const thumbUrl = file && file.thumb ? file.thumb : '';
            return {
                Id: filePath,
                Name: baseName,
                FileName: fileName,
                Type: 'Photo',
                MediaType: 'Photo',
                IsFolder: false,
                Path: filePath,
                size: size,
                modified: modified,
                thumb: url,
                ImageTags: url ? { Primary: url } : null,
                _photoUrl: url,
                _thumbUrl: thumbUrl,
                _isOpenList: true,
                _origin: this.origin,
                _nfoPath: nfoPath || '',
                _nfoLoaded: false
            };
        }

        /**
         * Bounded-concurrency direct-URL resolution for a page of photos.
         * OpenList 的 /d/ 裸路径在开启签名校验时会返回 401，必须以 /api/fs/get 返回的
         * raw_url（/p/...?sign=...）为准；并发限制避免一次 150 张照片打爆请求队列。
         */
        async _resolvePhotoUrls(items, concurrency = 6) {
            let cursor = 0;
            const worker = async () => {
                while (cursor < items.length) {
                    const item = items[cursor++];
                    try {
                        const res = await fetch(`${this.origin}/api/fs/get`, {
                            method: 'POST',
                            headers: this.getHeaders(),
                            body: JSON.stringify({ path: item.Path })
                        });
                        if (res.ok) {
                            const json = await res.json();
                            const raw = json.code === 200 ? json.data?.raw_url : '';
                            if (raw) {
                                item._photoUrl = raw;
                                item.thumb = raw;
                                item.ImageTags = { Primary: raw };
                                continue;
                            }
                        }
                    } catch (e) {}
                    // 降级：无签名裸路径（仅对关闭签名校验的实例有效）
                    const fallback = `${this.origin}/d${encodeURI(item.Path)}`;
                    if (!item._photoUrl) {
                        item._photoUrl = fallback;
                        item.thumb = fallback;
                        item.ImageTags = { Primary: fallback };
                    }
                }
            };
            await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
        }

        /**
         * 网格视图用的缩略图直链。服务端开启 thumbnail 时 f.thumb 指向压缩后的小图，
         * 可显著加快瀑布流加载；未开启时 thumb 为空或指向原图，此处统一回退到原图，
         * 页面只需给 <img> 挂 onerror 兜底即可，无需感知差异。
         */
        getPhotoThumbUrl(item) {
            if (!item) return '';
            return item._thumbUrl || this.getPhotoUrl(item);
        }

        /**
         * Direct image URL for a photo item. Resolved eagerly by fetchPhotos; if an item
         * reaches here without one, resolve it lazily and keep the fallback for now.
         */
        getPhotoUrl(item) {
            if (!item) return '';
            if (item._photoUrl) return item._photoUrl;
            this.initFromStorage();
            const filePath = item.Path || item.Id;
            if (!filePath) return '';
            const fallback = `${this.origin}/d${encodeURI(filePath)}`;
            item._photoUrl = fallback;
            this._resolvePhotoUrls([item], 1).catch(() => {});
            return fallback;
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
