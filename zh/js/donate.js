/**
 * EmbyX Donate & Player One Passcode Engine (DonateManager)
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 开源项目，¥9.9 的赞赏只是「喜欢就支持」，不是防线。
 * 想改、想 fork、想做个同类产品，都没问题。
 *
 * 如果你正琢磨怎么绕过它——可以，但没必要。
 * 直接让 AI 给你定制一个专属播放器，
 * 更贴合你的需求，也更省 token。
 *
 * 这道锁挡不住有心人，它只是问一句：愿意支持吗？
 * ────────────────────────────────────────────────────────────────────────────
 */

(function () {
    const _eggProofs = Object.create(null);
    const _cloudCheckPromises = new Map();
    const _cloudFetch = window.fetch.bind(window);
    const _cloudEncode = encodeURIComponent;
    const _readResponseJson = Function.call.bind(Response.prototype.json);

    async function _readCloudJson(response) {
        try {
            return await _readResponseJson(response);
        } catch (e) {
            return {};
        }
    }

    function _setEggProof(targetId) {
        if (!targetId || donateInstance.getCurrentTargetId() !== targetId) return;
        _eggProofs[targetId] = true;
    }

    class DonateManager {
        constructor() {
            this.API_VERIFY_URL = 'https://key.5nav.eu.org/api/verify';
            this.API_CHECK_URL = 'https://key.5nav.eu.org/api/check';
        }

        getCurrentTargetId() {
            const storedId = localStorage.getItem('emby_server_id') || '';
            const configuredId = window.app?.config?.serverId || '';
            if (storedId && configuredId && storedId !== configuredId) return '';
            return storedId || configuredId;
        }

        getBoundCode(targetId) {
            const tid = targetId || this.getCurrentTargetId();
            if (!tid) return '';
            return localStorage.getItem(`_p1_code_${tid}`) || '';
        }

        _clearEggProof(targetId, clearCode = true) {
            if (!targetId) return;
            delete _eggProofs[targetId];
            if (clearCode) {
                try {
                    localStorage.removeItem(`_p1_code_${targetId}`);
                } catch (e) {}
            }
        }

        _clearAllEggProofs() {
            Object.keys(_eggProofs).forEach(targetId => delete _eggProofs[targetId]);
            try {
                const keys = Object.keys(localStorage);
                keys.forEach(k => {
                    if (k.startsWith('_p1_code_')) {
                        localStorage.removeItem(k);
                    }
                });
            } catch (e) {}
        }

        hasEggAccess() {
            const targetId = this.getCurrentTargetId();
            if (!targetId) return false;
            return _eggProofs[targetId] === true;
        }

        isPlayerOne() {
            return this.hasEggAccess();
        }

        isActivated() {
            return this.hasEggAccess();
        }

        isCastLocked() {
            return !this.hasEggAccess();
        }

        renderDonateModalState() {
            const input = document.getElementById('donateCodeInput');
            const btn = document.getElementById('submitDonateCodeBtn');
            const err = document.getElementById('donateCodeError');
            if (!input || !btn) return;

            if (err) err.classList.add('hidden');

            const isP1 = this.isPlayerOne();
            const targetId = this.getCurrentTargetId();
            const boundCode = this.getBoundCode(targetId);

            if (isP1) {
                input.value = boundCode || '已激活';
                input.readOnly = true;
                input.classList.remove('border-gray-700', 'focus:border-amber-400');
                input.classList.add('border-amber-500/40', 'bg-amber-500/10', 'text-amber-300', 'font-bold', 'text-center');
                btn.disabled = true;
                btn.textContent = '已激活';
                btn.className = 'absolute right-1 px-3 py-1.5 bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-md text-xs font-bold cursor-default';
            } else {
                input.value = '';
                input.readOnly = false;
                input.placeholder = '赞助备注 EmbyX，加群领激活码';
                input.classList.add('border-gray-700', 'focus:border-amber-400');
                input.classList.remove('border-amber-500/40', 'bg-amber-500/10', 'text-amber-300', 'font-bold', 'text-center');
                btn.disabled = false;
                btn.textContent = '确认';
                btn.className = 'absolute right-1 px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-md text-xs font-bold active:scale-95 transition-all shadow';
                if (targetId && targetId.startsWith('openlist-unbound-') && err) {
                    err.textContent = '当前 OpenList 尚未绑定服务 ID，首次激活特权请先使用管理员账号登录一次 EmbyX';
                    err.classList.remove('hidden');
                }
            }
        }

        showDonateModal() {
            const modal = document.getElementById('donateModal');
            if (!modal) return;
            const profilePage = document.getElementById('profilePage');
            const isProfileActive = profilePage && profilePage.classList.contains('active');

            if (window.app?.closeAllModals) {
                window.app.closeAllModals(isProfileActive ? ['donateModal', 'profilePage'] : 'donateModal');
            }

            this.renderDonateModalState();

            modal.classList.remove('hidden', 'opacity-0', 'pointer-events-none');
            modal.classList.add('opacity-100');
            if (window.lucide && window.lucide.createIcons) {
                window.lucide.createIcons({ root: modal });
            }

            if (window.app?.input && typeof window.app.input.pushLayer === 'function') {
                window.app.input.pushLayer('modal', { id: 'donateModal' });
            }

            const targetId = this.getCurrentTargetId();
            this.checkCloudEggStatus().then(() => {
                if (this.getCurrentTargetId() === targetId) {
                    this.renderDonateModalState();
                }
            });
        }

        hideDonateModal() {
            if (window.app?.input && window.app.input.hasHistoryLayer('modal', 'donateModal') && !window.app.input._isHandlingPop) {
                window.history.back();
                return;
            }
            const modal = document.getElementById('donateModal');
            if (!modal) return;
            modal.classList.add('opacity-0', 'pointer-events-none');
            modal.classList.remove('opacity-100');
            setTimeout(() => modal.classList.add('hidden'), 200);

            const profilePage = document.getElementById('profilePage');
            if (profilePage && profilePage.classList.contains('active')) {
                if (window.app?.nav && typeof window.app.nav.focusModal === 'function') {
                    window.app.nav.focusModal(profilePage);
                }
            }
        }

        async verifySecretCode(code) {
            const cleanCode = String(code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
            const errEl = document.getElementById('donateCodeError');
            const btn = document.getElementById('submitDonateCodeBtn');

            if (!cleanCode || cleanCode.length < 4) {
                if (errEl) {
                    errEl.textContent = '请输入有效的 8 位激活码';
                    errEl.classList.remove('hidden');
                }
                return false;
            }

            if (btn) {
                btn.disabled = true;
                btn.innerHTML = `<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin inline-block"></i>`;
                if (window.lucide && window.lucide.createIcons) window.lucide.createIcons({ root: btn });
            }

            const targetId = this.getCurrentTargetId();
            if (!targetId) {
                if (errEl) {
                    errEl.textContent = '尚未获取服务器识别码，请先完成媒体库登录';
                    errEl.classList.remove('hidden');
                }
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = '确认';
                }
                return false;
            }
            if (targetId.startsWith('openlist-unbound-')) {
                if (errEl) {
                    errEl.textContent = '当前 OpenList 尚未初始化服务 ID，首次激活特权请先使用管理员账号登录一次 EmbyX 以绑定服务器';
                    errEl.classList.remove('hidden');
                }
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = '确认';
                }
                return false;
            }

            try {
                const resp = await _cloudFetch(this.API_VERIFY_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        app: 'embyx',
                        code: cleanCode,
                        target_id: targetId
                    })
                });

                const data = await _readCloudJson(resp);

                if (resp.ok && data.status === 'ok') {
                    _setEggProof(targetId);
                    const formattedCode = data.code || (cleanCode.length === 8 ? `${cleanCode.slice(0, 4)}-${cleanCode.slice(4)}` : cleanCode);
                    try {
                        localStorage.setItem(`_p1_code_${targetId}`, formattedCode);
                    } catch (e) {}

                    if (this.getCurrentTargetId() === targetId) {
                        this.saveToServerPrefs(true);
                        this.updateUI();
                        this.renderDonateModalState();

                        if (window.app && window.app.showToast) {
                            window.app.showToast('🎉 恭喜！您已成功解锁【头号玩家】特权！');
                        } else {
                            alert('🎉 恭喜！您已成功解锁【头号玩家】特权！');
                        }
                        return true;
                    }
                    return false;
                } else {
                    if (errEl) {
                        errEl.textContent = data.message || '激活码无效或已过期，请仔细核对';
                        errEl.classList.remove('hidden');
                    }
                    return false;
                }
            } catch (err) {
                if (errEl) {
                    errEl.textContent = '联网核验超时，请检查网络连接后重试';
                    errEl.classList.remove('hidden');
                }
                return false;
            } finally {
                if (btn && !this.isPlayerOne()) {
                    btn.disabled = false;
                    btn.textContent = '确认';
                }
            }
        }

        async saveToServerPrefs(isPro) {
            try {
                if (window.EmbyXCommon && EmbyXCommon.getServerType() === 'openlist') return;
                const server = localStorage.getItem('emby_server') || (window.app && window.app.config && window.app.config.server);
                const mediaToken = localStorage.getItem('emby_token') || (window.app && window.app.config && window.app.config.token);
                const userId = localStorage.getItem('emby_uid') || (window.app && window.app.config && window.app.config.userId);
                if (!server || !mediaToken || !userId) return;

                const isJellyfin = window.EmbyXCommon && EmbyXCommon.getServerType() === 'jellyfin';
                const base = server.replace(/\/+$/, '');
                const url = `${base}${isJellyfin ? '' : '/emby'}/DisplayPreferences/usersettings?userId=${userId}&Client=EmbyX`;
                const mediaHeaders = EmbyXCommon.getAuthHeaders({}, mediaToken);

                const getRes = await fetch(url, { headers: mediaHeaders });
                if (!getRes.ok) throw new Error(`HTTP ${getRes.status}`);
                const prefs = await getRes.json().catch(() => ({}));
                const customPrefs = prefs.CustomPrefs || {};
                customPrefs.player_one = isPro ? 'true' : 'false';

                await fetch(url, {
                    method: 'POST',
                    headers: { ...mediaHeaders, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        Id: prefs.Id || 'usersettings',
                        Client: 'EmbyX',
                        CustomPrefs: customPrefs
                    })
                });
            } catch (e) {
                console.warn('Sync to server prefs failed (silent):', e);
            }
        }

        async checkCloudEggStatus() {
            const targetId = this.getCurrentTargetId();
            if (!targetId) return false;

            let checkPromise = _cloudCheckPromises.get(targetId);
            if (!checkPromise) {
                const controller = typeof AbortController === 'function' ? new AbortController() : null;
                let expired = false;
                let timeoutId;
                const timeout = new Promise(resolve => {
                    timeoutId = setTimeout(() => {
                        expired = true;
                        controller?.abort();
                        this._clearEggProof(targetId, false);
                        if (this.getCurrentTargetId() === targetId) this.updateUI();
                        resolve(false);
                    }, 2000);
                });
                const request = (async () => {
                    let verified = false;
                    try {
                        const checkUrl = `${this.API_CHECK_URL}?app=embyx&target_id=${_cloudEncode(targetId)}`;
                        const res = await _cloudFetch(checkUrl, { cache: 'no-store', signal: controller?.signal });
                        const data = await _readCloudJson(res);
                        if (expired) return false;

                        verified = res.ok && data.status === 'ok' && data.player_one === true;
                        if (verified) {
                            _setEggProof(targetId);
                            if (data.code) {
                                try {
                                    localStorage.setItem(`_p1_code_${targetId}`, data.code);
                                } catch (e) {}
                            }
                        } else {
                            this._clearEggProof(targetId, res.ok);
                        }
                    } catch (e) {
                        if (expired) return false;
                        this._clearEggProof(targetId, false);
                    }

                    if (this.getCurrentTargetId() === targetId) {
                        this.updateUI();
                        return verified;
                    }
                    return false;
                })();
                checkPromise = Promise.race([request, timeout]).finally(() => clearTimeout(timeoutId));
                _cloudCheckPromises.set(targetId, checkPromise);
            }

            try {
                const verified = await checkPromise;
                return this.getCurrentTargetId() === targetId && verified === true && this.hasEggAccess();
            } finally {
                if (_cloudCheckPromises.get(targetId) === checkPromise) {
                    _cloudCheckPromises.delete(targetId);
                }
            }
        }

        async syncFromServer() {
            try {
                const targetId = this.getCurrentTargetId();
                if (!targetId) return false;

                const verified = await this.checkCloudEggStatus();
                return this.getCurrentTargetId() === targetId && verified === true;
            } catch (e) {
                console.warn('Sync from server error (silent):', e);
                return false;
            }
        }

        updateUI() {
            const isP1 = this.isPlayerOne();

            const playerOneBadge = document.getElementById('playerOneBadge');
            if (playerOneBadge) {
                if (isP1) {
                    playerOneBadge.classList.remove('hidden');
                    playerOneBadge.classList.add('flex');
                } else {
                    playerOneBadge.classList.add('hidden');
                    playerOneBadge.classList.remove('flex');
                }
            }

            const qualitySelect = document.getElementById('configPlayQuality');
            const qualityLock = document.getElementById('playQualityLockIcon');
            const qualityMask = document.getElementById('playQualityLockMask');

            if (qualitySelect) {
                if (isP1) {
                    qualitySelect.removeAttribute('disabled');
                    qualitySelect.classList.remove('opacity-60', 'cursor-not-allowed');
                    if (qualityLock) qualityLock.classList.add('hidden');
                    if (qualityMask) qualityMask.classList.add('hidden');
                } else {
                    qualitySelect.setAttribute('disabled', 'disabled');
                    qualitySelect.classList.add('opacity-60', 'cursor-not-allowed');
                    if (qualityLock) qualityLock.classList.remove('hidden');
                    if (qualityMask) qualityMask.classList.remove('hidden');
                }
            }

            const dramaCheckbox = document.getElementById('configShortDrama');
            const dramaLock = document.getElementById('shortDramaLockIcon');
            const dramaMask = document.getElementById('shortDramaLockMask');

            if (dramaCheckbox) {
                if (isP1) {
                    dramaCheckbox.removeAttribute('disabled');
                    if (dramaLock) dramaLock.classList.add('hidden');
                    if (dramaMask) dramaMask.classList.add('hidden');
                } else {
                    dramaCheckbox.setAttribute('disabled', 'disabled');
                    if (dramaLock) dramaLock.classList.remove('hidden');
                    if (dramaMask) dramaMask.classList.remove('hidden');
                }
            }

            const easterEggBtn = document.getElementById('castModalEasterEggBtn');
            if (easterEggBtn) {
                if (isP1) {
                    easterEggBtn.innerHTML = `<i data-lucide="rotate-cw" class="w-3.5 h-3.5 text-primary"></i><span>刷新</span>`;
                } else {
                    easterEggBtn.innerHTML = `<i data-lucide="flask-conical" class="w-3.5 h-3.5 text-primary"></i><span>彩蛋空间</span>`;
                }
                easterEggBtn.classList.remove('hidden');
            }

            if (window.lucide && window.lucide.createIcons) {
                window.lucide.createIcons();
            }
        }

        init() {
            this.updateUI();

            const donateModal = document.getElementById('donateModal');
            if (donateModal) {
                donateModal.addEventListener('click', (e) => {
                    if (e.target === donateModal) {
                        this.hideDonateModal();
                    }
                });
            }

            const qualityMask = document.getElementById('playQualityLockMask');
            if (qualityMask) {
                qualityMask.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!this.isPlayerOne()) {
                        this.showDonateModal();
                    }
                });
            }

            const dramaMask = document.getElementById('shortDramaLockMask');
            if (dramaMask) {
                dramaMask.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!this.isPlayerOne()) {
                        this.showDonateModal();
                    }
                });
            }

            const input = document.getElementById('donateCodeInput');
            if (input) {
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        if (!this.isPlayerOne()) {
                            this.verifySecretCode(input.value);
                        }
                    }
                });
            }

            this.checkCloudEggStatus();
        }
    }

    const donateInstance = new DonateManager();

    Object.freeze(DonateManager.prototype);
    Object.freeze(donateInstance);

    Object.defineProperty(window, 'DonateManager', {
        value: donateInstance,
        writable: false,
        configurable: false,
        enumerable: true
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => window.DonateManager.init());
    } else {
        window.DonateManager.init();
    }
})();
