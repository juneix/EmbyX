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

        _buildHlsSrc(id, mediaItem, forceReencode = false, quality = null) {
            const { server, token, playQuality } = this.app.config;
            const isPro = window.DonateManager ? window.DonateManager.hasEggAccess() : false;
            const currentQuality = isPro ? (quality || playQuality || 'auto') : 'direct';
            const msIdx = mediaItem?._selectedMediaSourceIndex || 0;
            const mediaSource = mediaItem?.MediaSources?.[msIdx] || mediaItem?.MediaSources?.[0];
            if (mediaItem && mediaSource?.Id) {
                mediaItem._activeMediaSourceId = mediaSource.Id;
            }
            const targetVideoId = mediaSource?.ItemId || (mediaSource?._isPart ? '' : (mediaItem?.Id || id));
            const mediaSourceId = mediaSource?._isPart ? '' : (mediaSource?.Id || '');
            const playSessionId = 'hls_' + targetVideoId + '_' + (mediaSourceId ? mediaSourceId.replace(/[^a-zA-Z0-9]/g, '') : '0') + '_' + Date.now().toString(16);
            const deviceId = this.app.config.deviceId || 'EmbyX-Device';

            const vStream = mediaSource?.MediaStreams?.find(s => s.Type === 'Video');
            const codec = (vStream?.Codec || mediaSource?.VideoCodec || '').toLowerCase();
            const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
            const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 && /Mobile/i.test(navigator.userAgent));
            const isApple = isSafari || isIOS;
            const isQualityLimited = (currentQuality === '1080p' || currentQuality === '720p');

            // H.264 视频走 MPEG-TS 切片以实现零延迟秒开；HEVC/AV1 视频走 fMP4 切片
            const useTsContainer = forceReencode || codec === 'h264';

            // 分辨率与码率限制
            let maxWidthParam = '';
            let maxHeightParam = '';
            let bitrateParam = '';

            if (currentQuality === '1080p') {
                maxWidthParam = 'MaxWidth=1920';
                maxHeightParam = 'MaxHeight=1080';
                bitrateParam = 'VideoBitrate=8000000';
            } else if (currentQuality === '720p') {
                maxWidthParam = 'MaxWidth=1280';
                maxHeightParam = 'MaxHeight=720';
                bitrateParam = 'VideoBitrate=4000000';
            }

            // 仅在明确强制重编码或限制画质时锁定 H.264；流拷贝时声明全格式支持，确保 Emby 0% 视频 CPU 无损流拷贝
            const videoCodecDecl = (forceReencode || isQualityLimited)
                ? 'VideoCodec=h264'
                : (isApple ? 'VideoCodec=hvc1,h264' : 'VideoCodec=h264,hevc,hvc1,vp9,av1');

            const params = [
                `api_key=${token}`,
                mediaSourceId ? `MediaSourceId=${mediaSourceId}` : '',
                `DeviceId=${deviceId}`,
                `PlaySessionId=${playSessionId}`,
                `EnableDirectStream=true`,
                `EnableVideoTranscoding=${forceReencode ? 'true' : (isQualityLimited ? 'true' : 'false')}`,
                `EnableAudioTranscoding=true`,
                `EnableAudioStreamCopy=true`,
                videoCodecDecl,
                `AudioCodec=aac,mp3,opus,flac,vorbis`,
                maxWidthParam,
                maxHeightParam,
                bitrateParam,
                `AudioBitrate=320000`,
                isSafari ? `TranscodingMaxAudioChannels=6` : `TranscodingMaxAudioChannels=2`,
                useTsContainer ? `SegmentContainer=ts` : `SegmentContainer=mp4`,
                `MinSegments=1`,
                forceReencode ? `AllowVideoStreamCopy=false` : `AllowVideoStreamCopy=true`,
                `AllowAudioStreamCopy=true`
            ].filter(Boolean).join('&');

            const fixUrl = window.EmbyXCommon?.fixUrlForJellyfin || ((u) => u);
            return fixUrl(`${server}/emby/Videos/${targetVideoId}/master.m3u8?${params}`);
        }

        getVideoSrc(id, mediaItem, isPrimaryPlayback = false) {
            if (isPrimaryPlayback) this.app.state.isStrmSource = false;
            const { server, token } = this.app.config;

            if (mediaItem?._rawUrl) {
                if (isPrimaryPlayback) this.app.state.playbackMethod = 'DirectPlay';
                return mediaItem._rawUrl;
            }

            const isPro = window.DonateManager ? window.DonateManager.hasEggAccess() : false;
            const quality = isPro ? (this.app.config.playQuality || (this.app.config.useStatic ? 'direct' : 'auto')) : 'direct';

            const msIdx = mediaItem?._selectedMediaSourceIndex || 0;
            const mediaSource = mediaItem?.MediaSources?.[msIdx] || mediaItem?.MediaSources?.[0];
            if (mediaItem && mediaSource?.Id) {
                mediaItem._activeMediaSourceId = mediaSource.Id;
            }
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

            // 非直接播放模式（用户主动选择限制质量或自动转码）
            if (quality !== 'direct') {
                if (isPrimaryPlayback) this.app.state.playbackMethod = (quality === 'auto' ? 'DirectStream' : 'Transcode');
                return this._buildHlsSrc(id, mediaItem, false, quality);
            }

            // ─── 绝对直接播放模式（Direct Play 原画裸流第一优先级） ───
            // 现代手机（尤其是安卓机）、电脑（Windows/Mac）硬解性能全面过剩，首选 DirectPlay 裸流直连
            const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 && /Mobile/i.test(navigator.userAgent));
            const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
            const isAndroid = /Android/i.test(navigator.userAgent);

            // 1. 特殊情况 A：音频检测（绝大多数浏览器无法原生解码 AC3/EAC3/DTS/TrueHD，会导致无声或播放受阻）
            // 触发“直接播放例外”：首播采用 HLS 视频流拷贝（0% 视频 CPU，仅转码音频至 AAC）
            const aStream = mediaSource?.MediaStreams?.find(s => s.Type === 'Audio');
            const aCodec = (aStream?.Codec || '').toLowerCase();
            const isUnsupportedAudio = ['ac3', 'eac3', 'dts', 'truehd'].includes(aCodec);
            if (isUnsupportedAudio) {
                if (isPrimaryPlayback) this.app.state.playbackMethod = 'DirectStream';
                return this._buildHlsSrc(id, mediaItem, false);
            }

            // 2. 特殊情况 B：非原生容器（MKV、TS 等）在桌面端与 iOS 的解封装适配
            // - 安卓设备（isAndroid）：底层系统（Stagefright/MediaExtractor）原生支持 MKV 解封装，直接走 stream?Static=true 原画秒开
            // - 桌面端浏览器（Windows/Mac Chrome/Edge/Firefox/Safari）及 iOS：未编译通用 MKV 解封装器，直接喂 MKV 会报格式不支持
            //   因此对非安卓端的非原生容器走 HLS 视频流拷贝（0% 视频 CPU，画面原画直通，避免卡顿 5 秒报错）
            const isNativeContainer = ['mp4', 'm4v', 'mov', 'webm'].some(type => container.includes(type));
            if (!isAndroid && !isNativeContainer) {
                if (isPrimaryPlayback) this.app.state.playbackMethod = 'DirectStream';
                return this._buildHlsSrc(id, mediaItem, false);
            }

            // 3. 苹果 Safari/iOS 环境下的 hev1 MP4 流拷贝适配
            const isApple = isSafari || isIOS;
            const isHev1Mp4 = isApple && codec === 'hevc' && codecTag.includes('hev1');
            if (isHev1Mp4) {
                if (isPrimaryPlayback) this.app.state.playbackMethod = 'DirectStream';
                return this._buildHlsSrc(id, mediaItem, false);
            }

            // 4. 其余所有正常格式（MP4/WebM，H.264/HEVC/AV1/VP9）全平台 100% 绝对裸流直连
            const targetVideoId = mediaSource?.ItemId || (mediaItem?.Id || id);
            const msId = mediaSource?._isPart ? '' : (mediaSource?.Id || '');
            const deviceId = this.app.config.deviceId || 'EmbyX-Device';
            const playSessionId = 'ex_' + targetVideoId + '_' + Date.now().toString(16);

            const params = [
                `api_key=${token}`,
                `Static=true`,
                msId ? `MediaSourceId=${msId}` : '',
                `DeviceId=${deviceId}`,
                `PlaySessionId=${playSessionId}`
            ].filter(Boolean).join('&');

            if (isPrimaryPlayback) this.app.state.playbackMethod = 'DirectPlay';
            const fixUrl = window.EmbyXCommon?.fixUrlForJellyfin || ((u) => u);
            return fixUrl(`${server}/emby/Videos/${targetVideoId}/stream?${params}`);
        }

        setVideoSource(videoEl, src, index, item, options = {}) {
            if (!videoEl || !src) return;
            if (this.app.castManager && this.app.castManager.isCasting) return;
            const sidMatch = /[?&]PlaySessionId=([^&]+)/i.exec(src);
            if (sidMatch) {
                videoEl.dataset.playSessionId = decodeURIComponent(sidMatch[1]);
            }
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
                    videoEl.onerror = null;
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
                videoEl.onerror = null;
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
                if (preloadOnly) return;
                if (videoEl.dataset.hlsLoading === 'true' || (this.activeHls && this.activeHls.media === videoEl)) return;
                if (!videoEl.error) return;
                const isCurrent = this.isCurrentPlayback(videoEl, item?.Id, src);
                if (isCurrent) this.retryWithAltMode(index, item);
            };
            videoEl.src = src;
            videoEl.load();
        }

        playVideo(index) {
            if (this.app.state.viewMode !== 'stream') return;
            if (this.app.castManager && this.app.castManager.isCasting) return;
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
                        if (typeof this.app.setPlayState === 'function') this.app.setPlayState(true);
                        else this.app.state.isPlaying = true;
                        if (btn) btn.classList.remove('paused');
                    }).catch(error => {
                        if (error?.name === 'AbortError' || !this.isCurrentPlayback(v, videoId, requestedSrc, playAttempt)) return;
                        console.warn('Playback error:', error);
                        if (error?.name !== 'NotAllowedError') return;
                        if (typeof this.app.setPlayState === 'function') this.app.setPlayState(false);
                        else this.app.state.isPlaying = false;
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
                    if (this.activeMpegts) { this.activeMpegts.destroy(); this.activeMpegts = null; }

                    const msIdx = item?._selectedMediaSourceIndex || 0;
                    const mediaSource = item?.MediaSources?.[msIdx] || item?.MediaSources?.[0];
                    const isStrm = (item.Path && item.Path.endsWith('.strm')) || 
                                   (mediaSource && 
                                    (mediaSource.Path?.startsWith('http') || 
                                     mediaSource.Container === 'strm'));

                    if (isStrm) {
                        this.app.state.isStrmSource = true;
                        const msId = mediaSource?.Id || '';
                        const playSessionId = this.app.state.playSessionId || ('ex_' + Date.now().toString(16));
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
                            this.playVideo(index);
                        } else if (v.canPlayType('application/vnd.apple.mpegurl') ||
                            (typeof Hls !== 'undefined' && Hls.isSupported())) {
                            this.app.state.playbackMethod = 'DirectPlay';
                            this.setVideoSource(v, playUrl, index, item, { autoplay: true, forceHls: true, live: true });
                            this.playVideo(index);
                        }
                    } else {
                        // 普通视频降级第 1 级：回退至 HLS 视频流拷贝（DirectStream）
                        // 画面 100% 零损耗，仅在必要时转码音频（如 AC3/DTS -> AAC），视频不转码（CPU 0%）
                        this.app.state.playbackMethod = 'DirectStream';
                        this.onFallback('DirectStream');
                        this.setVideoSource(v, this._buildHlsSrc(item.Id, item, false), index, item, { autoplay: true });
                        this.playVideo(index);
                    }
                } else {
                    // 直接播放模式下，若 HLS 流拷贝依然无法播放，坚决不触发高 CPU 强转码，尊重用户直接播放设置
                    this.app.toggleLoading(false);
                    this.app.state.playbackMethod = 'Failed';
                    this.onError('PLAYBACK_FAILED');
                }
            } else {
                // 转码模式（用户主动在设置中选择了“自动转码”或指定分辨率档位）
                if (retryCount === 0) {
                    if (this.activeHls) { this.activeHls.destroy(); this.activeHls = null; window.activeHls = null; }
                    if (this.activeMpegts) { this.activeMpegts.destroy(); this.activeMpegts = null; }
                    this.app.state.playbackMethod = 'Transcode';
                    this.onFallback('Transcode');
                    this.setVideoSource(v, this._buildHlsSrc(item.Id, item, true, this.app.config.playQuality), index, item, { autoplay: true });
                    this.playVideo(index);
                } else {
                    this.app.toggleLoading(false);
                    this.app.state.playbackMethod = 'Failed';
                    this.onError('TRANSCODE_FAILED');
                }
            }
        }

        togglePlay() {
            if (this.app.castManager && this.app.castManager.isCasting) {
                this.app.castManager.toggleRemotePlayPause();
                return;
            }
            const slideIdx = (this.app.state.currentIndex % 3 + 3) % 3;
            const v = document.getElementById(`video-p${slideIdx}`);
            const btn = document.getElementById(`playBtn-${slideIdx}`);
            if (!v) return;

            if (v.paused) {
                const playPromise = v.play();
                if (typeof this.app.setPlayState === 'function') this.app.setPlayState(true);
                else this.app.state.isPlaying = true;
                if (btn) btn.classList.remove('paused');
                if (playPromise !== undefined) {
                    playPromise.catch(error => {
                        console.warn('Playback resume error:', error);
                        if (typeof this.app.setPlayState === 'function') this.app.setPlayState(false);
                        else this.app.state.isPlaying = false;
                        if (btn) btn.classList.add('paused');
                    });
                }
            } else {
                v.pause();
                if (typeof this.app.setPlayState === 'function') this.app.setPlayState(false);
                else this.app.state.isPlaying = false;
                if (btn) btn.classList.add('paused');
            }
        }

        bindVideoEvents(videoEl, index, videoData) {
            videoEl.onwaiting = () => {
                clearTimeout(this._waitingTimer);
                this._waitingTimer = setTimeout(() => this.app.toggleLoading(true), 300);
            };

            videoEl.onplay = () => {
                if (typeof this.app.setPlayState === 'function') this.app.setPlayState(true);
            };

            // Seamless cross-fade when first frame renders
            videoEl.onplaying = () => {
                clearTimeout(this._waitingTimer);
                this.app.toggleLoading(false);
                videoEl.style.opacity = '1';
                if (typeof this.app.setPlayState === 'function') this.app.setPlayState(true);
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
                if (this.app?.state?.isDragging) return;
                const nowMs = Date.now();
                if (nowMs - (this._lastDomUpdate || 0) >= 250) {
                    this._lastDomUpdate = nowMs;
                    const pct = (videoEl.currentTime / videoEl.duration) * 100;
                    this.onTimeUpdate(videoEl.currentTime, videoEl.duration, pct);
                }
                this.reportPlayback('progress', videoEl);
            };

            videoEl.onpause = () => {
                if (typeof this.app.setPlayState === 'function') this.app.setPlayState(false);
                this.reportPlayback('progress', videoEl);
            };

            videoEl.onended = () => {
                this.reportPlayback('stopped', videoEl);
                this.onEnded();
            };

            videoEl.onerror = () => {
                if (videoEl.dataset.hlsFatalHandled === 'true') {
                    delete videoEl.dataset.hlsFatalHandled;
                    return;
                }
                if (videoEl.dataset.hlsLoading === 'true' || (this.activeHls && this.activeHls.media === videoEl)) {
                    return;
                }
                if (!videoEl.error) return;
                const requestedSrc = videoEl.dataset.requestedSrc || videoEl.currentSrc || videoEl.src;
                if (!this.isCurrentPlayback(videoEl, videoData?.Id, requestedSrc)) return;
                this.app.toggleLoading(false);
                this.retryWithAltMode(this.app.state.currentIndex, videoData);
            };
        }

        reportPlayback(event, videoEl, isKeepAlive = false) {
            if (!this.app.config.server || !this.app.config.token || this.app.state.videos.length === 0) return;
            const videoData = this.app.state.videos[this.app.state.currentIndex];
            if (!videoData || !videoEl) return;
            if (videoData._isOpenList || window.EmbyXCommon?.getServerType() === 'openlist') return;

            const now = Date.now();
            if (event === 'progress' && now - (this.app.state.lastReportTime || 0) < 5000) return;
            if (event === 'progress') this.app.state.lastReportTime = now;

            const eventMap = { 'playing': 'TimeUpdate', 'progress': 'TimeUpdate', 'stopped': 'Stopped' };
            const eventName = videoEl.paused ? 'Pause' : (eventMap[event] || 'TimeUpdate');
            const msIdx = videoData?._selectedMediaSourceIndex || 0;
            const mediaSourceId = videoData.MediaSources?.[msIdx]?.Id || videoData.MediaSources?.[0]?.Id || '';

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
                PlaySessionId: videoEl.dataset.playSessionId || this.app.state.playSessionId || ('ex_' + Date.now().toString(16))
            };

            const endpoint = eventName === 'Stopped' ? '/emby/Sessions/Playing/Stopped' : '/emby/Sessions/Playing/Progress';
            const url = fixUrlForJellyfin(`${this.app.config.server}${endpoint}?api_key=${this.app.config.token}`);
            const headers = this.app.getAuthHeaders(this.app.config.token, { 'Content-Type': 'application/json' });

            if (eventName === 'Stopped' || event === 'stopped') {
                this.terminateActiveEncoding(payload.PlaySessionId, isKeepAlive);
            }

            fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                keepalive: isKeepAlive
            }).catch(() => {});
        }

        terminateActiveEncoding(playSessionId = null, isKeepAlive = false) {
            const server = this.app?.config?.server;
            const token = this.app?.config?.token;
            if (!server || !token) return;
            if (this.app?.config?.fnOS || window.EmbyXCommon?.getServerType() === 'openlist') return;

            const sid = playSessionId || this.app.state?.playSessionId;
            const deviceId = this.app?.config?.deviceId || 'EmbyX-Device';
            if (!sid) return;

            const fixUrl = window.EmbyXCommon?.fixUrlForJellyfin || ((u) => u);
            const headers = this.app.getAuthHeaders(token, { 'Content-Type': 'application/json' });

            // 1. DELETE /emby/Videos/ActiveEncodings (通知 Emby 立即终止后台 ffmpeg 转码进程)
            const activeEncodingUrl = fixUrl(`${server}/emby/Videos/ActiveEncodings?DeviceId=${encodeURIComponent(deviceId)}&PlaySessionId=${encodeURIComponent(sid)}&api_key=${token}`);
            fetch(activeEncodingUrl, {
                method: 'DELETE',
                headers,
                keepalive: isKeepAlive
            }).catch(() => {});

            // 2. POST /emby/Sessions/Playing/Stopped (通知注销播放会话)
            const stopUrl = fixUrl(`${server}/emby/Sessions/Playing/Stopped?api_key=${token}`);
            fetch(stopUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify({ PlaySessionId: sid }),
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
