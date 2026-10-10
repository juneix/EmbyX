/**
 * EmbyX Video Player Controller (Zero-dependency, Vanilla JS)
 * Handles:
 * - HTML5 <video> lifecycle & state management
 * - Hls.js & mpegts.js integration
 * - iOS WebKit audio policies & stream copy (fMP4/hvc1)
 * - Adaptive fallback: DirectPlay -> DirectStream -> Transcode
 * - Playback progress debounced reporting to Emby / Jellyfin / fnOS
 */
(function (window) {
    'use strict';

    class VideoPlayer {
        constructor(options = {}) {
            this.app = options.app || null;
            this.onPlaying = options.onPlaying || (() => {});
            this.onWaiting = options.onWaiting || (() => {});
            this.onEnded = options.onEnded || (() => {});
            this.onTimeUpdate = options.onTimeUpdate || (() => {});
            this.onFallback = options.onFallback || (() => {});
            this.onError = options.onError || (() => {});

            this._waitingTimer = null;
            this._lastDomUpdate = 0;
            this.activeHls = null;
            this.activeMpegts = null;
        }

        formatTime(seconds) {
            if (isNaN(seconds) || seconds < 0) return '00:00';
            const s = Math.floor(seconds);
            const m = Math.floor(s / 60);
            const h = Math.floor(m / 60);
            const remSec = s % 60;
            const remMin = m % 60;
            const pad = n => String(n).padStart(2, '0');
            return h > 0 ? `${pad(h)}:${pad(remMin)}:${pad(remSec)}` : `${pad(remMin)}:${pad(remSec)}`;
        }

        isCurrentPlayback(videoEl, videoId, requestedSrc, playAttempt = null) {
            const current = this.app.state.videos[this.app.state.currentIndex];
            const slideIdx = (this.app.state.currentIndex % 3 + 3) % 3;
            return this.app.state.viewMode === 'stream' &&
                current && String(current.Id) === String(videoId) &&
                document.getElementById(`video-p${slideIdx}`) === videoEl &&
                videoEl.dataset.requestedSrc === requestedSrc &&
                (playAttempt === null || videoEl.dataset.playAttempt === playAttempt);
        }

        _buildHlsSrc(id, mediaItem, forceReencode = false) {
            const { server, token } = this.app.config;
            const mediaSource = mediaItem?.MediaSources?.[0];
            const mediaSourceId = mediaSource?.Id || '';
            const playSessionId = this.app.state.playSessionId || ('hls_' + id + '_' + Date.now());
            const deviceId = this.app.config.deviceId || 'EmbyX-Device';

            const vStream = mediaSource?.MediaStreams?.find(s => s.Type === 'Video');
            const codec = (vStream?.Codec || mediaSource?.VideoCodec || '').toLowerCase();
            const useTsContainer = forceReencode || codec === 'h264';
            const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
            const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 && /Mobile/i.test(navigator.userAgent));
            const isApple = isSafari || isIOS;

            const params = [
                `api_key=${token}`,
                mediaSourceId ? `MediaSourceId=${mediaSourceId}` : '',
                `DeviceId=${deviceId}`,
                `PlaySessionId=${playSessionId}`,
                `EnableDirectStream=true`,
                `EnableVideoTranscoding=${forceReencode ? 'true' : 'false'}`,
                `EnableAudioTranscoding=true`,
                `EnableAudioStreamCopy=true`,
                forceReencode ? `VideoCodec=h264` : (isApple ? `VideoCodec=hvc1,h264` : `VideoCodec=h264,hevc,hvc1,vp9,av1`),
                `AudioCodec=aac,mp3,ac3,eac3,opus,flac,vorbis`,
                forceReencode ? `VideoBitrate=20000000` : '',
                `AudioBitrate=320000`,
                isSafari ? `TranscodingMaxAudioChannels=6` : `TranscodingMaxAudioChannels=2`,
                useTsContainer ? `SegmentContainer=ts` : `SegmentContainer=mp4`,
                `MinSegments=1`,
                useTsContainer ? `BreakOnNonKeyFrames=True` : '',
                forceReencode ? `AllowVideoStreamCopy=false` : `AllowVideoStreamCopy=true`,
                `AllowAudioStreamCopy=true`
            ].filter(Boolean).join('&');

            return fixUrlForJellyfin(`${server}/emby/Videos/${id}/master.m3u8?${params}`);
        }

        getVideoSrc(id, mediaItem, isPrimaryPlayback = false) {
            if (isPrimaryPlayback) this.app.state.isStrmSource = false;
            const { server, token, useStatic } = this.app.config;

            const mediaSource = mediaItem?.MediaSources?.[0];
            const vStream = mediaSource?.MediaStreams?.find(s => s.Type === 'Video');
            const codec = (vStream?.Codec || mediaSource?.VideoCodec || '').toLowerCase();
            const container = (mediaSource?.Container || '').toLowerCase();
            const codecTag = (vStream?.CodecTag || mediaSource?.VideoCodecTag || '').toLowerCase();

            if (this.app.config.fnOS) {
                const mediaGuid = mediaItem?.Id || id;
                if (mediaGuid) {
                    if (isPrimaryPlayback) this.app.state.playbackMethod = 'DirectPlay';
                    return `${server}/v/api/v1/media/range/${encodeURIComponent(mediaGuid)}?api_key=${encodeURIComponent(token)}`;
                }
                if (isPrimaryPlayback) this.app.showToast('飞牛影视缺少 media_guid，无法播放');
                return '';
            }

            if (!useStatic) {
                if (isPrimaryPlayback) this.app.state.playbackMethod = 'Transcode';
                return this._buildHlsSrc(id, mediaItem);
            }

            const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 && /Mobile/i.test(navigator.userAgent));
            const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
            const isApple = isSafari || isIOS;

            const isHev1Mp4 = codec === 'hevc' && !codecTag.includes('hvc1');
            if (isApple && isHev1Mp4) {
                if (isPrimaryPlayback) this.app.state.playbackMethod = 'DirectStream';
                return this._buildHlsSrc(id, mediaItem, false);
            }

            const isNativeContainer = ['mp4', 'm4v', 'mov', 'webm'].some(type => container.includes(type));
            if (!isIOS && !isNativeContainer) {
                const playSessionId = this.app.state.playSessionId || ('ex_' + Date.now().toString(16));
                const deviceId = this.app.config.deviceId || 'EmbyX-Device';
                const msId = mediaSource?.Id || '';
                const params = [
                    `api_key=${token}`,
                    msId ? `MediaSourceId=${msId}` : '',
                    `DeviceId=${deviceId}`,
                    `PlaySessionId=${playSessionId}`,
                    `VideoCodec=h264,hevc,vp9,av1`,
                    `AudioCodec=aac,mp3,ac3,opus,flac,vorbis`,
                    `AllowVideoStreamCopy=true`,
                    `AllowAudioStreamCopy=true`
                ].filter(Boolean).join('&');
                if (isPrimaryPlayback) this.app.state.playbackMethod = 'DirectStream';
                const fixUrl = window.EmbyXCommon?.fixUrlForJellyfin || ((u) => u);
                return fixUrl(`${server}/emby/Videos/${id}/stream.mp4?${params}`);
            }

            const playSessionId = this.app.state.playSessionId || ('ex_' + Date.now().toString(16));
            const deviceId = this.app.config.deviceId || 'EmbyX-Device';
            const msId = mediaSource?.Id || '';

            const params = [
                `api_key=${token}`,
                `Static=true`,
                msId ? `MediaSourceId=${msId}` : '',
                `DeviceId=${deviceId}`,
                `PlaySessionId=${playSessionId}`
            ].filter(Boolean).join('&');

            if (isPrimaryPlayback) this.app.state.playbackMethod = 'DirectPlay';
            const fixUrl = window.EmbyXCommon?.fixUrlForJellyfin || ((u) => u);
            return fixUrl(`${server}/emby/Videos/${id}/stream?${params}`);
        }

        setVideoSource(videoEl, src, index, item, options = {}) {
            if (!videoEl || !src) return;
            const { preloadOnly = false, autoplay = false, forceHls = false, live = false } = options;
            const isHls = forceHls || /\.m3u8(?:$|[?#])/i.test(src);
            const nativeHls = !!videoEl.canPlayType('application/vnd.apple.mpegurl');

            if (isHls && !nativeHls && typeof Hls !== 'undefined' && Hls.isSupported()) {
                if (preloadOnly) {
                    if (this.activeHls?.media === videoEl) {
                        this.activeHls.destroy();
                        this.activeHls = null;
                        window.activeHls = null;
                    }
                    videoEl.pause();
                    videoEl.removeAttribute('src');
                    videoEl.load();
                    videoEl.dataset.requestedSrc = src;
                    return;
                }

                if (this.activeHls?.media === videoEl && videoEl.dataset.requestedSrc === src) {
                    if (autoplay && videoEl.dataset.hlsLoading === 'true') {
                        videoEl.dataset.pendingPlay = 'true';
                    }
                    return;
                }

                if (this.activeHls) {
                    this.activeHls.destroy();
                    this.activeHls = null;
                }
                videoEl.pause();
                videoEl.removeAttribute('src');
                videoEl.load();
                videoEl.dataset.requestedSrc = src;
                videoEl.dataset.hlsLoading = 'true';
                if (autoplay) videoEl.dataset.pendingPlay = 'true';

                const hls = new Hls(live ? {
                    maxBufferSize: 0,
                    liveSyncDurationCount: 3
                } : {
                    maxBufferLength: 30,
                    backBufferLength: 15
                });
                this.activeHls = hls;
                window.activeHls = hls;

                hls.on(Hls.Events.MEDIA_ATTACHED, () => {
                    if (this.activeHls === hls && videoEl.dataset.requestedSrc === src) {
                        hls.loadSource(src);
                    }
                });
                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    if (this.activeHls !== hls || !this.isCurrentPlayback(videoEl, item.Id, src)) return;
                    videoEl.dataset.hlsLoading = 'false';
                    if (videoEl.dataset.pendingPlay === 'true') {
                        delete videoEl.dataset.pendingPlay;
                        this.playVideo(index);
                    }
                });
                hls.on(Hls.Events.ERROR, (_event, data) => {
                    if (!data.fatal || this.activeHls !== hls) return;
                    const isCurrent = this.isCurrentPlayback(videoEl, item.Id, src);
                    hls.destroy();
                    this.activeHls = null;
                    window.activeHls = null;
                    videoEl.dataset.hlsLoading = 'false';
                    videoEl.dataset.hlsFatalHandled = 'true';
                    if (isCurrent) this.retryWithAltMode(index, item);
                });
                hls.attachMedia(videoEl);
                return;
            }

            if (!preloadOnly && this.activeHls) {
                this.activeHls.destroy();
                this.activeHls = null;
                window.activeHls = null;
            }
            videoEl.pause();
            videoEl.dataset.requestedSrc = src;
            videoEl.dataset.hlsLoading = 'false';
            videoEl.onerror = () => {
                const isCurrent = this.isCurrentPlayback(videoEl, item.Id, src);
                if (isCurrent) this.retryWithAltMode(index, item);
            };
            videoEl.src = src;
            videoEl.load();
        }

        playVideo(index) {
            if (this.app.state.viewMode !== 'stream') return;
            const slideIdx = (this.app.state.currentIndex % 3 + 3) % 3;

            // Stop non-current videos
            [0, 1, 2].forEach(i => {
                const vi = document.getElementById(`video-p${i}`);
                if (vi && i !== slideIdx) {
                    vi.pause();
                    vi.currentTime = 0;
                    const btn = document.getElementById(`playBtn-${i}`);
                    if (btn) btn.classList.remove('paused');
                }
            });

            const v = document.getElementById(`video-p${slideIdx}`);
            const btn = document.getElementById(`playBtn-${slideIdx}`);
            if (v) {
                if (v.dataset.hlsLoading === 'true') {
                    v.dataset.pendingPlay = 'true';
                    return;
                }
                const videoId = this.app.state.videos[this.app.state.currentIndex]?.Id;
                const requestedSrc = v.dataset.requestedSrc || v.currentSrc || v.src;
                const playAttempt = String((parseInt(v.dataset.playAttempt || '0') + 1));
                v.dataset.playAttempt = playAttempt;
                if (!this.app.state.isMuted) v.muted = false;
                const playPromise = v.play();

                if (playPromise !== undefined) {
                    playPromise.then(() => {
                        if (!this.isCurrentPlayback(v, videoId, requestedSrc, playAttempt)) return;
                        this.app.state.isPlaying = true;
                        if (btn) btn.classList.remove('paused');
                    }).catch(error => {
                        if (error?.name === 'AbortError' || !this.isCurrentPlayback(v, videoId, requestedSrc, playAttempt)) return;
                        console.warn('Playback error:', error);
                        if (error?.name !== 'NotAllowedError') return;
                        this.app.state.isPlaying = false;
                        this.app.toggleLoading(false);
                        if (btn) btn.classList.add('paused');

                        this.onError('AUTOPLAY_BLOCKED');
                        const app = document.getElementById('app');
                        if (app && app.classList.contains('interface-hidden')) {
                            app.classList.remove('interface-hidden');
                            this.app.showInterfaceTemp();
                        }
                    });
                }
            }
        }

        retryWithAltMode(index, item) {
            const slideIdx = (this.app.state.currentIndex % 3 + 3) % 3;
            const v = document.getElementById(`video-p${slideIdx}`);
            if (!v) return;

            const retryCount = parseInt(v.dataset.retryCount || '0');
            v.dataset.retryCount = String(retryCount + 1);

            const { server, token } = this.app.config;
            const deviceId = this.app.config.deviceId || 'EmbyX-Device';

            if (this.app.config.useStatic) {
                if (retryCount === 0) {
                    if (this.activeHls) { this.activeHls.destroy(); this.activeHls = null; window.activeHls = null; }
                    if (this.activeMpegts) { this.activeMpegts.destroy(); this.activeMpegts = null; window.activeMpegtsPlayer = null; }

                    const isStrm = (item.Path && item.Path.endsWith('.strm')) || 
                                   (item.MediaSources && item.MediaSources[0] && 
                                    (item.MediaSources[0].Path.startsWith('http') || 
                                     item.MediaSources[0].Container === 'strm'));

                    if (isStrm) {
                        this.app.state.isStrmSource = true;
                        const msId = item.MediaSources?.[0]?.Id || '';
                        const playSessionId = this.app.state.playSessionId || ('ex_' + Date.now().toString(16));
                        const mediaSource = item.MediaSources?.[0];
                        const container = (mediaSource?.Container || '').toLowerCase();
                        const path = (mediaSource?.Path || '').toLowerCase();
                        const isFlv = container === 'flv' || path.includes('.flv') || path.includes('flv=') || path.includes('/flv');

                        const playUrl = mediaSource?.Path && mediaSource.Path.startsWith('http') 
                            ? mediaSource.Path 
                            : fixUrlForJellyfin(`${server}/emby/Videos/${item.Id}/stream?Static=true&api_key=${token}&MediaSourceId=${msId}&DeviceId=${deviceId}&PlaySessionId=${playSessionId}`);

                        if (isFlv && typeof mpegts !== 'undefined' && mpegts.isSupported()) {
                            this.app.state.playbackMethod = 'DirectPlay';
                            v.removeAttribute('src');
                            v.onerror = null;

                            const player = mpegts.createPlayer({
                                type: 'mse',
                                isLive: true,
                                url: playUrl
                            }, {
                                enableWorker: true,
                                enableStashBuffer: false,
                                stashInitialSize: 128,
                                liveBufferLatencyChasing: true,
                                liveBufferLatencyMaxLatency: 1.5,
                                liveBufferLatencyMinRemain: 0.5
                            });
                            v.dataset.requestedSrc = playUrl;
                            v.dataset.hlsLoading = 'false';
                            player.attachMediaElement(v);
                            player.load();
                            this.activeMpegts = player;
                            window.activeMpegtsPlayer = player;
                            this.playVideo(index);
                        } else if (v.canPlayType('application/vnd.apple.mpegurl') ||
                            (typeof Hls !== 'undefined' && Hls.isSupported())) {
                            this.app.state.playbackMethod = 'DirectPlay';
                            this.setVideoSource(v, playUrl, index, item, { autoplay: true, forceHls: true, live: true });
                            this.playVideo(index);
                        }
                    } else {
                        if (this.app.state.playbackMethod !== 'DirectStream' && this.app.state.playbackMethod !== 'Transcode') {
                            if (this.activeHls) { this.activeHls.destroy(); this.activeHls = null; window.activeHls = null; }
                            if (this.activeMpegts) { this.activeMpegts.destroy(); this.activeMpegts = null; window.activeMpegtsPlayer = null; }
                            this.app.state.playbackMethod = 'DirectStream';
                            this.onFallback('DirectStream');
                            this.setVideoSource(v, this._buildHlsSrc(item.Id, item, false), index, item, { autoplay: true });
                            this.playVideo(index);
                        } else {
                            if (this.activeHls) { this.activeHls.destroy(); this.activeHls = null; window.activeHls = null; }
                            if (this.activeMpegts) { this.activeMpegts.destroy(); this.activeMpegts = null; window.activeMpegtsPlayer = null; }
                            this.app.state.playbackMethod = 'Transcode';
                            this.onFallback('Transcode');
                            this.setVideoSource(v, this._buildHlsSrc(item.Id, item, true), index, item, { autoplay: true });
                            this.playVideo(index);
                        }
                    }
                } else if (retryCount === 1) {
                    if (this.activeHls) { this.activeHls.destroy(); this.activeHls = null; window.activeHls = null; }
                    if (this.activeMpegts) { this.activeMpegts.destroy(); this.activeMpegts = null; window.activeMpegtsPlayer = null; }
                    this.app.state.playbackMethod = 'Transcode';
                    this.onFallback('Transcode');
                    this.setVideoSource(v, this._buildHlsSrc(item.Id, item, true), index, item, { autoplay: true });
                    this.playVideo(index);
                } else {
                    this.app.toggleLoading(false);
                    this.app.state.playbackMethod = 'Failed';
                    this.onError('PLAYBACK_FAILED');
                }
            } else {
                if (retryCount === 0) {
                    this.app.state.playbackMethod = 'Transcode';
                    this.onFallback('Transcode');
                    this.setVideoSource(v, this._buildHlsSrc(item.Id, item, true), index, item, { autoplay: true });
                    this.playVideo(index);
                } else {
                    this.app.toggleLoading(false);
                    this.app.state.playbackMethod = 'Failed';
                    this.onError('TRANSCODE_FAILED');
                }
            }
        }

        togglePlay() {
            const slideIdx = (this.app.state.currentIndex % 3 + 3) % 3;
            const v = document.getElementById(`video-p${slideIdx}`);
            const btn = document.getElementById(`playBtn-${slideIdx}`);
            if (!v) return;

            if (v.paused) {
                const playPromise = v.play();
                this.app.state.isPlaying = true;
                if (btn) btn.classList.remove('paused');
                if (playPromise !== undefined) {
                    playPromise.catch(error => {
                        console.warn('Playback resume error:', error);
                        this.app.state.isPlaying = false;
                        if (btn) btn.classList.add('paused');
                    });
                }
            } else {
                v.pause();
                this.app.state.isPlaying = false;
                if (btn) btn.classList.add('paused');
            }
        }

        bindVideoEvents(videoEl, index, videoData) {
            videoEl.onwaiting = () => {
                clearTimeout(this._waitingTimer);
                this._waitingTimer = setTimeout(() => this.app.toggleLoading(true), 300);
            };

            // Seamless cross-fade when first frame renders
            videoEl.onplaying = () => {
                clearTimeout(this._waitingTimer);
                this.app.toggleLoading(false);
                videoEl.style.opacity = '1';
                this.reportPlayback('playing', videoEl);
            };

            videoEl.oncanplay = () => {
                clearTimeout(this._waitingTimer);
                this.app.toggleLoading(false);
                videoEl.style.opacity = '1';
            };

            if (videoEl.readyState >= 3) {
                clearTimeout(this._waitingTimer);
                this.app.toggleLoading(false);
                videoEl.style.opacity = '1';
            }

            videoEl.ontimeupdate = () => {
                if (!videoEl.duration) return;
                const nowMs = Date.now();
                if (nowMs - (this._lastDomUpdate || 0) >= 250) {
                    this._lastDomUpdate = nowMs;
                    const pct = (videoEl.currentTime / videoEl.duration) * 100;
                    this.onTimeUpdate(videoEl.currentTime, videoEl.duration, pct);
                }
                this.reportPlayback('progress', videoEl);
            };

            videoEl.onpause = () => this.reportPlayback('progress', videoEl);

            videoEl.onended = () => {
                this.reportPlayback('stopped', videoEl);
                this.onEnded();
            };

            videoEl.onerror = () => {
                if (videoEl.dataset.hlsFatalHandled === 'true') {
                    delete videoEl.dataset.hlsFatalHandled;
                    return;
                }
                this.app.toggleLoading(false);
                this.retryWithAltMode(this.app.state.currentIndex, videoData);
            };
        }

        reportPlayback(event, videoEl, isKeepAlive = false) {
            if (!this.app.config.server || !this.app.config.token || this.app.state.videos.length === 0) return;
            const now = Date.now();
            if (event === 'progress' && now - (this.app.state.lastReportTime || 0) < 5000) return;
            if (event === 'progress') this.app.state.lastReportTime = now;

            const videoData = this.app.state.videos[this.app.state.currentIndex];
            if (!videoData || !videoEl) return;

            const eventMap = { 'playing': 'TimeUpdate', 'progress': 'TimeUpdate', 'stopped': 'Stopped' };
            const eventName = videoEl.paused ? 'Pause' : (eventMap[event] || 'TimeUpdate');
            const mediaSourceId = videoData.MediaSources?.[0]?.Id || '';

            if (event === 'playing') {
                this.reportCapabilities();
            }

            if (this.app.config.fnOS) {
                const pos = Math.floor(videoEl.currentTime || 0);
                const status = event === 'playing' ? 1 : (event === 'progress' ? (videoEl.paused ? 2 : 1) : 3);
                const body = {
                    video_id: videoData.Id,
                    stream_id: 0,
                    status: status,
                    position: pos,
                    duration: Math.floor(videoEl.duration || 0)
                };
                fetch(`${this.app.config.server}/v/api/v1/sub/play_report`, {
                    method: 'POST',
                    headers: this.app.getAuthHeaders(this.app.config.token, { 'Content-Type': 'application/json' }),
                    body: JSON.stringify(body)
                }).catch(() => {});
                return;
            }

            const payload = {
                QueueableMediaTypes: ["Video"],
                CanSeek: true,
                ItemId: videoData.Id,
                MediaSourceId: mediaSourceId,
                PositionTicks: Math.floor((videoEl.currentTime || 0) * 10000000),
                PlayMethod: this.app.state.playbackMethod === 'Transcode' ? 'Transcode' : (this.app.state.playbackMethod === 'DirectStream' ? 'DirectStream' : 'DirectPlay'),
                RepeatMode: "RepeatNone",
                SubtitleStreamIndex: -1,
                IsPaused: videoEl.paused,
                IsMuted: videoEl.muted,
                VolumeLevel: Math.floor((videoEl.volume || 1) * 100),
                PlaySessionId: this.app.state.playSessionId || ('ex_' + Date.now().toString(16))
            };

            const endpoint = eventName === 'Stopped' ? '/emby/Sessions/Playing/Stopped' : '/emby/Sessions/Playing/Progress';
            const url = fixUrlForJellyfin(`${this.app.config.server}${endpoint}?api_key=${this.app.config.token}`);
            const headers = this.app.getAuthHeaders(this.app.config.token, { 'Content-Type': 'application/json' });

            if (isKeepAlive && navigator.sendBeacon) {
                try {
                    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
                    navigator.sendBeacon(url, blob);
                    return;
                } catch (e) {}
            }

            fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                keepalive: isKeepAlive
            }).catch(() => {});
        }

        reportCapabilities() {
            if (this.app.state._capabilitiesReported || !this.app.config.server || !this.app.config.token) return;
            const payload = {
                PlayableMediaTypes: ["Video"],
                SupportsMediaControl: true,
                SupportedCommands: ["Play", "Pause", "Stop", "Seek", "VolumeUp", "VolumeDown", "Mute", "Unmute"]
            };
            fetch(fixUrlForJellyfin(`${this.app.config.server}/emby/Sessions/Capabilities/Full?api_key=${this.app.config.token}`), {
                method: 'POST',
                headers: this.app.getAuthHeaders(this.app.config.token, { 'Content-Type': 'application/json' }),
                body: JSON.stringify(payload)
            }).then(r => {
                if (r.ok) this.app.state._capabilitiesReported = true;
            }).catch(() => {});
        }
    }

    window.VideoPlayer = VideoPlayer;
})(window);
