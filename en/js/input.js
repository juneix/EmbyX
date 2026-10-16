/**
 * EmbyX Unified Input & Interaction Engine (Zero-dependency, Vanilla JS)
 * Combines:
 * - 2D geometry-based spatial navigation for irregular layouts & TV remote focus
 * - Hardware keyboard shortcuts & focus management
 * - Mobile/touchscreen gestures (swipe, double-tap heart/skip)
 */
(function (window) {
    'use strict';

    class InputManager {
        constructor(options = {}) {
            this.app = options.app || null;
            this.okClickCount = 0;
            this.okClickTimer = null;
        }

        // ══════════════════════════════════════════════════════════════
        // 1. 2D 空间导航与遥控器焦点管理 (原 SpatialNavigator)
        // ══════════════════════════════════════════════════════════════

        /**
         * Handle directional keys and OK/Enter inside active modal or grid view.
         * Returns true if the key event was consumed by navigation.
         */
        handleKey(e, context = {}) {
            const key = e.key;
            const keyCode = e.keyCode;
            const lowKey = (key || '').toLowerCase();
            const isInput = context.isInput || false;

            const isDirection = key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight' ||
                lowKey === 'w' || lowKey === 'a' || lowKey === 's' || lowKey === 'd' ||
                [38, 40, 37, 39].includes(keyCode);

            const isEnter = key === 'Enter' || keyCode === 13;

            if (!isDirection && !isEnter) return false;

            const container = context.container || document.body;
            const items = Array.from(container.querySelectorAll('.focusable-item'));
            if (!items.length) return false;

            let currentIndex = items.indexOf(document.activeElement);

            // 1. Directional Movement
            if (isDirection) {
                if (isInput) return false;
                e.preventDefault();

                if (currentIndex === -1) {
                    let startItem = items[0];
                    if (context.isGrid) {
                        const targetIdx = context.currentGridIndex ?? -1;
                        startItem = items.find(it => it.dataset.index == targetIdx) || items[0];
                    }
                    startItem?.focus();
                    return true;
                }

                // A. Fixed 3-column grid mode
                if (context.isGrid) {
                    let nextIdx = currentIndex;
                    if (key === 'ArrowDown' || lowKey === 's' || keyCode === 40) nextIdx += 3;
                    else if (key === 'ArrowUp' || lowKey === 'w' || keyCode === 38) nextIdx -= 3;
                    else if (key === 'ArrowRight' || lowKey === 'd' || keyCode === 39) nextIdx += 1;
                    else if (key === 'ArrowLeft' || lowKey === 'a' || keyCode === 37) nextIdx -= 1;

                    if (nextIdx >= 0 && nextIdx < items.length) {
                        items[nextIdx].focus();
                        items[nextIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                    return true;
                }

                // B. 2D geometry-based spatial navigation (e.g., Library modal)
                if (context.isSpatial) {
                    const cur = items[currentIndex];
                    const curR = cur.getBoundingClientRect();
                    const curCx = curR.left + curR.width / 2;
                    const curCy = curR.top + curR.height / 2;

                    let dir;
                    if (key === 'ArrowDown' || lowKey === 's' || keyCode === 40) dir = 'down';
                    else if (key === 'ArrowUp' || lowKey === 'w' || keyCode === 38) dir = 'up';
                    else if (key === 'ArrowRight' || lowKey === 'd' || keyCode === 39) dir = 'right';
                    else if (key === 'ArrowLeft' || lowKey === 'a' || keyCode === 37) dir = 'left';

                    let best = null, bestScore = Infinity;
                    items.forEach(item => {
                        if (item === cur) return;
                        const r = item.getBoundingClientRect();
                        const cx = r.left + r.width / 2;
                        const cy = r.top + r.height / 2;
                        const dx = cx - curCx, dy = cy - curCy;

                        // Retain candidates in target direction with 2px tolerance
                        if (dir === 'down' && dy <= 2) return;
                        if (dir === 'up' && dy >= -2) return;
                        if (dir === 'right' && dx <= 2) return;
                        if (dir === 'left' && dx >= -2) return;

                        // Weighted distance: prioritize main axis, penalize off-axis deviation
                        const score = (dir === 'down' || dir === 'up')
                            ? Math.abs(dy) + Math.abs(dx) * 3
                            : Math.abs(dx) + Math.abs(dy) * 3;

                        if (score < bestScore) {
                            bestScore = score;
                            best = item;
                        }
                    });

                    if (best) {
                        best.focus();
                        best.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }
                    return true;
                }

                // C. Linear list cycling (e.g., Profile page)
                if (key === 'ArrowDown' || lowKey === 's' || key === 'ArrowRight' || lowKey === 'd' || [40, 39].includes(keyCode)) {
                    currentIndex = (currentIndex + 1) % items.length;
                } else {
                    currentIndex = (currentIndex - 1 + items.length) % items.length;
                }
                items[currentIndex].focus();
                return true;
            }

            // 2. OK / Enter trigger
            if (isEnter) {
                if (document.activeElement && document.activeElement.classList.contains('focusable-item')) {
                    const tagName = document.activeElement.tagName.toLowerCase();
                    if (tagName === 'textarea' || (tagName === 'input' && document.activeElement.type !== 'checkbox')) {
                        return false;
                    }
                    e.preventDefault();
                    document.activeElement.click();
                    return true;
                }
            }

            return false;
        }

        /**
         * Auto focus first or active item when modal opens
         */
        focusModal(containerEl, delayMs = 300) {
            if (!containerEl) return;
            setTimeout(() => {
                const allItems = Array.from(containerEl.querySelectorAll('.focusable-item'));
                // Prioritize selected item with primary background
                const selected = allItems.find(i => i.classList.contains('bg-primary/20'));
                const target = selected || allItems[0];
                if (target) target.focus();
            }, delayMs);
        }

        /**
         * Blur active element if it belongs to closing modal
         */
        blurModal(containerEl) {
            if (containerEl && document.activeElement && containerEl.contains(document.activeElement)) {
                document.activeElement.blur();
            }
        }

        // ══════════════════════════════════════════════════════════════
        // 2. 键盘与全局按键分发
        // ══════════════════════════════════════════════════════════════

        bindKeyboard() {
            if (!this.app) return;
            const app = this.app;

            document.addEventListener('keydown', (e) => {
                const profileActive = document.getElementById('profilePage')?.classList.contains('active');
                const libraryActive = !document.getElementById('libraryModal')?.classList.contains('hidden');
                const playlistActive = !document.getElementById('addToPlaylistModal')?.classList.contains('hidden');

                const isInput = ['input', 'textarea', 'select'].includes(document.activeElement.tagName.toLowerCase());

                const key = e.key;
                const keyCode = e.keyCode;
                const lowKey = (key || '').toLowerCase();

                // ESC: 关闭任何打开的弹窗
                if (key === 'Escape') {
                    const modals = ['addToPlaylistModal', 'libraryModal', 'mediaInfoModal', 'deleteConfirmModal', 'syncConfirmModal'];
                    for (const id of modals) {
                        const el = document.getElementById(id);
                        if (el && !el.classList.contains('hidden')) {
                            app.toggleModal(id, false);
                            return;
                        }
                    }
                    if (profileActive) {
                        app.toggleModal('profilePage', false);
                        return;
                    }
                }

                // 空间导航 (Remote Control / Keyboard Focus)
                const isGridActive = document.getElementById('app')?.classList.contains('grid-active');
                if (profileActive || libraryActive || playlistActive || isGridActive) {
                    const isGrid = isGridActive && !profileActive && !libraryActive;
                    const container = profileActive ? document.getElementById('profilePage') :
                        libraryActive ? document.getElementById('libraryModal') :
                            playlistActive ? document.getElementById('addToPlaylistModal') :
                                document.getElementById('videoContainer');

                    const consumed = this.handleKey(e, {
                        isInput,
                        isGrid,
                        currentGridIndex: app.state.currentIndex,
                        isSpatial: libraryActive,
                        container
                    });
                    if (consumed) return;
                }

                if (isInput) return;

                // 1. 上下方向键 / WS：切换视频
                if (key === 'ArrowUp' || lowKey === 'w' || keyCode === 38) {
                    e.preventDefault();
                    app.prevVideo();
                } else if (key === 'ArrowDown' || lowKey === 's' || keyCode === 40) {
                    e.preventDefault();
                    app.nextVideo();
                }
                // 2. 左右方向键 / AD：快进快退 15 秒
                else if (key === 'ArrowLeft' || lowKey === 'a' || keyCode === 37) {
                    e.preventDefault();
                    const slideIdx = (app.state.currentIndex % 3 + 3) % 3;
                    const v = document.getElementById(`video-p${slideIdx}`);
                    if (v) v.currentTime = Math.max(0, v.currentTime - 15);
                    app.showInterfaceTemp();
                } else if (key === 'ArrowRight' || lowKey === 'd' || keyCode === 39) {
                    e.preventDefault();
                    const slideIdx = (app.state.currentIndex % 3 + 3) % 3;
                    const v = document.getElementById(`video-p${slideIdx}`);
                    if (v && v.duration) v.currentTime = Math.min(v.duration, v.currentTime + 15);
                    app.showInterfaceTemp();
                }
                // 3. 确认逻辑：空格键 & OK键
                else if (key === ' ' || key === 'Enter' || keyCode === 13) {
                    e.preventDefault();
                    if (key === ' ') {
                        app.togglePlay();
                    } else {
                        this.okClickCount++;
                        if (this.okClickCount === 1) {
                            this.okClickTimer = setTimeout(() => {
                                app.togglePlay();
                                this.okClickCount = 0;
                            }, 300);
                        } else if (this.okClickCount === 2) {
                            clearTimeout(this.okClickTimer);
                            this.okClickCount = 0;
                            this.handleDoubleTap(window.innerWidth / 2, window.innerHeight / 2);
                        }
                    }
                }
                // 4. 菜单键/缩放键 (j / Menu)
                else if (lowKey === 'j' || keyCode === 18 || keyCode === 93 || keyCode === 118) {
                    e.preventDefault();
                    app.toggleScaleMode();
                    app.showInterfaceTemp();
                }
                // 5. 功能快捷键 (R, E, F, G, V, I, U, M, Y, H)
                else {
                    if (lowKey === 'r' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                        app.dom.playModeBtn?.click();
                    } else if (lowKey === 'f') {
                        app.dom.fullscreenBtn?.click();
                    } else if (lowKey === 'e') {
                        app.dom.viewModeBtn?.click();
                    } else if (lowKey === 'g') {
                        const modal = document.getElementById('libraryModal');
                        if (modal && !modal.classList.contains('hidden')) {
                            app.toggleModal('libraryModal', false);
                        } else {
                            app.showLibraries();
                            app.dom.libraryBtn?.classList.remove('nav-clicked');
                            void app.dom.libraryBtn?.offsetWidth;
                            app.dom.libraryBtn?.classList.add('nav-clicked');
                            setTimeout(() => app.dom.libraryBtn?.classList.remove('nav-clicked'), 1000);
                        }
                    } else if (lowKey === 'i') {
                        const modal = document.getElementById('profilePage');
                        if (modal && modal.classList.contains('active')) {
                            app.toggleModal('profilePage', false);
                        } else {
                            app.toggleModal('profilePage', true);
                            app.dom.myBtn?.classList.remove('nav-clicked');
                            void app.dom.myBtn?.offsetWidth;
                            app.dom.myBtn?.classList.add('nav-clicked');
                            setTimeout(() => app.dom.myBtn?.classList.remove('nav-clicked'), 1000);
                        }
                    } else if (lowKey === 'v') {
                        if (!isGridActive) {
                            if (app.dom.mediaInfoModal && !app.dom.mediaInfoModal.classList.contains('hidden')) {
                                app.toggleModal('mediaInfoModal', false);
                            } else {
                                app.showMediaInfo();
                            }
                        }
                    } else if (lowKey === 'm') {
                        app.dom.muteBtn?.click();
                    } else if (lowKey === 'u') {
                        this.showCenterHeartAnimation();
                        const id = String(app.state.videos[app.state.currentIndex]?.Id);
                        if (!app.state.favorites.has(id)) {
                            app.toggleFavorite();
                            const favBtn = document.getElementById('favoriteBtn');
                            if (favBtn) {
                                favBtn.innerHTML = `<div class="w-12 h-12 flex items-center justify-center"><i data-lucide="heart" class="text-secondary fill-secondary w-6 h-6 drop-shadow-md"></i></div>`;
                                if (window.lucide) lucide.createIcons({ root: favBtn });
                            }
                        }
                        app.showInterfaceTemp();
                    } else if (lowKey === 'y') {
                        if (app.state.isFilteredByPerson) {
                            app.toggleViewMode();
                        } else {
                            const btn = document.getElementById('personBtn');
                            if (btn && btn.dataset.personName) btn.click();
                        }
                    } else if (lowKey === 'h') {
                        const playlistModal = document.getElementById('addToPlaylistModal');
                        if (playlistModal && !playlistModal.classList.contains('hidden')) {
                            app.toggleModal('addToPlaylistModal', false);
                        } else {
                            app.showAddToPlaylist();
                            app.showInterfaceTemp();
                        }
                    }
                }
            });
        }

        // ══════════════════════════════════════════════════════════════
        // 3. 触控与手势动画
        // ══════════════════════════════════════════════════════════════

        bindGestures(container) {
            if (this.app?.stage) {
                this.app.stage.bindGestures(container);
            }
        }

        async handleDoubleTapSkip(direction, x, y) {
            if (!this.app) return;
            const app = this.app;
            const slideIdx = (app.state.currentIndex % 3 + 3) % 3;
            const v = document.getElementById(`video-p${slideIdx}`);
            if (!v || !v.duration) return;

            const isRewind = direction === 'rewind';
            if (isRewind) {
                v.currentTime = Math.max(0, v.currentTime - 15);
            } else {
                v.currentTime = Math.min(v.duration, v.currentTime + 15);
            }
            app.showInterfaceTemp();

            const bubble = document.createElement('div');
            bubble.innerHTML = `
                <div class="flex flex-col items-center justify-center bg-black/40 backdrop-blur-md text-white rounded-full w-[80px] h-[80px] shadow-2xl space-y-1">
                    <div class="flex items-center justify-center">
                        ${isRewind ? '<i data-lucide="chevrons-left" class="w-6 h-6"></i>' : '<i data-lucide="chevrons-right" class="w-6 h-6"></i>'}
                    </div>
                    <span class="text-xs font-bold leading-none">15s</span>
                </div>
            `;
            bubble.className = 'absolute pointer-events-none z-50 transform transition-all duration-300 ease-out flex items-center justify-center';
            bubble.style.top = `${Math.max(80, Math.min(y - 40, window.innerHeight - 80))}px`;
            if (isRewind) bubble.style.left = '20px';
            else bubble.style.right = '20px';
            bubble.style.opacity = '0';
            bubble.style.transform = `scale(0.8) ${isRewind ? 'translateX(-20px)' : 'translateX(20px)'}`;

            document.getElementById('app').appendChild(bubble);
            if (window.lucide) lucide.createIcons({ root: bubble });

            requestAnimationFrame(() => {
                bubble.style.transform = 'scale(1) translateX(0)';
                bubble.style.opacity = '1';
                setTimeout(() => {
                    bubble.style.transform = `scale(0.8) ${isRewind ? 'translateX(-20px)' : 'translateX(20px)'}`;
                    bubble.style.opacity = '0';
                    setTimeout(() => bubble.remove(), 300);
                }, 400);
            });
        }

        showCenterHeartAnimation() {
            const heart = document.createElement('div');
            heart.className = 'heart-anim absolute pointer-events-none z-50';
            heart.style.cssText = `left:calc(50% - 32px);top:calc(50% - 32px);--rot:${Math.floor(Math.random() * 40) - 20}deg`;
            heart.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="#ef4444" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="drop-shadow-xl"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>';
            document.getElementById('app').appendChild(heart);
            heart.addEventListener('animationend', () => heart.remove());
        }

        async handleDoubleTap(x, y) {
            if (!this.app) return;
            const app = this.app;

            // 1. 点赞动画
            const heart = document.createElement('div');
            heart.className = 'heart-anim absolute pointer-events-none z-50';
            heart.style.cssText = `left:${x - 32}px;top:${y - 32}px;--rot:${Math.floor(Math.random() * 40) - 20}deg`;
            heart.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="#ef4444" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="drop-shadow-xl"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>';
            document.getElementById('app').appendChild(heart);
            heart.addEventListener('animationend', () => heart.remove());

            // 2. 自动标记收藏
            const currentVideo = app.state.videos[app.state.currentIndex];
            if (currentVideo && !currentVideo.UserData?.IsFavorite) {
                try {
                    const { server, token, userId } = app.config;
                    const res = await fetch(`${server}/emby/Users/${userId}/FavoriteItems/${currentVideo.Id}?api_key=${token}`, {
                        method: 'POST',
                        headers: app.getAuthHeaders(token)
                    });
                    if (res.ok) {
                        if (!currentVideo.UserData) currentVideo.UserData = {};
                        currentVideo.UserData.IsFavorite = true;
                        app.state.favorites.add(String(currentVideo.Id));

                        const favBtn = document.getElementById('favoriteBtn');
                        if (favBtn) {
                            favBtn.innerHTML = `<div class="w-12 h-12 flex items-center justify-center"><i data-lucide="heart" class="text-secondary fill-secondary w-6 h-6 drop-shadow-md"></i></div>`;
                            if (window.lucide) lucide.createIcons({ root: favBtn });
                        }
                        app.showToast('❤️ 已收藏');
                    }
                } catch (e) {
                    console.error('Double tap favorite failed:', e);
                }
            }
        }
    }

    // 同时挂载 InputManager 与兼容别名 SpatialNavigator，确保其它页面引用零破坏
    window.InputManager = InputManager;
    window.SpatialNavigator = InputManager;
})(window);
