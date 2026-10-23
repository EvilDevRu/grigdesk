import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { Page } from '../../desktop/node_modules/playwright-core/index.js';
import type { SandboxEntry,
     SandboxJob,
     SandboxOverview,
     } from '../../shared/plugins/sandboxes/sandboxContracts.ts';
import { clientBrowser } from './helpers/client-browser.mjs';

const baseEntry: SandboxEntry = {
    task: '990001',
    profile: 'demo-shop',
    owner: 'manual',
    slot: 0,
    fePort: 5190,
    apiPort: 8090,
    repos: [
        {
            name: 'frontend',
            branch: 'task-990001',
            path: '/workspace/worktrees/demo-shop/frontend/t990001',
        },
        {
            name: 'backend',
            branch: 'task-990001',
            path: '/workspace/worktrees/demo-shop/backend/t990001',
        },
    ],
    standAlive: true,
    feAlive: true,
    profileBinding: 'verified',
    removable: true,
    removableReason: null,
    updatedAt: '2026-10-22T09:30:00.000Z',
    actions: [{
            id: 'check',
            label: 'Проверить стенд',
            description: 'Проверка основных страниц и соединения с базой данных.',
            args: [],
            confirm: 'Запустить проверку на этом стенде?',
        }],
};
const baseJob: SandboxJob = {
    task: '990002',
    profile: 'demo-shop',
    action: 'up',
    actionId: null,
    actionLabel: null,
    state: 'running',
    index: 4,
    total: 11,
    label: 'Копируем базу данных',
    message: '',
    startedAt: '2026-10-22T09:35:00.000Z',
    finishedAt: null,
};
/**
 * Полное приложение получает синтетический обзор; POST записывается только в памяти.
 * Проверка диалогов и журналов не создаёт контейнеров и не обращается к рабочим данным.
 */
