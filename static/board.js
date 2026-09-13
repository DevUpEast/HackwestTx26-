(() => {
    const board = document.querySelector('#physics-board');
    if (!board) return;

    const cards = [...board.querySelectorAll('[data-post-card]')];
    const showcaseSetting = document.querySelector('#showcase-count');
    const modeSetting = document.querySelector('#board-mode');
    const showcaseKey = 'popple-showcase-count';
    const savedShowcaseCount = Number(localStorage.getItem(showcaseKey));
    const showcaseCount = Number.isInteger(savedShowcaseCount) && savedShowcaseCount >= 3 && savedShowcaseCount <= 10
        ? Math.min(savedShowcaseCount, cards.length)
        : Math.min(6, cards.length);
    if (showcaseSetting) showcaseSetting.value = String(showcaseCount);
    const shuffledIndexes = cards.map((_, index) => index).sort(() => Math.random() - 0.5);
    const showcasedIndexes = new Set(shuffledIndexes.slice(0, showcaseCount));
    cards.forEach((card, index) => {
        const isShowcased = showcasedIndexes.has(index);
        card.hidden = !isShowcased;
        card.setAttribute('aria-hidden', String(!isShowcased));
    });
    showcaseSetting?.addEventListener('change', (event) => {
        const count = Math.max(3, Math.min(10, Number(event.target.value)));
        localStorage.setItem(showcaseKey, String(count));
        window.location.reload();
    });
    const modeKey = 'popple-board-mode';
    let physicsMode = localStorage.getItem(modeKey) === 'physics';
    if (modeSetting) modeSetting.value = physicsMode ? 'physics' : 'grid';
    const folders = {
        left: board.querySelector('[data-edge-folder="left"]'),
        right: board.querySelector('[data-edge-folder="right"]'),
    };
    const slotOrder = [...showcasedIndexes];
    const folderZone = 130;
    let dragState = null;
    let selectedCard = null;
    let physicsFrame = 0;
    let physicsLastTime = 0;
    const physicsState = new Map();

    const themeToggle = document.querySelector('#theme-toggle');
    const savedTheme = localStorage.getItem('hackwest-theme') || 'light';
    document.body.classList.toggle('theme-dark', savedTheme === 'dark');
    const updateThemeLabel = () => {
        if (!themeToggle) return;
        const dark = document.body.classList.contains('theme-dark');
        themeToggle.textContent = dark ? 'LIGHT' : 'DARK';
        themeToggle.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    };
    updateThemeLabel();
    themeToggle?.addEventListener('click', () => {
        const dark = document.body.classList.toggle('theme-dark');
        localStorage.setItem('hackwest-theme', dark ? 'dark' : 'light');
        updateThemeLabel();
    });

    const getGrid = () => {
        const count = slotOrder.length;
        const columns = board.clientWidth < 700 ? 2 : Math.min(4, Math.max(2, Math.ceil(Math.sqrt(count * 1.35))));
        const gapX = board.clientWidth < 700 ? 8 : 18;
        const gapY = board.clientWidth < 700 ? 5 : 14;
        const occupancy = [];
        const placements = [];

        slotOrder.forEach((cardIndex) => {
            const priority = Number(cards[cardIndex].dataset.priority) || 2;
            const span = priority >= 5 ? Math.min(2, columns) : 1;
            let row = 0;
            let column = 0;
            while (true) {
                occupancy[row] ||= [];
                const available = Array.from({ length: span }, (_, offset) => !occupancy[row][column + offset]);
                if (column + span <= columns && available.every(Boolean)) break;
                column += 1;
                if (column + span > columns) {
                    row += 1;
                    column = 0;
                }
            }
            for (let offset = 0; offset < span; offset += 1) occupancy[row][column + offset] = true;
            placements.push({ row, column, span });
        });

        return {
            columns,
            rows: occupancy.length,
            gapX,
            gapY,
            placements,
            cellWidth: (board.clientWidth - gapX * (columns - 1)) / columns,
            cellHeight: (board.clientHeight - gapY * (occupancy.length - 1)) / occupancy.length,
        };
    };

    const setFolder = (side, progress, centerY = board.clientHeight / 2) => {
        const folder = folders[side];
        const normalizedProgress = Math.max(0, Math.min(1, progress));
        const direction = side === 'left' ? 1 : -1;
        const verticalPosition = Math.max(0, Math.min(1, centerY / Math.max(board.clientHeight, 1)));
        const rotation = side === 'left'
            ? -12 + verticalPosition * 24
            : 12 - verticalPosition * 24;
        const folderTop = Math.max(0, Math.min(52, verticalPosition * 100 - 24));
        folder.style.opacity = `${normalizedProgress * 0.96}`;
        folder.style.top = normalizedProgress > 0 ? `${folderTop}%` : '8%';
        folder.style.height = normalizedProgress > 0 ? '48%' : '84%';
        folder.style.transform = `translateX(${direction * (normalizedProgress - 1) * 72}%) rotate(${rotation}deg)`;
        folder.classList.toggle('is-active', normalizedProgress > 0);
    };

    const resetFolders = () => {
        setFolder('left', 0);
        setFolder('right', 0);
    };

    const updateFolders = (card) => {
        const leftEdge = card.offsetLeft;
        const rightEdge = leftEdge + card.offsetWidth;
        const centerY = card.offsetTop + card.offsetHeight / 2;
        setFolder('left', (folderZone - leftEdge) / folderZone, centerY);
        setFolder('right', (rightEdge - (board.clientWidth - folderZone)) / folderZone, centerY);
    };

    const placeCard = (card, slotIndex, animate = true) => {
        const grid = getGrid();
        placeCardInGrid(card, slotIndex, grid, animate);
    };

    const placeCardInGrid = (card, slotIndex, grid, animate = true) => {
        const placement = grid.placements[slotIndex];
        const priority = Number(card.dataset.priority) || 2;
        const sizeFactor = 0.86 + priority * 0.025;
        const occupiedWidth = grid.cellWidth * placement.span + grid.gapX * (placement.span - 1);
        const cardWidth = Math.floor(occupiedWidth * sizeFactor);
        const cardHeight = Math.floor(grid.cellHeight * (physicsMode ? 0.72 : 0.9));
        card.style.width = `${cardWidth}px`;
        card.style.height = `${cardHeight}px`;
        card.style.minHeight = '0';
        const titleSize = Math.max(15, Math.min(30, cardWidth / 18));
        const contentMargin = Math.max(24, Math.min(48, cardHeight * 0.17));
        card.style.setProperty('--card-title-size', `${titleSize}px`);
        card.style.setProperty('--card-content-margin', `${contentMargin}px`);
        const content = card.querySelector('.post-content');
        if (content) {
            let fittedSize = titleSize;
            const availableContentHeight = Math.max(42, cardHeight - contentMargin - 48);
            while (content.scrollHeight > availableContentHeight && fittedSize > 14) {
                fittedSize -= 1;
                card.style.setProperty('--card-title-size', `${fittedSize}px`);
            }
        }
        const left = placement.column * (grid.cellWidth + grid.gapX) + (occupiedWidth - cardWidth) / 2;
        const top = placement.row * (grid.cellHeight + grid.gapY) + (grid.cellHeight - cardHeight) / 2;
        if (board.classList.contains('is-reflowing')) {
            card.style.transition = 'left 460ms cubic-bezier(0.22, 0.8, 0.25, 1), top 460ms cubic-bezier(0.22, 0.8, 0.25, 1), width 460ms cubic-bezier(0.22, 0.8, 0.25, 1), height 460ms cubic-bezier(0.22, 0.8, 0.25, 1)';
        } else {
            card.style.transition = animate && !physicsMode ? 'left 120ms ease, top 120ms ease' : 'none';
        }
        card.style.left = `${left}px`;
        card.style.top = `${top}px`;
    };

    const seedPhysicsState = () => {
        physicsState.clear();
        slotOrder.forEach((cardIndex) => {
            const card = cards[cardIndex];
            physicsState.set(card, { x: card.offsetLeft, y: card.offsetTop, vx: 0, vy: 0 });
        });
    };

    const physicsTick = (time) => {
        if (!physicsMode) {
            physicsFrame = 0;
            return;
        }
        const delta = Math.min((time - physicsLastTime) / 1000 || 0, 0.04);
        physicsLastTime = time;
        const activeCards = slotOrder.map((index) => cards[index]).filter((card) => !card.hidden && !card.classList.contains('is-filing'));
        activeCards.forEach((card) => {
            const state = physicsState.get(card);
            if (!state || dragState?.card === card) return;
            state.vx *= 0.985;
            state.vy *= 0.985;
            state.x += state.vx * delta;
            state.y += state.vy * delta;
        });
        for (let firstIndex = 0; firstIndex < activeCards.length; firstIndex += 1) {
            for (let secondIndex = firstIndex + 1; secondIndex < activeCards.length; secondIndex += 1) {
                const first = activeCards[firstIndex];
                const second = activeCards[secondIndex];
                const firstState = physicsState.get(first);
                const secondState = physicsState.get(second);
                const overlapX = Math.min(firstState.x + first.offsetWidth, secondState.x + second.offsetWidth) - Math.max(firstState.x, secondState.x);
                const overlapY = Math.min(firstState.y + first.offsetHeight, secondState.y + second.offsetHeight) - Math.max(firstState.y, secondState.y);
                const overlapArea = Math.max(0, overlapX) * Math.max(0, overlapY);
                const smallerArea = Math.min(first.offsetWidth * first.offsetHeight, second.offsetWidth * second.offsetHeight);
                if (overlapArea <= smallerArea * 0.5) continue;
                const firstCenterX = firstState.x + first.offsetWidth / 2;
                const firstCenterY = firstState.y + first.offsetHeight / 2;
                const secondCenterX = secondState.x + second.offsetWidth / 2;
                const secondCenterY = secondState.y + second.offsetHeight / 2;
                const distance = Math.hypot(secondCenterX - firstCenterX, secondCenterY - firstCenterY) || 1;
                const pushX = (secondCenterX - firstCenterX) / distance;
                const pushY = (secondCenterY - firstCenterY) / distance;
                firstState.vx -= pushX * 34;
                firstState.vy -= pushY * 34;
                secondState.vx += pushX * 34;
                secondState.vy += pushY * 34;
            }
        }
        activeCards.forEach((card) => {
            const state = physicsState.get(card);
            if (!state || dragState?.card === card) return;
            const maxX = board.clientWidth - card.offsetWidth - 8;
            const maxY = board.clientHeight - card.offsetHeight - 8;
            if (state.x < 0 || state.x > maxX) state.vx *= -0.45;
            if (state.y < 0 || state.y > maxY) state.vy *= -0.45;
            state.x = Math.max(0, Math.min(maxX, state.x));
            state.y = Math.max(0, Math.min(maxY, state.y));
            card.style.left = `${state.x}px`;
            card.style.top = `${state.y}px`;
        });
        physicsFrame = requestAnimationFrame(physicsTick);
    };

    const startPhysics = () => {
        physicsMode = true;
        board.classList.add('is-physics');
        placeAllCards(false);
        seedPhysicsState();
        physicsLastTime = performance.now();
        if (!physicsFrame) physicsFrame = requestAnimationFrame(physicsTick);
    };

    const stopPhysics = () => {
        physicsMode = false;
        board.classList.remove('is-physics');
        if (physicsFrame) cancelAnimationFrame(physicsFrame);
        physicsFrame = 0;
        placeAllCards(true);
    };

    modeSetting?.addEventListener('change', (event) => {
        localStorage.setItem(modeKey, event.target.value);
        if (event.target.value === 'physics') startPhysics();
        else stopPhysics();
    });

    const placeAllCards = (animate = true) => {
        const grid = getGrid();
        slotOrder.forEach((cardIndex, slotIndex) => {
            if (!dragState || dragState.card !== cards[cardIndex]) {
                placeCardInGrid(cards[cardIndex], slotIndex, grid, animate);
            }
        });
    };

    const animateGridReflow = () => {
        board.classList.add('is-reflowing');
        void board.offsetWidth;
        placeAllCards(true);
        window.setTimeout(() => board.classList.remove('is-reflowing'), 520);
    };

    const getSlotIndex = (cardIndex) => slotOrder.indexOf(cardIndex);

    const swapSlots = (draggedIndex, targetIndex) => {
        const from = getSlotIndex(draggedIndex);
        const to = getSlotIndex(targetIndex);
        if (from === to || from < 0 || to < 0) return;
        [slotOrder[from], slotOrder[to]] = [slotOrder[to], slotOrder[from]];
        dragState.slotIndex = to;
        dragState.swapUntil = performance.now() + 180;
        placeAllCards(true);
    };

    const findSwapTarget = (pointerX, pointerY) => {
        if (performance.now() < dragState.swapUntil) return -1;
        const grid = getGrid();
        const currentSlot = dragState.slotIndex;
        let nearestSlot = currentSlot;
        let nearestDistance = Infinity;

        grid.placements.forEach((placement, slotIndex) => {
            if (slotIndex === currentSlot) return;
            const occupiedWidth = grid.cellWidth * placement.span + grid.gapX * (placement.span - 1);
            const centerX = placement.column * (grid.cellWidth + grid.gapX) + occupiedWidth / 2;
            const centerY = placement.row * (grid.cellHeight + grid.gapY) + grid.cellHeight / 2;
            const distanceX = (pointerX - centerX) / Math.max(grid.cellWidth, 1);
            const distanceY = (pointerY - centerY) / Math.max(grid.cellHeight, 1);
            const distance = distanceX * distanceX + distanceY * distanceY;
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestSlot = slotIndex;
            }
        });

        if (nearestSlot === currentSlot || nearestDistance > 0.34) return -1;
        const targetIndex = slotOrder[nearestSlot];
        return targetIndex === undefined ? -1 : targetIndex;
    };

    const closeArticle = () => {
        const modal = document.querySelector('#article-modal');
        modal.classList.add('is-closing');
        modal.classList.remove('is-open');
        modal.setAttribute('aria-hidden', 'true');
        selectedCard?.classList.remove('is-selected');
        selectedCard = null;
        modal.addEventListener('transitionend', () => modal.classList.remove('is-closing'), { once: true });
    };

    const openArticle = (card) => {
        const modal = document.querySelector('#article-modal');
        const sheet = modal.querySelector('.article-sheet');
        const boardRect = board.getBoundingClientRect();
        const cardRect = {
            left: boardRect.left + card.offsetLeft,
            top: boardRect.top + card.offsetTop,
            width: card.offsetWidth,
            height: card.offsetHeight,
        };
        const viewportCenterX = window.innerWidth / 2;
        const viewportCenterY = window.innerHeight / 2;
        const sheetWidth = Math.min(760, window.innerWidth - 36);
        const sheetHeight = Math.min(520, window.innerHeight - 48);
        modal.classList.remove('is-open', 'is-settled', 'is-closing');
        modal.style.setProperty('--modal-dx', '0px');
        modal.style.setProperty('--modal-dy', '0px');
        modal.style.setProperty('--modal-scale-x', '1');
        modal.style.setProperty('--modal-scale-y', '1');
        sheet.style.transition = 'none';
        void sheet.offsetWidth;
        modal.style.setProperty('--modal-dx', `${cardRect.left + cardRect.width / 2 - viewportCenterX}px`);
        modal.style.setProperty('--modal-dy', `${cardRect.top + cardRect.height / 2 - viewportCenterY}px`);
        modal.style.setProperty('--modal-scale-x', `${Math.max(0.12, cardRect.width / sheetWidth)}`);
        modal.style.setProperty('--modal-scale-y', `${Math.max(0.12, cardRect.height / sheetHeight)}`);
        void sheet.offsetWidth;
        sheet.style.transition = '';
        document.querySelector('#article-title').textContent = card.dataset.title;
        document.querySelector('#article-author').textContent = card.dataset.author;
        document.querySelector('#article-tags').textContent = card.dataset.tags.replaceAll(', ', ' / ');
        document.querySelector('#article-body').innerHTML = sanitizeArticleHtml(card.dataset.bodyHtml || `<p>${card.dataset.title}</p>`);
        const articleImage = document.querySelector('#article-image');
        const imageUrl = card.dataset.imageUrl || '';
        articleImage.hidden = !/^https?:\/\//i.test(imageUrl);
        if (!articleImage.hidden) articleImage.src = imageUrl;
        modal.classList.remove('is-closing');
        selectedCard?.classList.remove('is-selected');
        selectedCard = card;
        card.classList.add('is-selected');
		sheet.addEventListener('transitionend', () => modal.classList.add('is-settled'), { once: true });
        modal.classList.add('is-open');
        modal.setAttribute('aria-hidden', 'false');
    };

    const sanitizeArticleHtml = (html) => {
        const template = document.createElement('template');
        template.innerHTML = html;
        const allowedTags = new Set(['P', 'BR', 'STRONG', 'EM', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'A', 'IMG']);
        template.content.querySelectorAll('*').forEach((element) => {
            if (!allowedTags.has(element.tagName)) {
                element.replaceWith(...element.childNodes);
                return;
            }
            [...element.attributes].forEach((attribute) => {
                const validLink = element.tagName === 'A' && attribute.name === 'href' && /^(https?:|mailto:)/i.test(attribute.value);
                const validImage = element.tagName === 'IMG' && ['src', 'alt'].includes(attribute.name)
                    && (attribute.name === 'alt' || /^(https?:)/i.test(attribute.value));
                if (!validLink && !validImage) {
                    element.removeAttribute(attribute.name);
                }
            });
            if (element.tagName === 'A') element.setAttribute('rel', 'noopener noreferrer');
        });
        template.content.querySelectorAll('script, style, iframe, object, embed').forEach((element) => element.remove());
        return template.innerHTML;
    };

    document.querySelectorAll('[data-close-article]').forEach((control) => {
        control.addEventListener('click', closeArticle);
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeArticle();
    });

    const fileCard = (card, side) => {
        card.classList.add('is-filing');
        card.style.left = side === 'left' ? `-${card.offsetWidth}px` : `${board.clientWidth + card.offsetWidth}px`;
        const cardIndex = cards.indexOf(card);
        const slotIndex = getSlotIndex(cardIndex);
        slotOrder.splice(slotIndex, 1);
        window.setTimeout(() => {
            card.remove();
            animateGridReflow();
        }, 320);
    };

    const onPointerDown = (event, card, cardIndex) => {
        if (event.button !== 0 || card.classList.contains('is-filing')) return;
        event.preventDefault();
        const boardRect = board.getBoundingClientRect();
        dragState = {
            card,
            cardIndex,
            offsetX: event.clientX - boardRect.left - card.offsetLeft,
            offsetY: event.clientY - boardRect.top - card.offsetTop,
            moved: false,
            slotIndex: getSlotIndex(cardIndex),
            swapUntil: 0,
            lastX: event.clientX,
            lastY: event.clientY,
            lastTime: performance.now(),
            velocityX: 0,
            velocityY: 0,
        };
        card.setPointerCapture(event.pointerId);
        card.classList.add('is-dragging');
        card.style.transition = 'none';
        card.style.transform = 'none';
    };

    const updateCardTilt = (event, card) => {
        if (dragState?.card === card) return;
        const bounds = card.getBoundingClientRect();
        const normalizedX = (event.clientX - bounds.left) / bounds.width - 0.5;
        const normalizedY = (event.clientY - bounds.top) / bounds.height - 0.5;
        const rotateY = Math.max(-7, Math.min(7, normalizedX * 14));
        const rotateX = Math.max(-7, Math.min(7, normalizedY * -14));
        card.style.setProperty('--card-rotate-x', `${rotateX}deg`);
        card.style.setProperty('--card-rotate-y', `${rotateY}deg`);
        card.style.setProperty('--card-lift', '-4px');
    };

    const resetCardTilt = (card) => {
        card.style.setProperty('--card-rotate-x', '0deg');
        card.style.setProperty('--card-rotate-y', '0deg');
        card.style.setProperty('--card-lift', '0px');
    };

    const onPointerMove = (event) => {
        if (!dragState) return;
        const { card, cardIndex } = dragState;
        const boardRect = board.getBoundingClientRect();
        const pointerX = event.clientX - boardRect.left;
        const pointerY = event.clientY - boardRect.top;
        const currentTime = performance.now();
        const elapsed = Math.max(1, currentTime - dragState.lastTime);
        const velocityX = (event.clientX - dragState.lastX) / elapsed * 1000;
        const velocityY = (event.clientY - dragState.lastY) / elapsed * 1000;
        dragState.velocityX = Math.max(-900, Math.min(900, velocityX));
        dragState.velocityY = Math.max(-900, Math.min(900, velocityY));
        dragState.lastX = event.clientX;
        dragState.lastY = event.clientY;
        dragState.lastTime = currentTime;
        card.style.left = `${pointerX - dragState.offsetX}px`;
        card.style.top = `${pointerY - dragState.offsetY}px`;
        dragState.moved = true;
        if (physicsMode) {
            const state = physicsState.get(card);
            if (state) {
                state.x = pointerX - dragState.offsetX;
                state.y = pointerY - dragState.offsetY;
                state.vx = dragState.velocityX;
                state.vy = dragState.velocityY;
            }
            updateFolders(card);
            return;
        }
        updateFolders(card);
        const targetIndex = findSwapTarget(pointerX, pointerY);
        if (targetIndex >= 0) swapSlots(cardIndex, targetIndex);
    };

    const onPointerUp = (event) => {
        if (!dragState) return;
        const { card, cardIndex, moved } = dragState;
        const leftEdge = card.offsetLeft;
        const rightEdge = leftEdge + card.offsetWidth;
        const side = leftEdge <= 0 ? 'left' : rightEdge >= board.clientWidth ? 'right' : null;
        card.releasePointerCapture?.(event.pointerId);
        card.classList.remove('is-dragging');
        resetCardTilt(card);
        card.style.transition = physicsMode ? 'none' : '';
        if (physicsMode && moved) {
            const state = physicsState.get(card);
            if (state) {
                state.vx = Math.max(-760, Math.min(760, dragState.velocityX));
                state.vy = Math.max(-760, Math.min(760, dragState.velocityY));
            }
        }
        dragState = null;
        if (physicsMode) {
            if (side) {
                reactToCard(card, side);
                fileCard(card, side);
            } else if (!moved) {
                openArticle(card);
            }
            resetFolders();
            return;
        }
        if (side) {
            reactToCard(card, side);
            fileCard(card, side);
            resetFolders();
            return;
        }
        placeCard(card, getSlotIndex(cardIndex));
        resetFolders();
        if (!moved) openArticle(card);
    };

    cards.forEach((card, cardIndex) => {
        card.addEventListener('pointerdown', (event) => onPointerDown(event, card, cardIndex));
        card.addEventListener('pointermove', onPointerMove);
        card.addEventListener('pointermove', (event) => updateCardTilt(event, card));
        card.addEventListener('pointerleave', () => resetCardTilt(card));
        card.addEventListener('pointerup', onPointerUp);
        card.addEventListener('pointercancel', (event) => {
            if (dragState?.card === card) {
                card.releasePointerCapture?.(event.pointerId);
                card.classList.remove('is-dragging');
                resetCardTilt(card);
                card.style.transition = physicsMode ? 'none' : '';
                dragState = null;
                if (!physicsMode) placeCard(card, getSlotIndex(cardIndex));
            }
            resetCardTilt(card);
        });
    });

    let glowFrame = 0;
    let glowX = 50;
    let glowY = 50;
    const updateBoardGlow = (event) => {
        const boardRect = board.getBoundingClientRect();
        glowX = ((event.clientX - boardRect.left) / boardRect.width) * 100;
        glowY = ((event.clientY - boardRect.top) / boardRect.height) * 100;
        if (glowFrame) return;
        glowFrame = requestAnimationFrame(() => {
            board.style.setProperty('--mouse-x', `${glowX}%`);
            board.style.setProperty('--mouse-y', `${glowY}%`);
            glowFrame = 0;
        });
    };

    const reactToCard = (card, side) => {
        const reaction = side === 'right' ? 'like' : 'dislike';
        const reactions = JSON.parse(localStorage.getItem('popple-reactions') || '{}');
        reactions[card.dataset.title] = reaction;
        localStorage.setItem('popple-reactions', JSON.stringify(reactions));
        if (card.dataset.postId) {
            fetch('/api/reactions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ post_id: Number(card.dataset.postId), reaction }),
            }).catch(() => {});
        }
        const folder = folders[side];
        const label = folder?.querySelector('span');
        if (!label) return;
        const originalLabel = label.textContent;
        label.textContent = reaction === 'like' ? 'LIKED' : 'DISLIKED';
        folder.classList.add('has-reaction');
        window.setTimeout(() => {
            label.textContent = originalLabel;
            folder.classList.remove('has-reaction');
        }, 900);
    };

    board.addEventListener('pointermove', updateBoardGlow);

    placeAllCards(false);
    if (physicsMode) startPhysics();
    window.addEventListener('resize', () => {
        if (physicsMode) return;
        animateGridReflow();
    });
})();
