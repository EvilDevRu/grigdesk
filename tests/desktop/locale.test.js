import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';

import { createDesktopLocale } from '../../desktop/src/locale.ts';
import { applicationMenuTemplate, contextMenuTemplate } from '../../desktop/src/menu.ts';
import { SPLASH_STATUS_TEXT } from '../../desktop/src/splashWindow.ts';
import { localeMain } from './helpers/localeMain.js';
import { clientFailureText, connectionDetailText } from '../../shared/client/clientShell.ts';

test('I18N-D01/errors: известные отказы EN, прежний RU default и побайтный raw', () => {
  for (const code of ['identityMismatch', 'invalid_pairing', 'client_upgrade_required', 'locked']) {
    const english = clientFailureText(code, 'en');

    assert.ok(english.trim());
    assert.doesNotMatch(english, /[А-Яа-яЁё]/);
    assert.notEqual(english, code);
    assert.equal(clientFailureText(code), clientFailureText(code, 'ru'));
  }

  const raw = 'Ошибка сервера: invalid_pairing';

  assert.equal(connectionDetailText(raw, 'en'), raw);
  assert.equal(connectionDetailText({ code: 'unknown', message: raw }, 'en'), raw);
  assert.ok(connectionDetailText({ code: 'disconnected' }, 'en').trim());
});

test('I18N-D01: явный EN переводит меню, сохраняя роли, accelerator и вызов настроек', () => {
  let opens = 0;
  const ru = applicationMenuTemplate({ openSettings() {} });
  const en = applicationMenuTemplate({ openSettings: () => { 
    opens += 1; 
  } }, 'en');

  assert.deepEqual(en.map((item) => item.label), ['File', 'Edit', 'View', 'Help']);
  assert.deepEqual(en.slice(1).map((group) => group.submenu.map((item) => item.role || item.type)),
    ru.slice(1).map((group) => group.submenu.map((item) => item.role || item.type)));
  assert.equal(en[0].submenu[0].accelerator, ru[0].submenu[0].accelerator);
  en[0].submenu[0].click();
  assert.equal(opens, 1);

  const context = contextMenuTemplate({
    editFlags: { canCopy: true },
    isEditable: false,
    linkURL: 'https://example.test',
  }, () => {}, 'en');

  assert.equal(context[0].label, 'Copy');
  assert.equal(context.at(-1).label, 'Copy link address');
  assert.deepEqual(ru.map((item) => item.label), ['Файл', 'Правка', 'Вид', 'Справка']);
});

test('I18N-D01: чистый desktop-контекст выбирает preferred system language и явный язык', async () => {
  const file = new URL('../../desktop/src/locale.ts', import.meta.url);
  const exists = await access(file).then(() => true, () => false);

  assert.equal(exists, true, 'К5: контекст языка main отсутствует');

  const { createDesktopLocale } = await import(file);

  for (const [preference, systemLanguage, expected] of [
    ['system', 'ru-KZ', 'ru'], ['system', 'de-DE', 'en'], ['system', '', 'en'],
    ['en', 'ru-RU', 'en'], ['ru', 'en-US', 'ru'],
  ]) {
    assert.equal(createDesktopLocale({ preference, systemLanguage }).locale, expected);
  }
});

for (const readyFirst of [true, false]) {
  for (const [systemLanguage, preference, lang] of [
    ['en-US', undefined, 'en'], ['ru-RU', undefined, 'ru'], ['en-US', 'ru', 'ru'],
  ]) {
    test(`I18N-D01: prefs до splash; readyFirst=${readyFirst}, system=${systemLanguage}, pref=${preference}`,
      async (t) => {
        const f = await localeMain(t, { preference, systemLanguage });

        assert.equal(Boolean(f.fixture.window), true, 'Mock main создал настоящее ожидание заставки');

        if (readyFirst) {
          f.fixture.window.emit('ready-to-show');
        }

        f.load.resolve();
        await new Promise((resolve) => setImmediate(resolve));

        if (!readyFirst) {
          f.fixture.window.emit('ready-to-show');
        }

        await f.booting;
        assert.equal(f.events[0], 'readSettings', 'К5: выбор читается перед первым loadFile');
        assert.equal(f.events.filter((event) => event === 'readSettings').length, 1);
        assert.deepEqual(f.events.slice(1), ['loadFile', 'execute', 'execute-resolved', 'show']);
        assert.equal(f.doc.document.documentElement.lang, lang);
        assert.equal(f.doc.document.querySelector('.status').textContent,
          lang === 'ru' ? 'Загрузка…' : 'Loading…');
        assert.ok(f.frames() >= 2, 'Д8: показ после двух кадров применения текста');
        assert.equal(SPLASH_STATUS_TEXT, 'Загрузка…');
      });
  }
}


for (const [key, ru, en] of [
  ['checkingServer', 'Проверка сервера…', 'Checking server…'],
  ['startingServer', 'Запуск сервера…', 'Starting server…'],
  ['preparingServer', 'Подготовка сервера…', 'Preparing server…'],
  ['waitingVpn', 'Ожидание VPN…', 'Waiting for VPN…'],
]) {
  test(`I18N-D01: этап ${key} переведён в общем каталоге окна`, () => {
    assert.equal(createDesktopLocale({ preference: 'ru' }).t(`desktop.${key}`), ru);
    assert.equal(createDesktopLocale({ preference: 'en' }).t(`desktop.${key}`), en);
  });
}
