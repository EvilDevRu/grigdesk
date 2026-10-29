import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { extraProps, extraPorts } from './fixtures/loading/extraCases.mjs';
import { frames, startLoadingBrowser } from './fixtures/loading/browser.mjs';

let browser;
let cleanup;

before(async () => {
    browser = await startLoadingBrowser({ after: (callback) => {
            cleanup = callback;
        } });
});
after(async () => {
    await cleanup?.();
});

for (const width of [1280, 390, 899, 900, 1099, 1100]) {
    test(`LOAD-GEO-chat-${width}: каркас занимает области настоящей переписки`, async (t) => {
        const h = await browser.open(t, { viewport: {
          width,
          height: width === 390 ? 844 : 800
        } });

        assert.deepEqual(h.errors, []);
        assert.deepEqual(h.unexpected, []);

        const pendingBricks = await h.page.locator('.cl [data-ui-skeleton]').count();

        if (width < 900) {
            const stageVisible = await h.page.locator('.stage').isVisible();

            await h.page.evaluate(() => window.loadingFixture.ready());
            await frames(h.page);
            assert.deepEqual(h.errors, []);
            assert.deepEqual(h.unexpected, []);
            assert.equal(stageVisible, false, 'на телефоне стартует только список');
            assert.ok(pendingBricks > 0, 'список использует общие кирпичики');

            return;
        }

        const pairs = [
            ['.cl', '.cl', ['x', 'width']],
            ['.chat-loading-preview [data-loading-region="header"]', '.cs-top', ['y', 'height']],
            ['.chat-loading-preview [data-loading-region="body"]', '.cs-body', ['x', 'width']],
            ['.chat-loading-preview [data-loading-region="input"]', '.cs-input', ['y', 'height']],
            [
                '.chat-loading-preview [data-loading-region="composer"]',
                '[data-role="chat-composer"]',
                ['height']
            ],
        ];
        const pending = [];

        for (const [selector] of pairs) {
            const locator = h.page.locator(selector);
            const rect = await locator.count() ? await locator.boundingBox() : null;

            pending.push(rect);
        }

        await h.page.evaluate(() => window.loadingFixture.ready());
        await frames(h.page);
        assert.deepEqual(h.errors, []);
        assert.deepEqual(h.unexpected, []);

        const measurements = [];

        for (const [index, [loading, ready, dimensions]] of pairs.entries()) {
            const rect = await h.page.locator(ready).boundingBox();

            assert.ok(rect, `видна настоящая область ${ready}`);
            assert.ok(pendingBricks > 0, 'список использует общие кирпичики');
            assert.ok(pending[index], `видна область каркаса ${loading}`);

            for (const dimension of dimensions) {
                assert.ok(
                    Math.abs(rect[dimension] - pending[index][dimension]) <= 4,
                    `${loading} → ${ready}: ${dimension} ${pending[index][dimension]} → ${rect[dimension]}`
                );
            }

            measurements.push({
                loading,
                ready,
                pending: pending[index],
                readyRect: rect
            });
        }

        assert.equal(await h.page.locator('[data-ui-skeleton]').count(), 0);
        assert.equal(
            await h.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true
        );
        await writeFile(`${h.artifacts}/chat-${width}.json`, JSON.stringify(measurements, null, 2));
    });
}
for (const height of [160, 10000]) {
    test(`LOAD-PREFS-chat-${height}: сохранённые ширина и высота действуют до ответа`, async (t) => {
        const h = await browser.open(t, {
            storage: {
              'grigdesk-chats-list-width': '360',
              'grigdesk-chat-composer-h': String(height)
            },
        });
        const list = await h.page.locator('.cl').boundingBox();

        assert.ok(list);
        assert.equal(Math.round(list.width), 360);
        assert.ok(await h.page.locator('.chat-loading-preview [data-ui-skeleton]').count() > 0);

        const pending = await h.page.locator('[data-loading-region="composer"]').boundingBox();

        assert.ok(pending);
        await h.page.evaluate(() => window.loadingFixture.ready());
        await frames(h.page);

        const ready = await h.page.locator('[data-role="chat-composer"]').boundingBox();

        assert.ok(ready);
        assert.ok(Math.abs(pending.height - ready.height) <= 4);
        assert.ok(Math.abs(ready.height - Math.min(height, 368)) <= 1);
        assert.deepEqual(h.errors, []);
        assert.deepEqual(h.unexpected, []);
    });
}

