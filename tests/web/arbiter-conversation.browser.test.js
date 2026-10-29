import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { arbiterConversationBrowser } from '../helpers/arbiterConversationBrowser.js';

test('остановка → поток → F5 → обсуждение → диагностика → apply → resume-only → новый исход',
  { timeout: 120_000 }, async (t) => {
    const fx = await arbiterConversationBrowser(t);
    const { page } = fx;

    await page.goto(fx.url);
    await page.locator('[data-role="arbiter-start"]').click();
    await page.getByText('Читаю сведения о текущей остановке.', { exact: true }).waitFor();
    assert.equal(fx.gotoCalls(), 0);
    fx.releaseFirst();
    await page.getByRole('heading', { name: 'Известно, где остановилась проверка?' }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: 'Известно, где остановилась проверка?' }).waitFor();
    assert.equal(await page.getByText('Читаю сведения о текущей остановке.', { exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Пока неизвестно', exact: true }).click();
    await page.locator('[data-role="arbiter-diagnose"]:not([disabled])').waitFor();
    assert.equal(fx.gotoCalls(), 0);
    await page.locator('[data-role="arbiter-diagnose"]').click();
    await page.getByText(/В журнале задачи видно ожидание ответа тестового сервиса/).waitFor();
    await page.locator('[data-role="arbiter-apply"]:not([disabled])').waitFor();
    assert.equal(fx.gotoCalls(), 0);
    await page.screenshot({ path: path.join(fx.artifacts, 'dialog-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 380, height: 820 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(fx.artifacts, 'dialog-mobile.png'), fullPage: true });

    const other = await fx.browserContext.newPage();

    await other.goto(fx.url);
    await other.locator('[data-role="arbiter-apply"]:not([disabled])').waitFor();
    await Promise.allSettled([
      page.locator('[data-role="arbiter-apply"]').click(),
      other.locator('[data-role="arbiter-apply"]').click(),
    ]);
    await page.locator('[data-role="arbiter-resume"]').waitFor();
    assert.equal(fx.gotoCalls(), 1);
    assert.equal(fx.resumeCalls(), 1);
    assert.match(await page.locator('[data-role="arbiter-conversation"]').innerText(), /принято.*не запущен/);
    await page.locator('[data-role="arbiter-resume"]').click();
    await page.getByText(/Этап запущен повторно; результат ещё ожидается/).waitFor();
    assert.equal(fx.gotoCalls(), 1);
    assert.equal(fx.resumeCalls(), 2);

    const saved = (await fx.store.list('7'))[0];
    const apply = saved.operations.find((operation) => operation.kind === 'apply');
    const resume = saved.operations.find((operation) => operation.kind === 'resume');

    assert.equal(resume.applyOperationId, apply.id);
    assert.deepEqual(resume.acceptedEvent, apply.receipt.stage);

    await fx.call('attempt_stage_state_commit_v2', '7', fx.attempt, 'instrument', 'done');
    fx.broadcast('state-change', {});
    await page.getByText(/Этап завершён, конвейер продолжает работу/).waitFor();
    await fx.stopAgain();
    fx.broadcast('state-change', {});
    await page.getByRole('button', { name: 'Открыть текущую остановку', exact: true }).click();
    await page.locator('[data-role="arbiter-start"]').waitFor();
    fx.failNext('invalid');
    await page.locator('[data-role="arbiter-start"]').click();
    await page.getByText(/Разбор не завершён; сохранено то, что удалось получить/).waitFor();
    await page.locator('[data-role="arbiter-analysis-failure"]').waitFor();
    assert.equal(await page.locator('.ac-decision-empty').count(), 0);
    assert.equal(await page.locator('[data-role="arbiter-apply"]').count(), 0);
    await page.screenshot({ path: path.join(fx.artifacts, 'analysis-failure-mobile.png'), fullPage: true });

    const retryBox = await page.locator('[data-role="arbiter-start"]').boundingBox();

    assert.equal(retryBox !== null && retryBox.y >= 0 && retryBox.y + retryBox.height <= 820, true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(fx.artifacts, 'analysis-failure-desktop.png'), fullPage: true });
    fx.failNext('timeout');
    await page.locator('[data-role="arbiter-start"]').click();
    await page.locator('[data-role="arbiter-analysis-failure"]')
      .getByText('Истёк лимит времени разбора.', { exact: true }).waitFor();
    assert.equal(fx.gotoCalls(), 1);
    await page.goto(`${fx.url}/?lang=en`);
    await page.getByRole('heading', { name: 'Stop analysis', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Retry analysis', exact: true }).waitFor();
    await other.close();
    assert.deepEqual(fx.errors, []);
  });
