import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { startLoadingBrowser } from './fixtures/loading/browser.mjs';

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
test('LOAD-KEEP-work: операция сохраняет spinner и доступный численный progress', async (t) => {
    const h = await browser.open(t, { mode: 'work' });

    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.unexpected, []);
    assert.equal(await h.page.locator('.ui-spinner').count(), 1);
    assert.equal(await h.page.locator('[data-ui-skeleton]').count(), 0);
    assert.equal(await h.page.locator('[role="progressbar"]').getAttribute('aria-valuenow'), '3');
    assert.equal(await h.page.locator('[role="progressbar"]').getAttribute('aria-valuemax'), '7');
    assert.equal(
        await h.page.locator('[role="progressbar"]').getAttribute('aria-label'),
        'Передача модели'
    );
});

for (const [id, value, expected] of [
    ['default', null, null],
    ['empty', '', null],
    ['invalid', 'NaN', null],
    ['blocked', 'blocked', null],
    ['saved', '160', 160],
    ['ceiling', '10000', 368],
]) {
    test(`LOAD-KEEP-composer-${id}: настоящий ввод читает прежний device-key`, async (t) => {
        const storage = value === null ? {} : { 'grigdesk-chat-composer-h': value };
        const h = await browser.open(t, {
            mode: 'composer',
            storage,
            blockedStorage: id === 'blocked'
        });
        const input = h.page.locator('[data-role="chat-composer"]');

        assert.deepEqual(h.errors, []);
        assert.deepEqual(h.unexpected, []);
        assert.equal(await input.count(), 1, 'измеряется настоящий ChatSession');

        const rect = await input.boundingBox();

        assert.ok(rect, 'настоящий ввод виден');

        const style = await input.evaluate((element) => ({
            minimum: getComputedStyle(element).minHeight,
            maximum: getComputedStyle(element).maxHeight,
            chosen: getComputedStyle(element).getPropertyValue('--composer-h').trim(),
        }));

        assert.equal(style.minimum, '48px');
        assert.equal(style.maximum, '368px');

        if (expected === null) {
            assert.equal(style.chosen, '', 'неверная настройка оставляет естественную высоту CSS');
            assert.ok(rect.height >= 48 && rect.height <= 368);
        }
        else {
            assert.ok(
                Math.abs(rect.height - expected) <= 1,
                `${id}: высота ${rect.height}, ожидается ${expected}`
            );
        }

        await h.page.screenshot({ path: `${h.artifacts}/composer-${id}.png` });
    });
}
