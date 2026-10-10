/**
 * EmbyX Gallery Controller (Zero-dependency, Vanilla JS)
 * Handles:
 * - Slideshow auto-advance timer & magazine mode calculation
 * - Ken Burns / photo motion animation orchestration
 * - EXIF (TIFF / IFD) and XMP embedded metadata extraction & caching
 * - Swipe gestures (pan left/right, up for playlist) and double-tap heart animations
 */
(function (window) {
    'use strict';

    class Gallery {
        constructor(options = {}) {
            this.app = options.app || null;
            this.container = options.container || null;
            this.slideshowTimer = null;
            this.photoMetadataCache = new Map();
            this.photoMetadataControllers = new Map();

            if (this.container) {
                this.bindGestures(this.container);
            }
        }

        clampSlideshowInterval(value) {
            const num = parseInt(value, 10);
            return isNaN(num) || num < 5 ? 30 : Math.min(300, num);
        }

        isMagazineModeActive() {
            if (!this.app) return false;
            return !!(
                this.app.config.magazineMode &&
                this.app.state.viewMode === 'stream' &&
                window.innerWidth > window.innerHeight &&
                this.app.state.videos.length > 1
            );
        }

        getGalleryStep() {
            return this.isMagazineModeActive() ? 2 : 1;
        }

        getSlideshowIntervalMs() {
            if (!this.app) return 30000;
            return this.clampSlideshowInterval(this.app.config.slideshowInterval) * 1000;
        }

        clearSlideshowTimer() {
            if (this.slideshowTimer) {
                clearTimeout(this.slideshowTimer);
                this.slideshowTimer = null;
            }
        }

        isSlideshowAllowed() {
            if (!this.app) return false;
            return !!(
                this.app.config.autoplay !== false &&
                !this.app.state.isSlideshowPaused &&
                this.app.state.viewMode === 'stream' &&
                this.app.state.videos.length > 1 &&
                !this.app.isAnyModalOpen()
            );
        }

        scheduleSlideshow() {
            this.clearSlideshowTimer();
            if (!this.isSlideshowAllowed()) return;
            const step = this.getGalleryStep();
            if (this.app.state.currentIndex + step >= this.app.state.videos.length) return;
            this.slideshowTimer = setTimeout(() => {
                this.slideshowTimer = null;
                if (typeof this.app.nextVideo === 'function') {
                    this.app.nextVideo(true);
                }
            }, this.getSlideshowIntervalMs());
        }

        restartPhotoMotion(img) {
            if (!img || !this.app) return;
            if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                img.classList.remove('photo-motion');
                img.style.transform = '';
                return;
            }
            img.style.setProperty('--photo-motion-duration', `${this.clampSlideshowInterval(this.app.config.slideshowInterval)}s`);
            img.classList.remove('photo-motion');
            void img.offsetWidth;
            img.classList.add('photo-motion');
        }

        restartSlideMotion(slotIndex) {
            ['', '2'].forEach((suffix) => {
                const img = document.getElementById(`thumb${suffix}-${slotIndex}`);
                if (img && img.getAttribute('src')) this.restartPhotoMotion(img);
            });
        }

        abortInactivePhotoMetadata(activePhotoIds) {
            this.photoMetadataControllers.forEach((controller, id) => {
                if (!activePhotoIds.has(id)) controller.abort();
            });
        }

        getPhotoDisplayName(item) {
            const raw = item?.Path || item?.Name || '';
            let name = String(raw).split(/[\\/]/).pop() || String(raw);
            try { name = decodeURIComponent(name); } catch (e) { }
            name = name.split(/[?#]/)[0].trim();
            name = name.replace(/\.[^./\\]+$/, '').trim();
            return name || '-';
        }

        getPhotoMetadataText(item) {
            if (!item?.Id) return '-';
            return this.photoMetadataCache.get(String(item.Id))?.text || '-';
        }

        buildPhotoDownloadUrl(item) {
            if (!item?.Id || !this.app || !this.app.config.server || !this.app.config.token) return '';
            const fixUrl = window.EmbyXCommon?.fixUrlForJellyfin || ((u) => u);
            return fixUrl(`${this.app.config.server}/emby/Items/${item.Id}/Download?api_key=${this.app.config.token}`);
        }

        ensurePhotoMetadata(item, shouldRefreshUi = false) {
            if (!item?.Id || !this.app) return;
            const id = String(item.Id);
            const cached = this.photoMetadataCache.get(id);
            if (cached) return;
            if (this.photoMetadataControllers.has(id)) return;

            this.photoMetadataCache.set(id, { status: 'loading', text: '-' });
            const controller = new AbortController();
            this.photoMetadataControllers.set(id, controller);
            this.loadPhotoMetadata(item, controller.signal)
                .then(text => {
                    this.photoMetadataCache.set(id, { status: 'done', text: text || '-' });
                })
                .catch((error) => {
                    if (error?.name === 'AbortError') this.photoMetadataCache.delete(id);
                    else this.photoMetadataCache.set(id, { status: 'error', text: '-' });
                })
                .finally(() => {
                    this.photoMetadataControllers.delete(id);
                    if (this.app.state.videos[this.app.state.currentIndex]?.Id === item.Id && typeof this.app.updateUI === 'function') {
                        this.app.updateUI();
                    }
                });
        }

        async loadPhotoMetadata(item, signal) {
            const url = this.buildPhotoDownloadUrl(item);
            if (!url) return '-';
            const headers = this.app.getAuthHeaders(this.app.config.token, { 'Range': 'bytes=0-262143' });
            const res = await fetch(url, {
                headers,
                signal
            });
            if (!res.ok && res.status !== 206) return '-';
            const buffer = await res.arrayBuffer();
            return this.parseEmbeddedImageMetadata(buffer);
        }

        parseEmbeddedImageMetadata(buffer) {
            const bytes = new Uint8Array(buffer);
            if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return '-';

            const exifChunks = [];
            const xmpChunks = [];
            let offset = 2;
            while (offset + 4 < bytes.length) {
                if (bytes[offset] !== 0xff) break;
                const marker = bytes[offset + 1];
                if (marker === 0xda || marker === 0xd9) break;
                const length = (bytes[offset + 2] << 8) + bytes[offset + 3];
                if (length < 2 || offset + 2 + length > bytes.length) break;
                if (marker === 0xe1) {
                    const dataStart = offset + 4;
                    const dataEnd = offset + 2 + length;
                    const header = this.asciiFromBytes(bytes, dataStart, Math.min(dataStart + 35, dataEnd));
                    if (header.startsWith('Exif\0\0')) {
                        exifChunks.push(bytes.slice(dataStart + 6, dataEnd));
                    } else if (header.startsWith('http://ns.adobe.com/xap/1.0/\0')) {
                        xmpChunks.push(bytes.slice(dataStart + 29, dataEnd));
                    }
                }
                offset += 2 + length;
            }

            const exif = exifChunks.length ? this.parseExifTiff(exifChunks[0]) : {};
            const xmp = xmpChunks.length ? this.parseXmpPacket(xmpChunks[0]) : {};
            return this.formatPhotoMetadata({ ...exif, ...xmp });
        }

        asciiFromBytes(bytes, start, end) {
            let out = '';
            for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
            return out;
        }

        decodeTextBytes(bytes) {
            try {
                return new TextDecoder('utf-8').decode(bytes).replace(/\0+$/g, '').trim();
            } catch (e) {
                return this.asciiFromBytes(bytes, 0, bytes.length).replace(/\0+$/g, '').trim();
            }
        }

        parseExifTiff(tiffBytes) {
            const view = new DataView(tiffBytes.buffer, tiffBytes.byteOffset, tiffBytes.byteLength);
            if (view.byteLength < 8) return {};
            const little = view.getUint16(0, false) === 0x4949;
            if (view.getUint16(2, little) !== 42) return {};
            const firstIfd = view.getUint32(4, little);
            const tags = {};
            const tagNames = {
                0x010f: 'make',
                0x0110: 'model',
                0x0132: 'dateTime',
                0x829a: 'exposureTime',
                0x829d: 'fNumber',
                0x8827: 'iso',
                0x9003: 'dateTimeOriginal',
                0x920a: 'focalLength',
                0xa434: 'lensModel'
            };
            const readValue = (type, count, valueOffset) => {
                const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }[type] || 1;
                const size = typeSize * count;
                const ptr = size <= 4 ? valueOffset : view.getUint32(valueOffset, little);
                if (ptr < 0 || ptr + size > view.byteLength) return null;
                if (type === 2 || type === 7) return this.decodeTextBytes(tiffBytes.slice(ptr, ptr + size));
                if (type === 3) return count === 1 ? view.getUint16(ptr, little) : Array.from({ length: count }, (_, i) => view.getUint16(ptr + i * 2, little));
                if (type === 4) return count === 1 ? view.getUint32(ptr, little) : Array.from({ length: count }, (_, i) => view.getUint32(ptr + i * 4, little));
                if (type === 5) {
                    const n = view.getUint32(ptr, little);
                    const d = view.getUint32(ptr + 4, little);
                    return d ? n / d : null;
                }
                return null;
            };
            const walkIfd = (ifdOffset, depth = 0) => {
                if (!ifdOffset || ifdOffset + 2 > view.byteLength || depth > 3) return;
                const count = view.getUint16(ifdOffset, little);
                for (let i = 0; i < count; i++) {
                    const entry = ifdOffset + 2 + i * 12;
                    if (entry + 12 > view.byteLength) break;
                    const tag = view.getUint16(entry, little);
                    const type = view.getUint16(entry + 2, little);
                    const valueCount = view.getUint32(entry + 4, little);
                    if (tag === 0x8769 || tag === 0x8825) {
                        walkIfd(view.getUint32(entry + 8, little), depth + 1);
                        continue;
                    }
                    const name = tagNames[tag];
                    if (name && tags[name] == null) tags[name] = readValue(type, valueCount, entry + 8);
                }
            };
            walkIfd(firstIfd);
            return tags;
        }

        parseXmpPacket(xmpBytes) {
            const xml = this.decodeTextBytes(xmpBytes);
            if (!xml) return {};
            const decode = (value) => value
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#039;|&apos;/g, "'")
                .trim();
            const pickAttr = (name) => {
                const re = new RegExp(`${name}="([^"]+)"`);
                const m = xml.match(re);
                return m ? decode(m[1]) : '';
            };
            const pickTag = (name) => {
                const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`);
                const m = xml.match(re);
                if (!m) return '';
                const li = m[1].match(/<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/);
                return decode((li ? li[1] : m[1]).replace(/<[^>]+>/g, ' '));
            };
            return {
                make: pickAttr('tiff:Make') || pickTag('tiff:Make'),
                model: pickAttr('tiff:Model') || pickTag('tiff:Model'),
                lensModel: pickAttr('aux:Lens') || pickAttr('exifEX:LensModel') || pickTag('aux:Lens') || pickTag('exifEX:LensModel'),
                dateTimeOriginal: pickAttr('exif:DateTimeOriginal') || pickAttr('xmp:CreateDate') || pickAttr('photoshop:DateCreated'),
                description: pickTag('dc:description'),
                keywords: pickTag('dc:subject')
            };
        }

        formatPhotoMetadata(meta) {
            const isEn = (document.documentElement.lang || '').startsWith('en');
            const lines = [];
            const camera = [meta.make, meta.model].filter(Boolean).join(' ');
            if (camera) lines.push(isEn ? `Camera: ${camera}` : `相机：${camera}`);
            if (meta.lensModel) lines.push(isEn ? `Lens: ${meta.lensModel}` : `镜头：${meta.lensModel}`);
            const params = [];
            if (meta.fNumber) params.push(`f/${Number(meta.fNumber).toFixed(1).replace(/\.0$/, '')}`);
            if (meta.exposureTime) params.push(this.formatExposure(meta.exposureTime));
            if (meta.iso) params.push(`ISO ${Array.isArray(meta.iso) ? meta.iso[0] : meta.iso}`);
            if (meta.focalLength) params.push(`${Number(meta.focalLength).toFixed(0)}mm`);
            if (params.length) lines.push(isEn ? `Settings: ${params.join(' · ')}` : `参数：${params.join(' · ')}`);
            const date = meta.dateTimeOriginal || meta.dateTime;
            if (date) lines.push(isEn ? `Date: ${String(date).replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')}` : `时间：${String(date).replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')}`);
            if (meta.description) lines.push(isEn ? `Description: ${meta.description}` : `描述：${meta.description}`);
            if (meta.keywords) lines.push(isEn ? `Keywords: ${meta.keywords}` : `关键词：${meta.keywords}`);
            return lines.length ? lines.join('\n') : '-';
        }

        formatExposure(value) {
            const n = Number(value);
            if (!Number.isFinite(n) || n <= 0) return '';
            if (n < 1) return `1/${Math.round(1 / n)}s`;
            return `${n.toFixed(1).replace(/\.0$/, '')}s`;
        }

        bindGestures(container) {
            if (!container) return;
            let x0 = 0, y0 = 0;
            let t0 = 0;
            let clickTimer = null;
            let clickCount = 0;
            let lastTap = { x: 0, y: 0 };
            let gestureActive = false;

            container.style.touchAction = 'none';
            container.style.userSelect = 'none';
            container.style.webkitUserSelect = 'none';

            const isCenterTap = (x, y) => (
                x > window.innerWidth * 0.25 &&
                x < window.innerWidth * 0.75 &&
                y > window.innerHeight * 0.18 &&
                y < window.innerHeight * 0.82
            );

            const isExcludedTarget = (target) => {
                const excluded = [
                    '.bottom-nav',
                    '.bottom-info',
                    '.right-toolbar',
                    '#favoriteBtn',
                    '#addToPlaylistBtn',
                    '#scaleBtn',
                    '#personBtn',
                    '#fullscreenBtn',
                    '#deleteBtn',
                    '#libraryModal',
                    '#addToPlaylistModal',
                    '#mediaInfoModal',
                    '#deleteConfirmModal',
                    '.profile-layer',
                ];
                return excluded.some(sel => target.closest(sel));
            };

            const startHandler = (e) => {
                if (!this.app || this.app.state.viewMode !== 'stream' || this.app.isAnyModalOpen() || isExcludedTarget(e.target)) {
                    gestureActive = false;
                    return;
                }

                gestureActive = true;
                const t = e.touches ? e.touches[0] : e;
                x0 = t.clientX;
                y0 = t.clientY;
                t0 = Date.now();
            };

            const moveHandler = (e) => {
                if (!gestureActive || !this.app || this.app.state.viewMode !== 'stream' || this.app.isAnyModalOpen()) {
                    return;
                }
                const t = e.touches ? e.touches[0] : e;
                const diffX = t.clientX - x0;
                const diffY = t.clientY - y0;

                if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 8) {
                    if (e.cancelable) e.preventDefault();
                }
            };

            const endHandler = (e) => {
                if (!gestureActive || !this.app || this.app.state.viewMode !== 'stream') {
                    return;
                }
                gestureActive = false;
                const t = e.changedTouches ? e.changedTouches[0] : e;
                const diffX = t.clientX - x0;
                const diffY = t.clientY - y0;
                const time = Date.now() - t0;

                // 默认左右滑动：切换上一张 / 下一张照片 (符合画册看图直觉)
                if (Math.abs(diffX) > 50 && Math.abs(diffX) > Math.abs(diffY)) {
                    diffX < 0 ? (this.app.nextVideo && this.app.nextVideo()) : (this.app.prevVideo && this.app.prevVideo());
                    return;
                }

                // 次手势上下滑动：切换播放列表 / 媒体源相册弹窗
                if (Math.abs(diffY) > 50 && Math.abs(diffY) > Math.abs(diffX)) {
                    if (typeof this.app.toggleModal === 'function') {
                        this.app.toggleModal('libraryModal', true);
                    }
                    return;
                }

                if (Math.abs(diffX) < 10 && Math.abs(diffY) < 10 && time < 300) {
                    lastTap = { x: t.clientX, y: t.clientY };
                    clickCount++;
                    if (clickCount === 1) {
                        clickTimer = setTimeout(() => {
                            const app = document.getElementById('app');
                            if (isCenterTap(lastTap.x, lastTap.y)) {
                                if (typeof this.app.togglePlay === 'function') this.app.togglePlay();
                            } else if (app && app.classList.contains('interface-hidden')) {
                                app.classList.remove('interface-hidden');
                                if (typeof this.app.showInterfaceTemp === 'function') this.app.showInterfaceTemp();
                            }
                            clickCount = 0;
                        }, 250);
                    } else if (clickCount === 2) {
                        clearTimeout(clickTimer);
                        clickCount = 0;
                        if (isCenterTap(t.clientX, t.clientY)) {
                            this.handleDoubleTap(t.clientX, t.clientY);
                        } else if (typeof this.app.showInterfaceTemp === 'function') {
                            this.app.showInterfaceTemp();
                        }
                    }
                }
            };

            container.style.userSelect = 'none';
            container.style.webkitUserSelect = 'none';

            container.addEventListener('contextmenu', (e) => {
                if (e.target.closest('.photo-frame') || e.target.tagName.toLowerCase() === 'img') {
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
            });
        }

        async handleDoubleTap(x, y) {
            if (!this.app) return;
            // 1. 点赞动画 DOM 生成 (纯 SVG + 高性能 GPU 动画)
            const heart = document.createElement('div');
            heart.className = 'heart-anim absolute pointer-events-none z-50';
            heart.style.cssText = `left:${x - 32}px;top:${y - 32}px;--rot:${Math.floor(Math.random() * 40) - 20}deg`;
            heart.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="#ef4444" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="drop-shadow-xl"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>';
            const appEl = document.getElementById('app');
            if (appEl) appEl.appendChild(heart);
            heart.addEventListener('animationend', () => heart.remove());

            // 2. 自动标记收藏（如未收藏则添加）
            const currentPhoto = this.app.state.videos[this.app.state.currentIndex];
            if (currentPhoto && !currentPhoto.UserData?.IsFavorite) {
                try {
                    const { server, token, userId } = this.app.config;
                    const res = await fetch(`${server}/emby/Users/${userId}/FavoriteItems/${currentPhoto.Id}?api_key=${token}`, {
                        method: 'POST',
                        headers: this.app.getAuthHeaders(token)
                    });
                    if (res.ok) {
                        if (!currentPhoto.UserData) currentPhoto.UserData = {};
                        currentPhoto.UserData.IsFavorite = true;
                        this.app.state.favorites.add(String(currentPhoto.Id));

                        const favBtn = document.getElementById('favoriteBtn');
                        if (favBtn) {
                            favBtn.innerHTML = `<div class="w-12 h-12 flex items-center justify-center"><i data-lucide="heart" class="text-secondary fill-secondary w-6 h-6 drop-shadow-md"></i></div>`;
                            if (typeof lucide !== 'undefined' && lucide.createIcons) {
                                lucide.createIcons({ root: favBtn });
                            }
                        }
                        const isEn = (document.documentElement.lang || '').startsWith('en');
                        this.app.showToast(isEn ? '❤️ Favorited' : '❤️ 已收藏');
                    }
                } catch (e) {
                    console.error('Double tap favorite failed:', e);
                }
            }
        }
    }

    window.Gallery = Gallery;
    window.GalleryEngine = Gallery; // alias
})(window);
