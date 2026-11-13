import assert from 'node:assert/strict';
import test from 'node:test';

import { i18nBrowser, openLanguageChat, assertLanguageChat, chooseLanguage } from './helpers/i18nBrowser.js';

/**
 * Первый видимый shell наблюдается до навигации по настройкам и до записи preference.
 * MutationObserver сохраняет язык первого кадра, а не только конечное состояние DOM.
 */
async function firstFrame(page) {
  await page.addInitScript(() => {
    new MutationObserver(() => {
      const shell = document.querySelector('.shell');

      if (shell && !window.__firstLanguageFrame) {
        window.__firstLanguageFrame = {
          lang: document.documentElement.lang,
          settings: [...document.querySelectorAll('button')]
            .map((button) => button.getAttribute('aria-label')).filter(Boolean),
        };
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

test('I18N-B01: первый видимый RU/EN/non-RU; system автоматически не записывается', {
  timeout: 120000,
}, async (t) => {
  const { browser, origin } = await i18nBrowser(t);

  for (const [locale, expected, label] of [
    ['ru-KZ', 'ru', 'Настройки'], ['en-US', 'en', 'Settings'], ['de-DE', 'en', 'Settings'],
  ]) {
    const context = await browser.newContext({ locale });
    const page = await context.newPage();

    try {
      await firstFrame(page);
      await page.goto(origin + '#/chats');
      await page.waitForFunction(() => Boolean(window.__firstLanguageFrame));

      const frame = await page.evaluate(() => window.__firstLanguageFrame);

      assert.equal(frame.lang, expected);
      assert.ok(frame.settings.includes(label), `Первый кадр: ${locale}`);
      assert.equal(await page.evaluate(() => localStorage.getItem('grigdesk-ui-language')), null);
    } finally {
      await context.close();
    }
  }
});

test('I18N-B02: немедленная смена сохраняет чат/DOM/draft/selection/scroll, reload сохраняет язык', {
  timeout: 120000,
}, async (t) => {
  const { browser, origin } = await i18nBrowser(t);
  const context = await browser.newContext({ locale: 'ru-RU' });

  t.after(() => context.close());

  const page = await context.newPage();

  await page.addInitScript(() => {
    const Original = window.EventSource;

    window.__languageSseCount = 0;
    window.EventSource = class extends Original {
      constructor(...args) {
        super(...args);
        window.__languageSseCount += 1;
      }
    };
  });
  await openLanguageChat(page, origin);

  const address = page.url();
  let navigations = 0;

  page.on('framenavigated', () => { 
    navigations += 1; 
  });
  await chooseLanguage(page, 'en');
  await assertLanguageChat(page);
  assert.equal(page.url(), address);
  assert.equal(navigations, 0);
  assert.equal(await page.evaluate(() => window.__languageSseCount), 1);
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.equal(await page.getByRole('button', { name: 'Settings', exact: true }).isVisible(), true);
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('grigdesk-ui-language')), 'en');
  await chooseLanguage(page, 'system');
  assert.equal(await page.locator('html').getAttribute('lang'), 'ru');
});

test('I18N-B03: normal/compact и touch 390×844 показывают EN без горизонтальной обрезки', {
  timeout: 120000,
}, async (t) => {
  const { browser, origin } = await i18nBrowser(t);

  for (const [width, height, hasTouch, density] of [
    [1280, 800, false, 'normal'], [1280, 800, false, 'compact'], [390, 844, true, 'normal'],
  ]) {
    const context = await browser.newContext({
      locale: 'en-US',
      viewport: { width, height },
      hasTouch,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();

    try {
      await page.addInitScript((value) => {
        localStorage.setItem('grigdesk-ui-density', value);
      }, density);
      await page.goto(origin + '#/chats');
      await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('combobox', { name: 'Interface language', exact: true }).waitFor();

      const geometry = await page.locator('[data-role="settings-modal"]').evaluate((modal) => ({
        fits: modal.getBoundingClientRect().right <= innerWidth + 1,
        left: modal.getBoundingClientRect().left >= -1,
        pageFits: document.documentElement.scrollWidth <= innerWidth + 1,
      }));

      assert.deepEqual(geometry, { 
        fits: true, 
        left: true, 
        pageFits: true 
      });
    } finally {
      await context.close();
    }
  }
});

test('I18N-B04: при EN русский чат и raw-контент не пустеют и не становятся ключами', {
  timeout: 120000,
}, async (t) => {
  const { browser, origin } = await i18nBrowser(t);
  const context = await browser.newContext({ locale: 'en-US' });

  t.after(() => context.close());

  const page = await context.newPage();

  await openLanguageChat(page, origin);
  assert.equal(await page.getByRole('button', { name: 'Settings', exact: true }).isVisible(), true);
  assert.match(await page.locator('.cs').textContent(), /Проверка узкого экрана/);
  assert.match(await page.locator('.cs-body').textContent(), /long_code_/);
  assert.equal(await page.locator('textarea[data-role="chat-composer"]').inputValue(),
    'Черновик без перевода');
  assert.equal(await page.getByRole('button', { name: 'Attach file', exact: true }).isVisible(), true);
  assert.equal(await page.title(), 'GrigDesk');
});

test('I18N-B01/shell: старый shell использует browser fallback, новый хранит язык между origin', {
  timeout: 120000,
}, async (t) => {
  const state = {
    rev: 1,
    profile: null,
    profiles: [],
    status: 'none',
    detail: null,
    localAvailable: false,
    serverApi: null,
    appApi: { major: 0, minor: 1 },
    capabilities: [],
  };
  const old = await i18nBrowser(t, { shell: state });
  const context = await old.browser.newContext({ locale: 'en-US' });

  t.after(() => context.close());

  const page = await context.newPage();

  await page.goto(old.origin + '#/chats');
  await page.locator('.machine-welcome').waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');

  const sharedPreference = { preference: 'en', systemLanguage: 'ru-RU' };
  const noMachine = await i18nBrowser(t, { shell: { ...state, locale: sharedPreference } });
  const offline = await i18nBrowser(t, {
    shell: { 
      ...state, 
      status: 'offline', 
      locale: sharedPreference 
    },
  });
  const ru = await noMachine.browser.newContext({ locale: 'ru-RU' });

  t.after(() => ru.close());

  const localPage = await ru.newPage();

  await localPage.addInitScript(() => {
    localStorage.setItem('grigdesk-ui-language', 'ru');
  });

  for (const origin of [noMachine.origin, offline.origin]) {
    await localPage.goto(origin + '#/chats');
    await localPage.locator('.machine-welcome').waitFor();
    assert.equal(await localPage.locator('html').getAttribute('lang'), 'en');
  }
});
