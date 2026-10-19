import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { clientBrowser, scaleClientText } from './helpers/client-browser.mjs';

/**
 * Состояние вопроса меняется только в синтетическом Pinia экземпляре текущего документа.
 * Компоненты, UI-kit, router и настоящая геометрия Chromium остаются без подмен.
 */
async function pending(page, request) {
  await page.evaluate((value) => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;

    pinia._s.get('chat').pending = value ? { [value.pid]: value } : {};
  }, request);
}

test('телефон: чат, вложения, полный вопрос, разрешение и карточка задачи', {
  timeout: 120000,
}, async (t) => {
  const { browser, origin, artifacts } = await clientBrowser(t);

  for (const [width, height] of [[390, 844], [360, 740]]) {
    const context = await browser.newContext({
        viewport: { width, height },
        hasTouch: true,
        reducedMotion: 'reduce',
      });
    const page = await context.newPage();

    try {
      await page.goto(origin + '#/chats');
      await page.locator('.cl .row-hit').first().click();
      await page.locator('.cs-input').waitFor();
      assert.equal(await page.locator('.cl').isVisible(), false);
      assert.equal(await page.getByRole('button', { name: 'Приложить файл', exact: true }).isVisible(), true);
      await page.locator('textarea[data-role="chat-composer"]').fill('Черновик телефона');
      await page.getByRole('button', { name: 'К списку чатов', exact: true }).click();
      assert.equal(await page.locator('.cl').isVisible(), true);
      assert.equal(await page.locator('.cs-input').isVisible(), false);
      await page.locator('.cl .row-hit').first().click();
      assert.equal(await page.locator('textarea[data-role="chat-composer"]').inputValue(),
        'Черновик телефона');

      await pending(page, {
        pid: 'question-fixture',
        kind: 'question',
        chatKey: 'geometry-chat',
        questions: [{
          question: 'Полный_вопрос_'.repeat(30) + 'КОНЕЦ',
          options: [{ label: 'Первый вариант' }],
        }],
      });
      await page.locator('.q').waitFor();
      await scaleClientText(page, 1.3);

      const question = await page.locator('.q').evaluate((element) => ({
        width: element.clientWidth,
        scroll: element.scrollWidth,
        text: element.textContent,
      }));

      assert.ok(question.text.includes('КОНЕЦ'));
      assert.ok(question.scroll <= question.width + 1,
        `Вопрос обрезан: ${question.scroll}/${question.width}`);
      await page.screenshot({
        animations: "disabled",
        path: path.join(artifacts, `phone-question-${width}.png`),
      });
      await pending(page, {
        pid: 'permission-fixture',
        kind: 'perm',
        chatKey: 'geometry-chat',
        tool: 'Bash',
        input: { command: 'long_command_'.repeat(800) + 'КОНЕЦ' },
      });
      await page.locator('.perm').waitFor();
      await scaleClientText(page, 1.3, '.perm');

      const permission = await page.locator('.perm').evaluate((element) => ({
        width: element.clientWidth,
        scroll: element.scrollWidth,
        text: element.textContent,
      }));

      assert.ok(permission.text.includes('КОНЕЦ'));
      assert.ok(permission.scroll <= permission.width + 1);
      assert.equal(await page.getByRole('button', { name: 'Разрешить', exact: true }).isVisible(), true);
      await page.screenshot({
        animations: "disabled",
        path: path.join(artifacts, `phone-permission-${width}.png`),
      });
      await pending(page, null);
      await page.goto(origin + '#/board');
      await page.locator('[data-context="board-task"]').first().waitFor();
      await scaleClientText(page, 1.3);
      await page.locator('[data-context="board-task"]').first().click();
      await page.getByRole('heading', { name: 'Задача для узкого экрана', exact: true }).waitFor();
      await scaleClientText(page, 1.3, '[data-role="task-modal"]');
      assert.match(await page.locator('#task-modal-title').textContent(), /Задача для узкого экрана/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth
        <= document.documentElement.clientWidth + 1), true);
      await page.screenshot({
        animations: "disabled",
        path: path.join(artifacts, `phone-task-${width}.png`),
      });
    } finally {
      await context.close();
    }
  }
});
