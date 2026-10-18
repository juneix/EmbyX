/**
 * EmbyX Cast Controller (Zero-dependency, Vanilla JS)
 * Handles:
 * - W3C Remote Playback API (Chromecast / Google Cast / Edge Miracast)
 * - Apple WebKit AirPlay API (Safari on iOS & macOS)
 * - Emby & Jellyfin /Sessions DLNA device discovery & remote play
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

        async fetchControllableSessions() {
            const { server, token, deviceId, userId } = this.app.config;
            if (!server || !token) return [];

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

            // 1. 尝试拉取服务端可控制会话设备
            const sessions = await this.fetchControllableSessions();

            // 2. 无论是否发现服务端设备，统一弹出 EmbyX 规范设备选择卡片
            // 严禁跳过卡片直接静默调起系统原生投屏
            this.renderDeviceList(sessions || []);
            this.openModal();
        }

        triggerSystemCast() {
            if (window.DonateManager && window.DonateManager.isCastLocked()) {
                window.DonateManager.showDonateModal();
                return false;
            }

            const videoEl = this.getActiveVideoElement();
            if (!videoEl) return false;

            // 优先检查 Apple WebKit (Safari / iOS AirPlay)
            if (window.WebKitPlaybackTargetAvailabilityEvent || 'webkitShowPlaybackTargetPicker' in videoEl) {
                try {
                    videoEl.webkitShowPlaybackTargetPicker();
                    return true;
                } catch (e) {
                    console.warn('[CastManager] webkitShowPlaybackTargetPicker 出错:', e);
                }
            }

            // 检查 W3C Remote Playback API (Chrome / Edge / Android)
            if (videoEl.remote && typeof videoEl.remote.prompt === 'function') {
                videoEl.remote.prompt().then(() => {
                    this.app.showToast('已调起系统投屏选择器');
                }).catch(err => {
                    if (err.name !== 'NotFoundError' && err.name !== 'NotAllowedError') {
                        console.warn('[CastManager] RemotePlayback prompt:', err);
                    }
                });
                return true;
            }

            return false;
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

            // 依据屏幕视口动态计算约 60% 高度下最匹配的整数条目数，杜绝条目露半截
            const targetCardHeight = (window.innerHeight || 844) * 0.6;
            const cardHeaderAndPadding = 76; // p-4 (32px) + header 32px + mb-3 (12px)
            const itemHeight = 58; // 严格固定高度 h-[58px]
            const itemGap = 8;     // space-y-2
            const availableListHeight = Math.max(itemHeight, targetCardHeight - cardHeaderAndPadding);
            // 计算 60% 高度目标下最贴合的整数条目数量（至少 3 项）
            const maxFitItems = Math.max(3, Math.round((availableListHeight + itemGap) / (itemHeight + itemGap)));

            const totalItems = 1 + (sessions ? sessions.length : 0);
            const visibleCount = Math.min(totalItems, maxFitItems);
            const listMaxHeight = visibleCount * itemHeight + Math.max(0, visibleCount - 1) * itemGap;
            this.dom.castDeviceList.style.maxHeight = `${listMaxHeight}px`;

            const isLocked = window.DonateManager && window.DonateManager.isCastLocked();

            // 第一项：系统原生投屏（AirPlay / 浏览器原生 Cast）
            const systemItem = document.createElement('div');
            systemItem.className = `flex items-center justify-between h-[58px] min-h-[58px] max-h-[58px] flex-shrink-0 px-3.5 rounded-xl bg-white/10 hover:bg-white/15 active:scale-[0.98] cursor-pointer transition-all border border-white/10 ${isLocked ? 'opacity-50' : ''}`;
            systemItem.innerHTML = `
                <div class="flex items-center space-x-3 min-w-0">
                    <div class="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center text-white flex-shrink-0">
                        <i data-lucide="cast" class="w-4 h-4"></i>
                    </div>
                    <div class="min-w-0">
                        <div class="text-white text-sm font-medium truncate">系统原生投屏</div>
                        <div class="text-white/60 text-xs truncate">AirPlay / 浏览器投屏</div>
                    </div>
                </div>
                <i data-lucide="chevron-right" class="w-4 h-4 ${isLocked ? 'text-white/30' : 'text-white/40'} flex-shrink-0"></i>
            `;
            systemItem.onclick = () => {
                this.closeModal();
                if (isLocked) {
                    setTimeout(() => window.DonateManager?.showDonateModal(), 150);
                    return;
                }
                this.triggerSystemCast();
            };
            this.dom.castDeviceList.appendChild(systemItem);

            // 后续项：服务端 DLNA / Remote 会话设备（胶囊药丸，无绿色三角）
            sessions.forEach(s => {
                const name = s.DeviceName || s.Client || '局域网媒体设备';
                const client = s.Client || 'DLNA 渲染器';
                const icon = this.getDeviceIconName(name, client);
                const isActive = this.isCasting && this.activeSessionId === s.Id;

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
                    this.closeModal();
                    if (isLocked) {
                        setTimeout(() => window.DonateManager?.showDonateModal(), 150);
                        return;
                    }
                    this.castToSession(s);
                };
                this.dom.castDeviceList.appendChild(devItem);
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
                    this.isCasting = true;
                    this.isPaused = false;

                    // 1. 本地三槽视频制动并切换为高斯模糊海报展台
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

                    // 2. 渲染投屏控制台
                    this.renderCastingOverlay(this.activeSessionName);

                    // 3. 右上角投屏按钮变为红色 power 断开图标
                    this.renderPowerButton(true);

                    // 4. 启动轻量心跳监测
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
            if (!this.isCasting || !this.activeSessionId) return;

            // 确保本地三槽视频强行暂停，杜绝音画冲突
            [0, 1, 2].forEach(i => {
                const vi = document.getElementById(`video-p${i}`);
                if (vi) {
                    vi.pause();
                    vi.muted = true;
                }
            });

            const willPause = !this.isPaused;
            this.updatePlayPauseButton(willPause);

            const { server, token } = this.app.config;
            if (server && token) {
                const url = `${server}/emby/Sessions/${encodeURIComponent(this.activeSessionId)}/Playing/PlayPause?api_key=${encodeURIComponent(token)}`;
                fetch(url, {
                    method: 'POST',
                    headers: this.app.getAuthHeaders ? this.app.getAuthHeaders(token) : {}
                }).catch(() => {});
            }
        }

        async seekTo(seconds) {
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

        // 上下滑动连续投屏：手机保持高斯模糊展台与会话，直接向电视推送新视频
        async handleSlideChange() {
            if (!this.isCasting || !this.activeSessionId) return;

            const current = this.app.state.videos[this.app.state.currentIndex];
            if (!current) return;

            // 保持本地三槽视频制动并维持高斯模糊展台
            this.applyCastingStageTheme();

            // 更新播放按钮为播放态
            this.updatePlayPauseButton(false);

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

            if (sendStop && sid && server && token) {
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
            this.isCasting = false;
            this.isPaused = false;

            // 隐藏投屏控制台
            if (this.dom.castScreenOverlay) {
                this.dom.castScreenOverlay.classList.remove('flex');
                this.dom.castScreenOverlay.classList.add('hidden');
            }

            // 恢复右上角投屏图标
            this.renderPowerButton(false);

            // 恢复本地舞台海报状态与视频播放
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
                    
                    // 容错检查：电视端加载或启动初期 NowPlayingItem 可能尚未就绪，宽容连续 3 次未匹配后才认定已退出
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

                    // 同步完整版 DLNA / Emby Web 设备的播放进度与播放/暂停状态
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
                void this.dom.castModal.offsetHeight;
                this.dom.castModal.classList.remove('opacity-0', 'pointer-events-none');
                this.dom.castModal.classList.add('opacity-100');
                if (this.dom.castModalCard) {
                    this.dom.castModalCard.classList.remove('translate-y-4', 'opacity-0');
                    this.dom.castModalCard.classList.add('translate-y-0', 'opacity-100');
                }
            }
        }

        closeModal() {
            if (this.dom.castModal) {
                this.dom.castModal.classList.remove('opacity-100');
                this.dom.castModal.classList.add('opacity-0', 'pointer-events-none');
                if (this.dom.castModalCard) {
                    this.dom.castModalCard.classList.remove('translate-y-0', 'opacity-100');
                    this.dom.castModalCard.classList.add('translate-y-4', 'opacity-0');
                }
                setTimeout(() => {
                    if (this.dom.castModal && this.dom.castModal.classList.contains('opacity-0')) {
                        this.dom.castModal.classList.add('hidden');
                    }
                }, 200);
            }
        }
    }

    window.CastManager = CastManager;
})(window);
