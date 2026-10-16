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
            this.folderStack = []; // Navigation history: [{ id, name, type, seriesId, videos }]
            this.currentFolderId = null;
            this.currentFolderName = '';
            this.currentFolderType = ''; // 'Folder' | 'Series' | 'Season'
            this.activePlayingFolderId = null; // Currently playing drama/folder ID
            this.rootSiblings = []; // Siblings in root library, used for seamless cross-drama relay
            this.lastFocusedEpisodeId = null; // Used to auto-highlight last watched episode
            this.seriesCountCache = {};
            this._fetchingSeriesCounts = new Set();
        }

        /**
         * Check if short drama mode is enabled
         */
        isDramaMode() {
            return !!(this.app?.config?.shortDrama);
        }

        /**
         * Check if folder/drama drilldown mode should be active
         */
        isFolderModeActive() {
            return this.isDramaMode() &&
                !this.app?.state?.searchTerm &&
                !this.app?.state?.currentTag &&
                !this.app?.state?.currentPerson &&
                this.app?.state?.currentLibraryId !== 'favorites';
        }

        /**
         * Get fetch URL for short drama mode (non-recursive mixed top items)
         */
        getFetchUrl(config, libraryId, fetchStartIndex, pageSize) {
            const { server, token, userId } = config;
            const targetFolderId = this.currentFolderId || libraryId;
            let url = `${server}/emby/Users/${userId}/Items?api_key=${token}&Recursive=false&IncludeItemTypes=Folder,Series,Season,Movie,Episode,Video&Limit=${pageSize}&StartIndex=${fetchStartIndex}&Fields=Overview,Path,RunTimeTicks,MediaSources,ChildCount,RecursiveItemCount,SeriesName,ParentIndexNumber,IndexNumber`;
            if (targetFolderId && targetFolderId !== 'favorites') {
                url += `&ParentId=${targetFolderId}`;
            }
            return url;
        }

        /**
         * Process fetched items (mixed sort and record root siblings)
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
         * Check if item is a single-video folder (e.g. standalone movie in its own folder)
         */
        isSingleVideoFolder(item) {
            if (!item) return false;
            const isFolder = item.IsFolder || item.Type === 'Folder';
            if (!isFolder || item.Type === 'Series' || item.Type === 'Season') return false;
            const count = item.ChildCount ?? item.RecursiveItemCount;
            return count === 1 || count === 2;
        }

        /**
         * Get accurate episode count for Series (RecursiveItemCount prioritized, async fallback)
         */
        getSeriesEpisodeCount(item) {
            if (!item || item.Type !== 'Series') return 0;
            if (this.seriesCountCache && this.seriesCountCache[item.Id]) {
                return this.seriesCountCache[item.Id];
            }
            if (item.RecursiveItemCount && item.RecursiveItemCount > 0) {
                return item.RecursiveItemCount;
            }
            this.fetchSeriesEpisodeCount(item.Id);
            return item.ChildCount || 0;
        }

        /**
         * Asynchronously query Emby for real episode count and update DOM badge
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
                            badgeEl.textContent = `${total} Eps`;
                        }
                    }
                }
            } catch (e) {
            } finally {
                this._fetchingSeriesCounts.delete(seriesId);
            }
        }

        /**
         * Strict 3-tier mixed sort:
         * Tier 1: TV Series (Type === 'Series') pinned to top
         * Tier 2: Multi-video folders (ChildCount > 2) immediately following
         * Tier 3: Flattened single movies, dual-version folders & loose videos at the end
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
                    return 3; // single movie folder, dual-version folder, loose movie, loose video
                };

                const tierA = getTier(a);
                const tierB = getTier(b);

                if (tierA !== tierB) {
                    return tierA - tierB;
                }

                // Within tier: sort by index number ascending
                if (a.IndexNumber != null && b.IndexNumber != null) {
                    if (a.ParentIndexNumber != null && b.ParentIndexNumber != null && a.ParentIndexNumber !== b.ParentIndexNumber) {
                        return a.ParentIndexNumber - b.ParentIndexNumber;
                    }
                    return a.IndexNumber - b.IndexNumber;
                }

                // Within tier: alphabetical sort
                return (a.Name || '').localeCompare(b.Name || '', undefined, { numeric: true, sensitivity: 'base' });
            });
        }

        /**
         * Intelligently resolve folder video (supports cache, single movie, and multi-part/dual-version aggregation)
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
                        // Contains 2 videos (e.g. 1080P/4K versions or Part 1/Part 2), aggregate into single item with multiple MediaSources
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
                console.warn('Failed to resolve folder video:', e);
            }
            return null;
        }

        /**
         * Directly penetrate and play single-video movie folder (zero matryoshka)
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
                console.warn('Failed to resolve single video folder:', e);
            } finally {
                app.toggleLoading(false);
            }

            // Fallback: push as folder
            this.pushFolder(folderItem.Id, folderItem.Name, 'Folder');
        }

        /**
         * Dispatch user clicks on grid cards
         */
        async enterItem(item) {
            if (!this.app || !item) return;

            // Branch 1: Series
            if (item.Type === 'Series') {
                await this.openSeries(item);
                return;
            }

            // Branch 2: Season
            if (item.Type === 'Season') {
                await this.openSeason(item);
                return;
            }

            // Branch 3: Single-video movie folder (flatten matryoshka)
            if (this.isSingleVideoFolder(item)) {
                await this.playSingleVideoFolder(item);
                return;
            }

            // Branch 4: Multi-item Folder
            if (item.IsFolder || item.Type === 'Folder') {
                this.pushFolder(item.Id, item.Name, 'Folder');
                return;
            }

            // Branch 4: Movie or loose Video - play directly
            const videoIndex = this.app.state.videos.findIndex(v => v.Id === item.Id);
            if (videoIndex !== -1) {
                this.app.state.currentIndex = videoIndex;
                this.app.toggleViewMode();
            }
        }

        /**
         * Open Series (implements Emby's native single season auto-flatten principle)
         */
        async openSeries(seriesItem) {
            if (!this.app) return;
            const app = this.app;
            const { server, token, userId } = app.config;

            app.toggleLoading(true);
            try {
                // Save current parent state to stack
                this.folderStack.push({
                    id: this.currentFolderId || app.state.currentLibraryId,
                    name: this.currentFolderName || 'Root',
                    type: this.currentFolderType || 'Library',
                    videos: [...app.state.videos],
                    totalCount: app.state.totalCount
                });
                app.input?.pushLayer('folder', { id: seriesItem.Id });

                this.currentFolderId = seriesItem.Id;
                this.currentFolderName = seriesItem.Name;
                this.currentFolderType = 'Series';

                // 1. Check seasons
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
                    console.warn('Failed to fetch seasons, falling back to episodes:', e);
                }

                // 2. Emby Flatten Season: if only 1 season, auto-flatten episodes directly!
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
                        console.warn('Shows/Episodes failed, falling back to Items query:', e);
                    }

                    // Fallback
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
                    // Multi-season: render season cards
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
                console.error('Failed to load series:', err);
                app.showToast('Failed to load series: ' + (err.message || 'Network error'));
            } finally {
                app.toggleLoading(false);
            }
        }

        /**
         * Open specific season in multi-season series
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
                    totalCount: app.state.totalCount
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
                console.error('Failed to load season episodes:', err);
                app.showToast('Failed to load episodes');
            } finally {
                app.toggleLoading(false);
            }
        }

        /**
         * Drill down into folder
         */
        pushFolder(folderId, folderName, type = 'Folder') {
            if (!this.app) return;
            const parentId = this.currentFolderId || this.app.state.currentLibraryId;
            const parentName = this.currentFolderName || 'Root';

            this.folderStack.push({
                id: parentId,
                name: parentName,
                type: this.currentFolderType || 'Library',
                videos: [...this.app.state.videos],
                totalCount: this.app.state.totalCount
            });
            this.app?.input?.pushLayer('folder', { id: folderId });

            this.currentFolderId = folderId;
            this.currentFolderName = folderName;
            this.currentFolderType = type;

            this.app.state.startIndex = 0;
            this.app.fetchVideos();
        }

        /**
         * Return to parent level (strictly 1-step back)
         */
        popFolder() {
            if (this.app?.input && this.app.input.hasHistoryLayer('folder') && !this.app.input._isHandlingPop) {
                window.history.back();
                return true;
            }

            if (!this.app || this.folderStack.length === 0) return false;

            const prev = this.folderStack.pop();
            this.lastFocusedEpisodeId = null;

            if (prev.videos && Array.isArray(prev.videos)) {
                this.currentFolderId = (prev.id === this.app.state.currentLibraryId) ? null : prev.id;
                this.currentFolderName = (prev.name === 'Root') ? '' : prev.name;
                this.currentFolderType = prev.type || '';
                this.app.state.videos = prev.videos;
                this.app.state.totalCount = prev.totalCount || prev.videos.length;
                if (this.app.state.viewMode === 'grid') {
                    this.app.renderGridView();
                } else {
                    this.app.renderSlides();
                    this.app.loadVideo(0);
                }
                return true;
            }

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
         * Reset folder navigation stack
         */
        reset() {
            this.folderStack = [];
            this.currentFolderId = null;
            this.currentFolderName = '';
            this.currentFolderType = '';
            this.activePlayingFolderId = null;
            this.rootSiblings = [];
            this.lastFocusedEpisodeId = null;
        }

        /**
         * Save per-drama progress
         */
        saveDramaProgress(seriesOrFolderId, videoId, epIndex) {
            if (!seriesOrFolderId || !videoId) return;
            try {
                localStorage.setItem(`emby_drama_last_id_${seriesOrFolderId}`, String(videoId));
                if (epIndex != null) {
                    localStorage.setItem(`emby_drama_last_ep_${seriesOrFolderId}`, String(epIndex));
                }
            } catch (e) {}
        }

        /**
         * Get per-drama progress
         */
        getDramaProgress(seriesOrFolderId) {
            if (!seriesOrFolderId) return null;
            try {
                const lastId = localStorage.getItem(`emby_drama_last_id_${seriesOrFolderId}`);
                const lastEp = localStorage.getItem(`emby_drama_last_ep_${seriesOrFolderId}`);
                if (!lastId && !lastEp) return null;
                return { lastId, lastEp };
            } catch (e) {
                return null;
            }
        }

        /**
         * Cross-drama / cross-folder sibling relay:
         * When the current drama reaches the last episode or user scrolls past bottom,
         * seamlessly fetch and append the next sibling in the same library.
         */
        async loadNextSiblingRelay() {
            if (!this.app || !this.isDramaMode() || !this.activePlayingFolderId) return false;
            if (!this.rootSiblings || !this.rootSiblings.length) return false;

            const app = this.app;
            const { server, token, userId } = app.config;

            const currentIdx = this.rootSiblings.findIndex(item => item.Id === this.activePlayingFolderId);
            if (currentIdx === -1 || currentIdx + 1 >= this.rootSiblings.length) {
                return false;
            }

            const nextSibling = this.rootSiblings[currentIdx + 1];
            app.showToast(`Up next: ${nextSibling.Name || 'Next item'}`);

            try {
                let nextVideos = [];

                if (nextSibling.Type === 'Series') {
                    const epUrl = `${server}/emby/Shows/${nextSibling.Id}/Episodes?UserId=${userId}&api_key=${token}&Fields=Overview,Path,RunTimeTicks,MediaSources,IndexNumber,ParentIndexNumber,SeriesName`;
                    const res = await fetch(epUrl, { headers: app.getAuthHeaders(token) });
                    if (res.ok) {
                        const data = await res.json();
                        nextVideos = data.Items || [];
                    }
                } else if (nextSibling.IsFolder || nextSibling.Type === 'Folder') {
                    const fUrl = `${server}/emby/Users/${userId}/Items?ParentId=${nextSibling.Id}&Recursive=false&IncludeItemTypes=Movie,Episode,Video&api_key=${token}&Fields=Overview,Path,RunTimeTicks,MediaSources,IndexNumber,ParentIndexNumber,SeriesName`;
                    const res = await fetch(fUrl, { headers: app.getAuthHeaders(token) });
                    if (res.ok) {
                        const data = await res.json();
                        nextVideos = (data.Items || []).filter(it => !it.IsFolder && it.Type !== 'Folder' && it.Type !== 'Photo' && it.MediaType !== 'Photo' && it.Type !== 'PhotoAlbum');
                    }
                } else {
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
                console.error('Sibling relay load failed:', e);
            }
            return false;
        }
    }

    window.ShortDramaManager = ShortDramaManager;
})(window);
