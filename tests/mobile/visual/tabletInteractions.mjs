import assert from 'node:assert/strict';
import path from 'node:path';

import { inspectFrame } from './rules.mjs';

/**
 * Проверяет две колонки, движение кольца и возврат к черновику на планшете.
 * Уменьшение viewport моделирует клавиатуру, сохраняя размер screen устройства.
 */
export async function tabletInteractions(page, { width, height, directory }) {
  const list = page.locator('.split-list');
  const detail = page.locator('.split-detail');
  const left = await list.boundingBox();
  const right = await detail.boundingBox();

  assert.ok(left.width >= 200 && right.width >= 350, 'Обе колонки доступны на планшете');
  assert.ok(right.x >= left.x + left.width - 1, 'Колонки стоят рядом');

  const listHead = await page.locator('.chat-list-head').boundingBox();
  const chatHead = await page.locator('.chat-pane > .pane-head').boundingBox();

  assert.ok(listHead.height <= 108, 'Архив и поиск не раздувают шапку списка');
  assert.ok(chatHead.height <= 180, 'Настройки помещаются в компактную шапку');
  assert.ok(await page.locator('.row-model').first().isVisible(), 'Модель видна и в узком списке');
  assert.equal(await page.locator('.row-title').first().evaluate((node) => getComputedStyle(node).whiteSpace),
    'nowrap', 'Название чата занимает одну строку');
  assert.equal(await page.locator('.nav-badge').count(), 2, 'В рейке видны серверные индикаторы');
  assert.ok(await page.locator('.chat-context').isVisible(), 'Контекст доступен из шапки');
  assert.equal(await page.locator('.split-list .list-filters,.split-list .list-count').count(), 0);
  assert.equal(await page.getByRole('switch', { name: 'Показывать архив', exact: true }).count(), 1);

  const arc = page.locator('.chat-live-arc').first();
  const before = await arc.evaluate((element) => getComputedStyle(element).transform);

  await page.waitForTimeout(120);
  assert.notEqual(await arc.evaluate((element) => getComputedStyle(element).transform), before);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await arc.evaluate((element) => getComputedStyle(element).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Черновик с планшета');
  await page.getByRole('navigation').getByRole('link', { name: 'Настройки', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: 'Чаты', exact: true }).click();
  await page.getByRole('link', { name: 'Дизайн мобильного Кокпита', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.composer-input')?.value === 'Черновик с планшета',
  );

  await page.getByRole('button', { name: 'Вид чата', exact: true }).click();
  await page.getByRole('switch', { name: 'Показывать список чатов', exact: true }).click();
  await page.getByRole('slider', { name: 'Высота поля ввода', exact: true }).focus();
  await page.keyboard.press('End');
  assert.deepEqual(await page.evaluate(inspectFrame), []);
  await page.getByRole('button', { name: 'Применить', exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(await list.isVisible(), false, 'Список можно свернуть из самого разговора');
  await page.reload();
  await page.waitForSelector('.composer-input');
  assert.equal(await list.isVisible(), false, 'Выбранная раскладка переживает перезагрузку');
  assert.deepEqual(await page.evaluate(inspectFrame), []);
  await page.screenshot({ path: path.join(directory, 'chat-tablet-focus.png') });
  await page.getByRole('button', { name: 'Вид чата', exact: true }).click();
  await page.getByRole('button', { name: 'Обычный вид', exact: true }).click();
  await page.getByRole('slider', { name: 'Ширина списка', exact: true }).focus();
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: 'Применить', exact: true }).click();
  await page.waitForTimeout(100);
  assert.ok((await list.boundingBox()).width <= left.width, 'Ширина списка регулируется');
  await page.getByRole('button', { name: 'Вид чата', exact: true }).click();
  await page.getByRole('button', { name: 'Обычный вид', exact: true }).click();
  await page.getByRole('button', { name: 'Применить', exact: true }).click();
  await page.waitForTimeout(100);
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Черновик с планшета');

  // Playwright меняет вместе с viewport и screen; Android IME сжимает только окно.
  // Фиксируем экран устройства, чтобы проверять именно клавиатуру, а не смену устройства.
  await page.evaluate(({ width, height }) => {
    Object.defineProperties(window.screen, {
      width: { configurable: true, value: width },
      height: { configurable: true, value: height },
    });
  }, { width, height });
  await page.setViewportSize({ width, height: 460 });
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).focus();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.device), 'tablet');
  assert.ok((await list.boundingBox()).width >= 200, 'Клавиатура не скрывает список');

  const composer = await page.locator('.chat-composer').boundingBox();

  assert.ok(composer.y + composer.height <= 461, 'Ввод остаётся над клавиатурой');
  assert.deepEqual(await page.evaluate(inspectFrame), []);
  await page.screenshot({ path: path.join(directory, 'chat-tablet-keyboard.png') });
  await page.setViewportSize({ width, height });
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('');
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).blur();
}
