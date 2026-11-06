/**
 * EmbyX Short Drama & Folder Mode Manager (Zero-dependency, Vanilla JS)
 * Handles:
 * - Emby/Jellyfin Series & Flatten Season logic (single season auto-flatten, multi-season folder cards)
 * - Mixed folder exploration (Folders & Series first, then Movies & loose Videos)
 * - Navigation stack with single-level popFolder()
 * - TikTok-style seamless cross-drama / cross-folder sibling relay in stream mode
 * - Per-drama progress memory (last watched episode)
 */
(function (window) {
    'use strict';

    class ShortDramaManager {
        constructor(app) {
            this.app = app || null;
            this.folderStack = []; // 存储路径历史: [{ id, name, type, seriesId, videos }]
            this.currentFolderId = null;
            this.currentFolderName = '';
            this.currentFolderType = ''; // 'Folder' | 'Series' | 'Season'
            this.activePlayingFolderId = null; // 当前正在连播的剧集/文件夹 ID
            this.rootSiblings = []; // 当前媒体库根级/父级条目列表，用于跨剧无限接力
            this.lastFocusedEpisodeId = null; // 用于下钻后高亮定位上次观看集数
            this.seriesCountCache = {}; // 电视剧剧集真实总数缓存 { [seriesId]: count }
            this._fetchingSeriesCounts = new Set();
            this.pendingResume = null;
            this._lastPlaybackSave = 0;
            this._lastPlaybackItem = null;
        }

        /**
         * 是否处于短剧模式
         */
        isDramaMode() {
            const hasAccess = window.DonateManager ? window.DonateManager.hasEggAccess() : false;
            return !!(this.app?.config?.shortDrama && hasAccess);
        }

        /**
         * 判定是否应启用短剧/文件夹混排下钻模式
         */
        isFolderModeActive() {
            return this.isDramaMode() &&
                !this.app?.state?.searchTerm &&
                !this.app?.state?.currentTag &&
                !this.app?.state?.currentPerson &&
                this.app?.state?.currentLibraryId !== 'favorites';
        }

        /**
         * 获取短剧模式下的数据拉取 URL（非递归混排顶层项）
         */
        getFetchUrl(config, libraryId, fetchStartIndex, pageSize = 150) {
            const { server, token, userId } = config;
            const targetFolderId = this.currentFolderId || libraryId;
            const paging = pageSize > 0 ? `&Limit=${pageSize}&StartIndex=${fetchStartIndex}` : '';
            let url = `${server}/emby/Users/${userId}/Items?api_key=${token}&Recursive=false&IncludeItemTypes=Folder,Series,Season,Movie,Episode,Video,MusicVideo${paging}&Fields=Overview,Path,ParentId,RunTimeTicks,MediaSources,ChildCount,RecursiveItemCount,SeriesName,ParentIndexNumber,IndexNumber`;
            if (targetFolderId && targetFolderId !== 'favorites') {
                url += `&ParentId=${targetFolderId}`;
            }
            return url;
        }

        /**
         * 处理从服务端拉取的数据（混排与根级列表保存）
         */
        processFetchedItems(items) {
            if (!Array.isArray(items)) return [];
            const videoOnlyItems = items.filter(item => item && item.Type !== 'Photo' && item.MediaType !== 'Photo' && item.Type !== 'PhotoAlbum');
            const sorted = this.sortMixedItems(videoOnlyItems);
            if (!this.currentFolderId) {
                this.rootSiblings = [...sorted];
            }
            return sorted;
        }

        /**
         * 判定是否为单视频文件夹（如以单独文件夹存放的单部电影）
         */
        isSingleVideoFolder(item) {
            if (!item) return false;
            const isFolder = item.IsFolder || item.Type === 'Folder';
            if (!isFolder || item.Type === 'Series' || item.Type === 'Season') return false;
            const count = item.ChildCount ?? item.RecursiveItemCount;
            return count === 1 || count === 2;
        }

        /**
         * 获取电视剧真实分集数量（双重精准保障：RecursiveItemCount 优先，异步接口核准）
         */
        getSeriesEpisodeCount(item) {
            if (!item || item.Type !== 'Series') return 0;
            if (this.seriesCountCache && this.seriesCountCache[item.Id]) {
                return this.seriesCountCache[item.Id];
            }
            if (item.RecursiveItemCount && item.RecursiveItemCount > 0) {
                return item.RecursiveItemCount;
            }
            // 若服务端未返回 RecursiveItemCount，异步动态请求真实分集总数
            this.fetchSeriesEpisodeCount(item.Id);
            return item.ChildCount || 0;
        }

        /**
         * 异步请求 Emby 获取电视剧真实分集总数并无感更新徽标
         */
        async fetchSeriesEpisodeCount(seriesId) {
            if (!this.app || !seriesId) return;
            if (this._fetchingSeriesCounts.has(seriesId)) return;
            this._fetchingSeriesCounts.add(seriesId);

            try {
                const { server, token, userId } = this.app.config;
                const url = `${server}/emby/Shows/${seriesId}/Episodes?UserId=${userId}&api_key=${token}&Fields=Id`;
                const res = await fetch(url, { headers: this.app.getAuthHeaders(token) });
                if (res.ok) {
                    const data = await res.json();
                    const total = data.TotalRecordCount || (data.Items ? data.Items.length : 0);
                    if (total > 0) {
                        this.seriesCountCache[seriesId] = total;
                        const badgeEl = document.querySelector(`[data-series-badge="${seriesId}"]`);
                        if (badgeEl) {
                            badgeEl.textContent = `共 ${total} 集`;
                        }
                    }
                }
            } catch (e) {
                // 静默容错
            } finally {
                this._fetchingSeriesCounts.delete(seriesId);
            }
        }

        /**
         * 严格三级分层混排：
         * Tier 1: 电视剧实体 (Type === 'Series') 绝对置顶
         * Tier 2: 多视频普通文件夹 (ChildCount > 2) 紧随其后
         * Tier 3: 单片电影（单视频/双版本文件夹穿透平铺）与独立散落视频排在最后
         */
        sortMixedItems(items) {
            if (!Array.isArray(items)) return [];
            return [...items].sort((a, b) => {
                const getTier = (item) => {
                    if (item.Type === 'Series') return 1;
                    const isFolder = item.IsFolder || item.Type === 'Folder';
                    if (isFolder && item.Type !== 'Season') {
                        const count = item.ChildCount ?? item.RecursiveItemCount;
                        if (count > 2) return 2;
                    }
                    if (item.Type === 'Season') return 2;
                    return 3; // 单片电影、单视频文件夹、独立视频
                };

                const tierA = getTier(a);
                const tierB = getTier(b);

                if (tierA !== tierB) {
                    return tierA - tierB;
                }

                // 同级内：分集按序号升序
                if (a.IndexNumber != null && b.IndexNumber != null) {
                    if (a.ParentIndexNumber != null && b.ParentIndexNumber != null && a.ParentIndexNumber !== b.ParentIndexNumber) {
                        return a.ParentIndexNumber - b.ParentIndexNumber;
                    }
                    return a.IndexNumber - b.IndexNumber;
                }

                // 同级内按名称字母/拼音自然排序
                return (a.Name || '').localeCompare(b.Name || '', undefined, { numeric: true, sensitivity: 'base' });
            });
        }

        /**
         * 智能穿透解析文件夹内部视频（支持内存缓存、单片穿透、双版本/多Part聚合）
         */
        async resolveFolderVideo(folderItem) {
            if (!this.app || !folderItem) return null;
            if (folderItem._resolvedVideo) return folderItem._resolvedVideo;

            const isFolder = folderItem.IsFolder || folderItem.Type === 'Folder';
            if (!isFolder || folderItem.Type === 'Series' || folderItem.Type === 'Season') {
                return folderItem;
            }

            try {
                const { server, token, userId } = this.app.config;
                const url = `${server}/emby/Users/${userId}/Items?ParentId=${folderItem.Id}&Recursive=false&IncludeItemTypes=Movie,Episode,Video&Limit=4&Fields=Overview,Path,RunTimeTicks,MediaSources,IndexNumber,ParentIndexNumber,SeriesName`;
                const res = await fetch(url, { headers: this.app.getAuthHeaders(token) });
                if (res.ok) {
                    const data = await res.json();
                    const items = data.Items || [];
                    if (items.length === 1) {
                        const realVideo = items[0];
                        folderItem._resolvedVideo = realVideo;
                        return realVideo;
                    } else if (items.length === 2) {
                        // 包含两个视频文件（如双版本 1080P/4K 或 Part 1/Part 2），聚合为包含多个 MediaSources 的主对象
                        const mainVideo = items[0];
                        const secVideo = items[1];
                        if (!mainVideo.MediaSources) mainVideo.MediaSources = [];
                        mainVideo.MediaSources.forEach(s => {
                            if (!s.ItemId) s.ItemId = mainVideo.Id;
                        });
                        if (secVideo.MediaSources && secVideo.MediaSources.length > 0) {
                            secVideo.MediaSources.forEach(s => {
                                if (!mainVideo.MediaSources.some(m => m.Id === s.Id)) {
                                    s.ItemId = secVideo.Id;
                                    s._isAdditionalVersion = true;
                                    mainVideo.MediaSources.push(s);
                                }
                            });
                        } else {
                            mainVideo.MediaSources.push({
                                Id: secVideo.Id,
                                ItemId: secVideo.Id,
                                Name: secVideo.Name || 'Part 2',
                                Path: secVideo.Path,
                                Container: secVideo.Container,
                                RunTimeTicks: secVideo.RunTimeTicks,
                                MediaStreams: secVideo.MediaStreams,
                                _isAdditionalVersion: true
                            });
                        }
                        folderItem._resolvedVideo = mainVideo;
                        return mainVideo;
                    }
                }
            } catch (e) {
                console.warn('resolveFolderVideo 失败:', e);
            }
            return null;
        }

        /**
         * 直接穿透播放单视频电影文件夹（消灭套娃二次点击）
         */
        async playSingleVideoFolder(folderItem) {
            if (!this.app) return;
            const app = this.app;

            app.toggleLoading(true);
            try {
                const realVideo = await this.resolveFolderVideo(folderItem);
                if (realVideo) {
                    const idx = app.state.videos.findIndex(v => v.Id === folderItem.Id || v.Id === realVideo.Id);
                    if (idx !== -1) {
                        app.state.videos[idx] = realVideo;
                        app.state.currentIndex = idx;
                    } else {
                        app.state.videos.unshift(realVideo);
                        app.state.currentIndex = 0;
                    }
                    this.activePlayingFolderId = folderItem.Id;
                    if (app.state.viewMode === 'grid') {
                        app.toggleViewMode();
                    } else {
                        app.renderSlides();
                        await app.loadVideo(app.state.currentIndex);
                        app.playVideo(app.state.currentIndex);
                    }
                    return;
                }
            } catch (e) {
                console.warn('解析单片文件夹视频失败:', e);
            } finally {
                app.toggleLoading(false);
            }

            // 兜底：若解析失败回退为普通文件夹下钻
            this.pushFolder(folderItem.Id, folderItem.Name, 'Folder');
        }

        /**
         * 用户在宫格视图点击卡片时的分流处理
         */
        async enterItem(item) {
            if (!this.app || !item) return;

            // 分支 1: 电视剧 (Series)
            if (item.Type === 'Series') {
                await this.openSeries(item);
                return;
            }

            // 分支 2: 剧季 (Season)
            if (item.Type === 'Season') {
                await this.openSeason(item);
                return;
            }

            // 分支 3: 单视频电影文件夹（穿透套娃，直接秒级解析内部视频起播）
            if (this.isSingleVideoFolder(item)) {
                await this.playSingleVideoFolder(item);
                return;
            }

            // 分支 4: 真正的多项普通文件夹 (Folder)
            if (item.IsFolder || item.Type === 'Folder') {
                this.pushFolder(item.Id, item.Name, 'Folder');
                return;
            }

            // 分支 4: 独立电影 (Movie) 或散落视频 (Video) - 直接起播
            const videoIndex = this.app.state.videos.findIndex(v => v.Id === item.Id);
            if (videoIndex !== -1) {
                this.app.state.currentIndex = videoIndex;
                this.app.toggleViewMode();
            }
        }

        /**
         * 打开电视剧（贯彻 Emby 单季自动平铺 Flatten Season 理念）
         */
        async openSeries(seriesItem) {
            if (!this.app) return;
            const app = this.app;
            const { server, token, userId } = app.config;

            app.toggleLoading(true);
            try {
                // 保存当前父级状态入栈
                this.folderStack.push({
                    id: this.currentFolderId || app.state.currentLibraryId,
                    name: this.currentFolderName || '根目录',
                    type: this.currentFolderType || 'Library',
                    videos: [...app.state.videos],
                    totalCount: app.state.totalCount,
                    startIndex: app.state.startIndex || 0,
                    currentIndex: app.state.currentIndex
                });
                app.input?.pushLayer('folder', { id: seriesItem.Id });

                this.currentFolderId = seriesItem.Id;
                this.currentFolderName = seriesItem.Name;
                this.currentFolderType = 'Series';

                // 1. 探测该电视剧的季列表
                let seasons = [];
                try {
                    const seasonsRes = await fetch(`${server}/emby/Shows/${seriesItem.Id}/Seasons?UserId=${userId}&api_key=${token}`, {
                        headers: app.getAuthHeaders(token)
                    });
                    if (seasonsRes.ok) {
                        const seasonsData = await seasonsRes.json();
                        seasons = seasonsData.Items || [];
                    }
                } catch (e) {
                    console.warn('获取季列表失败，准备回退分集查询:', e);
                }

                // 2. Emby Flatten Season 原生逻辑：
                // 若只有 1 季（或无季嵌套的短剧）：自动穿透平铺分集！
                if (seasons.length <= 1) {
                    let episodes = [];
                    try {
                        const epUrl = `${server}/emby/Shows/${seriesItem.Id}/Episodes?UserId=${userId}&api_key=${token}&Fields=Overview,Path,RunTimeTicks,MediaSources,IndexNumber,ParentIndexNumber,SeriesName`;
                        const epRes = await fetch(epUrl, { headers: app.getAuthHeaders(token) });
                        if (epRes.ok) {
                            const epData = await epRes.json();
                            episodes = epData.Items || [];
                        }
                    } catch (e) {
                        console.warn('Shows/Episodes 失败，回退通用 Items 查询:', e);
                    }

                    // 兜底回退：若 Shows API 为空，使用 Items 递归查询
                    if (!episodes.length) {
                        const fallbackUrl = `${server}/emby/Users/${userId}/Items?ParentId=${seriesItem.Id}&Recursive=true&IncludeItemTypes=Episode,Video&api_key=${token}&Fields=Overview,Path,RunTimeTicks,MediaSources,IndexNumber,ParentIndexNumber,SeriesName`;
                        const fbRes = await fetch(fallbackUrl, { headers: app.getAuthHeaders(token) });
                        if (fbRes.ok) {
                            const fbData = await fbRes.json();
                            episodes = fbData.Items || [];
                        }
                    }

                    episodes = this.sortMixedItems(episodes);
                    app.state.videos = episodes;
                    app.state.totalCount = episodes.length;
                    app.state.startIndex = 0;

                    // 续播定位：检查该剧是否有上次观看记录
                    const progress = this.getDramaProgress(seriesItem.Id);
                    if (progress && progress.lastId) {
                        this.lastFocusedEpisodeId = progress.lastId;
                    } else {
                        this.lastFocusedEpisodeId = null;
                    }
                    this.activePlayingFolderId = seriesItem.Id;

                    if (app.state.viewMode === 'grid') {
                        app.renderGridView();
                    } else {
                        app.state.currentIndex = 0;
                        if (this.lastFocusedEpisodeId) {
                            const savedIdx = app.state.videos.findIndex(v => String(v.Id) === String(this.lastFocusedEpisodeId));
                            if (savedIdx !== -1) app.state.currentIndex = savedIdx;
                        }
                        app.renderSlides();
                        app.loadVideo(app.state.currentIndex);
                        app.playVideo(app.state.currentIndex);
                    }
                } else {
                    // 若有多季（S01, S02...）：以季文件夹卡片列表展示
                    seasons.forEach(s => {
                        s.IsFolder = true;
                        s.Type = 'Season';
                        s.SeriesId = seriesItem.Id;
                        s.SeriesName = seriesItem.Name;
                    });
                    app.state.videos = seasons;
                    app.state.totalCount = seasons.length;
                    app.state.startIndex = 0;
                    app.renderGridView();
                }
            } catch (err) {
                console.error('加载电视剧失败:', err);
                app.showToast('加载剧集失败: ' + (err.message || '网络异常'));
            } finally {
                app.toggleLoading(false);
            }
        }

        /**
         * 打开多季电视剧中的某一季
         */
        async openSeason(seasonItem) {
            if (!this.app) return;
            const app = this.app;
            const { server, token, userId } = app.config;

            app.toggleLoading(true);
            try {
                this.folderStack.push({
                    id: this.currentFolderId,
                    name: this.currentFolderName,
                    type: this.currentFolderType,
                    seriesId: seasonItem.SeriesId,
                    videos: [...app.state.videos],
                    totalCount: app.state.totalCount,
                    startIndex: app.state.startIndex || 0,
                    currentIndex: app.state.currentIndex
                });
                app.input?.pushLayer('folder', { id: seasonItem.Id });

                this.currentFolderId = seasonItem.Id;
                this.currentFolderName = `${seasonItem.SeriesName || ''} ${seasonItem.Name || ''}`.trim();
                this.currentFolderType = 'Season';

                let episodes = [];
                try {
                    const epUrl = `${server}/emby/Shows/${seasonItem.SeriesId}/Episodes?SeasonId=${seasonItem.Id}&UserId=${userId}&api_key=${token}&Fields=Overview,Path,RunTimeTicks,MediaSources,IndexNumber,ParentIndexNumber,SeriesName`;
                    const epRes = await fetch(epUrl, { headers: app.getAuthHeaders(token) });
                    if (epRes.ok) {
                        const epData = await epRes.json();
                        episodes = epData.Items || [];
                    }
                } catch (e) {}

                if (!episodes.length) {
                    const fbUrl = `${server}/emby/Users/${userId}/Items?ParentId=${seasonItem.Id}&Recursive=false&IncludeItemTypes=Episode,Video,Movie&api_key=${token}&Fields=Overview,Path,RunTimeTicks,MediaSources,IndexNumber,ParentIndexNumber,SeriesName`;
                    const fbRes = await fetch(fbUrl, { headers: app.getAuthHeaders(token) });
                    if (fbRes.ok) {
                        const fbData = await fbRes.json();
                        episodes = fbData.Items || [];
                    }
                }

                episodes = (episodes || []).filter(item => item && item.Type !== 'Photo' && item.MediaType !== 'Photo' && item.Type !== 'PhotoAlbum');
                episodes = this.sortMixedItems(episodes);
                app.state.videos = episodes;
                app.state.totalCount = episodes.length;
                app.state.startIndex = 0;

                const progress = this.getDramaProgress(seasonItem.SeriesId || seasonItem.Id);
                this.lastFocusedEpisodeId = progress ? progress.lastId : null;

                this.activePlayingFolderId = seasonItem.SeriesId || seasonItem.Id;

                if (app.state.viewMode === 'grid') {
                    app.renderGridView();
                } else {
                    app.state.currentIndex = 0;
                    if (this.lastFocusedEpisodeId) {
                        const savedIdx = app.state.videos.findIndex(v => String(v.Id) === String(this.lastFocusedEpisodeId));
                        if (savedIdx !== -1) app.state.currentIndex = savedIdx;
                    }
                    app.renderSlides();
                    app.loadVideo(app.state.currentIndex);
                    app.playVideo(app.state.currentIndex);
                }
            } catch (err) {
                console.error('加载季分集失败:', err);
                app.showToast('加载分集失败');
            } finally {
                app.toggleLoading(false);
            }
        }

        /**
         * 深入进入某个文件夹
         */
        async pushFolder(folderId, folderName, type = 'Folder', startIndex = 0) {
            if (!this.app) return;
            const parentId = this.currentFolderId || this.app.state.currentLibraryId;
            const parentName = this.currentFolderName || '根目录';

            this.folderStack.push({
                id: parentId,
                name: parentName,
                type: this.currentFolderType || 'Library',
                videos: [...this.app.state.videos],
                totalCount: this.app.state.totalCount,
                startIndex: this.app.state.startIndex || 0,
                currentIndex: this.app.state.currentIndex
            });
            this.app?.input?.pushLayer('folder', { id: folderId });

            this.currentFolderId = folderId;
            this.currentFolderName = folderName;
            this.currentFolderType = type;
            this.activePlayingFolderId = folderId;

            this.app.state.startIndex = startIndex;
            return this.app.fetchVideos(null, null, startIndex > 0);
        }

        /**
         * 返回上一级目录（严格保持单级返回）
         */
        popFolder() {
            if (this.app?.input && this.app.input.hasHistoryLayer('folder') && !this.app.input._isHandlingPop) {
                window.history.back();
                return true;
            }

            if (!this.app || this.folderStack.length === 0) return false;

            const prev = this.folderStack.pop();
            this.lastFocusedEpisodeId = null;

            // 若父级栈中完整缓存了上次列表，直接秒回无需再次请求网络
            if (prev.videos && Array.isArray(prev.videos)) {
                this.currentFolderId = (prev.id === this.app.state.currentLibraryId) ? null : prev.id;
                this.currentFolderName = (prev.name === '根目录') ? '' : prev.name;
                this.currentFolderType = prev.type || '';
                this.app.state.videos = prev.videos;
                this.app.state.totalCount = prev.totalCount || prev.videos.length;
                this.app.state.startIndex = prev.startIndex || 0;
                this.app.state.currentIndex = prev.currentIndex || 0;
                this.activePlayingFolderId = this.currentFolderId;
                if (this.app.state.viewMode === 'grid') {
                    this.app.renderGridView();
                } else {
                    this.app.renderSlides();
                    this.app.loadVideo(0);
                }
                return true;
            }

            // 兜底回退：重新请求网络
            if (this.folderStack.length === 0) {
                this.currentFolderId = null;
                this.currentFolderName = '';
                this.currentFolderType = '';
            } else {
                this.currentFolderId = prev.id;
                this.currentFolderName = prev.name;
                this.currentFolderType = prev.type || '';
            }

            this.app.state.startIndex = 0;
            this.app.fetchVideos();
            return true;
        }

        /**
         * 重置文件夹导航栈
         */
        reset() {
            this.folderStack = [];
            this.currentFolderId = null;
            this.currentFolderName = '';
            this.currentFolderType = '';
            this.activePlayingFolderId = null;
            this.rootSiblings = [];
            this.lastFocusedEpisodeId = null;
            this.pendingResume = null;
            this._lastPlaybackSave = 0;
            this._lastPlaybackItem = null;
        }

        getPlaybackKey(seriesOrFolderId = null) {
            const { server, serverId, userId, user } = this.app.config;
            const scope = [serverId || server, userId || user, this.app.state.currentLibraryId];
            if (seriesOrFolderId !== null) scope.push(seriesOrFolderId);
            return `emby_drama_resume_${JSON.stringify(scope)}`;
        }

        getPlaybackRecord() {
            try {
                const saved = JSON.parse(localStorage.getItem(this.getPlaybackKey()) || 'null');
                return saved && typeof saved.itemId === 'string' ? saved : null;
            } catch (e) {
                return null;
            }
        }

        getResumePosition(itemId, consume = true) {
            const record = this.pendingResume || this.getPlaybackRecord();
            if (consume) this.pendingResume = null;
            return record && String(record.itemId) === String(itemId) && Number.isFinite(record.position) ? record.position : 0;
        }

        savePlaybackProgress(videoData, videoEl, force = false) {
            if (!this.isDramaMode() || !videoData || !videoEl || !this.app.state.currentLibraryId) return;
            const now = Date.now();
            if (!force && this._lastPlaybackItem === String(videoData.Id) && now - (this._lastPlaybackSave || 0) < 5000) return;
            const app = this.app;
            const path = this.folderStack.map(({ id, name, type, seriesId, startIndex }) => ({ id, name, type, seriesId, startIndex }));
            if (!path.length) path.push({ id: app.state.currentLibraryId, type: 'Library', startIndex: app.state.startIndex || 0 });
            if (this.currentFolderId) {
                path.push({ id: this.currentFolderId, name: this.currentFolderName, type: this.currentFolderType, seriesId: videoData.SeriesId, startIndex: app.state.startIndex || 0 });
            }
            const previous = this.getPlaybackRecord();
            const previousDate = previous?.itemId === String(videoData.Id) ? previous.date : localStorage.getItem(`emby_last_date_${app.state.currentLibraryId}`);
            const record = {
                itemId: String(videoData.Id),
                position: videoEl.ended ? 0 : Math.max(0, videoEl.currentTime || 0),
                date: (app._isFirstLoad && previousDate) || new Date(now).toISOString(),
                path,
                startIndex: app.state.startIndex || 0
            };
            try {
                localStorage.setItem(this.getPlaybackKey(), JSON.stringify(record));
                this._lastPlaybackSave = now;
                this._lastPlaybackItem = record.itemId;
                const dramaId = videoData.SeriesId || this.activePlayingFolderId || this.currentFolderId;
                if (dramaId) this.saveDramaProgress(dramaId, record.itemId, videoData.IndexNumber || (app.state.currentIndex + 1));
                localStorage.setItem(`emby_last_id_${app.state.currentLibraryId}`, record.itemId);
                if (!app._isFirstLoad) {
                    localStorage.setItem(`emby_last_date_${app.state.currentLibraryId}`, record.date);
                    clearTimeout(app._syncTimer);
                    const { server, userId } = app.config;
                    const libId = app.state.currentLibraryId;
                    const libType = app.state.currentLibraryType;
                    app._syncTimer = setTimeout(() => {
                        if (app.config.server === server && app.config.userId === userId && app.state.currentLibraryId === libId) {
                            app.saveCloudSync(record.itemId, libId, libType, record.date);
                        }
                    }, 1000);
                }
                app._isFirstLoad = false;
            } catch (e) {}
        }

        async restorePlayback(record = null) {
            if (!this.app || !this.isDramaMode()) return false;
            const app = this.app;
            const { server, token, userId } = app.config;
            const libraryId = app.state.currentLibraryId;
            record = record || this.getPlaybackRecord();
            if (!record) {
                const itemId = localStorage.getItem(`emby_last_id_${libraryId}`);
                if (itemId) record = { itemId, position: null, path: [], startIndex: 0 };
            }
            if (!record?.itemId) return false;

            app.toggleLoading(true);
            app.stopCurrentPlayback();
            this.reset();
            app.state.currentPerson = null;
            app.state.currentTag = null;
            app.state.searchTerm = '';
            app.state.isFilteredByPerson = false;
            app.state.isFilteredByTag = false;
            app.setViewMode('grid');
            try {
                const isOpenList = window.EmbyXCommon?.getServerType() === 'openlist';
                const isPlaylist = app.state.currentLibraryType === 'playlist';
                let videoData = null;
                let folders = [];
                let items = null;
                let singleFolder = null;
                const fields = 'Overview,Path,ParentId,RunTimeTicks,MediaSources,IndexNumber,ParentIndexNumber,SeriesName';
                if (isOpenList) {
                    const base = libraryId === 'favorites' ? '/' : String(libraryId || '/').replace(/\/$/, '');
                    if (base && !String(record.itemId).startsWith(base + '/')) throw new Error('视频不属于当前媒体库');
                    const parent = String(record.itemId).slice(0, String(record.itemId).lastIndexOf('/')) || '/';
                    let path = base || '';
                    for (const name of parent.slice(path.length).split('/').filter(Boolean)) {
                        path += '/' + name;
                        folders.push({ Id: path, Name: name, Type: 'Folder' });
                    }
                } else if (app.config.fnOS) {
                    folders = (record.path || []).filter(folder => folder.type !== 'Library').map(folder => ({ Id: folder.id, Name: folder.name, Type: folder.type, SeriesId: folder.seriesId }));
                } else {
                    const itemRes = await fetch(`${server}/emby/Users/${userId}/Items/${encodeURIComponent(record.itemId)}?api_key=${token}`, { headers: app.getAuthHeaders(token) });
                    if (!itemRes.ok) throw new Error(`视频读取失败: ${itemRes.status}`);
                    videoData = await itemRes.json();
                    if (videoData.IsFolder || !['Movie', 'Episode', 'Video', 'MusicVideo'].includes(videoData.Type)) throw new Error('上次记录不是可播放视频');
                    if (libraryId === 'favorites') {
                        if (!videoData.UserData?.IsFavorite) throw new Error('视频已不在收藏夹');
                        const res = await fetch(`${server}/emby/Users/${userId}/Items?api_key=${token}&Recursive=true&Filters=IsFavorite&IncludeItemTypes=Movie,Episode,Video,MusicVideo&Fields=${fields}`, { headers: app.getAuthHeaders(token) });
                        if (!res.ok) throw new Error(`收藏夹读取失败: ${res.status}`);
                        items = (await res.json()).Items || [];
                    } else if (isPlaylist) {
                        const res = await fetch(`${server}/emby/Playlists/${libraryId}/Items?UserId=${userId}&api_key=${token}&Fields=${fields}`, { headers: app.getAuthHeaders(token) });
                        if (!res.ok) throw new Error(`播放列表读取失败: ${res.status}`);
                        items = (await res.json()).Items || [];
                    } else {
                        const res = await fetch(`${server}/emby/Items/${encodeURIComponent(record.itemId)}/Ancestors?UserId=${userId}&api_key=${token}`, { headers: app.getAuthHeaders(token) });
                        if (!res.ok) throw new Error(`目录读取失败: ${res.status}`);
                        const ancestors = await res.json();
                        const libraryIndex = ancestors.findIndex(item => String(item.Id) === String(libraryId));
                        if (libraryIndex === -1) throw new Error('视频不属于当前媒体库');
                        folders = ancestors.slice(0, libraryIndex).reverse();
                    }
                }

                const rootPage = (record.path || []).find(folder => String(folder.id) === String(libraryId));
                app.state.startIndex = Math.max(0, rootPage?.startIndex || 0);
                if (items === null && !await app.fetchVideos(libraryId, null, app.state.startIndex > 0)) throw new Error('媒体库读取失败');
                for (const folder of folders) {
                    if (folder.Type === 'Series') {
                        await this.openSeries(folder);
                    } else if (folder.Type === 'Season') {
                        if (app.state.videos.some(item => item.Type === 'Season')) await this.openSeason(folder);
                    } else {
                        const entry = app.state.videos.find(item => String(item.Id) === String(folder.Id));
                        if (folder === folders[folders.length - 1] && this.isSingleVideoFolder(entry || folder)) {
                            singleFolder = entry || folder;
                        } else {
                            const page = (record.path || []).find(entry => String(entry.id) === String(folder.Id));
                            await this.pushFolder(folder.Id, folder.Name, folder.Type, Math.max(0, page?.startIndex || 0));
                        }
                    }
                }
                if (videoData?.SeasonId && app.state.videos.some(item => item.Type === 'Season')) {
                    const season = app.state.videos.find(item => String(item.Id) === String(videoData.SeasonId));
                    if (!season) throw new Error('上次播放的季已不可用');
                    await this.openSeason(season);
                }

                if (isOpenList) {
                    let startIndex = Math.max(0, record.startIndex || 0);
                    let data = await window.OpenListManager.fetchItems({ path: this.currentFolderId || libraryId, startIndex, limit: 150, isFolderMode: true });
                    if (!(data.Items || []).some(item => String(item.Id) === String(record.itemId))) {
                        startIndex = 0;
                        do {
                            data = await window.OpenListManager.fetchItems({ path: this.currentFolderId || libraryId, startIndex, limit: 150, isFolderMode: true });
                            if ((data.Items || []).some(item => String(item.Id) === String(record.itemId))) break;
                            startIndex += 150;
                        } while (startIndex < (data.TotalRecordCount || 0));
                    }
                    items = data.Items || [];
                    app.state.startIndex = startIndex;
                    app.state.totalCount = data.TotalRecordCount || items.length;
                } else if (items === null && this.currentFolderType !== 'Series' && this.currentFolderType !== 'Season') {
                    const res = await fetch(this.getFetchUrl(app.config, libraryId, 0, null), { headers: app.getAuthHeaders(token) });
                    if (!res.ok) throw new Error(`文件夹读取失败: ${res.status}`);
                    items = (await res.json()).Items || [];
                }
                items = this.sortMixedItems((items || app.state.videos).filter(item => item && item.Type !== 'Photo' && item.MediaType !== 'Photo' && item.Type !== 'PhotoAlbum'));
                if (singleFolder) {
                    const folderIndex = items.findIndex(item => String(item.Id) === String(singleFolder.Id));
                    const resolved = await this.resolveFolderVideo(singleFolder);
                    if (folderIndex !== -1 && resolved) {
                        items[folderIndex] = resolved;
                        if (videoData && String(resolved.Id) === String(videoData.Id)) videoData.MediaSources = resolved.MediaSources;
                    }
                }
                const index = items.findIndex(item => String(item.Id) === String(record.itemId));
                if (index === -1) throw new Error('上次视频已不在当前目录');
                if (videoData) items[index] = videoData;
                videoData = items[index];
                app.state.videos = items;
                if (!isOpenList) {
                    app.state.startIndex = 0;
                    app.state.totalCount = items.length;
                }
                app.state.currentIndex = index;
                app.state.playMode = 'sequence';
                this.lastFocusedEpisodeId = String(videoData.Id);
                this.activePlayingFolderId = videoData.SeriesId || singleFolder?.Id || this.currentFolderId;
                const position = Number.isFinite(record.position) ? record.position : ((videoData.UserData?.PlaybackPositionTicks || 0) / 10000000);
                this.pendingResume = { itemId: String(videoData.Id), position: Math.max(0, position) };
                app._isFirstLoad = true;
                app.toggleViewMode();
                return true;
            } catch (e) {
                console.warn('恢复短剧播放失败:', e);
                this.reset();
                app.setViewMode('grid');
                app.state.startIndex = 0;
                app.state.currentIndex = 0;
                app.showToast('无法恢复上次播放，请在当前媒体库重新选片');
                return false;
            } finally {
                app.toggleLoading(false);
            }
        }

        /**
         * 保存单剧观看进度
         */
        saveDramaProgress(seriesOrFolderId, videoId, epIndex) {
            if (!seriesOrFolderId || !videoId) return;
            try {
                localStorage.setItem(this.getPlaybackKey(seriesOrFolderId), JSON.stringify({ lastId: String(videoId), lastEp: epIndex == null ? null : String(epIndex) }));
            } catch (e) {}
        }

        /**
         * 获取单剧历史观看进度
         */
        getDramaProgress(seriesOrFolderId) {
            if (!seriesOrFolderId) return null;
            try {
                return JSON.parse(localStorage.getItem(this.getPlaybackKey(seriesOrFolderId)) || 'null');
            } catch (e) {
                return null;
            }
        }

        /**
         * 跨剧/跨文件夹接力机制 (Relay Infinite Feed)：
         * 当当前短剧最后一集播放完毕或用户下滑触底时，自动向媒体库父级寻找下一个兄弟条目追加
         */
        async loadNextSiblingRelay() {
            if (!this.app || !this.isDramaMode() || !this.activePlayingFolderId) return false;
            if (!this.rootSiblings || !this.rootSiblings.length) return false;

            const app = this.app;
            const { server, token, userId } = app.config;

            // 1. 在媒体库同级列表中定位当前剧集/文件夹的位置
            const currentIdx = this.rootSiblings.findIndex(item => item.Id === this.activePlayingFolderId);
            if (currentIdx === -1 || currentIdx + 1 >= this.rootSiblings.length) {
                // 已经到达媒体库尽头，不跨媒体库
                return false;
            }

            const nextSibling = this.rootSiblings[currentIdx + 1];
            app.showToast(`已播完当前剧，即将连播: ${nextSibling.Name || '下一部'}`);

            try {
                let nextVideos = [];

                // A. 下一个是电视剧：拉取其分集
                if (nextSibling.Type === 'Series') {
                    const epUrl = `${server}/emby/Shows/${nextSibling.Id}/Episodes?UserId=${userId}&api_key=${token}&Fields=Overview,Path,RunTimeTicks,MediaSources,IndexNumber,ParentIndexNumber,SeriesName`;
                    const res = await fetch(epUrl, { headers: app.getAuthHeaders(token) });
                    if (res.ok) {
                        const data = await res.json();
                        nextVideos = data.Items || [];
                    }
                }
                // B. 下一个是文件夹：拉取该文件夹内容
                else if (nextSibling.IsFolder || nextSibling.Type === 'Folder') {
                    const fUrl = `${server}/emby/Users/${userId}/Items?ParentId=${nextSibling.Id}&Recursive=false&IncludeItemTypes=Movie,Episode,Video&api_key=${token}&Fields=Overview,Path,RunTimeTicks,MediaSources,IndexNumber,ParentIndexNumber,SeriesName`;
                    const res = await fetch(fUrl, { headers: app.getAuthHeaders(token) });
                    if (res.ok) {
                        const data = await res.json();
                        nextVideos = (data.Items || []).filter(it => !it.IsFolder && it.Type !== 'Folder' && it.Type !== 'Photo' && it.MediaType !== 'Photo' && it.Type !== 'PhotoAlbum');
                    }
                }
                // C. 下一个是独立单片/电影
                else {
                    if (nextSibling.Type !== 'Photo' && nextSibling.MediaType !== 'Photo' && nextSibling.Type !== 'PhotoAlbum') {
                        nextVideos = [nextSibling];
                    }
                }

                if (nextVideos.length > 0) {
                    nextVideos = this.sortMixedItems(nextVideos);
                    app.state.videos.push(...nextVideos);
                    this.activePlayingFolderId = nextSibling.Id;
                    return true;
                }
            } catch (e) {
                console.error('接力拉取下一个兄弟条目失败:', e);
            }
            return false;
        }
    }

    window.ShortDramaManager = ShortDramaManager;
})(window);