async function fixture(t: TestContext) {
    const client = await clientBrowser(t);
    const overview: SandboxOverview = {
        profiles: [{
                id: 'demo-shop',
                canRaise: true,
                reason: null,
            }],
        sandboxes: [
            structuredClone(baseEntry),
            {
                ...structuredClone(baseEntry),
                task: '990002',
                slot: 1,
                fePort: null,
                apiPort: null,
                standAlive: null,
                repos: [],
                actions: [],
                removable: false,
                removableReason: 'job_running',
            },
            {
                ...structuredClone(baseEntry),
                task: '1427',
                owner: 'pipeline',
                slot: 2,
                removable: false,
                removableReason: 'pipeline_owned',
                repos: [{
                        name: 'frontend',
                        branch: 'task-1427',
                        path: '/workspace/worktrees/demo-shop/frontend/t1427',
                    }],
                actions: [],
            },
        ],
        jobs: [structuredClone(baseJob)],
        manualRange: { from: 990000, to: 999999 },
    };
    const state = {
        overview,
        failRead: false,
        writes: [] as Array<{
            path: string;
            body: unknown;
        }>,
    };
    /**
     * Все ручки песочниц перехватываются до перехода, включая чтение после действия.
     * Ответы меняются через state, поэтому refresh проверяет настоящий store и декодер.
     */
    async function open(width = 1280, height = 900, touch = width < 500) {
        const page: Page = await client.browser.newPage({
            viewport: { width, height },
            hasTouch: touch,
            isMobile: touch,
        });
        const errors: string[] = [];

        page.setDefaultTimeout(10000);
        await page.addInitScript(() => localStorage.setItem('grigdesk-ui-language', 'ru'));
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route(/\/api\/sandboxes(?:\/[^?]*)?$/, async (route) => {
            const path = new URL(route.request().url()).pathname;

            if (route.request().method() === 'POST') {
                state.writes.push({ path, body: route.request().postDataJSON() });
                await route.fulfill({ json: { task: baseJob.task, job: baseJob } });

                return;
            }
            if (path.endsWith('/log')) {
                await route.fulfill({ json: {
                        task: baseEntry.task,
                        action: 'run',
                        state: 'done',
                        text: 'Проверка страниц: успешно.\nБаза данных: доступна.',
                        truncated: false,
                    } });

                return;
            }

            const json = { error: 'sandbox_error', message: 'Не удалось прочитать состояние песочниц.' };

            await route.fulfill(state.failRead ? { status: 503, json } : { json: state.overview });
        });
        await page.route(/\/api\/tasks(?:\/[^?]*)?(?:\?.*)?$/, async (route) => {
            const pathname = new URL(route.request().url()).pathname;
            const tasks = state.overview.sandboxes.map((stand, index) => ({
                task: stand.task,
                profile: stand.profile,
                title: `Полное название задачи ${stand.task}`,
                daemonAlive: index % 5 === 0 || index % 5 === 3,
                result: index % 5 === 4 ? 'done' : null,
                stall: index % 5 === 2 ? { kind: 'human', title: 'BUILD: нужно решение' } : null,
                silence: index % 5 === 3 ? { sec: 600, stage: 'BUILD' } : null,
            }));

            if (pathname === '/api/tasks') {
                await route.fulfill({ json: { tasks, silenceWindow: 300 } });

                return;
            }

            const task = pathname.match(/^\/api\/tasks\/(\d+)\/graph$/)?.[1];
            const index = tasks.findIndex((item) => item.task === task);
            const json = index % 5 === 1
                ? { nodes: { gate: ['gate', 'Принять результат'] }, statuses: { gate: 'wait' } }
                : { nodes: {}, statuses: {} };

            await route.fulfill({ json });
        });
        await page.route(/\/api\/b24\/task\/\d+(?:\?.*)?$/, async (route) => {
            const task = new URL(route.request().url()).pathname.split('/').at(-1)!;

            await route.fulfill({ json: {
                    id: Number(task),
                    title: `Полное название задачи ${task}`,
                    description: '<p>Синтетическая карточка задачи.</p>',
                    status_label: 'В работе',
                } });
        });
        await page.goto(`${client.origin}#/sandboxes`, { waitUntil: 'domcontentloaded' });
        await page.locator('.sandboxes > .ui-pane-header').waitFor();
        await page.getByRole('button', { name: 'Обновить песочницы' })
            .filter({ hasNot: page.locator('[aria-hidden="true"].ui-button__content') }).waitFor();

        return { page, errors };
    }

    return {
        ...client,
        state,
        open,
    };
}
/**
 * Барьеры действий работают и на исходных карточках, и на новом списке.
 * Переключатель нужен только когда рабочая область стала однопанельной.
 */
async function showList(page: Page) {
    const list = page.getByRole('button', { name: 'Список', exact: true });

    if (await list.isVisible()) {
        await list.click();
    }
}
/**
 * Выбор выполняется по номеру, без зависимости от порядка профилей.
 * В исходном виде несколько карточек уже открыты, поэтому отдельного клика нет.
 */
async function chooseStand(page: Page, task: string) {
    await showList(page);

    const row = page.locator('[data-context="workspace-catalog-row"]')
        .filter({ hasText: new RegExp(`\\bt${task}\\b`) });

    if (await row.count()) {
        await row.click();
    }
}
/**
 * Измеряется фактическая ширина списка и раскрытых секций, включая длинные пути.
 * Внутренняя вертикальная прокрутка допустима, горизонтальная у рабочей области — нет.
 */
