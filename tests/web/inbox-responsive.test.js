import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { clientBrowser, scaleClientText } from './helpers/client-browser.mjs';
import { inbox, items, responses } from './fixtures/inbox/data.mjs';

/**
 * Проверяется видимость действий внутри окна и реальное переполнение содержимого.
 * Одного отсутствия горизонтального scrollbar недостаточно: overflow может скрыть кнопку.
 */
async function geometry(page) {
  return page.locator('.inbox-page').evaluate((root) => {
    const elements = [...root.querySelectorAll('*')];
    const actions = root.querySelector('.actions').getBoundingClientRect();
    const overflow = elements.filter((element) => {
      const style = getComputedStyle(element);

      return element.clientWidth && element.scrollWidth > element.clientWidth + 2
        && style.overflowX === 'visible' && !['INPUT', 'TEXTAREA'].includes(element.tagName);
    }).map((element) => element.className);

    return {
      overflow,
      documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      actionsVisible: actions.top >= 0 && actions.bottom <= innerHeight,
    };
  });
}

test('входящие: очередь, переписка и постоянные действия на desktop и узком экране', {
  timeout: 120000,
}, async (t) => {
  const { browser, origin, artifacts } = await clientBrowser(t, { responses });

  for (const [width, height, hasTouch, scale] of [
    [320, 740, true, 1.3],
    [390, 844, true, 1],
    [768, 1024, true, 1],
    [1024, 768, false, 1],
    [1440, 900, false, 1],
    [1920, 1080, false, 1],
  ]) {
    const page = await browser.newPage({
      viewport: { width, height },
      hasTouch,
      locale: 'ru-RU',
    });
    const errors = [];

    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin + '#/inbox');
    await page.locator('[data-inbox-row]').first().waitFor();
    await scaleClientText(page, scale, '.inbox-page');

    const narrow = (await page.locator('.inbox-page').boundingBox()).width <= 900;

    assert.equal(await page.locator('.inbox-detail').isVisible(), !narrow);
    await page.screenshot({ path: path.join(artifacts, `inbox-${width}-queue.png`) });
    await page.locator('[data-inbox-row]').first().click();
    await page.locator('.item-title').waitFor();
    assert.equal(await page.locator('.inbox-catalog').isVisible(), !narrow);
    assert.equal(await page.locator('.source-description').getAttribute('open'), null);
    assert.deepEqual(await geometry(page), {
      overflow: [],
      documentOverflow: false,
      actionsVisible: true,
    }, `${width}: геометрия переписки`);
    await page.locator('.item-scroll').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    assert.equal((await geometry(page)).actionsVisible, true);
    await page.locator('.item-scroll').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: path.join(artifacts, `inbox-${width}-detail.png`) });

    if (narrow) {
      await page.getByRole('button', { name: '← К обращениям' }).click();
      assert.equal(await page.locator('[data-inbox-row]').first().evaluate(
        (element) => element === document.activeElement,
      ), true, 'возврат восстанавливает фокус строки');
    }

    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('входящие: длинные ссылки, много сообщений и узкая панель в широком окне', {
  timeout: 60000,
}, async (t) => {
  const first = {
    ...items[0],
    title: 'https://example.test/' + 'long-path-'.repeat(40),
    messages: Array.from({ length: 30 }, (_, index) => ({
      ...items[0].messages[0],
      messageRef: `long-message-${index}`,
      text: index ? 'https://example.test/' + 'long-path-'.repeat(50) : items[0].messages[0].text,
    })),
  };
  const { browser, origin } = await clientBrowser(t, {
    responses: { ...responses, '/api/inbox': { ...inbox, items: [first, ...items.slice(1)] } },
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });

  await page.goto(origin + '#/inbox');
  await page.locator('[data-inbox-row]').first().waitFor();
  await page.locator('.inbox-page').evaluate((element) => {
    element.style.width = '600px';
  });
  assert.equal(await page.locator('.inbox-detail').isVisible(), false);
  await page.locator('[data-inbox-row]').first().focus();
  await page.keyboard.press('Enter');
  await page.locator('.detail-navigation').waitFor();
  assert.deepEqual((await geometry(page)).overflow, []);
  assert.equal((await geometry(page)).actionsVisible, true);
  await page.locator('.item-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  assert.equal((await geometry(page)).actionsVisible, true);
});
