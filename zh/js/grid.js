/**
 * EmbyX Grid View & Poster Gallery Controller (Zero-dependency, Vanilla JS)
 * Handles:
 * - 3:4 aspect-ratio card rendering for videos and short drama folders
 * - SafeHeader with pagination (❮ 1/N ❯), shuffle, search toggle, and one-level folder back (❮)
 * - Search bar with composition debounce & tag/actor filtering
 * - Hitokoto footer quote loading & cache
 */
(function (window) {
    'use strict';

    class GridViewManager {
        constructor(app) {
            this.app = app || null;
        }

        render() {
            if (!this.app) return;
            const app = this.app;

            app.dom.slides = null;
            const container = app.dom.videoContainer;
            if (!container) return;

            document.documentElement.scrollTop = 0;
            container.style.transition = 'none';
            void container.offsetHeight;
            container.style.transform = 'none';

            let bgLayer = container.querySelector('.bg-poster-layer');
            let safeHeader = document.getElementById('gridSafeHeader');
            let searchBar = document.getElementById('gridSearchBar');
            let scrollArea = document.getElementById('gridScrollArea');

            if (!safeHeader || !searchBar || !scrollArea) {
                container.innerHTML = '';
                container.className = 'absolute inset-0 z-10 bg-black/40 overflow-hidden';

                bgLayer = document.createElement('div');
                bgLayer.className = 'bg-poster-layer absolute inset-0 bg-cover bg-center opacity-70 scale-[1.15] blur-xl z-[-1] pointer-events-none';
                container.appendChild(bgLayer);

                scrollArea = document.createElement('div');
                scrollArea.id = 'gridScrollArea';
                scrollArea.className = 'absolute inset-0 overflow-y-auto overflow-x-hidden w-full overscroll-contain z-0';
                scrollArea.style.WebkitOverflowScrolling = 'touch';
                container.appendChild(scrollArea);

                safeHeader = document.createElement('div');
                safeHeader.id = 'gridSafeHeader';
                container.appendChild(safeHeader);

                searchBar = document.createElement('div');
                searchBar.id = 'gridSearchBar';
                safeHeader.appendChild(searchBar);

                let isDown = false, startY, scrollTop;
                scrollArea.addEventListener('mousedown', (e) => {
                    isDown = true;
                    scrollArea.style.cursor = 'grabbing';
                    startY = e.pageY - scrollArea.offsetTop;
                    scrollTop = scrollArea.scrollTop;
                });
                scrollArea.addEventListener('mouseleave', () => { isDown = false; scrollArea.style.cursor = ''; });
                scrollArea.addEventListener('mouseup', () => { isDown = false; scrollArea.style.cursor = ''; });
                scrollArea.addEventListener('mousemove', (e) => {
                    if (!isDown) return;
                    e.preventDefault();
                    const y = e.pageY - scrollArea.offsetTop;
                    const walk = (y - startY) * 2;
                    scrollArea.scrollTop = scrollTop - walk;
                });
            }

            // 背景海报模糊层更新
            const currentVideo = app.state.videos[app.state.currentIndex];
            const bgPosterStr = currentVideo ? app.getImageSrc(currentVideo) : app.getImageSrc(null);
            if (bgPosterStr) {
                bgLayer.style.backgroundImage = `url('${bgPosterStr}')`;
            }

            let libraryName = '全部视频';
            if (app.state.searchTerm) {
                libraryName = `搜索：${app.state.searchTerm}`;
            } else if (app.state.isFilteredByTag && app.state.currentTag) {
                libraryName = `标签：${app.state.currentTag}`;
            } else if (app.state.currentPerson) {
                libraryName = `演员：${app.state.currentPerson}`;
            } else if (app.drama?.currentFolderName) {
                libraryName = app.drama.currentFolderName;
            } else if (app.state.currentLibraryId === 'favorites') {
                libraryName = '收藏夹';
            } else if (app.state.currentLibraryId) {
                const libIdStr = String(app.state.currentLibraryId);
                const cachedViewsStr = localStorage.getItem('emby_views_cache');
                if (cachedViewsStr) {
                    try {
                        const cached = JSON.parse(cachedViewsStr);
                        let found = null;
                        if (cached.views && cached.views.Items) {
                            found = cached.views.Items.find(i => String(i.Id) === libIdStr);
                        }
                        if (!found && cached.playlists && cached.playlists.Items) {
                            found = cached.playlists.Items.find(i => String(i.Id) === libIdStr);
                        }
                        if (found) libraryName = found.Name;
                    } catch (e) { }
                }
            }

            const PAGE_SIZE = 150;
            let totalCount = 0;
            if (app.state.searchTerm) {
                totalCount = typeof app.state.searchTotalCount === 'number' ? app.state.searchTotalCount : (app.state.totalCount || app.state.videos.length);
            } else if (app.state.currentPerson || app.state.isFilteredByTag) {
                totalCount = typeof app.state.personTotalCount === 'number' ? app.state.personTotalCount : app.state.personVideos.length;
            } else {
                totalCount = app.state.totalCount || app.state.videos.length;
            }
            const startIndex = app.state.startIndex || 0;
            const currentPage = Math.floor(startIndex / PAGE_SIZE) + 1;
            const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
            const countStr = totalCount > 999 ? '999+' : String(totalCount);

            safeHeader.className = 'absolute top-0 left-0 right-0 z-20 bg-black/25 backdrop-blur-xl border-b border-white/10 flex flex-col transition-all';
            safeHeader.style.paddingTop = 'var(--safe-top)';

            const isSearchActive = !!app.state.searchTerm;
            const hasFolderBack = !!(app.drama && app.drama.folderStack.length > 0);

            const headerNav = document.createElement('div');
            headerNav.id = 'gridHeaderNav';
            headerNav.className = 'flex items-center gap-2 px-3 h-[60px] w-full';
            headerNav.innerHTML = `
                ${hasFolderBack ? `
                    <button id="gridFolderBackBtn" title="返回上一级" class="p-1 -ml-1 text-gray-300 hover:text-white active:scale-90 transition-transform flex items-center justify-center">
                        <i data-lucide="chevron-left" class="w-5 h-5"></i>
                    </button>
                ` : ''}
                <span class="text-sm font-bold text-gray-200 truncate max-w-[40%] flex items-center">${libraryName}</span>
                <span class="text-xs font-bold text-primary/70 tabular-nums flex items-center">
                    ${countStr}
                    ${!app.config.shortDrama ? `
                    <span class="w-1.5"></span>
                    <button id="gridShuffleBtn" title="随机换一批" class="active:scale-90 transition-transform p-[2px] bg-white/10 rounded-full hover:bg-white/20 flex items-center justify-center">
                        <i data-lucide="sparkles" class="w-3.5 h-3.5 text-white"></i>
                    </button>
                    ` : ''}
                </span>
                <span class="flex-1"></span>
                <button id="gridFolderSearchBtn" title="搜索"
                    class="w-7 h-7 flex items-center justify-center rounded-full active:scale-90 transition-all ${isSearchActive ? 'text-primary bg-primary/20' : 'text-white hover:text-white/80'}">
                    <i data-lucide="folder-search" class="w-4 h-4"></i>
                </button>
                <button id="gridPrevBtn" class="px-1.5 py-0.5 rounded text-xs flex items-center justify-center ${currentPage <= 1 ? 'text-gray-600 pointer-events-none' : 'text-gray-300 active:scale-90 hover:text-white transition-colors'}">❮</button>
                <span class="text-xs font-bold text-white tabular-nums flex items-center">${currentPage}<span class="px-0.5">/</span>${totalPages}</span>
                <button id="gridNextBtn" class="px-1.5 py-0.5 rounded text-xs flex items-center justify-center ${currentPage >= totalPages ? 'text-gray-600 pointer-events-none' : 'text-gray-300 active:scale-90 hover:text-white transition-colors'}">❯</button>
            `;

            safeHeader.innerHTML = '';
            safeHeader.appendChild(headerNav);
            safeHeader.appendChild(searchBar);

            if (hasFolderBack) {
                const backBtn = document.getElementById('gridFolderBackBtn');
                if (backBtn) {
                    backBtn.onclick = (e) => {
                        e.stopPropagation();
                        app.drama.popFolder();
                    };
                }
            }

            searchBar.className = `w-full px-3 pb-2.5 pt-0.5 ${app.state.searchTerm ? '' : 'hidden'}`;
            if (!searchBar.innerHTML) {
                searchBar.innerHTML = `
                    <div class="flex items-center gap-2 bg-white/10 rounded-lg px-3 py-2">
                        <i data-lucide="search" class="w-4 h-4 text-white flex-shrink-0"></i>
                        <input id="gridSearchInput" type="search"
                               value="${app.state.searchTerm}"
                               placeholder="视频名、演员、描述…"
                               class="flex-1 bg-transparent text-white text-sm outline-none placeholder-white/80 min-w-0">
                    </div>
                `;
            }

            scrollArea.style.paddingTop = isSearchActive ?
                'calc(7.25rem + var(--safe-top))' :
                'calc(3.75rem + var(--safe-top))';
            scrollArea.style.paddingBottom = 'calc(4.5rem + env(safe-area-inset-bottom, 0px))';

            const shuffleBtn = document.getElementById('gridShuffleBtn');
            if (shuffleBtn) {
                const curLibId = app.state.currentLibraryId;
                const libArg = (!curLibId || curLibId === 'favorites' || app.state.currentPerson || app.state.searchTerm) ? null : curLibId;
                shuffleBtn.onclick = (e) => {
                    e.stopPropagation();
                    app.state.startIndex = 0;
                    app.fetchVideos(libArg, null, false, true);
                };
            }

            const curLibId = app.state.currentLibraryId;
            const libArg = (!curLibId || curLibId === 'favorites' || app.state.currentPerson) ? null : curLibId;

            const prevBtn = document.getElementById('gridPrevBtn');
            if (prevBtn && currentPage > 1) {
                prevBtn.onclick = (e) => {
                    e.stopPropagation();
                    app.state.startIndex = Math.max(0, startIndex - PAGE_SIZE);
                    app.fetchVideos(libArg, null, true, false, false, app.state.searchTerm);
                };
            }
            const nextBtn = document.getElementById('gridNextBtn');
            if (nextBtn && currentPage < totalPages) {
                nextBtn.onclick = (e) => {
                    e.stopPropagation();
                    app.state.startIndex = startIndex + PAGE_SIZE;
                    app.fetchVideos(libArg, null, true, false, false, app.state.searchTerm);
                };
            }

            // 清空并重新构建卡片容器
            scrollArea.innerHTML = '';
            const gridWrapper = document.createElement('div');
            gridWrapper.className = 'grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-1 content-start w-full relative z-10 px-1 pt-2';
            scrollArea.appendChild(gridWrapper);

            const rawList = (app.state.currentPerson || app.state.isFilteredByTag) ? app.state.personVideos : app.state.videos;
            const listToRender = (rawList || []).filter(item => item && item.Type !== 'Photo' && item.MediaType !== 'Photo' && item.Type !== 'PhotoAlbum');
            listToRender.forEach((item, index) => {
                const isSeries = item.Type === 'Series';
                const isSeason = item.Type === 'Season';
                const isSingleMovie = !!(app.drama?.isSingleVideoFolder(item));
                const isFolder = (item.IsFolder || item.Type === 'Folder' || isSeries || isSeason) && !isSingleMovie;
                const el = document.createElement('div');
                const isActive = !app.state.currentPerson && !isFolder && (index === app.state.currentIndex);
                const isLastWatchedTarget = !isFolder && app.drama?.lastFocusedEpisodeId && String(item.Id) === String(app.drama.lastFocusedEpisodeId);

                el.setAttribute('tabindex', '0');
                el.setAttribute('data-index', index);
                el.className = `focusable-item aspect-[3/4] relative cursor-pointer overflow-hidden rounded-sm active:scale-95 transition-transform ${
                    isLastWatchedTarget ? 'ring-2 ring-primary ring-offset-2 ring-offset-black border-2 border-primary box-border' :
                    isActive ? 'border-2 border-primary box-border' : 'bg-gray-800'
                }`;

                // 封面图（OpenList 直链未必放行 CORS，强制 anonymous 会直接加载失败）
                const img = document.createElement('img');
                if (!item._isOpenList) img.crossOrigin = 'anonymous';
                img.referrerPolicy = 'no-referrer';
                img.src = app.getImageSrc(item);
                img.className = 'w-full h-full object-cover';
                img.loading = 'lazy';
                img.onerror = () => {
                    img.onerror = null;
                    img.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"%3E%3Crect width="1" height="1" fill="%23333"%2F%3E%3C%2Fsvg%3E';
                };
                el.appendChild(img);

                // ═══ 分支 1: 文件夹 / 电视剧 / 季卡片 ═══
                if (isFolder) {
                    el.onclick = () => {
                        if (app.drama) {
                            app.drama.enterItem(item);
                        }
                    };

                    // 居中或顶部遮罩：剧集名称
                    const topLayer = document.createElement('div');
                    topLayer.className = 'absolute inset-0 z-10 bg-gradient-to-t from-black/90 via-black/30 to-black/60 p-2 flex flex-col justify-between';

                    // 图标 (Series / Season / Folder)
                    const iconDiv = document.createElement('div');
                    iconDiv.className = 'self-end text-primary/90';
                    const iconName = item.Type === 'Series' ? 'tv' : item.Type === 'Season' ? 'layers' : 'folder';
                    iconDiv.innerHTML = `<i data-lucide="${iconName}" class="w-5 h-5 drop-shadow"></i>`;
                    topLayer.appendChild(iconDiv);

                    // 居中/主体标题
                    const titleDiv = document.createElement('div');
                    titleDiv.className = 'text-white text-sm font-bold text-center line-clamp-3 drop-shadow-md px-1';
                    titleDiv.textContent = item.Name;
                    topLayer.appendChild(titleDiv);

                    // 底部：集数与进度（统一基准线：与视频卡片共享 8px 底部内边距与 items-center）
                    const botDiv = document.createElement('div');
                    botDiv.className = 'w-full flex items-center justify-between text-[11px] text-gray-300 font-mono leading-none';
                    let countBadge = '文件夹';
                    if (item.Type === 'Series') {
                        const epCount = app.drama?.getSeriesEpisodeCount(item) || item.RecursiveItemCount || 0;
                        countBadge = epCount ? `共 ${epCount} 集` : '短剧';
                    } else if (item.Type === 'Season') {
                        countBadge = item.IndexNumber != null ? `第 ${item.IndexNumber} 季` : '分季';
                    } else {
                        const childCount = item.ChildCount || item.RecursiveItemCount;
                        if (childCount) countBadge = `共 ${childCount} 项`;
                    }

                    let progressStr = '';
                    const progress = app.drama?.getDramaProgress(item.Id);
                    if (progress && progress.lastEp) {
                        progressStr = `第 ${progress.lastEp} 集`;
                    }

                    botDiv.innerHTML = `
                        <span ${item.Type === 'Series' ? `data-series-badge="${item.Id}"` : ''}>${countBadge}</span>
                        ${progressStr ? `<span class="text-primary font-bold">${progressStr}</span>` : ''}
                    `;
                    topLayer.appendChild(botDiv);
                    el.appendChild(topLayer);
                }
                // ═══ 分支 2: 普通单集视频卡片 / 单片电影 ═══
                else {
                    el.onclick = () => {
                        // 若是单视频电影文件夹，穿透套娃直接起播
                        if (isSingleMovie) {
                            if (app.drama) {
                                app.drama.enterItem(item);
                            }
                            return;
                        }

                        if (app.state.currentPerson) {
                            app.state.videos = [...app.state.personVideos];
                            app.state.isFilteredByPerson = true;
                        }
                        // 如果在短剧模式且在某个文件夹/剧集内播放，记录该剧进度并绑定 activePlayingFolderId
                        if (app.drama) {
                            const dramaId = app.drama.currentFolderId || item.SeriesId;
                            if (dramaId) {
                                app.drama.activePlayingFolderId = dramaId;
                                app.drama.saveDramaProgress(dramaId, item.Id, item.IndexNumber || (index + 1));
                            }
                        }
                        app.state.currentIndex = index;
                        app.toggleViewMode();
                    };

                    const isShortDrama = app.config.shortDrama;
                    const pad = n => String(n).padStart(2, '0');
                    const hasSeason = item.ParentIndexNumber != null;
                    const hasEp = item.IndexNumber != null;
                    const isMovieType = item.Type === 'Movie' || isSingleMovie;
                    const isEpisodeType = item.Type === 'Episode' || hasSeason || hasEp;

                    // 时长格式化：电影/电视剧显示 1h45m 或 34m；普通短视频显示 05:30
                    let durationStr = '';
                    if (item.RunTimeTicks) {
                        const totalSec = Math.floor(item.RunTimeTicks / 10000000);
                        const mins = Math.floor(totalSec / 60);
                        const secs = totalSec % 60;
                        const hours = Math.floor(mins / 60);
                        const remMins = mins % 60;

                        if (isMovieType || isEpisodeType) {
                            durationStr = hours > 0 ? `${hours}h${remMins}m` : `${mins}m`;
                        } else {
                            durationStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
                        }
                    }

                    // 统一底部信息区结构：与文件夹卡片共享 px-2 pb-2 及 items-center，保证所有卡片底部在同一水平线上
                    const bottomLayer = document.createElement('div');
                    bottomLayer.className = 'absolute bottom-0 left-0 right-0 z-10 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-2 pt-6 pb-2 flex items-center justify-between gap-1.5';

                    if (isMovieType) {
                        // 电影：左下角纯电影名（剔除括号年份），右下角时长 (1h45m 或 34m)
                        const cleanName = (item.Name || '').replace(/\s*[\(\[（【]\s*\d{4}\s*[\)\]）】]\s*$/, '').trim();
                        bottomLayer.innerHTML = `
                            <span class="text-white text-[11px] font-medium truncate flex-1 leading-none drop-shadow">${cleanName}</span>
                            ${durationStr ? `<span class="text-white/80 text-[11px] font-mono whitespace-nowrap leading-none drop-shadow flex-shrink-0">${durationStr}</span>` : ''}
                        `;
                    } else if (isShortDrama && (hasSeason || hasEp)) {
                        // 电视剧单集：左下角 S01E01，右下角时长 (1h45m 或 34m)
                        const epLabel = (hasSeason ? `S${pad(item.ParentIndexNumber)}` : '') + (hasEp ? `E${pad(item.IndexNumber)}` : '');
                        bottomLayer.innerHTML = `
                            <span class="text-white/90 text-[11px] font-mono leading-none drop-shadow flex-shrink-0">${epLabel}</span>
                            ${durationStr ? `<span class="text-white/80 text-[11px] font-mono whitespace-nowrap leading-none drop-shadow flex-shrink-0">${durationStr}</span>` : ''}
                        `;
                    } else {
                        // 普通短视频：左下角标题，右下角标准时间码 (05:30)
                        bottomLayer.innerHTML = `
                            <span class="text-white text-[11px] font-medium truncate flex-1 leading-none drop-shadow">${item.Name || ''}</span>
                            ${durationStr ? `<span class="text-white/80 text-[11px] font-mono whitespace-nowrap leading-none drop-shadow flex-shrink-0">${durationStr}</span>` : ''}
                        `;
                    }
                    el.appendChild(bottomLayer);
                }

                gridWrapper.appendChild(el);
            });

            // 一言彩蛋
            const eggFooter = document.createElement('div');
            eggFooter.className = 'col-span-full pt-8 pb-24 px-4 text-center text-gray-600 text-[11px] leading-relaxed select-none';
            eggFooter.innerHTML = '<span class="opacity-40">——</span>';
            gridWrapper.appendChild(eggFooter);

            if (app.state._hitokotoCache) {
                const data = app.state._hitokotoCache;
                const source = [data.from_who, data.from].filter(Boolean).join(' · ');
                eggFooter.innerHTML = `
                    <p class="text-gray-300">“${data.hitokoto || ''}”</p>
                    ${source ? `<p class="mt-1 text-gray-500 italic">- ${source} -</p>` : ''}
                `;
            } else {
                fetch('https://v1.hitokoto.cn/?encode=json&charset=utf-8')
                    .then(r => r.json())
                    .then(data => {
                        app.state._hitokotoCache = data;
                        const text = data.hitokoto || '';
                        const source = [data.from_who, data.from].filter(Boolean).join(' · ');
                        eggFooter.innerHTML = `
                            <p class="text-gray-300">“${text}”</p>
                            ${source ? `<p class="mt-1 text-gray-500 italic">- ${source} -</p>` : ''}
                        `;
                    })
                    .catch(() => {
                        eggFooter.innerHTML = '';
                    });
            }

            app.updateUI();

            requestAnimationFrame(() => {
                const targetEl = gridWrapper.querySelector('.ring-primary') || gridWrapper.children[app.state.currentIndex];
                if (targetEl && scrollArea) {
                    const elTop = targetEl.offsetTop;
                    const elHeight = targetEl.offsetHeight;
                    const areaHeight = scrollArea.clientHeight;
                    scrollArea.scrollTop = elTop - (areaHeight / 2) + (elHeight / 2);
                }
            });

            const fsBtn = document.getElementById('gridFolderSearchBtn');
            if (fsBtn) {
                fsBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (app.state.searchTerm) {
                        this.searchVideos('');
                    } else {
                        const bar = document.getElementById('gridSearchBar');
                        if (bar) {
                            bar.classList.toggle('hidden');
                            if (scrollArea) {
                                scrollArea.style.paddingTop = bar.classList.contains('hidden') ?
                                    'calc(3.75rem + var(--safe-top))' :
                                    'calc(7.25rem + var(--safe-top))';
                            }
                            if (!bar.classList.contains('hidden')) {
                                document.getElementById('gridSearchInput')?.focus();
                            }
                        }
                    }
                };
            }

            const searchInput = document.getElementById('gridSearchInput');
            if (searchInput && !searchInput.dataset.bound) {
                searchInput.dataset.bound = 'true';
                let isComposing = false;
                let debounce = null;

                searchInput.addEventListener('compositionstart', () => {
                    isComposing = true;
                });
                searchInput.addEventListener('compositionend', (e) => {
                    isComposing = false;
                    const val = e.target.value.trim();
                    this.searchVideos(val);
                });
                searchInput.addEventListener('input', (e) => {
                    if (isComposing) return;
                    clearTimeout(debounce);
                    const val = e.target.value.trim();
                    debounce = setTimeout(() => this.searchVideos(val), 500);
                });
                searchInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape') this.searchVideos('');
                });
            }

            if (window.lucide) lucide.createIcons();
        }

        async searchVideos(term) {
            if (!this.app) return;
            const app = this.app;
            if (!term) {
                this.restorePreSearch();
                return;
            }
            if (!app.state.preSearchState) {
                app.state.preSearchState = {
                    currentLibraryId: app.state.currentLibraryId,
                    currentLibraryType: app.state.currentLibraryType,
                    videos: [...app.state.videos],
                    totalCount: app.state.totalCount,
                    startIndex: app.state.startIndex,
                    currentIndex: app.state.currentIndex
                };
                app.input?.pushLayer('search');
            }
            app.state.searchTerm = term;
            app.state.startIndex = 0;
            await app.fetchVideos(null, null, false, false, false, term);
        }

        restorePreSearch() {
            if (!this.app) return;
            const app = this.app;
            if (app.input && app.input.hasHistoryLayer('search') && !app.input._isHandlingPop) {
                window.history.back();
                return;
            }
            if (app.state.preSearchState) {
                Object.assign(app.state, app.state.preSearchState);
                app.state.preSearchState = null;
            }
            app.state.searchTerm = '';
            this.render();
        }

        async filterByTag(tagName) {
            if (!this.app || !tagName) return;
            const app = this.app;
            app.toggleLoading(true);
            try {
                const { server, token, userId } = app.config;
                const sortStr = app.config.shortDrama ? 'SortBy=SeriesName,ParentIndexNumber,IndexNumber&SortOrder=Ascending' : 'SortBy=DateCreated&SortOrder=Descending';
                const url = `${server}/emby/Users/${userId}/Items?api_key=${token}&Recursive=true&IncludeItemTypes=Movie,Episode,Video,MusicVideo&Limit=150&Fields=Overview,Path,RunTimeTicks,MediaSources,Tags,TagItems,SeriesName,ParentIndexNumber,IndexNumber&Tags=${encodeURIComponent(tagName)}&${sortStr}`;
                const res = await fetch(url, { headers: app.getAuthHeaders(token) });
                if (res.ok) {
                    const data = await res.json();
                    app.state.personVideos = data.Items || [];
                    app.state.personTotalCount = data.TotalRecordCount || app.state.personVideos.length;
                    app.state.currentTag = tagName;
                    app.state.isFilteredByTag = true;
                    app.state.currentPerson = null;
                    app.state.viewMode = 'grid';
                    app.input?.pushLayer('filter', { type: 'tag', name: tagName });

                    const vBtn = app.dom.viewModeBtn;
                    if (vBtn) {
                        vBtn.innerHTML = `<i data-lucide="layout-grid" class="stroke-current w-5 h-5"></i>`;
                        if (window.lucide) lucide.createIcons();
                    }

                    const appEl = document.getElementById('app');
                    if (appEl) {
                        appEl.classList.remove('interface-hidden');
                        appEl.classList.add('grid-active');
                    }
                    if (app.dom.videoContainer) app.dom.videoContainer.style.touchAction = 'auto';
                    this.render();
                }
            } catch (e) {
                app.showToast('筛选标签失败');
            } finally {
                app.toggleLoading(false);
            }
        }
    }

    window.GridViewManager = GridViewManager;
})(window);