test('LOAD-MOTION: три формы имеют одну пульсацию, в том числе внутри transform', async (t) => {
    const h = await browser.open(t, { mode: 'kit' });
    const bricks = h.page.locator('[data-ui-skeleton]');

    assert.equal(await bricks.count(), 3, 'публичные формы созданы');

    const defaultSizes = await bricks.evaluateAll((elements) => elements.map((element) => {
        const rect = element.getBoundingClientRect();

        return {
          width: rect.width,
          height: rect.height,
          radius: getComputedStyle(element).borderRadius
        };
    }));

    assert.equal(defaultSizes[0].height, 8);
    assert.equal(defaultSizes[1].height, 64);
    assert.equal(defaultSizes[2].width, 32);
    assert.equal(defaultSizes[2].height, 32);
    assert.ok(Number.parseFloat(defaultSizes[2].radius) >= 16, 'кружок имеет круглый контур');

    for (const transformed of [false, true]) {
        await h.page.evaluate((value) => {
            window.loadingFixture.state.transformed = value;
        }, transformed);
        await frames(h.page);

        const motion = await bricks.evaluateAll((elements) => elements.map((element) => {
            const style = getComputedStyle(element);
            const animation = element.getAnimations()[0];

            if (!animation) {
                return {
                    name: style.animationName,
                    duration: style.animationDuration,
                    opacity: []
                };
            }

            animation.pause();
            animation.currentTime = 0;

            const first = getComputedStyle(element).opacity;

            animation.currentTime = 1200;

            return {
                name: style.animationName,
                duration: style.animationDuration,
                opacity: [first, getComputedStyle(element).opacity],
            };
        }));

        assert.equal(new Set(motion.map((item) => item.name)).size, 1);
        assert.notEqual(motion[0].name, 'none');
        assert.ok(motion.every((item) => item.duration === '2.4s'));
        assert.ok(
            motion.every((item) => item.opacity.length === 2 && item.opacity[0] !== item.opacity[1])
        );
    }
});
test('LOAD-REDUCE: уменьшение движения останавливает блоки без изменения размеров', async (t) => {
    const h = await browser.open(t, { mode: 'kit' });
    const bricks = h.page.locator('[data-ui-skeleton]');

    assert.equal(await bricks.count(), 3, 'публичные формы созданы');

    const before = await bricks.evaluateAll((elements) => elements.map((element) => {
        const rect = element.getBoundingClientRect();

        return {
          width: rect.width,
          height: rect.height
        };
    }));

    await h.page.emulateMedia({ reducedMotion: 'reduce' });
    await frames(h.page);

    const reduced = await bricks.evaluateAll((elements) => elements.map((element) => ({
        animation: getComputedStyle(element).animationName,
        opacity: getComputedStyle(element).opacity,
    })));

    await frames(h.page);
    assert.ok(reduced.every((item) => item.animation === 'none'));
    assert.deepEqual(await bricks.evaluateAll((elements) => elements.map((element) => ({
        animation: getComputedStyle(element).animationName,
        opacity: getComputedStyle(element).opacity,
    }))), reduced);
    assert.deepEqual(await bricks.evaluateAll((elements) => elements.map((element) => {
        const rect = element.getBoundingClientRect();

        return {
          width: rect.width,
          height: rect.height
        };
    })), before);
    await h.page.emulateMedia({ reducedMotion: 'no-preference' });
    await frames(h.page);
    assert.ok(
        await bricks.evaluateAll(
        (elements) => elements.every((element) => getComputedStyle(element).animationName !== 'none')
    )
    );
});

const surfaceGeometry = [
    ...[...extraProps, ...extraPorts].map((item) => [item.id, ...item.geometry]),
    ['projects-list', 'row', '[data-role="project-row"]', ['x', 'width', 'height']],
    ['settings-mcp', 'row', '.mcprow', ['x', 'width', 'height']],
    ['document-file', 'metadata', '.document-meta', ['y', 'height']],
    ['pipeline-deferred', 'row', '[data-role="pipeline-deferred-findings"] li', ['x', 'width']],
    ['docker-containers', 'row', '.docker-row', ['x', 'width', 'height']],
    ['docker-usage', 'table', '.docker-usage', ['x', 'width']],
    ['studio3d-library', 'tile', '[data-context="studio-model-card"]', ['x', 'width', 'height']],
];

