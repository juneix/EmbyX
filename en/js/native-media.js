/**
 * EmbyX Native Media Session (Zero-dependency, Vanilla JS)
 * Handles:
 * - Sync WebView video playback state to Android native MediaSession
 * - Lockscreen / Notification / Dynamic Capsule / Bluetooth headset / Car media control
 * - Support Android native Picture-in-Picture (PiP) mode awareness
 * - Active only in APK: window.EmbyXNativeMedia is injected by patch_android.py
 * - In browsers without window.EmbyXNativeMedia, the module idles silently
 */
(function (window) {
    'use strict';

    const MEDIA_EVENTS = ['play', 'playing', 'pause', 'ended', 'loadedmetadata', 'timeupdate', 'seeked'];

    class NativeMediaSession {
        constructor(app) {
            this.app = app;
            this._lastPoster = '';
            this._lastPosterFor = '';
            this._lastSyncAt = 0;
            this._activeEl = null;
            this._bound = false;
        }

        get bridge() {
            return window.EmbyXNativeMedia || null;
        }

        get enabled() {
            const b = this.bridge;
            return !!b && typeof b.update === 'function';
        }

        get activeVideoElement() {
            const idx = (this.app.state.currentIndex % 3 + 3) % 3;
            return document.getElementById(`video-p${idx}`);
        }

        start() {
            if (this._bound) return;
            this._bound = true;

            window.__embyxMediaCommand = (cmd, arg) => this.handleCommand(cmd, arg);
            window.__embyxPipChanged = (inPip) => this.handlePipChange(inPip);

            MEDIA_EVENTS.forEach(evt => {
                document.addEventListener(evt, (e) => this.onMediaEvent(e), true);
            });
        }

        handlePipChange(inPip) {
            if (inPip) {
                document.body.classList.add('pip-active');
            } else {
                document.body.classList.remove('pip-active');
            }
        }

        onMediaEvent(e) {
            const el = e.target;
            if (!el || el.tagName !== 'VIDEO') return;
            if (el !== this.activeVideoElement) return;
            if (this.app.state.viewMode !== 'stream') return;
            if (this.app.castManager && this.app.castManager.isCasting) return;

            this._activeEl = el;
            if (e.type === 'timeupdate') {
                const now = Date.now();
                if (now - this._lastSyncAt < 3000) return;
                this._lastSyncAt = now;
            }
            this.sync(false);
        }

        currentItem() {
            return this.app.state.videos[this.app.state.currentIndex] || null;
        }

        posterUrl(item) {
            if (!item) return '';
            if (this._lastPosterFor === item.Id) return this._lastPoster;
            let url = '';
            try {
                url = this.app.getImageSrc ? this.app.getImageSrc(item) : '';
            } catch (e) {
                url = '';
            }
            this._lastPosterFor = item.Id;
            this._lastPoster = url || '';
            return this._lastPoster;
        }

        sync(isIdle) {
            if (!this.enabled) return;
            const item = this.currentItem();
            const el = this._activeEl || this.activeVideoElement;

            if (isIdle || !item || this.app.state.viewMode !== 'stream' ||
                (this.app.castManager && this.app.castManager.isCasting)) {
                try { this.bridge.clear(); } catch (e) {}
                return;
            }

            const payload = {
                title: item.Name || item.FileName || 'EmbyX',
                subtitle: item.SeriesName || item.ProductionYear || '',
                poster: this.posterUrl(item),
                playing: el ? !el.paused && !el.ended : false,
                position: el && isFinite(el.currentTime) ? Math.floor(el.currentTime * 1000) : 0,
                duration: el && isFinite(el.duration) ? Math.floor(el.duration * 1000) : 0,
                canPrev: this.app.state.currentIndex > 0,
                canNext: this.app.state.currentIndex < this.app.state.videos.length - 1
            };

            try {
                this.bridge.update(JSON.stringify(payload));
            } catch (e) {
                console.warn('[NativeMedia] Failed to sync media state:', e);
            }
        }

        handleCommand(cmd, arg) {
            const app = this.app;
            const el = this._activeEl || this.activeVideoElement;
            switch (cmd) {
                case 'play':
                    if (el && el.paused) {
                        if (typeof app.togglePlay === 'function') app.togglePlay();
                        else el.play().catch(() => {});
                    }
                    break;
                case 'pause':
                    if (el && !el.paused) {
                        if (typeof app.togglePlay === 'function') app.togglePlay();
                        else el.pause();
                    }
                    break;
                case 'next':
                    if (typeof app.nextVideo === 'function') app.nextVideo();
                    break;
                case 'prev':
                    if (typeof app.prevVideo === 'function') app.prevVideo();
                    break;
                case 'seek': {
                    const seconds = Number(arg);
                    if (el && isFinite(seconds)) el.currentTime = seconds;
                    break;
                }
                case 'stop':
                    if (el) el.pause();
                    try { this.bridge.clear(); } catch (e) {}
                    break;
            }
            setTimeout(() => this.sync(false), 120);
        }
    }

    window.NativeMediaSession = NativeMediaSession;
})(window);
