(() => {
    const board = document.querySelector('#physics-board');
    if (!board || typeof Matter === 'undefined') return;

    const { Bodies, Body, Composite, Engine, Mouse, MouseConstraint, Runner } = Matter;
    const cards = [...board.querySelectorAll('[data-post-card]')];
    const folders = {
        left: board.querySelector('[data-edge-folder="left"]'),
        right: board.querySelector('[data-edge-folder="right"]'),
    };
    const engine = Engine.create({ gravity: { x: 0, y: 0 } });
    const width = board.clientWidth;
    const height = board.clientHeight;
    const wallThickness = 80;
    const walls = [
        Bodies.rectangle(width / 2, height + wallThickness / 2, width, wallThickness, { isStatic: true }),
        Bodies.rectangle(width / 2, -wallThickness / 2, width, wallThickness, { isStatic: true }),
        Bodies.rectangle(-wallThickness / 2, height / 2, wallThickness, height, { isStatic: true }),
        Bodies.rectangle(width + wallThickness / 2, height / 2, wallThickness, height, { isStatic: true }),
    ];

    const bodies = cards.map((card, index) => {
        const cardWidth = card.offsetWidth;
        const cardHeight = card.offsetHeight;
        const desktopSlots = [
            [0.17, 0.16], [0.50, 0.15], [0.83, 0.17],
            [0.31, 0.41], [0.67, 0.40],
            [0.16, 0.70], [0.50, 0.69], [0.84, 0.71],
        ];
        const mobileSlots = [
            [0.29, 0.14], [0.71, 0.14],
            [0.28, 0.38], [0.72, 0.38],
            [0.30, 0.62], [0.70, 0.61],
            [0.28, 0.84], [0.72, 0.84],
        ];
        const slots = width < 700 ? mobileSlots : desktopSlots;
        const [slotX, slotY] = slots[index % slots.length];
        const x = width * slotX;
        const y = height * slotY;
        const body = Bodies.rectangle(x, y, cardWidth, cardHeight, {
            restitution: 0.82,
            friction: 0.02,
            frictionAir: 0.13,
            chamfer: { radius: 16 },
        });
        card.style.left = `${x - cardWidth / 2}px`;
        card.style.top = `${y - cardHeight / 2}px`;
        return body;
    });

    Composite.add(engine.world, [...walls, ...bodies]);
    const mouse = Mouse.create(board);
    const mouseConstraint = MouseConstraint.create(engine, {
        mouse,
        constraint: { stiffness: 0.18, render: { visible: false } },
    });
    Composite.add(engine.world, mouseConstraint);

    const bodyCards = new Map(bodies.map((body, index) => [body.id, { body, card: cards[index] }]));
    const edgeDropWidth = 94;
    let draggedBody = null;
    let dragStartedAt = null;
    let dragMoved = false;
    const articleModal = document.querySelector('#article-modal');
    const articleTitle = document.querySelector('#article-title');
    const articleAuthor = document.querySelector('#article-author');
    const articleTags = document.querySelector('#article-tags');

    const closeArticle = () => {
        articleModal.classList.remove('is-open');
        articleModal.setAttribute('aria-hidden', 'true');
    };

    const openArticle = (card) => {
        articleTitle.textContent = card.dataset.title;
        articleAuthor.textContent = card.dataset.author;
        articleTags.textContent = card.dataset.tags.replaceAll(', ', ' / ');
        articleModal.classList.add('is-open');
        articleModal.setAttribute('aria-hidden', 'false');
    };

    articleModal.querySelectorAll('[data-close-article]').forEach((control) => {
        control.addEventListener('click', closeArticle);
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeArticle();
    });

    const setFolder = (side, active) => {
        folders[side].classList.toggle('is-active', active);
    };

    const updateFolders = (body, pointerX = body && body.position.x) => {
        setFolder('left', Boolean(body && pointerX < edgeDropWidth));
        setFolder('right', Boolean(body && pointerX > width - edgeDropWidth));
    };

    const clampBody = (body, card) => {
        const halfWidth = card.offsetWidth / 2;
        const halfHeight = card.offsetHeight / 2;
        const boardWidth = board.clientWidth;
        const boardHeight = board.clientHeight;
        const minX = halfWidth;
        const maxX = boardWidth - halfWidth;
        const minY = halfHeight;
        const maxY = boardHeight - halfHeight;
        const x = Math.max(minX, Math.min(maxX, body.position.x));
        const y = Math.max(minY, Math.min(maxY, body.position.y));

        if (x !== body.position.x || y !== body.position.y) {
            Body.setPosition(body, { x, y });
            Body.setVelocity(body, {
                x: x === minX || x === maxX ? 0 : body.velocity.x,
                y: y === minY || y === maxY ? 0 : body.velocity.y,
            });
        }

        return { x, y, halfWidth, halfHeight };
    };

    const render = () => bodies.forEach((body, index) => {
        const card = cards[index];
        if (card.classList.contains('is-filing')) return;
        const { x, y, halfWidth, halfHeight } = clampBody(body, card);
        card.style.left = `${x - halfWidth}px`;
        card.style.top = `${y - halfHeight}px`;
        card.style.transform = 'none';
    });
    Matter.Events.on(engine, 'afterUpdate', render);
    Matter.Events.on(mouseConstraint, 'startdrag', (event) => {
        draggedBody = event.body;
        dragStartedAt = { x: event.mouse.position.x, y: event.mouse.position.y };
        dragMoved = false;
        updateFolders(draggedBody, event.mouse.position.x);
    });
    Matter.Events.on(mouseConstraint, 'mousemove', (event) => {
        if (draggedBody) {
            const dx = event.mouse.position.x - dragStartedAt.x;
            const dy = event.mouse.position.y - dragStartedAt.y;
            dragMoved = dragMoved || Math.hypot(dx, dy) > 8;
            clampBody(draggedBody, bodyCards.get(draggedBody.id).card);
            updateFolders(draggedBody, event.mouse.position.x);
        }
    });
    Matter.Events.on(mouseConstraint, 'enddrag', (event) => {
        const body = event.body;
        const pointerX = event.mouse.position.x;
        const side = pointerX < edgeDropWidth ? 'left'
            : pointerX > width - edgeDropWidth ? 'right' : null;
        draggedBody = null;
        setFolder('left', false);
        setFolder('right', false);
        if (side) fileCard(body, side);
    });
    Runner.run(Runner.create(), engine);

    function fileCard(body, side) {
        const item = bodyCards.get(body.id);
        if (!item || item.card.classList.contains('is-filing')) return;

        const { card } = item;
        card.classList.add('is-filing');
        card.style.left = side === 'left' ? `-${card.offsetWidth}px` : `${width + card.offsetWidth}px`;
        card.style.transform = 'none';
        Composite.remove(engine.world, body);
        window.setTimeout(() => card.remove(), 320);
    }

    cards.forEach((card, index) => {
        card.querySelector('.favorite-button').addEventListener('click', (event) => {
            event.stopPropagation();
            event.currentTarget.classList.toggle('is-favorite');
            event.currentTarget.textContent = event.currentTarget.classList.contains('is-favorite') ? '*' : '+';
        });
        card.addEventListener('click', () => {
            if (!dragMoved && !card.classList.contains('is-filing')) openArticle(card);
        });
        Body.setVelocity(bodies[index], { x: 0, y: 0 });
        Body.setAngle(bodies[index], 0);
        Body.setInertia(bodies[index], Infinity);
        Body.setAngularVelocity(bodies[index], 0);
    });

    window.addEventListener('resize', () => {
        Body.setPosition(walls[0], { x: board.clientWidth / 2, y: board.clientHeight + wallThickness / 2 });
        Body.setPosition(walls[1], { x: board.clientWidth / 2, y: -wallThickness / 2 });
        Body.setPosition(walls[2], { x: -wallThickness / 2, y: board.clientHeight / 2 });
        Body.setPosition(walls[3], { x: board.clientWidth + wallThickness / 2, y: board.clientHeight / 2 });
    });
})();