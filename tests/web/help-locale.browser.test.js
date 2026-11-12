import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { chromium } from '../../desktop/node_modules/playwright-core/index.mjs';
import { i18nBrowser, chooseLanguage } from './helpers/i18nBrowser.js';
import { localeCorpus, signedCorpus } from '../helpers/helpLocale.mts';

// Полный Chromium содержит службу речи: headless-shell падает при открытии SpeechPage.
// Этот выбор среды не меняет возможности приложения и не подменяет проверку языка.
const originalChrome = process.env.CHROME_BIN;

process.env.CHROME_BIN ||= chromium.executablePath();
after(() => {
  if (originalChrome === undefined) {
    delete process.env.CHROME_BIN;
  } else {
    process.env.CHROME_BIN = originalChrome;
  }
});

/**
 * API отдаёт обе локали, включая старый URL без query.
 * Браузер проверяет настоящий entry приложения и хранит только синтетические данные.
 */
async function helpPage(t, options = {}) {
  /**
   * F1 поверх настроек выбирает speech, обычная страница остаётся на chats.
   * Обе статьи входят в один синтетический корпус с прежними стабильными id.
   */
  const corpus = (locale) => {
    const bundle = localeCorpus(locale);

    bundle.articles.push({
      ...bundle.articles[1],
      id: 'speech',
      file: 'speech.md',
      title: locale === 'en' ? 'Speech guide' : 'Руководство диктовки',
      markdown: locale === 'en' ? '# Speech guide' : '# Руководство диктовки',
    });

    return signedCorpus(bundle);
  };

  const h = await i18nBrowser(t, {
    responses: {
      '/api/auth/state': {
        authenticated: true,
        configured: true,
        clientScope: 'help-browser-fixture',
      },
      '/api/help': corpus('ru'),
      '/api/help?locale=en': corpus('en'),
      '/api/help?locale=ru': corpus('ru'),
    },
  });
  const context = await h.browser.newContext({
    locale: options.locale || 'ru-RU',
    hasTouch: options.touch === true,
    isMobile: options.touch === true,
    viewport: options.viewport || { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  t.after(() => context.close());
  await page.goto(h.origin + '#/help/chats');
  await page.locator('article .rich-md').waitFor();

  return {
    ...h,
    context,
    page,
  };
}

test('HELP-B1: обычная страница ru/en/ru, поиск, ссылки, reload сохраняют chats', async (t) => {
  const { page } = await helpPage(t);

  assert.match(await page.locator('article').innerText(), /Рабочая папка/u);
  await chooseLanguage(page, 'en');
  assert.match(await page.locator('article').innerText(), /Chat working directory/u);
  assert.ok(page.url().endsWith('#/help/chats'));
  await page.getByRole('searchbox').fill('working directory');
  assert.match(await page.locator('.help-index-panel').innerText(), /Chat working directory/u);
  await page.getByRole('searchbox').fill('');
  await page.locator('article a[href="#/help/overview"]').click();
  await page.waitForURL('**/#/help/overview');
  await page.goBack();
  await page.waitForURL('**/#/help/chats');
  await page.reload();
  await page.locator('article .rich-md').waitFor();
  assert.match(await page.locator('article').innerText(), /Chat working directory/u);
  await chooseLanguage(page, 'ru');
  assert.match(await page.locator('article').innerText(), /Рабочая папка/u);
});

test('HELP-B2: F1 поверх dirty настроек меняет текст без потери формы и маршрута', async (t) => {
  const { page } = await helpPage(t);

  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.locator('[data-role="settings-modal"]').waitFor();

  await page.evaluate(() => {
    const settings = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
      ._s.get('settings');

    settings.selectPage('speech.dictation');
  });
  await page.waitForFunction(() => {
    const settings = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
      ._s.get('settings');

    return settings.snapshot.resources.some((resource) => resource.id === 'speech' && resource.loaded);
  });

  const before = await page.evaluate(() => {
    const settings = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
      ._s.get('settings');

    settings.setField('speech', 'dictionary', 'СЛОВАРЬ БЕЗ APPLY');

    return {
      pageId: settings.pageId,
      dirty: settings.snapshot.dirtyCount,
      route: location.hash,
      open: settings.isOpen,
    };
  });

  await page.keyboard.press('F1');
  await page.locator('[role="dialog"] .help-browser').waitFor();
  await page.evaluate(() => {
    localStorage.setItem('grigdesk-ui-language', 'en');
    window.dispatchEvent(new StorageEvent('storage', { key: 'grigdesk-ui-language', newValue: 'en' }));
  });
  await page.waitForFunction(() => document.documentElement.lang === 'en');

  const help = page.locator('[role="dialog"]').filter({ has: page.locator('.help-browser') });

  assert.match(await help.innerText(), /Speech guide/u);
  await page.keyboard.press('Escape');

  const after = await page.evaluate(() => {
    const settings = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
      ._s.get('settings');

    return {
      pageId: settings.pageId,
      dirty: settings.snapshot.dirtyCount,
      route: location.hash,
      open: settings.isOpen,
      dictionary: settings.getValue('speech', 'dictionary'),
    };
  });

  assert.deepEqual(after, { ...before, dictionary: 'СЛОВАРЬ БЕЗ APPLY' });
});

for (const screen of [{
  width: 700,
  height: 900,
  touch: false,
},
  {
    width: 390,
    height: 844,
    touch: true,
  }]) {
  test(`HELP-B3: ${screen.width}×${screen.height}, touch=${screen.touch}, system de`, async (t) => {
    const { page } = await helpPage(t, {
      locale: 'de-DE',
      viewport: {
      width: screen.width, height: screen.height,
    },
      touch: screen.touch,
    });

  assert.match(await page.locator('article').innerText(), /Chat working directory/u);
  await page.locator('.help-browser button[aria-controls]').click();
  await page.getByRole('searchbox').fill('unfindable-sentinel');
  assert.match(await page.locator('.help-index-panel').innerText(), /nothing found|no results/iu);
  await page.getByRole('searchbox').fill('');
  await page.locator('.help-index-item').filter({ hasText: 'Guide' }).first().click();
  assert.equal(await page.locator('.help-browser button[aria-controls]')
    .getAttribute('aria-expanded'), 'false');
  await page.evaluate(() => {
    location.hash = '/help/missing';
  });
  await page.waitForFunction(() => !document.querySelector('article .rich-md'));
  assert.equal(await page.locator('article .rich-md').count(), 0);
  });
}

test('HELP-B2: Ask создаёт EN draft с locale/id/version и сохраняет прежний без POST', async (t) => {
  const { page } = await helpPage(t);
  let posts = 0;

  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/chat') {
      posts += 1;
    }
  });

  const previous = await page.evaluate(() => {
    const chat = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat');

    return chat.newSession({ title: 'Прежний', draft: 'НЕОТПРАВЛЕННЫЙ ТЕКСТ' });
  });

  await chooseLanguage(page, 'en');
  await page.getByRole('button', { name: 'Ask an agent', exact: true }).click();
  await page.waitForURL('**/#/chats');

  const result = await page.evaluate((previousId) => {
    const chat = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat');

    return {
      old: chat.sessions.find((entry) => entry.id === previousId)?.draft,
      current: chat.sessions.find((entry) => entry.id === chat.activeId)?.draft,
      activeId: chat.activeId,
    };
  }, previous);

  assert.notEqual(result.activeId, previous);
  assert.equal(result.old, 'НЕОТПРАВЛЕННЫЙ ТЕКСТ');
  assert.match(result.current, /locale[^\n]{0,12}en/u);
  assert.match(result.current, /chats/u);
  assert.match(result.current, /0\.1\.0/u);
  assert.equal(posts, 0);
});
