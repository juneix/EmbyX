/**
 * EmbyX Donate & Player One Passcode Engine (DonateManager)
 *
 * ────────────────────────────────────────────────────────────────────────────
 * An open-source project. The ¥9.9 is just "support it if you like it", not a defense.
 * Modify it, fork it, ship a competitor — none of that is a problem.
 *
 * Thinking about working around it? You can, but there is no point.
 * Just have your AI build you a custom player — it fits your needs better
 * and costs far fewer tokens.
 *
 * This lock will not stop anyone determined. It only asks: would you like to support it?
 * ────────────────────────────────────────────────────────────────────────────
 */

(function () {
    const _eggMemoryMap = new Map();
    let _cloudChecking = false;

    class DonateManager {
        constructor() {
            this.API_VERIFY_URL = 'https://key.5nav.eu.org/api/verify';
            this.API_CHECK_URL = 'https://key.5nav.eu.org/api/check';
        }

        getCurrentTargetId() {
            return localStorage.getItem('emby_server_id') ||
                   (window.app && window.app.config && window.app.config.serverId) || '';
        }

        getBoundCode(targetId) {
            const tid = targetId || this.getCurrentTargetId();
            if (!tid) return '';
            return localStorage.getItem(`_p1_code_${tid}`) || '';
        }

        _setEggProof(targetId, token) {
            if (!targetId) return;
            _eggMemoryMap.set(targetId, String(token || 'verified_p1'));
        }

        _clearEggProof(targetId) {
            if (!targetId) return;
            _eggMemoryMap.delete(targetId);
            try {
                localStorage.removeItem(`_p1_token_${targetId}`);
                localStorage.removeItem(`_p1_code_${targetId}`);
            } catch (e) {}
        }

        _clearAllEggProofs() {
            _eggMemoryMap.clear();
            try {
                const keys = Object.keys(localStorage);
                keys.forEach(k => {
                    if (k.startsWith('_p1_token_') || k.startsWith('_p1_code_')) {
                        localStorage.removeItem(k);
                    }
                });
            } catch (e) {}
        }

        hasEggAccess() {
            const targetId = this.getCurrentTargetId();
            if (!targetId) return false;
            return _eggMemoryMap.has(targetId);
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
                input.value = boundCode || 'Activated';
                input.readOnly = true;
                input.classList.remove('border-gray-700', 'focus:border-amber-400');
                input.classList.add('border-amber-500/40', 'bg-amber-500/10', 'text-amber-300', 'font-bold', 'text-center');
                btn.disabled = true;
                btn.textContent = 'Active';
                btn.className = 'absolute right-1 px-3 py-1.5 bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-md text-xs font-bold cursor-default';
            } else {
                input.value = '';
                input.readOnly = false;
                input.placeholder = 'activation code';
                input.classList.add('border-gray-700', 'focus:border-amber-400');
                input.classList.remove('border-amber-500/40', 'bg-amber-500/10', 'text-amber-300', 'font-bold', 'text-center');
                btn.disabled = false;
                btn.textContent = 'Confirm';
                btn.className = 'absolute right-1 px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-md text-xs font-bold active:scale-95 transition-all shadow';
                if (targetId && targetId.startsWith('openlist-unbound-') && err) {
                    err.textContent = 'OpenList server ID is not bound. Please login once with an admin account to initialize it.';
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

            this.checkCloudEggStatus().then(() => this.renderDonateModalState());
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
                    errEl.textContent = 'Please enter a valid 8-digit activation code';
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
            if (targetId && targetId.startsWith('openlist-unbound-')) {
                if (errEl) {
                    errEl.textContent = 'OpenList server ID is not bound. Please login once with an admin account to initialize it.';
                    errEl.classList.remove('hidden');
                }
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = 'Confirm';
                }
                return false;
            }

            try {
                const resp = await fetch(this.API_VERIFY_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        app: 'embyx',
                        code: cleanCode,
                        target_id: targetId,
                        server_id: targetId
                    })
                });

                const data = await resp.json().catch(() => ({}));

                if (resp.ok && data.status === 'ok') {
                    this._setEggProof(targetId, data.token || 'verified_p1');
                    const formattedCode = data.code || (cleanCode.length === 8 ? `${cleanCode.slice(0, 4)}-${cleanCode.slice(4)}` : cleanCode);
                    try {
                        localStorage.setItem(`_p1_code_${targetId}`, formattedCode);
                    } catch (e) {}

                    this.saveToServerPrefs(true);
                    this.updateUI();
                    this.renderDonateModalState();

                    if (window.app && window.app.showToast) {
                        window.app.showToast('🎉 Congratulations! You have unlocked Player One privileges!');
                    } else {
                        alert('🎉 Congratulations! You have unlocked Player One privileges!');
                    }
                    return true;
                } else {
                    if (errEl) {
                        errEl.textContent = data.message || 'Activation code is invalid or expired';
                        errEl.classList.remove('hidden');
                    }
                    return false;
                }
            } catch (err) {
                if (errEl) {
                    errEl.textContent = 'Verification timed out. Please check your connection.';
                    errEl.classList.remove('hidden');
                }
                return false;
            } finally {
                if (btn && !this.isPlayerOne()) {
                    btn.disabled = false;
                    btn.textContent = 'Confirm';
                }
            }
        }

        async saveToServerPrefs(isPro) {
            try {
                if (window.EmbyXCommon && EmbyXCommon.getServerType() === 'openlist') return;
                const server = localStorage.getItem('emby_server') || (window.app && window.app.config && window.app.config.server);
                const token = localStorage.getItem('emby_token') || (window.app && window.app.config && window.app.config.token);
                const userId = localStorage.getItem('emby_uid') || (window.app && window.app.config && window.app.config.userId);
                if (!server || !token || !userId) return;

                const isJellyfin = window.EmbyXCommon && EmbyXCommon.getServerType() === 'jellyfin';
                const base = server.replace(/\/+$/, '');
                const url = `${base}${isJellyfin ? '' : '/emby'}/DisplayPreferences/usersettings?userId=${userId}&client=EmbyX`;

                const getRes = await fetch(url, { headers: { 'X-Emby-Token': token } });
                const prefs = await getRes.json().catch(() => ({}));
                const customPrefs = prefs.CustomPrefs || {};
                customPrefs.player_one = isPro ? 'true' : 'false';

                await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Emby-Token': token
                    },
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
            if (!targetId || _cloudChecking) return this.hasEggAccess();

            _cloudChecking = true;
            try {
                const checkUrl = `${this.API_CHECK_URL}?app=embyx&target_id=${encodeURIComponent(targetId)}&server_id=${encodeURIComponent(targetId)}`;
                const res = await fetch(checkUrl, { cache: 'no-store' });
                const data = await res.json().catch(() => ({}));

                if (res.ok && data.status === 'ok' && data.player_one === true) {
                    this._setEggProof(targetId, data.token || 'verified_p1');
                    if (data.code) {
                        try {
                            localStorage.setItem(`_p1_code_${targetId}`, data.code);
                        } catch (e) {}
                    }
                    this.updateUI();
                    return true;
                } else {
                    this._clearEggProof(targetId);
                    this.updateUI();
                    return false;
                }
            } catch (e) {
                this._clearEggProof(targetId);
                this.updateUI();
                return false;
            } finally {
                _cloudChecking = false;
            }
        }

        async syncFromServer() {
            try {
                const server = localStorage.getItem('emby_server') || (window.app && window.app.config && window.app.config.server);
                const token = localStorage.getItem('emby_token') || (window.app && window.app.config && window.app.config.token);
                const userId = localStorage.getItem('emby_uid') || (window.app && window.app.config && window.app.config.userId);
                const targetId = this.getCurrentTargetId();

                if (!targetId) return;

                const cloudVerified = await this.checkCloudEggStatus();
                if (cloudVerified) {
                    return;
                }

                if (server && token && userId && (!window.EmbyXCommon || EmbyXCommon.getServerType() !== 'openlist')) {
                    const isJellyfin = window.EmbyXCommon && EmbyXCommon.getServerType() === 'jellyfin';
                    const base = server.replace(/\/+$/, '');
                    const url = `${base}${isJellyfin ? '' : '/emby'}/DisplayPreferences/usersettings?userId=${userId}&client=EmbyX`;
                    const res = await fetch(url, { headers: { 'X-Emby-Token': token } });
                    const prefs = await res.json().catch(() => ({}));
                    if (prefs?.CustomPrefs?.player_one === 'true') {
                        const verified = await this.checkCloudEggStatus();
                        if (verified) {
                            return;
                        }
                    }
                }

                this._clearEggProof(targetId);
                this.updateUI();
            } catch (e) {
                console.warn('Sync from server error (silent):', e);
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
                    qualitySelect.value = 'direct';
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
                    dramaCheckbox.checked = false;
                    dramaCheckbox.setAttribute('disabled', 'disabled');
                    if (dramaLock) dramaLock.classList.remove('hidden');
                    if (dramaMask) dramaMask.classList.remove('hidden');
                }
            }

            const easterEggBtn = document.getElementById('castModalEasterEggBtn');
            if (easterEggBtn) {
                if (isP1) {
                    easterEggBtn.innerHTML = `<i data-lucide="rotate-cw" class="w-3.5 h-3.5 text-primary"></i><span>Refresh</span>`;
                } else {
                    easterEggBtn.innerHTML = `<i data-lucide="flask-conical" class="w-3.5 h-3.5 text-primary"></i><span>Lab</span>`;
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