async function geometry(page: Page) {
    return page.locator('.sandboxes').evaluate((root) => {
        const selectors = '.sandboxes__scroll, .sandbox-card, .ui-workspace-section__body';
        // Закрытый details сохраняет расчётную ширину потомков, но не рисует их.
        // Содержимое раскрытий проверяется после открытия ниже в этом же сценарии.
        const panels = [...root.querySelectorAll(selectors)]
            .filter((node) => node.checkVisibility());
        const controls = [...root.querySelectorAll('.sandboxes__filters input, .sandboxes__filters select')];
        const cards = [...root.querySelectorAll('.sandbox-card')];
        const rows = [...root.querySelectorAll('[data-context="workspace-catalog-row"]')];
        const card = cards[0]!;
        const ports = card.querySelector('.sandbox-card__ports')!.getBoundingClientRect();
        const links = [...card.querySelectorAll('.sandbox-card__ports a')]
            .map((node) => node.getBoundingClientRect());
        const run = card.querySelector('.sandbox-card__run button')!.getBoundingClientRect();
        const headings = card.querySelector('h3')!.getBoundingClientRect();
        const overflowing = panels.filter((node) => node.scrollWidth > node.clientWidth + 1)
            .map((node) => ({
            className: node.className,
            width: node.clientWidth,
            scroll: node.scrollWidth,
        }));

        return {
            fits: root.scrollWidth <= root.clientWidth + 1
                && root.getBoundingClientRect().right <= innerWidth + 1,
            panelsFit: panels.every((node) => node.scrollWidth <= node.clientWidth + 1),
            header: root.querySelector('.ui-pane-header')!.getBoundingClientRect().height,
            titleHeight: root.querySelector('h1')!.getBoundingClientRect().height,
            controls: controls.map((node) => node.getBoundingClientRect().height),
            overflowing,
            rowCount: rows.length,
            cardCount: cards.length,
            cardBorder: getComputedStyle(card).borderTopWidth,
            portsAligned: links.every((link) => link.top === links[0]!.top
                && link.height === links[0]!.height),
            portsHeight: links[0]!.height,
            runHeight: run.height,
            actionAxis: Math.abs(ports.left - run.left) < 1,
            headingAxis: Math.abs(headings.left - ports.left) < 1,
        };
    });
}

