/**
 * EmbyX Spatial Navigation & Remote Control Engine
 * Zero-dependency, pure vanilla DOM spatial focus manager.
 * Supports:
 * - 2D geometry-based spatial navigation for irregular layouts
 * - 3-column grid directional offsets
 * - Linear tab/list focus cycling
 * - Automatic focus trapping on modal open/close
 * - Remote OK / Enter key dispatch
 */
(function (window) {
    'use strict';

    class SpatialNavigator {
        constructor(options = {}) {
            this.app = options.app || null;
        }

        /**
         * Handle directional keys and OK/Enter inside active modal or grid view.
         * Returns true if the key event was consumed by navigation.
         */
        handleKey(e, context = {}) {
            const key = e.key;
            const keyCode = e.keyCode;
            const lowKey = (key || '').toLowerCase();
            const isInput = context.isInput || false;

            const isDirection = key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight' ||
                lowKey === 'w' || lowKey === 'a' || lowKey === 's' || lowKey === 'd' ||
                [38, 40, 37, 39].includes(keyCode);

            const isEnter = key === 'Enter' || keyCode === 13;

            if (!isDirection && !isEnter) return false;

            const container = context.container || document.body;
            const items = Array.from(container.querySelectorAll('.focusable-item'));
            if (!items.length) return false;

            let currentIndex = items.indexOf(document.activeElement);

            // 1. Directional Movement
            if (isDirection) {
                if (isInput) return false;
                e.preventDefault();

                if (currentIndex === -1) {
                    let startItem = items[0];
                    if (context.isGrid) {
                        const targetIdx = context.currentGridIndex ?? -1;
                        startItem = items.find(it => it.dataset.index == targetIdx) || items[0];
                    }
                    startItem?.focus();
                    return true;
                }

                // A. Fixed 3-column grid mode
                if (context.isGrid) {
                    let nextIdx = currentIndex;
                    if (key === 'ArrowDown' || lowKey === 's' || keyCode === 40) nextIdx += 3;
                    else if (key === 'ArrowUp' || lowKey === 'w' || keyCode === 38) nextIdx -= 3;
                    else if (key === 'ArrowRight' || lowKey === 'd' || keyCode === 39) nextIdx += 1;
                    else if (key === 'ArrowLeft' || lowKey === 'a' || keyCode === 37) nextIdx -= 1;

                    if (nextIdx >= 0 && nextIdx < items.length) {
                        items[nextIdx].focus();
                        items[nextIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                    return true;
                }

                // B. 2D geometry-based spatial navigation (e.g., Library modal)
                if (context.isSpatial) {
                    const cur = items[currentIndex];
                    const curR = cur.getBoundingClientRect();
                    const curCx = curR.left + curR.width / 2;
                    const curCy = curR.top + curR.height / 2;

                    let dir;
                    if (key === 'ArrowDown' || lowKey === 's' || keyCode === 40) dir = 'down';
                    else if (key === 'ArrowUp' || lowKey === 'w' || keyCode === 38) dir = 'up';
                    else if (key === 'ArrowRight' || lowKey === 'd' || keyCode === 39) dir = 'right';
                    else if (key === 'ArrowLeft' || lowKey === 'a' || keyCode === 37) dir = 'left';

                    let best = null, bestScore = Infinity;
                    items.forEach(item => {
                        if (item === cur) return;
                        const r = item.getBoundingClientRect();
                        const cx = r.left + r.width / 2;
                        const cy = r.top + r.height / 2;
                        const dx = cx - curCx, dy = cy - curCy;

                        // Retain candidates in target direction with 2px tolerance
                        if (dir === 'down' && dy <= 2) return;
                        if (dir === 'up' && dy >= -2) return;
                        if (dir === 'right' && dx <= 2) return;
                        if (dir === 'left' && dx >= -2) return;

                        // Weighted distance: prioritize main axis, penalize off-axis deviation
                        const score = (dir === 'down' || dir === 'up')
                            ? Math.abs(dy) + Math.abs(dx) * 3
                            : Math.abs(dx) + Math.abs(dy) * 3;

                        if (score < bestScore) {
                            bestScore = score;
                            best = item;
                        }
                    });

                    if (best) {
                        best.focus();
                        best.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }
                    return true;
                }

                // C. Linear list cycling (e.g., Profile page)
                if (key === 'ArrowDown' || lowKey === 's' || key === 'ArrowRight' || lowKey === 'd' || [40, 39].includes(keyCode)) {
                    currentIndex = (currentIndex + 1) % items.length;
                } else {
                    currentIndex = (currentIndex - 1 + items.length) % items.length;
                }
                items[currentIndex].focus();
                return true;
            }

            // 2. OK / Enter trigger
            if (isEnter) {
                if (document.activeElement && document.activeElement.classList.contains('focusable-item')) {
                    const tagName = document.activeElement.tagName.toLowerCase();
                    if (tagName === 'textarea' || (tagName === 'input' && document.activeElement.type !== 'checkbox')) {
                        return false;
                    }
                    e.preventDefault();
                    document.activeElement.click();
                    return true;
                }
            }

            return false;
        }

        /**
         * Auto focus first or active item when modal opens
         */
        focusModal(containerEl, delayMs = 300) {
            if (!containerEl) return;
            setTimeout(() => {
                const allItems = Array.from(containerEl.querySelectorAll('.focusable-item'));
                // Prioritize selected item with primary background
                const selected = allItems.find(i => i.classList.contains('bg-primary/20'));
                const target = selected || allItems[0];
                if (target) target.focus();
            }, delayMs);
        }

        /**
         * Blur active element if it belongs to closing modal
         */
        blurModal(containerEl) {
            if (containerEl && document.activeElement && containerEl.contains(document.activeElement)) {
                document.activeElement.blur();
            }
        }
    }

    window.SpatialNavigator = SpatialNavigator;
})(window);
