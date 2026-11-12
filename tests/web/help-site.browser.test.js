import assert from 'node:assert/strict';
import test from 'node:test';
import { i18nBrowser } from './helpers/i18nBrowser.js';
import { selectUiOption } from './helpers/selectUiOption.ts';
import { localeCorpus } from '../helpers/helpLocale.mts';

for (const scenario of [
  {
    name: 'URL system важнее preference en',
    system: 'ru-RU',
    query: '?locale=system',
    stored: 'en',
    locale: 'ru',
  },
  {
    name: 'URL en важнее ru системы',
    system: 'ru-RU',
    query: '?locale=en',
    locale: 'en',
  },
  {
    name: 'de система по умолчанию en',
    system: 'de-DE',
    query: '',
    locale: 'en',
  },
  {
    name: 'URL ru важнее preference en',
    system: 'en-US',
    query: '?locale=ru',
    stored: 'en',
    locale: 'ru',
  },
  {
    name: 'preference en важнее ru системы',
    system: 'ru-RU',
    query: '',
    stored: 'en',
    locale: 'en',
  },
  {
    name: 'storage denied сохраняет URL en',
    system: 'ru-RU',
    query: '?locale=en',
    denied: true,
    locale: 'en',
  },
]) {
  test(`HELP-READER-L1: ${scenario.name}, собственные JSON без API/cookies`, async (t) => {
    const h = await i18nBrowser(t);
    const context = await h.browser.newContext({ locale: scenario.system });

    await context.addCookies([{
      name: 'fixture',
      value: 'MUST-NOT-LEAK',
      url: h.origin,
    }]);

    const page = await context.newPage();
    const requests = [];

    t.after(() => context.close());
    await page.addInitScript(({ stored, denied }) => {
      if (stored) {
        localStorage.setItem('grigdesk-help-language', stored);
      }
      if (denied) {
        Object.defineProperty(window, 'localStorage', { get() {
          throw new Error('Storage denied');
        } });
      }
    }, { stored: scenario.stored, denied: scenario.denied });
    await page.route('**/help/help*.json', async (route) => {
      const request = route.request();
      const locale = new URL(request.url()).pathname.endsWith('help.en.json') ? 'en' : 'ru';

      requests.push({ locale, cookie: request.headers().cookie });
      await route.fulfill({ json: localeCorpus(locale) });
    });
    page.on('request', (request) => {
      assert.equal(new URL(request.url()).pathname.startsWith('/api/'), false);
      assert.equal(new URL(request.url()).origin, new URL(h.origin).origin);
    });
    await page.goto(h.origin + 'help/index.html' + scenario.query + '#/help/chats');
    await page.locator('article .rich-md').waitFor();
    assert.match(await page.locator('article').innerText(), scenario.locale === 'en'
      ? /Chat working directory/u : /Рабочая папка/u);
    assert.deepEqual(requests, [{ locale: scenario.locale, cookie: undefined }]);
    assert.equal(await page.getByRole('combobox').count(), 1, 'Reader имеет выбор system/ru/en');
    await page.getByRole('searchbox').fill(scenario.locale === 'en' ? 'working directory' : 'рабочая папка');
    assert.equal(await page.locator('.help-index-item').count() > 0, true);
    await page.getByRole('searchbox').fill('');
    await page.locator('article a[href="#/help/overview"]').click();
    await page.waitForFunction(() => location.hash === '#/help/overview');
    await page.reload();
    await page.locator('article .rich-md').waitFor();
    assert.ok(page.url().endsWith('#/help/overview'));

    const language = page.getByRole('combobox');

    const selected = scenario.locale === 'en' ? 'ru' : 'en';

    await selectUiOption(page, language, selected);
    await page.waitForFunction((locale) =>
      new URL(location.href).searchParams.get('locale') === locale, selected);
    assert.ok(page.url().endsWith('#/help/overview'));
    await page.reload();
    await page.locator('article .rich-md').waitFor();
    assert.match(await page.locator('article').innerText(), selected === 'en' ? /Guide/u : /Руководство/u);
    await page.evaluate(() => {
      location.hash = '/help/missing';
    });
    await page.waitForFunction(() => !document.querySelector('article .rich-md'));
    assert.equal(await page.locator('article .rich-md').count(), 0);
  });
}

test('HELP-READER-L1: EN file-404 даёт RU fallback, сбой сети требует Retry', async (t) => {
  const h = await i18nBrowser(t);
  const context = await h.browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  let broken = true;
  let ruCalls = 0;

  t.after(() => context.close());
  await page.route('**/help/help*.json', async (route) => {
    const english = new URL(route.request().url()).pathname.endsWith('help.en.json');

    if (english && broken) {
      await route.fulfill({ status: 404, body: 'not found' });
    } else {
      if (!english) {
        ruCalls += 1;
      }

      await route.fulfill({ json: localeCorpus(english ? 'en' : 'ru') });
    }
  });
  await page.goto(h.origin + 'help/index.html?locale=en#/help/chats');
  await page.locator('article .rich-md').waitFor();
  assert.equal(ruCalls, 1);
  assert.match(await page.locator('article').innerText(), /Рабочая папка/u);
  assert.match(await page.locator('body').innerText(), /Russian|русск/iu);
  broken = false;
  await page.reload();
  await page.locator('article .rich-md').waitFor();
  assert.match(await page.locator('article').innerText(), /Chat working directory/u);
});

for (const failure of ['network', 'invalid-json']) {
  test(`HELP-READER-L1: ${failure} не подменяется RU, Retry повторяет EN`, async (t) => {
    const h = await i18nBrowser(t);
    const context = await h.browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    let broken = true;
    let ruCalls = 0;

    t.after(() => context.close());
    await page.route('**/help/help*.json', async (route) => {
      const english = new URL(route.request().url()).pathname.endsWith('help.en.json');

      if (!english) {
        ruCalls += 1;
      }
      if (english && broken) {
        if (failure === 'network') {
          await route.abort('failed');
        } else {
          await route.fulfill({ contentType: 'application/json', body: '{invalid-json' });
        }
      } else {
        await route.fulfill({ json: localeCorpus(english ? 'en' : 'ru') });
      }
    });
    await page.goto(h.origin + 'help/index.html?locale=en#/help/chats');
    await page.locator('article .rich-md, .help-state button').waitFor();
    assert.equal(ruCalls, 0);
    assert.equal(await page.locator('article .rich-md').count(), 0);
    broken = false;
    await page.locator('.help-state button').click();
    await page.locator('article .rich-md').waitFor();
    assert.match(await page.locator('article').innerText(), /Chat working directory/u);
  });
}