test('песочницы: геометрия списка и формы на двенадцати ширинах и в альбомном touch', async (t) => {
    const client = await fixture(t);
    const sizes = [
        [1920, 1080], [1600, 900], [1440, 900], [1280, 720], [1024, 768], [900, 700],
        [768, 1024], [600, 800], [480, 800], [390, 844], [360, 740], [320, 640], [844, 390],
    ];

    for (const [width, height] of sizes) {
        const touch = width! < 500 || height === 390;
        const { page, errors } = await client.open(width, height, touch);

        assert.equal(await page.locator('[data-context="workspace-catalog-row"]').count(),
            3,
            'Список состоит из компактных строк');
        await chooseStand(page, baseEntry.task);
        await page.locator('.sandbox-card').first().waitFor();

        const measured = await geometry(page);

        await writeFile(`${client.artifacts}/geometry-${width}.json`, JSON.stringify(measured, null, 2));
        await page.screenshot({ path: `${client.artifacts}/sandboxes-${width}.png` });
        assert.equal(measured.fits, true, `область ${width}`);
        assert.equal(measured.panelsFit,
            true,
            `содержимое ${width}: ${JSON.stringify(measured.overflowing)}`);
        assert.ok(measured.titleHeight <= 22, `заголовок остаётся в одну строку ${width}`);
        // Фильтры могут быть в скрытой панели списка; высоты там проверяются при её показе.
        // В рабочей панели измеряются только реально видимые элементы.
        assert.ok(measured.controls.every((height) => height === 0 || height === (touch ? 44 : 32)));
        assert.equal(measured.controls.length, 3);
        assert.equal(measured.rowCount, 3);
        assert.equal(measured.cardCount, 1);
        assert.equal(measured.cardBorder, '1px');
        assert.equal(measured.portsAligned, true);
        assert.equal(measured.actionAxis, true, `ось действий ${width}`);
        assert.equal(measured.headingAxis, true, `ось заголовка ${width}`);
        assert.equal(measured.portsHeight, touch ? 44 : 32);
        assert.equal(measured.runHeight, touch ? 44 : 32);

        if (width! >= 768 && !touch) {
            assert.equal(measured.header, 36);
        }

        await page.getByRole('button', { name: '+ Поднять стенд', exact: true }).click();
        await page.locator('.sandbox-raise').waitFor();

        const form = await page.locator('.sandbox-raise').evaluate((root) => {
            const fields = [...root.querySelectorAll('select, input:not([type="checkbox"])')]
                .map((node) => node.getBoundingClientRect());
            const button = root.querySelector('button[type="submit"]')!.getBoundingClientRect();

            return {
                heights: fields.map((field) => field.height),
                aligned: fields[0]!.top === fields[1]!.top || fields[0]!.left === fields[1]!.left,
                buttonHeight: button.height,
            };
        });

        assert.deepEqual(form.heights, touch ? [44, 44] : [32, 32]);
        assert.equal(form.aligned, true, `ось формы ${width}`);
        assert.equal(form.buttonHeight, touch ? 44 : 32);

        const formBesideList = await page.locator('.sandboxes').evaluate((root) => {
            if (root.getBoundingClientRect().width <= 1000) {
                return true;
            }

            const form = root.querySelector('#sandboxes-create')!.getBoundingClientRect();
            const rows = [...root.querySelectorAll('[data-context="workspace-catalog-row"]')];

            return rows.every((row) => row.getBoundingClientRect().right <= form.left);
        });

        assert.equal(formBesideList, true, 'Форма находится в рабочей колонке');
        await page.screenshot({ path: `${client.artifacts}/sandboxes-create-${width}.png` });
        await page.getByRole('button', { name: 'Профиль: Подсказка' }).click();
        await page.getByRole('tooltip').filter({ hasText: 'Профиль определяет проект' }).waitFor();
        await page.screenshot({ path: `${client.artifacts}/sandboxes-help-${width}.png` });
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Скрыть форму', exact: true }).click();
        await page.locator('.sandbox-card__details > summary').first().click();
        await page.locator('.sandbox-card__removal > summary').first().click();
        await page.locator('.sandbox-card__actions').first().scrollIntoViewIfNeeded();
        assert.equal((await geometry(page)).panelsFit, true, `раскрытые секции ${width}`);
        await page.screenshot({ path: `${client.artifacts}/sandboxes-details-${width}.png` });
        assert.deepEqual(errors, []);
        await page.close();
    }
});
test('песочницы: ввод переживает сворачивание, подъём и снос требуют подтверждения', async (t) => {
    const client = await fixture(t);
    const { page, errors } = await client.open();

    await page.getByRole('button', { name: '+ Поднять стенд', exact: true }).click();
    await page.getByText('Без привязки к задаче', { exact: true }).click();
    await page.getByRole('textbox', { name: 'Номер задачи', exact: true }).fill('12345');
    await page.getByRole('button', { name: 'Скрыть форму', exact: true }).click();
    await page.getByRole('button', { name: '+ Поднять стенд', exact: true }).click();
    assert.equal(await page.getByRole('textbox',
        { name: 'Номер задачи',
        exact: true }).inputValue(),
        '12345');
    await page.getByRole('button', { name: 'Поднять стенд', exact: true }).click();
    assert.equal(client.state.writes.length, 0);
    await Promise.all([
        page.waitForResponse((response) => response.request().method() === 'POST'),
        page.getByRole('dialog').getByRole('button', { name: 'Поднять', exact: true }).click(),
    ]);
    assert.deepEqual(client.state.writes[0], {
        path: '/api/sandboxes',
        body: { profile: 'demo-shop', task: '12345' },
    });
    await chooseStand(page, baseEntry.task);
    await page.locator('.sandbox-card__removal > summary').first().click();
    await page.getByRole('button', { name: 'Снести стенд', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Отмена', exact: true }).click();
    assert.equal(client.state.writes.length, 1);
    await page.getByRole('button', { name: 'Снести вместе с изменениями', exact: true }).click();
    await Promise.all([
        page.waitForResponse((response) => response.request().method() === 'POST'),
        page.getByRole('dialog').getByRole('button', { name: 'Снести', exact: true }).click(),
    ]);
    assert.deepEqual(client.state.writes[1], { path: '/api/sandboxes/990001/down', body: { force: true } });
    assert.deepEqual(errors, []);
});
test('песочницы: ошибка чтения, повтор, пустое состояние и исчезнувший профиль', async (t) => {
    const client = await fixture(t);

    client.state.failRead = true;
    client.state.overview.sandboxes = [];
    client.state.overview.jobs = [];

    const { page, errors } = await client.open(390);

    await page.getByRole('alert').filter({ hasText: 'Не удалось прочитать' }).waitFor();
    assert.equal(await page.locator('.sandbox-raise').isVisible(), false);
    assert.equal(await page.getByText('Стендов пока нет.', { exact: false }).count(), 0);
    client.state.failRead = false;
    await page.getByRole('button', { name: 'Обновить песочницы' }).click();
    await page.locator('.sandbox-raise').waitFor();
    assert.equal(await page.getByRole('combobox',
        { name: 'Профиль',
        exact: true }).inputValue(),
        'demo-shop');
    await page.screenshot({ path: `${client.artifacts}/sandboxes-empty.png` });
    client.state.overview.profiles = [];
    await page.getByRole('button', { name: 'Обновить песочницы' }).click();
    await page.getByRole('alert').filter({ hasText: 'Нет профилей' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Поднять стенд', exact: true })
        .getAttribute('aria-disabled'), 'true');
    assert.deepEqual(errors, []);
});
test('песочницы: фильтры, журнал и длинные данные в узком доке desktop', async (t) => {
    const client = await fixture(t);
    const entry = client.state.overview.sandboxes[0]!;

    entry.profile = 'профиль_с_длинным_названием_'.repeat(5);
    entry.repos[0]!.branch = 'ветка_проверки_'.repeat(15);
    entry.repos[0]!.path = '/workspace/' + 'очень_длинная_папка_'.repeat(15);
    entry.actions![0]!.label = 'Проверить_все_сценарии_'.repeat(10);
    client.state.overview.jobs.push({
        ...baseJob,
        task: entry.task,
        action: 'run',
        state: 'done',
        message: 'Проверка завершена',
    });

    const { page, errors } = await client.open();

    await page.locator('.sandboxes').evaluate((root) => {
        (root as HTMLElement).style.width = '600px';
    });
    await page.getByRole('searchbox', { name: 'Поиск стенда' }).fill('t990001');
    await page.getByText('Найдено: 1 из 3', { exact: true }).waitFor();
    await chooseStand(page, baseEntry.task);
    await page.locator('.sandbox-card__details > summary').click();
    await page.getByRole('button', { name: 'Журнал задания', exact: true }).click();
    await page.getByText('Проверка страниц: успешно.', { exact: false }).waitFor();
    assert.equal((await geometry(page)).panelsFit, true);
    await page.screenshot({ path: `${client.artifacts}/sandboxes-narrow-dock.png` });
    await showList(page);
    await page.getByRole('combobox', { name: 'Какие стенды показать' }).selectOption('pipeline');
    await page.getByText('Подходящих стендов нет.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Сбросить', exact: true }).click();

    const rows = page.locator('[data-context="workspace-catalog-row"]');

    assert.equal(await rows.count() || await page.locator('.sandbox-card').count(), 3);
    assert.deepEqual(errors, []);
});
test('десять стендов двух профилей помещаются на 1600x1000', async (t) => {
    const client = await fixture(t);

    client.state.overview.sandboxes = Array.from({ length: 10 }, (_, index) => ({
        ...structuredClone(baseEntry),
        task: String(100 + index),
        profile: index < 5 ? 'demo-shop' : 'demo-tools',
        owner: 'pipeline',
        slot: index % 5,
        removable: false,
        removableReason: 'pipeline_owned',
    }));
    client.state.overview.jobs = [];

    const { page, errors } = await client.open(1600, 1000, false);
    const rows = page.locator('[data-context="workspace-catalog-row"]');

    assert.equal(await rows.count(), 10, 'Десять стендов представлены десятью короткими строками');
    await page.getByText('Полное название задачи 100', { exact: false }).first().waitFor();

    const measured = await rows.evaluateAll((nodes) => {
        const rects = nodes.map((node) => node.getBoundingClientRect());
        let catalog = nodes[0]!.parentElement!;

        while (!nodes.every((node) => catalog.contains(node))) {
            catalog = catalog.parentElement!;
        }

        const bounds = catalog.getBoundingClientRect();
        const documentScroll = document.scrollingElement!;
        const card = document.querySelector('.sandbox-card')!.getBoundingClientRect();

        return {
            count: rects.length,
            allInside: rects.every((rect) => rect.top >= bounds.top && rect.bottom <= bounds.bottom + 1),
            inViewport: rects.every((rect) => rect.top >= 0 && rect.bottom <= innerHeight),
            listFits: catalog.scrollHeight <= catalog.clientHeight + 1,
            pageFits: documentScroll.scrollHeight <= documentScroll.clientHeight + 1,
            separateColumns: rects.every((rect) => rect.right <= card.left),
            distinctRows: rects.slice(1).every((rect, index) => rect.top >= rects[index]!.bottom),
        };
    });

    await writeFile(`${client.artifacts}/ten-rows.json`, JSON.stringify(measured, null, 2));
    await page.screenshot({ path: `${client.artifacts}/ten-rows.png` });
    assert.deepEqual(measured, {
        count: 10,
        allInside: true,
        inViewport: true,
        listFits: true,
        pageFits: true,
        separateColumns: true,
        distinctRows: true,
    });
    await page.getByRole('link', { name: 'Открыть задачу', exact: true }).first().click();

    const modal = page.locator('[data-role="task-modal"]');

    await modal.waitFor();
    assert.match(await modal.innerText(), /Полное название задачи 100/);
    assert.match(await modal.innerText(), /100/);
    assert.deepEqual(errors, []);
});
test('список и стенд переключаются по контейнеру', async (t) => {
    const client = await fixture(t);

    for (const [width, height, dock] of [[900, 800, false], [1600, 1000, true],
        [390, 844, false], [844, 390, false]] as const) {
        const { page, errors } = await client.open(width, height, width === 390 || height === 390);

        if (dock) {
            await page.locator('.sandboxes').evaluate((root) => {
                (root as HTMLElement).style.width = '600px';
            });
        }

        const list = page.getByRole('button', { name: 'Список', exact: true });
        const detail = page.getByRole('button', { name: 'Стенд', exact: true });

        assert.equal(await list.count(), 1, 'Есть переключатель списка по ширине контейнера');
        assert.equal(await list.isVisible(), true);
        await list.click();
        assert.equal(await list.getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('[data-context="workspace-catalog-row"]').first().isVisible(), true);
        assert.equal(await page.locator('.sandbox-card').isVisible(), false);
        await chooseStand(page, baseEntry.task);
        assert.equal(await detail.getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('.sandbox-card').isVisible(), true);
        assert.equal(await page.locator('[data-context="workspace-catalog-row"]').first().isVisible(), false);
        await page.getByRole('button', { name: '+ Поднять стенд', exact: true }).click();
        await page.getByText('Без привязки к задаче', { exact: true }).click();
        await page.getByRole('textbox', { name: 'Номер задачи', exact: true }).fill('12345');
        await list.click();
        await detail.click();
        assert.equal(await page.getByRole('textbox',
            { name: 'Номер задачи',
            exact: true }).inputValue(),
            '12345');
        await page.getByRole('button', { name: 'Скрыть форму', exact: true }).click();
        await page.locator('.sandboxes').evaluate((root) => {
            (root as HTMLElement).style.width = '';
        });
        await page.setViewportSize({ width: 1600, height: 1000 });
        assert.equal(await page.locator('[data-context="workspace-catalog-row"]').first().isVisible(), true);
        assert.equal(await page.locator('.sandbox-card').isVisible(), true);
        assert.equal(await list.isVisible(), false);
        assert.deepEqual(errors, []);
        await page.close();
    }
});
