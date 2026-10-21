/**
 * EmbyX Authentication & Configuration Controller (Zero-dependency, Vanilla JS)
 * Handles:
 * - LocalStorage configuration loading, saving, and reset
 * - Emby standard authentication with dual headers & fallback
 * - fnOS (飞牛影视) gateway OAuth handshake & token exchange
 */
(function (window) {
    'use strict';

    class AuthManager {
        /**
         * @param {object} app EmbyApp 实例
         * @param {object} [options]
         * @param {string} [options.keyPrefix='emby'] 页面私有的 localStorage 前缀，派生 <prefix>_autoplay 与 <prefix>_lib_id/_lib_type
         */
        constructor(app, options) {
            this.app = app || null;
            this.keyPrefix = (options && options.keyPrefix) || 'emby';
            this._oauthExchanging = false;
            this._fnosOAuthUrl = null;
        }

        loadConfig() {
            if (!this.app) return;
            const app = this.app;

            app.config.server = localStorage.getItem('emby_server') || '';
            app.config.user = localStorage.getItem('emby_user') || '';
            app.config.token = localStorage.getItem('emby_token') || '';
            app.config.userId = localStorage.getItem('emby_uid') || '';
            // 播放质量与短剧模式仅 index.html 使用，pic.html 无对应控件，按需跳过
            if (app.dom.configPlayQuality) {
                app.config.playQuality = localStorage.getItem('emby_play_quality') || 'direct';
                app.config.useStatic = (app.config.playQuality === 'direct');
            }
            app.config.autoplay = localStorage.getItem(this.keyPrefix + '_autoplay') !== 'false';
            if (app.dom.configShortDrama) app.config.shortDrama = localStorage.getItem('emby_shortdrama') === 'true';
            app.config.deleteMode = localStorage.getItem('emby_delete_mode') === 'true';
            app.config.fnOS = localStorage.getItem('emby_fnOS') === 'true';
            app.config.serverId = localStorage.getItem('emby_server_id') || '';

            // 生成或读取设备唯一 ID
            if (!localStorage.getItem('emby_device_id')) {
                const randomId = Math.random().toString(36).slice(2, 10);
                localStorage.setItem('emby_device_id', `EmbyX-${randomId}`);
            }
            app.config.deviceId = localStorage.getItem('emby_device_id');

            // 读取交互状态
            const savedScale = localStorage.getItem('emby_is_scale_fill');
            if (savedScale !== null) app.state.isScaleFill = savedScale === 'true';

            const savedMute = localStorage.getItem('emby_is_muted');
            if (savedMute !== null && 'isMuted' in app.state) app.state.isMuted = savedMute === 'true';

            const savedPlayMode = localStorage.getItem('emby_play_mode');
            if (savedPlayMode !== null) app.state.playMode = savedPlayMode;
            if (app.config.shortDrama) app.state.playMode = 'sequence';

            const savedLibId = localStorage.getItem(this.keyPrefix + '_lib_id');
            const savedLibType = localStorage.getItem(this.keyPrefix + '_lib_type');
            if (savedLibId) {
                app.state.currentLibraryId = savedLibId;
                app.state.currentLibraryType = savedLibType || 'library';
            } else if (EmbyXCommon.getServerType() === 'openlist') {
                const openlistBase = localStorage.getItem('openlist_base_path') || '/';
                app.state.currentLibraryId = openlistBase;
                app.state.currentLibraryType = 'library';
            } else {
                app.state.currentLibraryId = 'favorites';
                app.state.currentLibraryType = 'favorites';
            }

            // 填充 UI
            if (app.dom.configServer) app.dom.configServer.value = app.config.server;
            if (app.dom.configUser) app.dom.configUser.value = app.config.user;
            if (app.dom.configPwd && app.config.token) {
                const pwdLen = parseInt(localStorage.getItem('emby_pwd_len') || '0');
                app.dom.configPwd.value = pwdLen > 0 ? '*'.repeat(pwdLen) : '';
            }
            if (app.dom.configPlayQuality) app.dom.configPlayQuality.value = app.config.playQuality;
            if (app.dom.configAutoplay) app.dom.configAutoplay.checked = app.config.autoplay;
            if (app.dom.configShortDrama) app.dom.configShortDrama.checked = app.config.shortDrama;
            if (app.dom.configDeleteMode) app.dom.configDeleteMode.checked = app.config.deleteMode;

            // 页面私有配置（pic.html 的轮播间隔与杂志模式），由页面自行接管
            if (typeof app.loadPageConfig === 'function') app.loadPageConfig();

            // 基于配置同步 UI
            if (app.dom.deleteBtn) app.dom.deleteBtn.style.display = app.config.deleteMode ? 'flex' : 'none';
            if (app.dom.playModeBtn) {
                app.dom.playModeBtn.innerHTML = `<i data-lucide="${app.config.autoplay ? 'repeat' : 'repeat-1'}" class="stroke-current w-5 h-5"></i>`;
                if (window.lucide) lucide.createIcons();
            }

            // Jellyfin 初始化挂载
            if (window.EmbyXCommon && EmbyXCommon.getServerType() === 'jellyfin' && window.enableJellyfinFetchProxy) {
                enableJellyfinFetchProxy();
            }

            // 服务器类型图标回显
            EmbyXCommon.updateServerTypeIcon(document.getElementById('serverTypeIcon'));

            // 同步配置
            if (window.DonateManager && typeof window.DonateManager.syncFromServer === 'function') {
                window.DonateManager.syncFromServer();
            }
        }

        initFnosOAuth() {
            // 1. URL 中的重定向 code
            const urlParams = new URLSearchParams(window.location.search);
            const code = urlParams.get('code');
            if (code) {
                window.history.replaceState({}, document.title, window.location.pathname);
                this.handleFnosOAuthCode(code);
                return;
            }

            // 2. postMessage 与 storage 监听
            window.addEventListener('message', (e) => {
                if (e.data && e.data.type === 'FNOS_OAUTH_CODE' && e.data.code) {
                    this.handleFnosOAuthCode(e.data.code);
                }
            });
            window.addEventListener('storage', (e) => {
                if (e.key === 'fnos_oauth_code' && e.newValue) {
                    try {
                        const parsed = JSON.parse(e.newValue);
                        if (parsed && parsed.code) {
                            localStorage.removeItem('fnos_oauth_code');
                            this.handleFnosOAuthCode(parsed.code);
                        }
                    } catch (err) {}
                }
            });

            // 3. 探测网关
            this.detectFnosGateway();
        }

        async detectFnosGateway() {
            if (!this.app) return;
            const app = this.app;
            try {
                if (app.config.token && app.config.fnOS) return;

                let base = window.location.pathname.replace(/\/[^/]*\.[^/]+$/, '');
                base = base.endsWith('/') ? base : base + '/';
                const res = await fetch(base + 'api/fnos/oauth-config');
                if (!res.ok) return;
                const config = await res.json();
                if (!config.is_gateway || !config.oauth_url) return;

                this._fnosOAuthUrl = config.oauth_url;
                const box = document.getElementById('fnosOAuthBox');
                const titleEl = document.getElementById('fnosOAuthTitle');
                if (box) {
                    if (titleEl && config.server_name) {
                        titleEl.textContent = `已发现飞牛影视：${config.server_name}`;
                    }
                    box.classList.remove('hidden');
                    if (window.lucide) lucide.createIcons({ root: box });
                }
            } catch (e) {
                // 静默忽略
            }
        }

        openFnosOAuth(oauthUrl) {
            const width = 520;
            const height = 650;
            const left = Math.max(0, (window.screen.width - width) / 2);
            const top = Math.max(0, (window.screen.height - height) / 2);
            return window.open(
                oauthUrl,
                'fnos_oauth',
                `width=${width},height=${height},top=${top},left=${left},menubar=no,toolbar=no,location=no,status=no,resizable=yes`
            );
        }

        async handleFnosOAuthCode(code) {
            if (!this.app || !code || this._oauthExchanging) return;
            const app = this.app;
            this._oauthExchanging = true;
            app.toggleLoading(true);
            app.showToast('正在完成飞牛影视认证...');

            try {
                let base = window.location.pathname.replace(/\/[^/]*\.[^/]+$/, '');
                base = base.endsWith('/') ? base : base + '/';
                const res = await fetch(base + 'api/fnos/oauth-exchange', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code })
                });
                if (!res.ok) throw new Error(`换票请求失败: ${res.status}`);
                const data = await res.json();
                if (!data.AccessToken) throw new Error('未能获取有效 AccessToken');

                const cleanPath = window.location.pathname.replace(/\/[^/]*\.[^/]+$/, '').replace(/\/+$/, '');
                const serverUrl = window.location.origin + cleanPath;
                const userId = (data.SessionInfo && data.SessionInfo.UserId) || (data.User && data.User.Id) || '1';
                const userName = (data.User && data.User.Name) || 'fnos_user';

                localStorage.setItem('emby_server', serverUrl);
                localStorage.setItem('emby_user', userName);
                localStorage.setItem('emby_token', data.AccessToken);
                localStorage.setItem('emby_uid', userId);
                localStorage.setItem('emby_fnOS', 'true');
                localStorage.setItem('emby_static', 'true');
                localStorage.setItem('emby_pwd_len', '0');

                localStorage.removeItem('emby_views_cache');
                localStorage.removeItem('emby_favorites');
                localStorage.removeItem('emby_lib_id');
                localStorage.removeItem('emby_lib_type');

                app.showToast('✅ 飞牛影视授权成功，正在加载...', 2000);
                setTimeout(() => location.reload(), 800);
            } catch (e) {
                console.error('OAuth exchange error:', e);
                app.showToast(`❌ 飞牛授权失败: ${e.message || '未知错误'}`);
                app.toggleLoading(false);
            } finally {
                this._oauthExchanging = false;
            }
        }

        async saveConfig() {
            if (!this.app) return;
            const app = this.app;

            let server = app.dom.configServer.value.trim().replace(/\/$/, "");
            const user = app.dom.configUser.value.trim();
            const pwd = app.dom.configPwd.value.trim();

            const playQuality = app.dom.configPlayQuality ? app.dom.configPlayQuality.value : 'direct';
            const isStatic = playQuality === 'direct';
            const autoplay = app.dom.configAutoplay ? app.dom.configAutoplay.checked : true;
            const shortDrama = app.dom.configShortDrama ? app.dom.configShortDrama.checked : false;
            const deleteMode = app.dom.configDeleteMode ? app.dom.configDeleteMode.checked : false;

            if (!server || !user) return app.showToast('请填写完整信息');

            app.toggleLoading(true);

            const { server: normalizedServer, isAutoFilled } = EmbyXCommon.normalizeServerUrl(server);
            server = normalizedServer;

            try {
                const pwdLen = parseInt(localStorage.getItem('emby_pwd_len') || '0');
                const isUnchangedPwd = /^\*+$/.test(pwd) && pwd.length === pwdLen && pwdLen > 0;
                if (isUnchangedPwd && app.config.token && app.config.server === server && app.config.user === user) {
                    const fnOS = app.config.fnOS;
                    this.savePrefs({ playQuality, isStatic, autoplay, shortDrama, deleteMode, fnOS });
                    if (typeof app.savePageConfig === 'function') app.savePageConfig();

                    localStorage.removeItem('emby_views_cache');
                    localStorage.removeItem('emby_favorites');
                    location.reload();
                    return;
                }

                const auth = await EmbyXCommon.authenticate({
                    server,
                    user,
                    pwd,
                    deviceName: app.config.deviceName,
                    deviceId: app.config.deviceId,
                    appVersion: app.config.appVersion,
                    isAutoFilled
                });

                const { data, userId, fnOS, serverType, finalServer } = auth;
                server = finalServer;

                const serverId = data.ServerId || (data.User && data.User.ServerId) || (data.SessionInfo && data.SessionInfo.ServerId) || '';
                if (serverId) {
                    localStorage.setItem('emby_server_id', serverId);
                }

                if (serverType) {
                    localStorage.setItem('embyx_server_type', serverType);
                }

                localStorage.setItem('emby_server', server);
                localStorage.setItem('emby_user', user);
                localStorage.setItem('emby_token', data.AccessToken);
                localStorage.setItem('emby_uid', userId);
                this.savePrefs({ playQuality, isStatic, autoplay, shortDrama, deleteMode, fnOS });
                if (typeof app.savePageConfig === 'function') app.savePageConfig();

                app.config = { ...app.config, server, user, token: data.AccessToken, userId, serverId, serverType, playQuality, useStatic: isStatic, autoplay, shortDrama, deleteMode, fnOS };

                const pwdLen2 = pwd ? pwd.length : 0;
                localStorage.setItem('emby_pwd_len', pwdLen2);
                app.dom.configPwd.value = pwdLen2 > 0 ? '*'.repeat(pwdLen2) : '';
                if (app.dom.deleteBtn) app.dom.deleteBtn.style.display = deleteMode ? 'flex' : 'none';
                if (app.dom.playModeBtn) {
                    app.dom.playModeBtn.innerHTML = `<i data-lucide="${autoplay ? 'repeat' : 'repeat-1'}" class="stroke-current w-5 h-5"></i>`;
                    if (window.lucide) lucide.createIcons();
                }

                localStorage.removeItem('emby_views_cache');
                localStorage.removeItem('emby_favorites');
                localStorage.removeItem(this.keyPrefix + '_lib_id');
                localStorage.removeItem(this.keyPrefix + '_lib_type');
                location.reload();
            } catch (e) {
                console.error('saveConfig error:', e);
                const status = e?.status;
                if (status === 401 || status === 'NO_TOKEN') {
                    app.showToast('❌ 认证失败：用户名或密码错误');
                } else if (status === 404) {
                    app.showToast('❌ 连接失败：请检查端口号');
                } else if (status) {
                    app.showToast('❌ 连接失败 ' + status + '，请检查 Emby 日志');
                } else {
                    const msg = e?.message || '';
                    const isHttps = location.protocol === 'https:';
                    const targetHttp = server.startsWith('http:');
                    if (isHttps && targetHttp) {
                        app.showToast('❌ 连接失败：请求被拦截 (HTTPS -> HTTP)');
                    } else if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('ERR_CONNECTION')) {
                        app.showToast('❌ 无法连接服务器');
                    } else {
                        app.showToast('❌ 连接失败：' + (msg || '未知错误'));
                    }
                }
            } finally {
                app.toggleLoading(false);
            }
        }

        // 统一落盘公共偏好；页面私有键（pic 的轮播/杂志模式）由页面钩子 savePageConfig 自行处理
        savePrefs({ playQuality, isStatic, autoplay, shortDrama, deleteMode, fnOS }) {
            localStorage.setItem(this.keyPrefix + '_autoplay', autoplay);
            const dom = (this.app && this.app.dom) || {};
            if (dom.configPlayQuality) {
                localStorage.setItem('emby_play_quality', playQuality);
                localStorage.setItem('emby_static', isStatic);
            }
            if (dom.configShortDrama) localStorage.setItem('emby_shortdrama', shortDrama);
            localStorage.setItem('emby_delete_mode', deleteMode);
            if (fnOS) localStorage.setItem('emby_fnOS', 'true');
            else localStorage.removeItem('emby_fnOS');
        }

        async resetConfig() {
            if (confirm('确定要重置所有配置吗？')) {
                try {
                    if (window.DonateManager) {
                        if (typeof window.DonateManager.saveToServerPrefs === 'function') {
                            await window.DonateManager.saveToServerPrefs(false);
                        }
                        if (typeof window.DonateManager._clearAllEggProofs === 'function') {
                            window.DonateManager._clearAllEggProofs();
                        }
                    }
                } catch (e) {
                    console.warn('Reset server prefs failed (silent):', e);
                }

                try {
                    // 1. Android APK 原生私有缓存目录与 WebView 磁盘缓存彻底清除
                    if (window.EmbyXNative && typeof window.EmbyXNative.clearAppCache === 'function') {
                        window.EmbyXNative.clearAppCache();
                    }
                } catch (e) {
                    console.warn('Native clearAppCache failed:', e);
                }

                try {
                    // 2. 深度清理 PWA / Service Worker 离线缓存 (CacheStorage)
                    if (typeof window !== 'undefined' && window.caches && typeof window.caches.keys === 'function') {
                        const cacheKeys = await window.caches.keys();
                        await Promise.all(cacheKeys.map(key => window.caches.delete(key)));
                    }
                } catch (e) {
                    console.warn('Clear CacheStorage failed:', e);
                }

                try {
                    // 3. 深度清理 IndexedDB 本地数据库
                    if (typeof window !== 'undefined' && window.indexedDB && typeof window.indexedDB.databases === 'function') {
                        const dbs = await window.indexedDB.databases();
                        if (Array.isArray(dbs)) {
                            dbs.forEach(db => {
                                if (db.name) window.indexedDB.deleteDatabase(db.name);
                            });
                        }
                    }
                } catch (e) {
                    console.warn('Clear IndexedDB failed:', e);
                }

                try {
                    if (typeof sessionStorage !== 'undefined') {
                        sessionStorage.clear();
                    }
                } catch (e) {}

                localStorage.clear();
                location.reload();
            }
        }
    }

    window.AuthManager = AuthManager;
})(window);
