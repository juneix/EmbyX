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
            if (app.closeAllModals) {
                app.closeAllModals('mediaInfoModal');
            }
            const item = app.state.videos[app.state.currentIndex];
            if (!item) return;

            if (app.dom.mediaInfoModal) {
                app.dom.mediaInfoModal.classList.remove('hidden');
            }
            app.showInterfaceTemp();

            const prevBtn = document.getElementById('mediaInfoPrevVerBtn');
            const nextBtn = document.getElementById('mediaInfoNextVerBtn');
            const titleEl = document.getElementById('mediaInfoTitle');
            if (titleEl) titleEl.textContent = '流媒体信息';
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
                            // 记录当前实际正在播放的 sourceId，优先取 player 记录的 _activeMediaSourceId，次取当前已选 index 的 Id
                            const activeSourceId = item._activeMediaSourceId || (item.MediaSources && item.MediaSources[item._selectedMediaSourceIndex || 0]?.Id);
                            const existingAdditional = (item.MediaSources || []).filter(s => s._isAdditionalVersion || s._isPart || (s.ItemId && s.ItemId !== item.Id));
                            item.MediaSources = data.MediaSources;
                            item.MediaSources.forEach(s => {
                                if (!s.ItemId) s.ItemId = item.Id;
                            });
                            if (existingAdditional.length > 0) {
                                existingAdditional.forEach(s => {
                                    if (!item.MediaSources.some(m => m.Id === s.Id)) {
                                        item.MediaSources.push(s);
                                    }
                                });
                            }

                            if (activeSourceId) {
                                const matchedIdx = item.MediaSources.findIndex(s => s.Id === activeSourceId || s.ItemId === activeSourceId);
                                if (matchedIdx !== -1) {
                                    item._selectedMediaSourceIndex = matchedIdx;
                                }
                            } else if (item._selectedMediaSourceIndex === undefined) {
                                const defaultIdx = item.MediaSources.findIndex(s => s.Type === 'Default');
                                item._selectedMediaSourceIndex = defaultIdx !== -1 ? defaultIdx : 0;
                            }
                        }
                        item.PartCount = data.PartCount || 1;
                    }

                    // 探测是否存在多 Part 分卷（若有则顺带并入 MediaSources，零侵入统一调度）
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
                        } catch (pe) {
                            // 静默容错
                        }
                    }

                    item._fullSourcesFetched = true;
                }

                let mediaSources = item.MediaSources;
                if (!mediaSources || mediaSources.length === 0) {
                    app.dom.mediaInfoContent.innerHTML = `<div class="text-center text-red-400 py-4">无法获取媒体信息</div>`;
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
                app.dom.mediaInfoContent.innerHTML = `<div class="text-center text-red-400 py-4">获取数据失败</div>`;
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
                    titleEl.innerHTML = `流媒体信息<span class="text-primary font-bold ml-1.5 text-base">#${curIdx + 1}</span>`;
                } else {
                    titleEl.textContent = '流媒体信息';
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

                const switchToSource = (newIndex) => {
                    item._selectedMediaSourceIndex = newIndex;
                    const curSrc = mediaSources[newIndex];
                    if (curSrc?.Id) {
                        item._activeMediaSourceId = curSrc.Id;
                    }
                    this.renderContent(item, mediaSources, newIndex);

                    const slideIdx = (app.state.currentIndex % 3 + 3) % 3;
                    const curVideoEl = document.getElementById(`video-p${slideIdx}`);
                    if (curVideoEl && app.player) {
                        delete curVideoEl.dataset.requestedSrc;
                        const newSrc = app.player.getVideoSrc(item.Id, item, true);
                        if (newSrc) {
                            app.player.setVideoSource(curVideoEl, newSrc, app.state.currentIndex, item, { autoplay: true });
                        }
                    }

                    const nameLabel = curSrc?.Name || `#${newIndex + 1}`;
                    app.showToast(`已切换至: ${nameLabel}`);
                };

                prevBtn.onclick = (e) => {
                    e.stopPropagation();
                    if ((item._selectedMediaSourceIndex || 0) > 0) {
                        switchToSource((item._selectedMediaSourceIndex || 0) - 1);
                    }
                };

                nextBtn.onclick = (e) => {
                    e.stopPropagation();
                    if ((item._selectedMediaSourceIndex || 0) < total - 1) {
                        switchToSource((item._selectedMediaSourceIndex || 0) + 1);
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

            const c = src.Container || '未知';
            const vStream = src.MediaStreams?.find(s => s.Type === 'Video');
            const w = vStream?.Width || '?';
            const h = vStream?.Height || '?';
            const fps = vStream?.AverageFrameRate ? Math.round(parseFloat(vStream.AverageFrameRate)) : '?';

            // 规范化视频编码展示（直观标识 CodecTag、10-bit 及 HDR，方便排查兼容性）
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
                const base = baseMap[codec] || (codec ? codec.toUpperCase() : '未知');

                const details = [];
                // 仅针对有内部差异/兼容性差异的编码（如 hev1 vs hvc1、avc1、mp4v 等）展示 CodecTag，AV1/VP9 等常规格式不展示
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

            // 规范化音频编码展示（方案 A：普通双声道省略，仅 5.1 / 7.1 / 1.0 标注；多音轨当前高亮白，其余浅灰）
            const formatAudioStream = (stream) => {
                if (!stream) return '未知';
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
                const fallbackCodec = (src.AudioCodec || '未知').toUpperCase();
                aCodecHtml = `<span class="text-white/70 font-mono">${fallbackCodec}</span>`;
            } else if (aStreams.length === 1) {
                const text = formatAudioStream(aStreams[0]);
                aCodecHtml = `<span class="text-white/70 font-mono">${text}</span>`;
            } else {
                const activeIdx = activeAudioStream ? activeAudioStream.Index : aStreams[0].Index;
                aCodecHtml = aStreams.map(s => {
                    const text = formatAudioStream(s);
                    const isActive = (s.Index === activeIdx);
                    return isActive
                        ? `<span class="text-white font-medium font-mono">${text}</span>`
                        : `<span class="text-white/50 font-mono">${text}</span>`;
                }).join(` <span class="text-white/30">/</span> `);
            }

            const bitrate = src.Bitrate ? (src.Bitrate / 1000000).toFixed(2) + ' Mbps' : '未知';
            const fileSizeStr = src.Size ? (src.Size > 1024 * 1024 * 1024 ? (src.Size / (1024 * 1024 * 1024)).toFixed(1) + ' GB' : (src.Size / (1024 * 1024)).toFixed(1) + ' MB') : '未知';

            let transcodeState = '直接播放';
            if (app.state.playbackMethod === 'Failed') {
                transcodeState = '播放失败';
            } else if (app.state.playbackMethod === 'DirectPlay') {
                transcodeState = app.state.isStrmSource ? '直接播放 (STRM)' : '直接播放';
            } else if (app.state.playbackMethod === 'DirectStream') {
                const audioCodec = (activeAudioStream?.Codec || src.AudioCodec || '').toLowerCase();
                const isAudioNative = ['aac', 'mp3', 'opus', 'flac', 'vorbis', 'aac_latm'].includes(audioCodec);
                if (isAudioNative) {
                    transcodeState = '直接串流';
                } else {
                    const audioLabel = { 'dts': 'DTS', 'truehd': 'TrueHD', 'opus': 'Opus', 'flac': 'FLAC', 'vorbis': 'Vorbis', 'ac3': 'AC3', 'eac3': 'EAC3' }[audioCodec] || audioCodec.toUpperCase();
                    transcodeState = `直接串流（${audioLabel}→AAC）`;
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
                    transcodeState = `转码播放（${resTag || '1080P'} / H264）`;
                } else if (q === '720p') {
                    transcodeState = `转码播放（${resTag || '720P'} / H264）`;
                } else if (q === 'auto') {
                    transcodeState = resTag ? `转码播放（自动 ${resTag} / H264）` : '转码播放（自动 / H264）';
                } else {
                    transcodeState = resTag ? `转码播放（${resTag} / H264）` : '转码播放（H264）';
                }
            } else {
                transcodeState = app.config.useStatic ? '直接播放' : '转码播放';
            }

            app.dom.mediaInfoContent.innerHTML = `
                <div class="grid grid-cols-3 gap-2 py-2 items-center border-b border-white/10">
                    <span class="text-white font-medium text-right">分辨率</span>
                    <span class="col-span-2 text-white/80 font-mono">${w}x${h}@${fps}</span>
                </div>
                <div class="grid grid-cols-3 gap-2 py-2 items-center border-b border-white/10">
                    <span class="text-white font-medium text-right">封装格式</span>
                    <span class="col-span-2 text-white/80">${c.toUpperCase()}</span>
                </div>
                <div class="grid grid-cols-3 gap-2 py-2 items-center border-b border-white/10">
                    <span class="text-white font-medium text-right">视频编码</span>
                    <span class="col-span-2 text-white/80 font-mono">${vCodecStr}</span>
                </div>
                <div class="grid grid-cols-3 gap-2 py-2 items-center border-b border-white/10">
                    <span class="text-white font-medium text-right">音频编码</span>
                    <span class="col-span-2">${aCodecHtml}</span>
                </div>
                <div class="grid grid-cols-3 gap-2 py-2 items-center border-b border-white/10">
                    <span class="text-white font-medium text-right">总码率</span>
                    <span class="col-span-2 text-white/80 font-mono">${bitrate}</span>
                </div>
                <div class="grid grid-cols-3 gap-2 py-2 items-center border-b border-white/10">
                    <span class="text-white font-medium text-right">文件体积</span>
                    <span class="col-span-2 text-white/80 font-mono">${fileSizeStr}</span>
                </div>
                <div class="grid grid-cols-3 gap-2 py-2 items-center">
                    <span class="text-white font-medium text-right">播放策略</span>
                    <span class="col-span-2 text-white/80">${transcodeState}</span>
                </div>
            `;
        }
    }

    window.MediaInfoModal = MediaInfoModal;
})(window);