for (const [id, region, readySelector, dimensions] of surfaceGeometry) {
    for (const width of [1280, 390]) {
        test(`LOAD-GEO-${id}-${width}: сравнение с настоящим ready DOM`, async (t) => {
            const h = await browser.open(t, {
              mode: id,
              viewport: {
              width,
              height: 844
            }
            });

            assert.deepEqual(h.errors, []);
            assert.deepEqual(h.unexpected, []);

            const brickCount = await h.page.locator('[data-ui-skeleton]').count();
            const loadingSelector = `[data-loading-region="${region}"]`;
            const locator = h.page.locator(loadingSelector).first();
            const pending = await locator.count() ? await locator.boundingBox() : null;

            await h.release();
            await h.page.evaluate(() => window.loadingFixture.ready());
            await h.page.locator(readySelector).first().waitFor({ state: 'visible' });
            await frames(h.page);

            const ready = await h.page.locator(readySelector).first().boundingBox();

            assert.ok(ready);
            assert.deepEqual(h.errors, []);
            assert.deepEqual(h.unexpected, []);

            if (id === 'docker-usage') {
                assert.equal(await h.page.locator('.docker-panel').evaluate((element) =>
                    getComputedStyle(element).containerName), 'docker-panel',
                'уборка измеряется в настоящем контейнере DockerPanel');
            }

            assert.ok(brickCount > 0, `${id}: есть общие кирпичики`);
            assert.ok(pending, `измеряемая область ${loadingSelector} видна`);

            for (const dimension of dimensions) {
                assert.ok(Math.abs(pending[dimension] - ready[dimension]) <= 4,
                    `${id}: ${dimension} ${pending[dimension]} → ${ready[dimension]}`);
            }

            assert.equal(await h.page.locator('[data-ui-skeleton]').count(), 0);
            assert.deepEqual(h.errors, []);
            assert.deepEqual(h.unexpected, []);
            assert.equal(
                await h.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
                true
            );
            await writeFile(`${h.artifacts}/${id}-${width}.json`, JSON.stringify({
                loadingSelector,
                readySelector,
                pending,
                ready,
                viewport: {
                  width,
                  height: 844
                },
            }, null, 2));
        });
    }
}

test('LOAD-GALLERY: примеры форм, раскладок и композиции доступны в настоящей галерее', async (t) => {
    const h = await browser.open(t, { mode: 'gallery' });

    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.unexpected, []);

    for (const id of [
        'line', 'block', 'circle', 'list', 'form', 'text', 'chat', 'columns', 'show-label', 'reduce',
    ]) {
        assert.equal(await h.page.locator(`[data-loading-example="${id}"]`).count(), 1,
            `галерея содержит пример ${id}`);
    }
});

test('LOAD-A11Y: подпись объявляется без занимаемого места, пояснение видно', async (t) => {
    const h = await browser.open(t, { mode: 'kit' });
    const label = h.page.locator('.ui-loading-state__label');
    const status = h.page.locator('[role="status"]');

    assert.equal(await status.count(), 1);
    assert.match(await status.textContent(), /Загрузка/);

    const hidden = await label.evaluate((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();

        return (rect.width <= 1 && rect.height <= 1)
            || (style.position === 'absolute' && (style.clip !== 'auto' || style.clipPath !== 'none'));
    });

    assert.equal(hidden, true, 'обычная подпись скрыта визуально');

    const description = await h.page.locator('.ui-loading-state__description').boundingBox();

    assert.ok(description && description.width > 1 && description.height > 1);
    assert.equal(await h.page.locator('[role="progressbar"]').count(), 0);
});

for (const width of [1280, 390]) {
  test(`LOAD-GEO-inbox-structure-${width}: шапка, вкладки и карточка совпадают с очередью`, async (t) => {
    const h = await browser.open(t, { mode: 'inbox', viewport: { width, height: 844 } });
    const pairs = [
      ['header', '.queue-head', ['y', 'height']],
      ['tabs', '.section-tabs', ['x', 'width', 'height']],
      ['card', '.item-card', ['x', 'width']],
    ];
    const pending = [];

    for (const [region] of pairs) {
      const locator = h.page.locator(`[data-loading-region="${region}"]`).first();

      pending.push(await locator.count() ? await locator.boundingBox() : null);
    }

    const bricks = await h.page.locator('[data-ui-skeleton]').count();

    await h.release();
    await h.page.evaluate(() => window.loadingFixture.ready());
    await h.page.locator('.item-card').waitFor({ state: 'visible' });
    await frames(h.page);
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.unexpected, []);
    assert.equal(await h.page.locator('[data-ui-loading]').count(), 0);
    assert.ok(bricks > 0, 'очередь показывает свой каркас');

    for (const [index, [region, selector, dimensions]] of pairs.entries()) {
      const ready = await h.page.locator(selector).first().boundingBox();

      assert.ok(pending[index] && ready, `видны обе области ${region}`);

      for (const dimension of dimensions) {
        assert.ok(Math.abs(pending[index][dimension] - ready[dimension]) <= 4,
          `очередь/${region}: ${dimension} совпадает с допуском 4px`);
      }
    }
  });
}
