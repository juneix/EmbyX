/**
 * EmbyX Stage & Physics Engine (Zero-dependency, Vanilla JS)
 * Handles:
 * - 3-slot virtual DOM slide recycle & transform choreography
 * - Smooth cover / poster transition without white/blank glitch
 * - Touch & mouse swipe physics (inertia, resistance, threshold)
 * - Double-tap heart GPU animations
 */
(function (window) {
    'use strict';

    class StageEngine {
        constructor(options = {}) {
            this.app = options.app || null;
            this.container = options.container || null;
            this.onIndexChange = options.onIndexChange || (() => {});
            this.onDoubleTap = options.onDoubleTap || (() => {});
            this.onDoubleTapSkip = options.onDoubleTapSkip || (() => {});

            this.slides = [];
            this.init();
            this.bindGestures();
        }

        init() {
            if (!this.container) return;
            this.container.innerHTML = '';
            this.container.className = 'relative w-full h-full transition-transform duration-300 ease-out';
            this.container.style.transition = 'none';
            this.container.style.transform = `translateY(-${this.app.state.currentIndex * 100}%)`;
            void this.container.offsetHeight;
            this.container.style.transition = '';

            // Initialize exactly 3 physical DOM slots
            for (let i = 0; i < 3; i++) {
                const el = document.createElement('div');
                el.className = 'slide-item bg-black';
                el.id = `slide-${i}`;
                el.style.display = 'none';
                el.innerHTML = `
                    <div class="w-full h-full relative bg-black overflow-hidden" style="transform: translateZ(0);">
                        <!-- 封面缩略图：平滑淡入，防止白底或破图框 -->
                        <img id="thumb-${i}" class="absolute inset-0 w-full h-full z-0 transition-opacity duration-300 ${this.app.state.isScaleFill ? 'object-cover' : 'object-contain'}" src="" alt="" style="opacity: ${this.app.state.isScaleFill ? '1' : '0'};" />
                        <!-- 全屏高斯模糊背景：无论视频或海报比例，始终满屏弥散打底 -->
                        <div id="poster-${i}" class="absolute inset-0 bg-cover bg-center scale-[1.15] blur-xl transition-opacity duration-300 z-0 ${this.app.state.isScaleFill ? 'opacity-0' : 'opacity-70'}"></div>
                        <div id="overlay-${i}" class="absolute inset-0 bg-black/40 transition-opacity duration-300 z-0 ${this.app.state.isScaleFill ? 'opacity-0' : 'opacity-100'}"></div>
                        
                        <!-- 视频层：初始透明，在 onplaying / canplay 时淡入，保持透明以透出底层高斯模糊 -->
                        <video id="video-p${i}"
                            class="video-fullscreen ${this.app.state.isScaleFill ? 'object-cover' : 'object-contain'} opacity-0 transition-opacity duration-300 z-10"
                            playsinline webkit-playsinline muted autoplay
                            poster="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></video>
                        
                        <!-- 遮罩层：屏蔽系统原生菜单 -->
                        <div class="touch-layer absolute inset-0 z-20" style="-webkit-touch-callout: none;"></div>
                        
                        <div id="playBtn-${i}" class="play-pause-btn">
                            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="stroke-white w-8 h-8"><polygon points="6 3 20 12 6 21 6 3"/></svg>
                        </div>
                    </div>
                `;
                this.container.appendChild(el);
            }

            this.slides = [
                document.getElementById('slide-0'),
                document.getElementById('slide-1'),
                document.getElementById('slide-2')
            ];

            if (typeof lucide !== 'undefined' && lucide.createIcons) {
                lucide.createIcons();
            }
        }

        renderBuffer() {
            if (this.app.state.viewMode !== 'stream' || !this.slides) return;

            this.container.style.transform = `translateY(-${this.app.state.currentIndex * 100}%)`;

            const offsets = [-1, 0, 1];
            offsets.forEach((offset) => {
                const videoIdx = this.app.state.currentIndex + offset;
                if (videoIdx < 0 || videoIdx >= this.app.state.videos.length) return;

                const slideIdx = (videoIdx % 3 + 3) % 3;
                const slideEl = this.slides[slideIdx];
                let videoData = this.app.state.videos[videoIdx];
                if ((videoData.IsFolder || videoData.Type === 'Folder') && this.app.drama) {
                    if (videoData._resolvedVideo) {
                        videoData = videoData._resolvedVideo;
                        this.app.state.videos[videoIdx] = videoData;
                    } else if (offset !== 0) {
                        this.app.drama.resolveFolderVideo(videoData).then(real => {
                            if (real) this.app.state.videos[videoIdx] = real;
                        });
                    }
                }

                slideEl.style.transform = `translateY(${videoIdx * 100}%)`;
                slideEl.style.display = 'block';

                if (slideEl.dataset.id !== videoData.Id) {
                    slideEl.dataset.id = videoData.Id;
                    const posterSrc = this.app.getImageSrc(videoData);

                    // 封面平滑更新：预载完成后再赋值，根据填充模式控制可见度
                    const thumbEl = document.getElementById(`thumb-${slideIdx}`);
                    if (thumbEl) {
                        const tempImg = new Image();
                        tempImg.onload = () => {
                            if (slideEl.dataset.id === videoData.Id) {
                                thumbEl.src = posterSrc;
                                thumbEl.style.opacity = this.app.state.isScaleFill ? '1' : '0';
                            }
                        };
                        tempImg.onerror = () => {
                            if (slideEl.dataset.id === videoData.Id) {
                                thumbEl.src = this.app.getImageSrc(null);
                                thumbEl.style.opacity = this.app.state.isScaleFill ? '1' : '0';
                            }
                        };
                        tempImg.src = posterSrc;
                    }

                    // 模糊背景预就位
                    const posterEl = document.getElementById(`poster-${slideIdx}`);
                    if (posterEl) {
                        posterEl.style.backgroundImage = `url('${posterSrc}')`;
                        posterEl.style.opacity = this.app.state.isScaleFill ? '0' : '0.7';
                    }
                    const overlayEl = document.getElementById(`overlay-${slideIdx}`);
                    if (overlayEl) {
                        overlayEl.style.opacity = this.app.state.isScaleFill ? '0' : '1';
                    }

                    // 视频重置透明度，等待流加载完成平滑接管
                    const videoEl = document.getElementById(`video-p${slideIdx}`);
                    videoEl.style.opacity = '0';
                    videoEl.onerror = null;

                    const isIOS = /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
                        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 && /Mobile/i.test(navigator.userAgent));

                    if (isIOS && offset !== 0) {
                        if (videoEl.src) {
                            videoEl.removeAttribute('src');
                            videoEl.load();
                        }
                    } else if (!videoData.IsFolder && videoData.Type !== 'Folder') {
                        const preloadSrc = this.app.player.getVideoSrc(videoData.Id, videoData, false);
                        this.app.player.setVideoSource(videoEl, preloadSrc, videoIdx, videoData, {
                            preloadOnly: offset !== 0
                        });
                    }

                    videoEl.muted = (offset === 0) ? this.app.state.isMuted : true;
                    document.getElementById(`playBtn-${slideIdx}`).classList.remove('paused');
                }
            });

            // 隐藏有效窗口外的卡片
            for (let i = 0; i < 3; i++) {
                const activeIndices = offsets.map(o => (this.app.state.currentIndex + o));
                const currentSlideVideoIdx = activeIndices.find(idx => ((idx % 3 + 3) % 3) === i);
                if (currentSlideVideoIdx === undefined || currentSlideVideoIdx < 0 || currentSlideVideoIdx >= this.app.state.videos.length) {
                    this.slides[i].style.display = 'none';
                    this.slides[i].dataset.id = '';
                    const videoEl = document.getElementById(`video-p${i}`);
                    if (videoEl) {
                        videoEl.onerror = null;
                        videoEl.pause();
                        videoEl.style.opacity = '0';
                        videoEl.removeAttribute('src');
                        videoEl.load();
                    }
                }
            }
        }

        switchSlide(newIndex, direction) {
            const slideIdx = (this.app.state.currentIndex % 3 + 3) % 3;
            const curV = document.getElementById(`video-p${slideIdx}`);
            if (curV) {
                curV.pause();
                if (this.app.player.activeMpegts) {
                    this.app.player.activeMpegts.destroy();
                    this.app.player.activeMpegts = null;
                    window.activeMpegtsPlayer = null;
                }
                this.app.player.reportPlayback('stopped', curV);
            }

            // 同步预就位目标 slide，防止 GPU 重绘空档闪烁
            if (this.slides) {
                const destSlideIdx = (newIndex % 3 + 3) % 3;
                const destSlide = this.slides[destSlideIdx];
                if (destSlide) {
                    destSlide.style.transform = `translateY(${newIndex * 100}%)`;
                    destSlide.style.display = 'block';
                }
            }

            this.app.state.currentIndex = newIndex;

            // 预拉取更多
            if (newIndex >= this.app.state.videos.length - 5 && this.app.state.videos.length < (this.app.state.totalCount || 999999)) {
                if (!this._fetchingAppend) {
                    this._fetchingAppend = true;
                    this.app.fetchVideos(null, null, false, this.app.state.playMode === 'random', true).finally(() => { this._fetchingAppend = false; });
                }
            }

            if (this.container) {
                this.container.style.transform = `translateY(-${newIndex * 100}%)`;
            }

            requestAnimationFrame(async () => {
                await this.app.loadVideo(newIndex);
                this.app.player.playVideo(newIndex);
            });
        }

        bindGestures(targetContainer) {
            if (this._gesturesBound) return;
            const container = targetContainer || document.getElementById('app') || this.container;
            if (!container) return;
            this._gesturesBound = true;

            let state = 'IDLE'; // IDLE, SPEED, DRAG
            let x0 = 0, y0 = 0, t0 = 0;
            let longPressTimer = null;
            let clickTimer = null;
            let clickCount = 0;
            let targetTime = 0;
            let originalTime = 0;
            let gestureActive = false;

            container.style.touchAction = 'none';
            container.style.userSelect = 'none';
            container.style.webkitUserSelect = 'none';

            let speedToast = document.getElementById('stageSpeedToast');
            if (!speedToast) {
                const isEn = (document.documentElement.lang || '').startsWith('en');
                speedToast = document.createElement('div');
                speedToast.id = 'stageSpeedToast';
                speedToast.className = 'absolute top-[calc(env(safe-area-inset-top)+20px)] left-1/2 -translate-x-1/2 bg-black/50 backdrop-blur-sm text-white px-4 py-2 rounded-full text-sm font-bold opacity-0 transition-opacity z-50 pointer-events-none flex items-center gap-2';
                speedToast.innerHTML = `<i data-lucide="fast-forward" class="w-4 h-4 text-green-400"></i><span>${isEn ? '2x Fast Forward' : '2 倍速播放中'}</span>`;
                const appRoot = document.getElementById('app') || document.body;
                appRoot.appendChild(speedToast);
                if (typeof lucide !== 'undefined' && lucide.createIcons) {
                    lucide.createIcons({ root: speedToast });
                }
            }

            const resetSpeed = () => {
                clearTimeout(longPressTimer);
                if (speedToast) speedToast.classList.add('opacity-0');
                const slideIdx = (this.app.state.currentIndex % 3 + 3) % 3;
                const v = document.getElementById(`video-p${slideIdx}`);
                if (v && v.playbackRate !== 1.0) v.playbackRate = 1.0;
            };

            const isExcluded = (target) => {
                const excluded = [
                    '.bottom-nav',
                    '.bottom-info',
                    '.right-toolbar',
                    '#favoriteBtn',
                    '#addToPlaylistBtn',
                    '#scaleBtn',
                    '#muteBtn',
                    '#personBtn',
                    '#fullscreenBtn',
                    '#deleteBtn',
                    'header',
                    '.safe-header',
                    '#libraryModal',
                    '#addToPlaylistModal',
                    '#mediaInfoModal',
                    '#deleteConfirmModal',
                    '.profile-layer'
                ];
                return excluded.some(sel => target.closest(sel));
            };

            const startHandler = (e) => {
                if (this.app.state.viewMode !== 'stream') { gestureActive = false; resetSpeed(); return; }
                if (this.app.isAnyModalOpen && this.app.isAnyModalOpen()) { gestureActive = false; resetSpeed(); return; }
                if (isExcluded(e.target)) {
                    gestureActive = false;
                    resetSpeed();
                    return;
                }

                gestureActive = true;
                state = 'IDLE';
                const t = e.touches ? e.touches[0] : e;
                x0 = t.clientX;
                y0 = t.clientY;
                t0 = Date.now();

                const slideIdx = (this.app.state.currentIndex % 3 + 3) % 3;
                const v = document.getElementById(`video-p${slideIdx}`);
                if (v) originalTime = v.currentTime || 0;

                clearTimeout(longPressTimer);
                longPressTimer = setTimeout(() => {
                    if (state === 'IDLE' && gestureActive && (!this.app.isAnyModalOpen || !this.app.isAnyModalOpen())) {
                        state = 'SPEED';
                        if (v) v.playbackRate = 2.0;
                        if (speedToast) speedToast.classList.remove('opacity-0');
                    }
                }, 300);
            };

            const moveHandler = (e) => {
                if (!gestureActive || this.app.state.viewMode !== 'stream' || (this.app.isAnyModalOpen && this.app.isAnyModalOpen())) {
                    if (state === 'SPEED') resetSpeed();
                    return;
                }
                const t = e.touches ? e.touches[0] : e;
                const diffX = t.clientX - x0;
                const diffY = t.clientY - y0;

                if (Math.abs(diffX) > Math.abs(diffY)) {
                    if (e.cancelable) e.preventDefault();
                }

                if (Math.abs(diffX) > 15 || Math.abs(diffY) > 15) {
                    clearTimeout(longPressTimer);
                    if (state === 'SPEED') resetSpeed();
                    if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 15) {
                        state = 'DRAG';
                    }
                }

                if (state === 'DRAG') {
                    if (e.cancelable) e.preventDefault();
                    const slideIdx = (this.app.state.currentIndex % 3 + 3) % 3;
                    const v = document.getElementById(`video-p${slideIdx}`);
                    if (v && v.duration) {
                        const ratio = diffX / (window.innerWidth / 2);
                        targetTime = originalTime + (ratio * v.duration);
                        targetTime = Math.max(0, Math.min(targetTime, v.duration));

                        const progressEl = document.getElementById('progressLine');
                        if (progressEl) progressEl.style.width = `${(targetTime / v.duration) * 100}%`;
                    }
                }
            };

            const endHandler = (e) => {
                if (!gestureActive || this.app.state.viewMode !== 'stream') {
                    resetSpeed();
                    return;
                }
                gestureActive = false;
                clearTimeout(longPressTimer);

                const slideIdx = (this.app.state.currentIndex % 3 + 3) % 3;
                const v = document.getElementById(`video-p${slideIdx}`);

                if (state === 'SPEED') {
                    resetSpeed();
                    state = 'IDLE';
                    if (typeof this.app.showInterfaceTemp === 'function') this.app.showInterfaceTemp();
                    return;
                }

                if (state === 'DRAG') {
                    if (v) v.currentTime = targetTime;
                    state = 'IDLE';
                    if (typeof this.app.showInterfaceTemp === 'function') this.app.showInterfaceTemp();
                    return;
                }

                state = 'IDLE';
                const t = e.changedTouches ? e.changedTouches[0] : e;
                const diffX = t.clientX - x0;
                const diffY = t.clientY - y0;
                const time = Date.now() - t0;

                if (Math.abs(diffY) > 50 && Math.abs(diffY) > Math.abs(diffX)) {
                    diffY < 0 ? this.app.nextVideo() : this.app.prevVideo();
                    return;
                }

                if (Math.abs(diffX) <= 15 && Math.abs(diffY) <= 15 && time < 350) {
                    clickCount++;
                    if (clickCount === 1) {
                        clickTimer = setTimeout(() => {
                            const app = document.getElementById('app');
                            if (app && app.classList.contains('interface-hidden')) {
                                app.classList.remove('interface-hidden');
                                if (typeof this.app.showInterfaceTemp === 'function') this.app.showInterfaceTemp();
                            } else {
                                this.app.player.togglePlay();
                            }
                            clickCount = 0;
                        }, 250);
                    } else if (clickCount === 2) {
                        clearTimeout(clickTimer);
                        clickCount = 0;
                        const w = window.innerWidth;
                        if (t.clientX < w / 4) {
                            this.onDoubleTapSkip('rewind', t.clientX, t.clientY);
                        } else if (t.clientX > w * 3 / 4) {
                            this.onDoubleTapSkip('forward', t.clientX, t.clientY);
                        } else {
                            this.onDoubleTap(t.clientX, t.clientY);
                        }
                    }
                }
            };

            container.addEventListener('contextmenu', (e) => {
                if (e.target.closest('.touch-layer') || e.target.tagName.toLowerCase() === 'video') {
                    e.preventDefault();
                }
            });

            container.addEventListener('touchstart', startHandler, { passive: true });
            container.addEventListener('touchmove', moveHandler, { passive: false });

            let lastTouchEnd = 0;
            container.addEventListener('touchend', (e) => {
                lastTouchEnd = Date.now();
                endHandler(e);
            });
            container.addEventListener('touchcancel', () => { 
                gestureActive = false; 
                state = 'IDLE'; 
                resetSpeed();
            });

            let isMouseDown = false;
            container.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                if (Date.now() - lastTouchEnd < 500) return;
                isMouseDown = true;
                e.touches = [{ clientX: e.clientX, clientY: e.clientY }];
                startHandler(e);
            });
            container.addEventListener('mousemove', (e) => {
                if (!isMouseDown) return;
                e.touches = [{ clientX: e.clientX, clientY: e.clientY }];
                moveHandler(e);
            });
            const mouseEndHandler = (e) => {
                if (!isMouseDown) return;
                isMouseDown = false;
                e.changedTouches = [{ clientX: e.clientX, clientY: e.clientY }];
                endHandler(e);
            };
            container.addEventListener('mouseup', mouseEndHandler);
            container.addEventListener('mouseleave', (e) => {
                mouseEndHandler(e);
                resetSpeed();
            });
            window.addEventListener('blur', resetSpeed);
        }

        spawnHeart(x, y) {
            const heart = document.createElement('div');
            heart.className = 'heart-anim absolute pointer-events-none z-50';
            heart.style.cssText = `left:${x - 32}px;top:${y - 32}px;--rot:${Math.floor(Math.random() * 40) - 20}deg`;
            heart.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="#ef4444" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="drop-shadow-xl"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>';
            document.getElementById('app').appendChild(heart);
            setTimeout(() => heart.remove(), 900);
        }
    }

    window.StageEngine = StageEngine;
})(window);
