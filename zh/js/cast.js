/**
 * EmbyX Cast Controller (Zero-dependency, Vanilla JS)
 * Handles:
 * - W3C Remote Playback API (Chromecast / Google Cast / Edge Miracast)
 * - Apple WebKit AirPlay API (Safari on iOS & macOS)
 * - Emby & Jellyfin /Sessions DLNA device discovery & remote play
 * - Native UPnP/DLNA renderer discovery & AVTransport control (APK only)
 * - iOS Control Center style pill device selector modal
 * - Pure black casting console & power disconnect button
 * - Seamless swipe-to-next continuous casting
 */
(function (window) {
    'use strict';

    class CastManager {
        constructor(app) {
            this.app = app;
            this.activeSessionId = null;
            this.activeSessionName = '';
            this.heartbeatTimer = null;
            this.isCasting = false;
            this.isPaused = false;
            // 活跃通道：'server' (Emby/Jellyfin /Sessions), 'native' (APK SSDP DLNA), 'system' (AirPlay / RemotePlayback)
            this.activeChannel = null;
            this.activeNative = null;
            this._nativeDevices = [];
            this._nativeScanning = false;
            this._remoteAvailable = false;
            this._preparedNativeUrl = '';
            this._preparedVideoId = '';
            this._boundVideos = new Set();
            this._lastSessions = [];

            this.dom = {
                castBtn: document.getElementById('castBtn'),
                castModal: document.getElementById('castModal'),
                castModalCard: document.getElementById('castModalCard'),
                castDeviceList: document.getElementById('castDeviceList'),
                castScreenOverlay: document.getElementById('castScreenOverlay'),
                castScreenDeviceName: document.getElementById('castScreenDeviceName'),
                switchCastDeviceBtn: document.getElementById('switchCastDeviceBtn'),
                castPlayPauseBtn: document.getElementById('castPlayPauseBtn'),
                castPlayPauseIcon: document.getElementById('castPlayPauseIcon')
            };

            this.init();
            this.initSystemCastAvailability();
        }

        init() {
            if (this.dom.castBtn) {
                this.dom.castBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (this.isCasting) {
                        this.disconnect(true);
                    } else {
                        this.showPicker();
                    }
                };
            }

            if (this.dom.switchCastDeviceBtn) {
                this.dom.switchCastDeviceBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.showPicker();
                };
            }

            if (this.dom.castPlayPauseBtn) {
                this.dom.castPlayPauseBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.toggleRemotePlayPause();
                };
            }

            if (this.dom.castModal) {
                this.dom.castModal.onclick = (e) => {
                    if (e.target === this.dom.castModal) {
                        this.closeModal();
                    }
                };
            }
        }

        handleEasterEggClick() {
            this.closeModal();
            setTimeout(() => {
                window.DonateManager?.showDonateModal();
            }, 150);
        }

        getActiveVideoElement() {
            const idx = (this.app.state.currentIndex % 3 + 3) % 3;
            return document.getElementById(`video-p${idx}`);
        }

        // ── 系统原生投屏（W3C Remote Playback API + WebKit AirPlay + Chrome Cast 极简桥接） ──
        initSystemCastAvailability() {
            if (this.getNativeDlna()) return;

            // 仅在 Chromium 环境注册极简 Cast Framework 钩子，不阻塞主流程
            if (!window.__onGCastApiAvailable) {
                window.__onGCastApiAvailable = (isAvailable) => {
                    if (isAvailable && window.cast?.framework) {
                        try {
                            const ctx = window.cast.framework.CastContext.getInstance();
                            ctx.setOptions({
                                receiverApplicationId: 'CC1AD845',
                                autoJoinPolicy: 'origin_scoped'
                            });
                            ctx.addEventListener(window.cast.framework.CastContextEventType.SESSION_STATE_CHANGED, (e) => {
                                if (e.sessionState === window.cast.framework.SessionState.SESSION_ENDED) {
                                    if (this.activeChannel === 'system') {
                                        this.disconnect(false);
                                    }
                                }
                            });
                        } catch (e) {}
                    }
                };
            }
            if (!document.getElementById('embyx-gcast-sdk') && window.chrome && !window.WebKitPlaybackTargetAvailabilityEvent) {
                const s = document.createElement('script');
                s.id = 'embyx-gcast-sdk';
                s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
                s.async = true;
                document.head.appendChild(s);
            }

            const checkAndBind = () => {
                [0, 1, 2].forEach(i => {
                    const v = document.getElementById(`video-p${i}`);
                    if (!v || this._boundVideos.has(v)) return;
                    this._boundVideos.add(v);

                    // 1. W3C Remote Playback API
                    if (v.remote && typeof v.remote.watchAvailability === 'function') {
                        try {
                            v.remote.watchAvailability((available) => {
                                const changed = this._remoteAvailable !== available;
                                this._remoteAvailable = available;
                                if (changed && this.dom.castModal && !this.dom.castModal.classList.contains('hidden')) {
                                    this.renderDeviceList(this._lastSessions || []);
                                }
                            }).catch(() => {
                                this._remoteAvailable = true;
                            });
                        } catch (e) {
                            this._remoteAvailable = true;
                        }
                    }

                    // 监听 Remote Playback 连接状态事件
                    if (v.remote && typeof v.remote.addEventListener === 'function') {
                        v.remote.addEventListener('connecting', () => {
                            this.app.showToast('正在连接投屏设备...');
                        });
                        v.remote.addEventListener('connect', () => {
                            this.activeChannel = 'system';
                            this.activeSessionName = '浏览器投屏';
                            this.isCasting = true;
                            this.renderPowerButton(true);
                            this.app.showToast('已连接系统投屏');
                        });
                        v.remote.addEventListener('disconnect', () => {
                            if (this.activeChannel === 'system') {
                                this.disconnect(false);
                            }
                        });
                    }

                    // 2. Apple WebKit AirPlay 事件
                    v.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => {
                        const available = (e.availability === 'available');
                        const changed = this._remoteAvailable !== available;
                        this._remoteAvailable = available;
                        if (changed && this.dom.castModal && !this.dom.castModal.classList.contains('hidden')) {
                            this.renderDeviceList(this._lastSessions || []);
                        }
                    });

                    v.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', () => {
                        const isWireless = !!(v.webkitCurrentPlaybackTargetIsWireless);
                        if (isWireless) {
                            this.activeChannel = 'system';
                            this.activeSessionName = 'AirPlay';
                            this.isCasting = true;
                            this.renderPowerButton(true);
                            this.app.showToast('已连接 AirPlay');
                        } else if (this.activeChannel === 'system') {
                            this.disconnect(false);
                        }
                    });
                });
            };

            checkAndBind();
            setTimeout(checkAndBind, 1000);
        }

        // 异步预热媒体直链，供点击系统原生投屏时同步赋值，杜绝手势被打断
        async prepareNativeStreamUrl(videoItem) {
            if (!videoItem) return;
            if (this._preparedVideoId === videoItem.Id && this._preparedNativeUrl) return;
            this._preparedVideoId = videoItem.Id;
            this._preparedNativeUrl = '';
            try {
                const url = await this.getNativeStreamUrl(videoItem);
                if (this._preparedVideoId === videoItem.Id) {
                    this._preparedNativeUrl = url || '';
                }
            } catch (e) {
                console.warn('[CastManager] 预热直链失败:', e);
            }
        }

        async fetchControllableSessions() {
            const { server, token, deviceId, userId } = this.app.config;
            if (!server || !token) return [];
            if (window.EmbyXCommon && EmbyXCommon.getServerType() === 'openlist') return [];

            try {
                const params = [`api_key=${encodeURIComponent(token)}`];
                if (userId) {
                    params.push(`ControllableByUserId=${encodeURIComponent(userId)}`);
                }
                const url = `${server}/emby/Sessions?${params.join('&')}`;
                const res = await fetch(url, {
                    headers: this.app.getAuthHeaders ? this.app.getAuthHeaders(token) : {}
                });
                if (!res.ok) return [];

                const sessions = await res.json();
                if (!Array.isArray(sessions)) return [];

                return sessions.filter(s => {
                    if (!s || !s.Id || s.DeviceId === deviceId) return false;
                    const canControl = s.SupportsRemoteControl === true ||
                        s.SupportsMediaControl === true ||
                        s.Capabilities?.SupportsMediaControl === true;
                    const types = s.PlayableMediaTypes || s.Capabilities?.PlayableMediaTypes || [];
                    const canVideo = types.some(t => String(t).toLowerCase() === 'video') || types.length === 0;
                    return canControl && canVideo;
                });
            } catch (err) {
                console.warn('[CastManager] 拉取会话列表失败:', err);
                return [];
            }
        }

        // ── 原生 DLNA 通道（仅 APK 注入的 EmbyXCastDlna 对象存在时启用） ──
        getNativeDlna() {
            const bridge = window.EmbyXCastDlna;
            return bridge && typeof bridge.discover === 'function' ? bridge : null;
        }

        initNativeDlnaBridge() {
            if (this._nativeDlnaReady) return;
            this._nativeDlnaReady = true;
            this._nativeDlnaPending = new Map();
            window.__embyxDlnaDiscover = (id, json) => {
                const p = this._nativeDlnaPending.get(id);
                if (!p) return;
                this._nativeDlnaPending.delete(id);
                try { p.resolve(JSON.parse(json || '[]')); } catch (e) { p.resolve([]); }
            };
            window.__embyxDlnaResult = (id, ok, payload) => {
                const p = this._nativeDlnaPending.get(id);
                if (!p) return;
                this._nativeDlnaPending.delete(id);
                p.resolve(ok === true ? (payload || '') : null);
            };
        }

        waitNativeDlna(requestId, timeoutMs) {
            this.initNativeDlnaBridge();
            return new Promise(resolve => {
                const timer = setTimeout(() => {
                    this._nativeDlnaPending.delete(requestId);
                    resolve(null);
                }, timeoutMs);
                this._nativeDlnaPending.set(requestId, {
                    resolve: (v) => { clearTimeout(timer); resolve(v); }
                });
            });
        }

        extractUdn(deviceId) {
            const m = String(deviceId || '').match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
            return m ? m[1].toLowerCase() : '';
        }

        async discoverNativeRenderers() {
            const dlna = this.getNativeDlna();
            if (!dlna) return [];
            const requestId = 'discover_' + Date.now().toString(36);
            const pending = this.waitNativeDlna(requestId, 8000);
            try {
                dlna.discover(requestId);
            } catch (e) {
                console.warn('[CastManager] 原生 DLNA 发现失败:', e);
                return [];
            }
            const list = await pending;
            if (!Array.isArray(list)) return [];
            return list.filter(d => d && (d.udn || d.location));
        }

        async nativeCommand(device, action, arg = '') {
            const dlna = this.getNativeDlna();
            if (!dlna || !device || !device.udn) return null;
            const requestId = 'cmd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            const pending = this.waitNativeDlna(requestId, 6000);
            try {
                dlna.command(requestId, device.udn, action, arg);
            } catch (e) {
                console.warn('[CastManager] 原生 DLNA 指令失败:', e);
                return null;
            }
            return pending;
        }

        async showPicker() {
            if (this.app.state.viewMode !== 'stream') {
                this.app.showToast('请在播放模式下使用投屏');
                return;
            }

            const current = this.app.state.videos[this.app.state.currentIndex];
            if (!current) {
                this.app.showToast('当前未在播放视频');
                return;
            }

            // 预热原画直链供点击系统投屏时同步使用
            this.prepareNativeStreamUrl(current);

            // 1. 服务端优先：Emby / Jellyfin 的 DLNA 会话设备
            const sessions = await this.fetchControllableSessions();
            this._lastSessions = sessions || [];

            // 2. 无论是否发现设备，统一弹出 EmbyX 规范设备选择卡片
            this._nativeDevices = [];
            this._nativeScanning = !!this.getNativeDlna();
            this.openModal();
            this.renderDeviceList(sessions || []);

            // 3. 原生兜底：APK 内手机自身 SSDP 发现，异步补齐列表，不阻塞卡片首帧
            if (!this._nativeScanning) return;
            const discovered = await this.discoverNativeRenderers();
            this._nativeScanning = false;
            const covered = new Set(sessions.map(s => this.extractUdn(s.DeviceId)).filter(Boolean));
            this._nativeDevices = discovered.filter(d => {
                const udn = this.extractUdn(d.udn || '');
                return !udn || !covered.has(udn);
            });
            if (this.dom.castModal && !this.dom.castModal.classList.contains('hidden')) {
                this.renderDeviceList(sessions || []);
            }
        }

        triggerSystemCast() {
            if (window.DonateManager && window.DonateManager.isCastLocked()) {
                window.DonateManager.showDonateModal();
                return false;
            }

            const videoEl = this.getActiveVideoElement();
            if (!videoEl) return false;

            // 智能直链切换：若当前本地正以 HLS(Blob) 播放，切换为直链以便 Chromecast 等硬件自主拉流
            const currentSrc = videoEl.currentSrc || videoEl.src || '';
            if (currentSrc.startsWith('blob:') && this._preparedNativeUrl) {
                const savedTime = !isNaN(videoEl.currentTime) ? videoEl.currentTime : 0;
                if (this.app.player?.activeHls) {
                    this.app.player.activeHls.destroy();
                    this.app.player.activeHls = null;
                }
                videoEl.src = this._preparedNativeUrl;
                videoEl.currentTime = savedTime;
                videoEl.play().catch(() => {});
            }

            // 1. Apple WebKit (Safari / iOS AirPlay)
            if (window.WebKitPlaybackTargetAvailabilityEvent || 'webkitShowPlaybackTargetPicker' in videoEl) {
                try {
                    videoEl.webkitShowPlaybackTargetPicker();
                    return true;
                } catch (e) {
                    console.warn('[CastManager] webkitShowPlaybackTargetPicker 出错:', e);
                }
            }

            // 2. Chrome / Chromium 官方 Cast 框架（弹出 Media Router 官方投放面板）
            const castCtx = window.cast?.framework?.CastContext?.getInstance?.();
            if (castCtx && typeof castCtx.requestSession === 'function') {
                castCtx.requestSession().then(async () => {
                    const session = castCtx.getCurrentSession();
                    if (!session) return;
                    const current = this.app.state.videos[this.app.state.currentIndex];
                    const url = await this.getNativeStreamUrl(current);
                    if (!url) return;
                    const castMedia = window.chrome?.cast?.media;
                    if (!castMedia) return;

                    const mediaInfo = new castMedia.MediaInfo(url, 'video/mp4');
                    mediaInfo.metadata = new castMedia.GenericMediaMetadata();
                    mediaInfo.metadata.title = current.Name || current.FileName || 'EmbyX';
                    const request = new castMedia.LoadRequest(mediaInfo);
                    const startSec = videoEl && !isNaN(videoEl.currentTime) ? Math.floor(videoEl.currentTime) : 0;
                    request.currentTime = startSec;
                    request.autoplay = true;

                    session.loadMedia(request).then(() => {
                        // 方案一：极简静音暂停，右上角切换为红色断开按钮
                        videoEl.pause();
                        videoEl.muted = true;
                        this.activeChannel = 'system';
                        this.activeSessionName = session.getCastDevice()?.friendlyName || 'Chromecast';
                        this.isCasting = true;
                        this.renderPowerButton(true);
                        this.app.showToast(`已投屏至 ${this.activeSessionName}`);
                    }).catch((e) => {
                        console.warn('[CastManager] Chromecast loadMedia 失败:', e);
                        this.app.showToast('Chromecast 无法播放该视频');
                    });
                }).catch((err) => {
                    const code = typeof err === 'string' ? err : (err && (err.code || err.name)) || '';
                    if (code !== 'cancel') {
                        console.warn('[CastManager] requestSession 失败:', err);
                    }
                });
                return true;
            }

            // 3. W3C Remote Playback API 兜底 (Android Chrome 等)
            if (videoEl.remote && typeof videoEl.remote.prompt === 'function') {
                this.promptRemotePlayback(videoEl);
                return true;
            }

            this.app.showToast('当前浏览器不支持系统原生投屏');
            return false;
        }

        promptRemotePlayback(videoEl) {
            videoEl.remote.prompt().catch(err => {
                const name = err && err.name;
                if (name === 'NotAllowedError') {
                    // 用户在原生菜单中取消选择，静默
                    return;
                }
                if (name === 'NotFoundError') {
                    this.app.showToast('未发现可投屏设备');
                    return;
                }
                if (name === 'NotSupportedError') {
                    this.app.showToast('当前视频流不支持投屏播放');
                    return;
                }
                console.warn('[CastManager] RemotePlayback prompt 失败:', err);
                this.app.showToast('未发现可投屏设备');
            });
        }

        getDeviceIconName(name = '', client = '') {
            const lower = (name + ' ' + client).toLowerCase();
            if (lower.includes('speaker') || lower.includes('音箱') || lower.includes('audio') || lower.includes('homepod')) {
                return 'speaker';
            }
            if (lower.includes('mac') || lower.includes('pc') || lower.includes('windows') || lower.includes('linux')) {
                return 'monitor';
            }
            if (lower.includes('phone') || lower.includes('iphone') || lower.includes('android')) {
                return 'smartphone';
            }
            return 'tv';
        }

        renderDeviceList(sessions) {
            if (!this.dom.castDeviceList) return;
            this.dom.castDeviceList.innerHTML = '';

            const targetCardHeight = (window.innerHeight || 844) * 0.6;
            const cardHeaderAndPadding = 76;
            const itemHeight = 58;
            const itemGap = 8;
            const availableListHeight = Math.max(itemHeight, targetCardHeight - cardHeaderAndPadding);
            const maxFitItems = Math.max(3, Math.round((availableListHeight + itemGap) / (itemHeight + itemGap)));

            const nativeDevices = this._nativeDevices || [];
            // APK 内 WebView 不暴露 remote / webkitShowPlaybackTargetPicker，直接不渲染该条目
            const showSystemCast = !this.getNativeDlna();
            const isScanning = this._nativeScanning && nativeDevices.length === 0;
            const realItems = (showSystemCast ? 1 : 0) + (sessions ? sessions.length : 0) + nativeDevices.length;
            const totalItems = Math.max(1, realItems);
            const visibleCount = Math.min(totalItems, maxFitItems);
            const listMaxHeight = visibleCount * itemHeight + Math.max(0, visibleCount - 1) * itemGap;
            this.dom.castDeviceList.style.maxHeight = `${listMaxHeight}px`;

            const isLocked = window.DonateManager && window.DonateManager.isCastLocked();

            const appendDeviceItem = (name, client, isActive, onSelect, isSystemCast = false) => {
                const icon = this.getDeviceIconName(name, client);
                const devItem = document.createElement('div');
                devItem.className = `flex items-center justify-between h-[58px] min-h-[58px] max-h-[58px] flex-shrink-0 px-3.5 rounded-xl ${isActive ? 'bg-primary/20 border-primary/40 text-primary' : 'bg-white/10 hover:bg-white/15 border-white/10 text-white'} ${isLocked ? 'opacity-50' : ''} active:scale-[0.98] cursor-pointer transition-all border`;

                const rightHtml = isLocked
                    ? `<i data-lucide="chevron-right" class="w-4 h-4 text-white/30 flex-shrink-0"></i>`
                    : (isActive ? `<i data-lucide="check" class="w-5 h-5 text-primary flex-shrink-0"></i>` : ``);

                devItem.innerHTML = `
                    <div class="flex items-center space-x-3 min-w-0">
                        <div class="w-8 h-8 rounded-lg ${isActive ? 'bg-primary/20 text-primary' : 'bg-white/10 text-white'} flex items-center justify-center flex-shrink-0">
                            <i data-lucide="${icon}" class="w-4 h-4"></i>
                        </div>
                        <div class="min-w-0">
                            <div class="text-white text-sm font-medium truncate">${name}</div>
                            <div class="text-white/60 text-xs truncate">${client}</div>
                        </div>
                    </div>
                    ${rightHtml}
                `;
                devItem.onclick = () => {
                    if (isSystemCast) {
                        // 系统原生投屏：同步关闭卡片并跳过 history.back，确保手势不中断
                        this.closeModal(true);
                        if (isLocked) {
                            setTimeout(() => window.DonateManager?.showDonateModal(), 150);
                            return;
                        }
                        onSelect();
                    } else {
                        this.closeModal();
                        if (isLocked) {
                            setTimeout(() => window.DonateManager?.showDonateModal(), 150);
                            return;
                        }
                        onSelect();
                    }
                };
                this.dom.castDeviceList.appendChild(devItem);
            };

            // 第一项：系统原生投屏（AirPlay / 浏览器原生 Cast），仅浏览器端出现
            if (showSystemCast) {
                appendDeviceItem(
                    '系统原生投屏',
                    'AirPlay / 浏览器投屏',
                    this.isCasting && this.activeChannel === 'system',
                    () => this.triggerSystemCast(),
                    true
                );
            }

            if (isScanning) {
                appendDeviceItem('正在扫描局域网设备', '请稍候…', false, () => {});
            } else if (realItems === 0) {
                appendDeviceItem('未发现可投屏设备', '请确认设备与本机在同一网络', false, () => {});
            }

            // 服务端 DLNA / Remote 会话设备（第一优先级）
            sessions.forEach(s => {
                const name = s.DeviceName || s.Client || '局域网媒体设备';
                const client = s.Client || 'DLNA 渲染器';
                const isActive = this.isCasting && this.activeChannel === 'server' && this.activeSessionId === s.Id;
                appendDeviceItem(name, client, isActive, () => this.castToSession(s));
            });

            // 手机原生 DLNA 发现的渲染器（APK 专属）
            nativeDevices.forEach(d => {
                const name = d.name || '局域网媒体设备';
                const client = d.model || d.manufacturer || 'DLNA';
                const isActive = this.isCasting && this.activeChannel === 'native' &&
                    this.activeNative && this.activeNative.udn === d.udn;
                appendDeviceItem(name, client, isActive, () => this.castToNative(d));
            });

            if (window.lucide && window.lucide.createIcons) {
                window.lucide.createIcons({ root: this.dom.castDeviceList });
            }
        }

        applyCastingStageTheme() {
            [0, 1, 2].forEach(i => {
                const vi = document.getElementById(`video-p${i}`);
                if (vi) {
                    vi.pause();
                    vi.muted = true;
                    vi.style.opacity = '0';
                }
                const thumb = document.getElementById(`thumb-${i}`);
                if (thumb) thumb.style.opacity = '0';
                const poster = document.getElementById(`poster-${i}`);
                if (poster) poster.style.opacity = '0.7';
                const overlay = document.getElementById(`overlay-${i}`);
                if (overlay) overlay.style.opacity = '1';
            });
        }

        restoreStageTheme() {
            const isScaleFill = !!this.app.state.isScaleFill;
            [0, 1, 2].forEach(i => {
                const thumb = document.getElementById(`thumb-${i}`);
                if (thumb) thumb.style.opacity = isScaleFill ? '1' : '0';
                const poster = document.getElementById(`poster-${i}`);
                if (poster) poster.style.opacity = isScaleFill ? '0' : '0.7';
                const overlay = document.getElementById(`overlay-${i}`);
                if (overlay) overlay.style.opacity = isScaleFill ? '0' : '1';
            });
        }

        async castToSession(session, explicitTicks = null) {
            if (window.DonateManager && window.DonateManager.isCastLocked()) {
                window.DonateManager.showDonateModal();
                return;
            }

            const current = this.app.state.videos[this.app.state.currentIndex];
            if (!current) return;

            const videoEl = this.getActiveVideoElement();
            const currentTime = videoEl && !isNaN(videoEl.currentTime) ? videoEl.currentTime : 0;
            const startTicks = explicitTicks !== null ? explicitTicks : Math.floor(currentTime * 10000000);
            const { server, token } = this.app.config;

            const msIdx = current?._selectedMediaSourceIndex || 0;
            const mediaSource = current?.MediaSources?.[msIdx] || current?.MediaSources?.[0];
            const targetItemId = mediaSource?.ItemId || (mediaSource?._isPart ? '' : (current?.Id || ''));

            this.app.showToast(`正在推送至 ${session.DeviceName || session.Client}...`);

            try {
                const params = [
                    `ItemIds=${encodeURIComponent(targetItemId)}`,
                    `PlayCommand=PlayNow`,
                    `StartPositionTicks=${startTicks}`,
                    `api_key=${encodeURIComponent(token)}`
                ].join('&');

                const url = `${server}/emby/Sessions/${encodeURIComponent(session.Id)}/Playing?${params}`;
                const res = await fetch(url, {
                    method: 'POST',
                    headers: this.app.getAuthHeaders ? this.app.getAuthHeaders(token) : {}
                });

                if (res.ok) {
                    this.activeSessionId = session.Id;
                    this.activeSessionName = session.DeviceName || session.Client || '电视';
                    this.activeChannel = 'server';
                    this.activeNative = null;
                    this.isCasting = true;
                    this.isPaused = false;

                    this.applyCastingStageTheme();
                    if (this.app.player) {
                        if (this.app.player.activeHls) {
                            this.app.player.activeHls.destroy();
                            this.app.player.activeHls = null;
                        }
                        if (this.app.player.activeMpegts) {
                            this.app.player.activeMpegts.destroy();
                            this.app.player.activeMpegts = null;
                        }
                    }

                    this.renderCastingOverlay(this.activeSessionName);
                    this.renderPowerButton(true);
                    this.startHeartbeat(current.Id);
                    this.app.showToast(`已投屏至 ${this.activeSessionName}`);
                } else {
                    this.app.showToast('投屏请求被服务端拒绝');
                }
            } catch (err) {
                console.error('[CastManager] 投屏失败:', err);
                this.app.showToast('投屏连接异常');
            }
        }

        // 原生 DLNA 推送：手机直接向渲染器下发 SetAVTransportURI + Play
        async castToNative(device) {
            if (window.DonateManager && window.DonateManager.isCastLocked()) {
                window.DonateManager.showDonateModal();
                return;
            }
            const dlna = this.getNativeDlna();
            if (!dlna || !device) return;

            const current = this.app.state.videos[this.app.state.currentIndex];
            if (!current) return;

            const videoEl = this.getActiveVideoElement();
            const startSeconds = videoEl && !isNaN(videoEl.currentTime) ? Math.floor(videoEl.currentTime) : 0;
            const url = await this.getNativeStreamUrl(current);
            if (!url) {
                this.app.showToast('投屏连接异常');
                return;
            }

            const name = device.name || '电视';
            const title = current.Name || current.FileName || 'EmbyX';
            this.app.showToast(`正在推送至 ${name}...`);
            const ok = await this.nativeCommand(device, 'play', JSON.stringify({ url, start: startSeconds, title }));
            if (ok === null) {
                this.app.showToast('投屏连接异常');
                return;
            }

            this.activeChannel = 'native';
            this.activeNative = device;
            this.activeSessionId = null;
            this.activeSessionName = name;
            this.isCasting = true;
            this.isPaused = false;

            this.applyCastingStageTheme();
            if (this.app.player) {
                if (this.app.player.activeHls) {
                    this.app.player.activeHls.destroy();
                    this.app.player.activeHls = null;
                }
                if (this.app.player.activeMpegts) {
                    this.app.player.activeMpegts.destroy();
                    this.app.player.activeMpegts = null;
                }
            }

            this.renderCastingOverlay(name);
            this.renderPowerButton(true);
            this.startNativeHeartbeat();
            this.app.showToast(`已投屏至 ${name}`);
        }

        // 取渲染器可直连的原画地址
        async getNativeStreamUrl(item) {
            if (!item) return '';
            if (item._rawUrl) return item._rawUrl;

            const isOpenList = item._isOpenList ||
                (window.EmbyXCommon && EmbyXCommon.getServerType() === 'openlist');
            if (isOpenList) {
                if (window.OpenListManager && typeof window.OpenListManager.getPlayUrl === 'function') {
                    try { return await window.OpenListManager.getPlayUrl(item); } catch (e) {}
                }
                return item._signedUrl || '';
            }

            const { server, token, deviceId } = this.app.config;
            if (!server || !token) return '';

            const msIdx = item._selectedMediaSourceIndex || 0;
            const mediaSource = item?.MediaSources?.[msIdx] || item?.MediaSources?.[0];
            const targetVideoId = mediaSource?.ItemId || (mediaSource?._isPart ? '' : (item?.Id || ''));
            if (!targetVideoId) return '';
            const msId = mediaSource?._isPart ? '' : (mediaSource?.Id || '');
            const params = [
                `api_key=${encodeURIComponent(token)}`,
                `Static=true`,
                msId ? `MediaSourceId=${msId}` : '',
                `DeviceId=${encodeURIComponent(deviceId || 'EmbyX-Device')}`,
                `PlaySessionId=cast_${encodeURIComponent(targetVideoId)}_${Date.now().toString(16)}`
            ].filter(Boolean).join('&');
            const fixUrl = window.EmbyXCommon?.fixUrlForJellyfin || ((u) => u);
            return fixUrl(`${server}/emby/Videos/${targetVideoId}/stream?${params}`);
        }

        startNativeHeartbeat() {
            this.stopHeartbeat();
            let missCount = 0;
            this.heartbeatTimer = setInterval(async () => {
                if (!this.isCasting || this.activeChannel !== 'native' || !this.activeNative) {
                    this.stopHeartbeat();
                    return;
                }
                const state = await this.nativeCommand(this.activeNative, 'state', '');
                if (state === null) {
                    if (++missCount < 3) return;
                    this.disconnect(false);
                    this.app.showToast('电视端已结束播放');
                    return;
                }
                missCount = 0;
                let info;
                try { info = JSON.parse(state); } catch (e) { return; }
                if (!info) return;
                if (info.paused !== undefined && info.paused !== this.isPaused) {
                    this.updatePlayPauseButton(!!info.paused);
                }
                const duration = Number(info.duration) || 0;
                const position = Number(info.position) || 0;
                if (duration > 0 && this.app.dom.progressLine) {
                    const pct = Math.min(100, Math.max(0, (position / duration) * 100));
                    this.app.dom.progressLine.style.width = `${pct}%`;
                    if (this.app.dom.currentTime && this.app.player?.formatTime) {
                        this.app.dom.currentTime.textContent = this.app.player.formatTime(position);
                    }
                    if (this.app.dom.totalTime && this.app.player?.formatTime) {
                        this.app.dom.totalTime.textContent = this.app.player.formatTime(duration);
                    }
                }
            }, 4500);
        }

        renderCastingOverlay(name) {
            if (this.dom.castScreenDeviceName) {
                this.dom.castScreenDeviceName.textContent = name || '电视';
            }
            this.updatePlayPauseButton(false);
            if (this.dom.castScreenOverlay) {
                this.dom.castScreenOverlay.classList.remove('hidden');
                this.dom.castScreenOverlay.classList.add('flex');
            }
            if (window.lucide && window.lucide.createIcons) {
                lucide.createIcons({ root: this.dom.castScreenOverlay });
            }
        }

        updatePlayPauseButton(isPaused) {
            this.isPaused = isPaused;
            if (this.dom.castPlayPauseBtn) {
                const iconName = isPaused ? 'play' : 'pause';
                this.dom.castPlayPauseBtn.innerHTML = `<i data-lucide="${iconName}" class="stroke-white w-7 h-7"></i>`;
                if (window.lucide && window.lucide.createIcons) {
                    lucide.createIcons({ root: this.dom.castPlayPauseBtn });
                }
            }
        }

        renderPowerButton(isCastActive) {
            if (!this.dom.castBtn) return;
            if (isCastActive) {
                this.dom.castBtn.innerHTML = `
                    <div class="w-12 h-12 flex items-center justify-center cursor-pointer active:scale-90 transition-transform bg-black/25 backdrop-blur-xl border border-white/10 shadow-[inset_0_1px_1px_rgba(255,255,255,0.25),0_8px_24px_rgba(0,0,0,0.3)] rounded-full" title="断开投屏">
                        <i data-lucide="power" class="stroke-red-400 text-red-400 w-5 h-5 drop-shadow-md"></i>
                    </div>
                `;
            } else {
                this.dom.castBtn.innerHTML = `
                    <div class="w-12 h-12 flex items-center justify-center cursor-pointer active:scale-90 transition-transform bg-black/25 backdrop-blur-xl border border-white/10 shadow-[inset_0_1px_1px_rgba(255,255,255,0.25),0_8px_24px_rgba(0,0,0,0.3)] rounded-full" title="投屏">
                        <i data-lucide="cast" class="stroke-white w-5 h-5 drop-shadow-md"></i>
                    </div>
                `;
            }
            if (window.lucide && window.lucide.createIcons) {
                lucide.createIcons({ root: this.dom.castBtn });
            }
        }

        toggleRemotePlayPause() {
            if (!this.isCasting || (!this.activeSessionId && !this.activeNative && this.activeChannel !== 'system')) return;

            if (this.activeChannel === 'system') {
                const videoEl = this.getActiveVideoElement();
                if (videoEl) {
                    if (videoEl.paused) {
                        videoEl.play().catch(() => {});
                        this.updatePlayPauseButton(false);
                    } else {
                        videoEl.pause();
                        this.updatePlayPauseButton(true);
                    }
                }
                return;
            }

            [0, 1, 2].forEach(i => {
                const vi = document.getElementById(`video-p${i}`);
                if (vi) {
                    vi.pause();
                    vi.muted = true;
                }
            });

            const willPause = !this.isPaused;
            this.updatePlayPauseButton(willPause);

            if (this.activeChannel === 'native') {
                this.nativeCommand(this.activeNative, willPause ? 'pause' : 'resume', '');
                return;
            }

            const { server, token } = this.app.config;
            if (server && token && this.activeSessionId) {
                const url = `${server}/emby/Sessions/${encodeURIComponent(this.activeSessionId)}/Playing/PlayPause?api_key=${encodeURIComponent(token)}`;
                fetch(url, {
                    method: 'POST',
                    headers: this.app.getAuthHeaders ? this.app.getAuthHeaders(token) : {}
                }).catch(() => {});
            }
        }

        async seekTo(seconds) {
            if (this.activeChannel === 'system') {
                const videoEl = this.getActiveVideoElement();
                if (videoEl && !isNaN(seconds)) {
                    videoEl.currentTime = Math.max(0, Number(seconds) || 0);
                }
                return;
            }
            if (this.activeChannel === 'native') {
                if (!this.isCasting || !this.activeNative) return;
                this.nativeCommand(this.activeNative, 'seek', String(Math.floor(seconds)));
                return;
            }
            if (!this.isCasting || !this.activeSessionId) return;
            const targetTicks = Math.floor(seconds * 10000000);
            const { server, token } = this.app.config;
            if (server && token) {
                try {
                    const url = `${server}/emby/Sessions/${encodeURIComponent(this.activeSessionId)}/Playing/Seek?SeekPositionTicks=${targetTicks}&api_key=${encodeURIComponent(token)}`;
                    fetch(url, {
                        method: 'POST',
                        headers: this.app.getAuthHeaders ? this.app.getAuthHeaders(token) : {}
                    }).catch(() => {});
                } catch (e) {
                    console.warn('[CastManager] Seek 失败:', e);
                }
            }
        }

        // 上下滑动连续投屏
        async handleSlideChange() {
            if (!this.isCasting || (!this.activeSessionId && !this.activeNative && this.activeChannel !== 'system')) return;

            const current = this.app.state.videos[this.app.state.currentIndex];
            if (!current) return;

            if (this.activeChannel === 'system') {
                this.prepareNativeStreamUrl(current);
                const videoEl = this.getActiveVideoElement();
                if (videoEl && this.app.player) {
                    const playSrc = this._preparedNativeUrl || this.app.player.getVideoSrc(current.Id, current, false);
                    this.app.player.setVideoSource(videoEl, playSrc, this.app.state.currentIndex, current, { autoplay: true });
                }
                return;
            }

            this.applyCastingStageTheme();
            this.updatePlayPauseButton(false);

            if (this.activeChannel === 'native') {
                const url = await this.getNativeStreamUrl(current);
                if (url && this.activeNative) {
                    const title = current.Name || current.FileName || 'EmbyX';
                    this.nativeCommand(this.activeNative, 'play', JSON.stringify({ url, start: 0, title })).then(() => {
                        this.app.showToast(`已向 ${this.activeSessionName} 投屏下一集`);
                    });
                }
                return;
            }

            const msIdx = current?._selectedMediaSourceIndex || 0;
            const mediaSource = current?.MediaSources?.[msIdx] || current?.MediaSources?.[0];
            const targetItemId = mediaSource?.ItemId || (mediaSource?._isPart ? '' : (current?.Id || ''));
            const { server, token } = this.app.config;

            if (server && token && targetItemId) {
                try {
                    const params = [
                        `ItemIds=${encodeURIComponent(targetItemId)}`,
                        `PlayCommand=PlayNow`,
                        `StartPositionTicks=0`,
                        `api_key=${encodeURIComponent(token)}`
                    ].join('&');

                    const url = `${server}/emby/Sessions/${encodeURIComponent(this.activeSessionId)}/Playing?${params}`;
                    fetch(url, {
                        method: 'POST',
                        headers: this.app.getAuthHeaders ? this.app.getAuthHeaders(token) : {}
                    }).catch(() => {});

                    this.startHeartbeat(current.Id);
                    this.app.showToast(`已向 ${this.activeSessionName} 投屏下一集`);
                } catch (e) {
                    console.warn('[CastManager] 连滑投屏请求失败:', e);
                }
            }
        }

        async disconnect(sendStop = true) {
            this.stopHeartbeat();

            const sid = this.activeSessionId;
            const { server, token } = this.app.config;

            if (this.activeChannel === 'system') {
                const castCtx = window.cast?.framework?.CastContext?.getInstance?.();
                if (castCtx) {
                    try { castCtx.endCurrentSession(true); } catch (e) {}
                }
            } else if (sendStop && this.activeChannel === 'native' && this.activeNative) {
                this.nativeCommand(this.activeNative, 'stop', '');
            } else if (sendStop && sid && server && token) {
                try {
                    const url = `${server}/emby/Sessions/${encodeURIComponent(sid)}/Playing/Stop?api_key=${encodeURIComponent(token)}`;
                    fetch(url, {
                        method: 'POST',
                        headers: this.app.getAuthHeaders ? this.app.getAuthHeaders(token) : {}
                    }).catch(() => {});
                } catch (e) {}
            }

            this.activeSessionId = null;
            this.activeSessionName = '';
            this.activeChannel = null;
            this.activeNative = null;
            this.isCasting = false;
            this.isPaused = false;

            if (this.dom.castScreenOverlay) {
                this.dom.castScreenOverlay.classList.remove('flex');
                this.dom.castScreenOverlay.classList.add('hidden');
            }

            this.renderPowerButton(false);
            this.restoreStageTheme();

            const videoEl = this.getActiveVideoElement();
            if (videoEl) {
                videoEl.style.opacity = '1';
                videoEl.muted = this.app.state.isMuted;
                if (this.app.player) {
                    const current = this.app.state.videos[this.app.state.currentIndex];
                    if (current) {
                        const playSrc = this.app.player.getVideoSrc(current.Id, current, false);
                        this.app.player.setVideoSource(videoEl, playSrc, this.app.state.currentIndex, current);
                    }
                }
            }

            if (sendStop) {
                this.app.showToast('已断开投屏');
            }
        }

        startHeartbeat(currentVideoId) {
            this.stopHeartbeat();
            let heartbeatMissCount = 0;
            this.heartbeatTimer = setInterval(async () => {
                if (!this.isCasting || !this.activeSessionId) {
                    this.stopHeartbeat();
                    return;
                }

                try {
                    const sessions = await this.fetchControllableSessions();
                    const s = sessions.find(x => x.Id === this.activeSessionId);
                    
                    const isSameVideo = s && s.NowPlayingItem && (
                        String(s.NowPlayingItem.Id) === String(currentVideoId) ||
                        String(s.NowPlayingItem.SeriesId) === String(currentVideoId)
                    );

                    if (!s || !isSameVideo) {
                        heartbeatMissCount++;
                        if (heartbeatMissCount >= 3) {
                            this.disconnect(false);
                            this.app.showToast('电视端已结束播放');
                        }
                        return;
                    }
                    heartbeatMissCount = 0;

                    if (s.PlayState) {
                        if (s.PlayState.IsPaused !== undefined && s.PlayState.IsPaused !== this.isPaused) {
                            this.updatePlayPauseButton(!!s.PlayState.IsPaused);
                        }

                        if (typeof s.PlayState.PositionTicks === 'number') {
                            const curSec = s.PlayState.PositionTicks / 10000000;
                            const current = this.app.state.videos[this.app.state.currentIndex];
                            const totalTicks = s.NowPlayingItem?.RunTimeTicks || current?.RunTimeTicks;
                            const totalSec = totalTicks ? (totalTicks / 10000000) : 0;
                            if (totalSec > 0) {
                                const pct = Math.min(100, Math.max(0, (curSec / totalSec) * 100));
                                if (this.app.dom.progressLine) {
                                    this.app.dom.progressLine.style.width = `${pct}%`;
                                }
                                if (this.app.dom.currentTime && this.app.player?.formatTime) {
                                    this.app.dom.currentTime.textContent = this.app.player.formatTime(curSec);
                                }
                                if (this.app.dom.totalTime && this.app.player?.formatTime) {
                                    this.app.dom.totalTime.textContent = this.app.player.formatTime(totalSec);
                                }
                            }
                        }
                    }
                } catch (e) {}
            }, 4500);
        }

        stopHeartbeat() {
            if (this.heartbeatTimer) {
                clearInterval(this.heartbeatTimer);
                this.heartbeatTimer = null;
            }
        }

        openModal() {
            if (this.app?.closeAllModals) {
                this.app.closeAllModals('castModal');
            }
            if (window.DonateManager) {
                window.DonateManager.updateUI();
            }
            if (this.dom.castModal) {
                this.dom.castModal.classList.remove('hidden');
                if (this.app?.nav) {
                    this.app.nav.focusModal(this.dom.castModal);
                }
                if (this.app?.input && typeof this.app.input.pushLayer === 'function') {
                    this.app.input.pushLayer('modal', { id: 'castModal' });
                }
                if (typeof this.app?.showInterfaceTemp === 'function') {
                    this.app.showInterfaceTemp();
                }
            }
        }

        closeModal(skipHistory = false) {
            if (!skipHistory && this.app?.input && this.app.input.hasHistoryLayer('modal', 'castModal') && !this.app.input._isHandlingPop) {
                window.history.back();
                return;
            }
            if (this.app?.input && typeof this.app.input.removeHistoryLayer === 'function') {
                this.app.input.removeHistoryLayer('modal', 'castModal');
            }
            if (this.dom.castModal) {
                this.dom.castModal.classList.add('hidden');
                if (this.app?.nav) {
                    this.app.nav.blurModal(this.dom.castModal);
                }
                if (typeof this.app?.showInterfaceTemp === 'function') {
                    this.app.showInterfaceTemp();
                }
            }
        }
    }

    window.CastManager = CastManager;
})(window);
