/**
 * EmbyX Media Information Drawer & Stream Analyzer (Zero-dependency, Vanilla JS)
 * Inspects:
 * - Video resolution, FPS, Codec (HEVC, H.264, AV1, etc.)
 * - Audio Codec & Multi-channel configuration
 * - Container format, Bitrate, File Size
 * - Direct Play vs Direct Stream vs Transcoding strategy detection
 */
(function (window) {
    'use strict';

    class MediaInfoModal {
        constructor(app) {
            this.app = app || null;
        }

        async show() {
            if (!this.app) return;
            const app = this.app;
            const item = app.state.videos[app.state.currentIndex];
            if (!item) return;

            if (app.dom.mediaInfoModal) {
                app.dom.mediaInfoModal.classList.remove('hidden');
            }
            app.showInterfaceTemp();

            const prevBtn = document.getElementById('mediaInfoPrevVerBtn');
            const nextBtn = document.getElementById('mediaInfoNextVerBtn');
            const titleEl = document.getElementById('mediaInfoTitle');
            if (titleEl) titleEl.textContent = 'Media Info';
            if (prevBtn) prevBtn.classList.add('hidden');
            if (nextBtn) nextBtn.classList.add('hidden');

            if (app.dom.mediaInfoContent) {
                app.dom.mediaInfoContent.innerHTML = `<div class="flex justify-center py-4"><i data-lucide="loader-2" class="w-6 h-6 animate-spin text-gray-500"></i></div>`;
                if (window.lucide) lucide.createIcons();
            }

            try {
                if (!item._fullSourcesFetched) {
                    const detailUrl = `${app.config.server}/emby/Users/${app.config.userId}/Items/${item.Id}?api_key=${app.config.token}&Fields=MediaSources,PartCount`;
                    const res = await fetch(detailUrl, { headers: app.getAuthHeaders(app.config.token) });
                    if (res.ok) {
                        const data = await res.json();
                        if (data && data.MediaSources && data.MediaSources.length > 0) {
                            const activeSourceId = item._activeMediaSourceId || (item.MediaSources && item.MediaSources[item._selectedMediaSourceIndex || 0]?.Id);
                            item.MediaSources = data.MediaSources;

                            if (activeSourceId) {
                                const matchedIdx = data.MediaSources.findIndex(s => s.Id === activeSourceId || s.ItemId === activeSourceId);
                                if (matchedIdx !== -1) {
                                    item._selectedMediaSourceIndex = matchedIdx;
                                }
                            } else if (item._selectedMediaSourceIndex === undefined) {
                                const defaultIdx = data.MediaSources.findIndex(s => s.Type === 'Default');
                                item._selectedMediaSourceIndex = defaultIdx !== -1 ? defaultIdx : 0;
                            }
                        }
                        item.PartCount = data.PartCount || 1;
                    }

                    if (item.PartCount > 1) {
                        try {
                            const pUrl = `${app.config.server}/emby/Videos/${item.Id}/AdditionalParts?api_key=${app.config.token}&UserId=${app.config.userId}`;
                            const pRes = await fetch(pUrl, { headers: app.getAuthHeaders(app.config.token) });
                            if (pRes.ok) {
                                const pData = await pRes.json();
                                if (pData.Items && pData.Items.length > 0) {
                                    if (!item.MediaSources) item.MediaSources = [];
                                    pData.Items.forEach((part, idx) => {
                                        if (!item.MediaSources.some(s => s.Id === part.Id || s.ItemId === part.Id)) {
                                            item.MediaSources.push({
                                                Id: part.Id,
                                                ItemId: part.Id,
                                                Name: part.Name || `Part ${idx + 2}`,
                                                Container: part.Container || 'mp4',
                                                Size: part.Size || 0,
                                                RunTimeTicks: part.RunTimeTicks,
                                                MediaStreams: part.MediaStreams,
                                                _isPart: true
                                            });
                                        }
                                    });
                                }
                            }
                        } catch (pe) {}
                    }

                    item._fullSourcesFetched = true;
                }

                let mediaSources = item.MediaSources;
                if (!mediaSources || mediaSources.length === 0) {
                    app.dom.mediaInfoContent.innerHTML = `<div class="text-center text-red-400 py-4">Unable to get media info</div>`;
                    return;
                }

                if (item._selectedMediaSourceIndex === undefined || item._selectedMediaSourceIndex >= mediaSources.length) {
                    const activeSourceId = item._activeMediaSourceId;
                    if (activeSourceId) {
                        const matchedIdx = mediaSources.findIndex(s => s.Id === activeSourceId || s.ItemId === activeSourceId);
                        item._selectedMediaSourceIndex = matchedIdx !== -1 ? matchedIdx : 0;
                    } else {
                        const defaultIdx = mediaSources.findIndex(s => s.Type === 'Default');
                        item._selectedMediaSourceIndex = defaultIdx !== -1 ? defaultIdx : 0;
                    }
                }

                this.renderContent(item, mediaSources, item._selectedMediaSourceIndex);
            } catch (e) {
                app.dom.mediaInfoContent.innerHTML = `<div class="text-center text-red-400 py-4">Failed to fetch data</div>`;
            }
        }

        renderContent(item, mediaSources, curIdx) {
            const app = this.app;
            const src = mediaSources[curIdx] || mediaSources[0];
            if (!src) return;

            const total = mediaSources.length;
            const prevBtn = document.getElementById('mediaInfoPrevVerBtn');
            const nextBtn = document.getElementById('mediaInfoNextVerBtn');
            const titleEl = document.getElementById('mediaInfoTitle');

            if (titleEl) {
                if (total > 1) {
                    titleEl.innerHTML = `Media Info<span class="text-primary font-bold ml-1.5 text-base">#${curIdx + 1}</span>`;
                } else {
                    titleEl.textContent = 'Media Info';
                }
            }

            if (prevBtn && nextBtn) {
                if (total > 1) {
                    if (curIdx > 0) {
                        prevBtn.classList.remove('hidden');
                    } else {
                        prevBtn.classList.add('hidden');
                    }
                    if (curIdx < total - 1) {
                        nextBtn.classList.remove('hidden');
                    } else {
                        nextBtn.classList.add('hidden');
                    }
                    if (window.lucide) lucide.createIcons();
                } else {
                    prevBtn.classList.add('hidden');
                    nextBtn.classList.add('hidden');
                }

                prevBtn.onclick = (e) => {
                    e.stopPropagation();
                    if ((item._selectedMediaSourceIndex || 0) > 0) {
                        item._selectedMediaSourceIndex = (item._selectedMediaSourceIndex || 0) - 1;
                        const curSrc = mediaSources[item._selectedMediaSourceIndex];
                        if (curSrc?.Id) {
                            item._activeMediaSourceId = curSrc.Id;
                        }
                        this.renderContent(item, mediaSources, item._selectedMediaSourceIndex);
                        app.loadVideo(app.state.currentIndex);
                        app.playVideo(app.state.currentIndex);
                        const nameLabel = curSrc?.Name || `#${item._selectedMediaSourceIndex + 1}`;
                        app.showToast(`Switched to: ${nameLabel}`);
                    }
                };

                nextBtn.onclick = (e) => {
                    e.stopPropagation();
                    if ((item._selectedMediaSourceIndex || 0) < total - 1) {
                        item._selectedMediaSourceIndex = (item._selectedMediaSourceIndex || 0) + 1;
                        const curSrc = mediaSources[item._selectedMediaSourceIndex];
                        if (curSrc?.Id) {
                            item._activeMediaSourceId = curSrc.Id;
                        }
                        this.renderContent(item, mediaSources, item._selectedMediaSourceIndex);
                        app.loadVideo(app.state.currentIndex);
                        app.playVideo(app.state.currentIndex);
                        const nameLabel = curSrc?.Name || `#${item._selectedMediaSourceIndex + 1}`;
                        app.showToast(`Switched to: ${nameLabel}`);
                    }
                };
            }

            if (src._isPart && (!src.MediaStreams || src.MediaStreams.length === 0)) {
                fetch(`${app.config.server}/emby/Users/${app.config.userId}/Items/${src.ItemId || src.Id}?api_key=${app.config.token}&Fields=MediaSources`, {
                    headers: app.getAuthHeaders(app.config.token)
                }).then(r => r.ok ? r.json() : null).then(d => {
                    if (d?.MediaSources?.[0]) {
                        Object.assign(src, d.MediaSources[0]);
                        this.renderContent(item, mediaSources, curIdx);
                    }
                }).catch(() => {});
            }

            const c = src.Container || 'Unknown';
            const vStream = src.MediaStreams?.find(s => s.Type === 'Video');
            const w = vStream?.Width || '?';
            const h = vStream?.Height || '?';
            const fps = vStream?.AverageFrameRate ? Math.round(parseFloat(vStream.AverageFrameRate)) : '?';

            // Format video codec with CodecTag, 10-bit, and HDR for easier troubleshooting
            const formatVideoCodec = (stream, fallbackCodec) => {
                const codec = (stream?.Codec || fallbackCodec || '').toLowerCase();
                const tag = (stream?.CodecTag || '').toLowerCase();
                const bitDepth = stream?.BitDepth;
                const videoRange = (stream?.VideoRange || '').toUpperCase();
                const extType = (stream?.ExtendedVideoType || '').toUpperCase();

                const baseMap = {
                    'h264': 'H264',
                    'avc': 'H264',
                    'hevc': 'HEVC',
                    'h265': 'HEVC',
                    'av1': 'AV1',
                    'vp9': 'VP9',
                    'vp8': 'VP8',
                    'mpeg4': 'MPEG-4',
                    'vc1': 'VC-1'
                };
                const base = baseMap[codec] || (codec ? codec.toUpperCase() : 'Unknown');

                const details = [];
                // Only show CodecTag for codecs with compatibility/internal variances (e.g. hev1 vs hvc1, avc1, mp4v); not for AV1/VP9
                const tagRelevantCodecs = ['hevc', 'h265', 'h264', 'avc', 'mpeg4'];
                if (tag && tag !== codec && tagRelevantCodecs.includes(codec)) {
                    details.push(tag);
                }
                if (videoRange.includes('DOVI') || extType === 'DOVI') {
                    details.push('DV');
                } else if (videoRange.includes('HDR10')) {
                    details.push('HDR10');
                } else if (videoRange.includes('HLG')) {
                    details.push('HLG');
                } else if (videoRange.includes('HDR')) {
                    details.push('HDR');
                }
                if (bitDepth && bitDepth > 8) {
                    details.push(`${bitDepth}-bit`);
                }

                return details.length > 0 ? `${base} (${details.join(', ')})` : base;
            };

            const vCodecStr = formatVideoCodec(vStream, src.VideoCodec);

            // Format audio codec (Plan A: omit 2.0/stereo, label 5.1/7.1/1.0; active track high-contrast white, others gray)
            const formatAudioStream = (stream) => {
                if (!stream) return 'Unknown';
                const codec = (stream.Codec || '').toUpperCase();
                const channels = stream.Channels;
                const layout = (stream.ChannelLayout || '').toLowerCase();

                let chTag = '';
                if (channels === 6 || layout === '5.1') {
                    chTag = '5.1';
                } else if (channels === 8 || layout === '7.1') {
                    chTag = '7.1';
                } else if (channels === 1 || layout === '1.0' || layout === 'mono') {
                    chTag = '1.0';
                } else if (channels && channels > 2 && channels !== 6 && channels !== 8) {
                    chTag = layout ? layout.toUpperCase() : `${channels}ch`;
                }

                return chTag ? `${codec} ${chTag}` : codec;
            };

            const aStreams = src.MediaStreams?.filter(s => s.Type === 'Audio') || [];
            let activeAudioStream = null;
            if (item._activeAudioStreamIndex !== undefined) {
                activeAudioStream = aStreams.find(s => s.Index === item._activeAudioStreamIndex);
            }
            if (!activeAudioStream) {
                activeAudioStream = aStreams.find(s => s.IsDefault) || aStreams[0];
            }

            let aCodecHtml = '';
            if (aStreams.length === 0) {
                const fallbackCodec = (src.AudioCodec || 'Unknown').toUpperCase();
                aCodecHtml = `<span class="text-gray-200 font-mono">${fallbackCodec}</span>`;
            } else if (aStreams.length === 1) {
                const text = formatAudioStream(aStreams[0]);
                aCodecHtml = `<span class="text-white font-medium font-mono">${text}</span>`;
            } else {
                const activeIdx = activeAudioStream ? activeAudioStream.Index : aStreams[0].Index;
                aCodecHtml = aStreams.map(s => {
                    const text = formatAudioStream(s);
                    const isActive = (s.Index === activeIdx);
                    return isActive
                        ? `<span class="text-white font-medium font-mono">${text}</span>`
                        : `<span class="text-gray-500 font-mono">${text}</span>`;
                }).join(` <span class="text-gray-600">/</span> `);
            }

            const bitrate = src.Bitrate ? (src.Bitrate / 1000000).toFixed(2) + ' Mbps' : 'Unknown';
            const fileSizeStr = src.Size ? (src.Size > 1024 * 1024 * 1024 ? (src.Size / (1024 * 1024 * 1024)).toFixed(1) + ' GB' : (src.Size / (1024 * 1024)).toFixed(1) + ' MB') : 'Unknown';

            let transcodeState = 'Direct Play';
            if (app.state.playbackMethod === 'Failed') {
                transcodeState = 'Playback Failed';
            } else if (app.state.playbackMethod === 'DirectPlay') {
                transcodeState = app.state.isStrmSource ? 'Direct Play (STRM)' : 'Direct Play';
            } else if (app.state.playbackMethod === 'DirectStream') {
                const audioCodec = (activeAudioStream?.Codec || src.AudioCodec || '').toLowerCase();
                const isAudioNative = ['aac', 'mp3', 'opus', 'flac', 'vorbis', 'aac_latm'].includes(audioCodec);
                if (isAudioNative) {
                    transcodeState = 'Direct Stream';
                } else {
                    const audioLabel = { 'dts': 'DTS', 'truehd': 'TrueHD', 'opus': 'Opus', 'flac': 'FLAC', 'vorbis': 'Vorbis', 'ac3': 'AC3', 'eac3': 'EAC3' }[audioCodec] || audioCodec.toUpperCase();
                    transcodeState = `Direct Stream (${audioLabel}→AAC)`;
                }
            } else if (app.state.playbackMethod === 'Transcode' || app.state.playbackMethod === 'TranscodeStream') {
                const slideIdx = (app.state.currentIndex % 3 + 3) % 3;
                const videoEl = document.getElementById(`video-p${slideIdx}`);
                const realW = videoEl?.videoWidth || 0;
                const realH = videoEl?.videoHeight || 0;
                let resTag = '';
                if (realW && realH) {
                    const shortEdge = Math.min(realW, realH);
                    const longEdge = Math.max(realW, realH);
                    if (shortEdge >= 2000 || longEdge >= 3500) resTag = '4K';
                    else if (shortEdge >= 950 || longEdge >= 1700) resTag = '1080P';
                    else if (shortEdge >= 650 || longEdge >= 1150) resTag = '720P';
                    else if (shortEdge >= 400 || longEdge >= 700) resTag = '480P';
                    else resTag = `${shortEdge}P`;
                }

                const q = app.config.playQuality;
                if (q === '1080p') {
                    transcodeState = `Transcoding (${resTag || '1080P'} / H264)`;
                } else if (q === '720p') {
                    transcodeState = `Transcoding (${resTag || '720P'} / H264)`;
                } else if (q === 'auto') {
                    transcodeState = resTag ? `Transcoding (Auto ${resTag} / H264)` : 'Transcoding (Auto / H264)';
                } else {
                    transcodeState = resTag ? `Transcoding (${resTag} / H264)` : 'Transcoding (H264)';
                }
            } else {
                transcodeState = app.config.useStatic ? 'Direct Play' : 'Transcoding';
            }

            app.dom.mediaInfoContent.innerHTML = `
                <div class="grid grid-cols-3 gap-2 py-2 items-center border-b border-gray-700/50">
                    <span class="text-gray-500 text-right">Resolution</span>
                    <span class="col-span-2 text-gray-200 font-mono">${w}x${h}@${fps}</span>
                </div>
                <div class="grid grid-cols-3 gap-2 py-2 items-center border-b border-gray-700/50">
                    <span class="text-gray-500 text-right">Container</span>
                    <span class="col-span-2 text-gray-200">${c.toUpperCase()}</span>
                </div>
                <div class="grid grid-cols-3 gap-2 py-2 items-center border-b border-gray-700/50">
                    <span class="text-gray-500 text-right">Video Codec</span>
                    <span class="col-span-2 text-gray-200 font-mono">${vCodecStr}</span>
                </div>
                <div class="grid grid-cols-3 gap-2 py-2 items-center border-b border-gray-700/50">
                    <span class="text-gray-500 text-right">Audio Codec</span>
                    <span class="col-span-2">${aCodecHtml}</span>
                </div>
                <div class="grid grid-cols-3 gap-2 py-2 items-center border-b border-gray-700/50">
                    <span class="text-gray-500 text-right">Bitrate</span>
                    <span class="col-span-2 text-gray-200 font-mono">${bitrate}</span>
                </div>
                <div class="grid grid-cols-3 gap-2 py-2 items-center border-b border-gray-700/50">
                    <span class="text-gray-500 text-right">File Size</span>
                    <span class="col-span-2 text-gray-200 font-mono">${fileSizeStr}</span>
                </div>
                <div class="grid grid-cols-3 gap-2 py-2 items-center">
                    <span class="text-gray-500 text-right">Playback Mode</span>
                    <span class="col-span-2 text-gray-200">${transcodeState}</span>
                </div>
            `;
        }
    }

    window.MediaInfoModal = MediaInfoModal;
})(window);
