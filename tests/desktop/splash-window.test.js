import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  guardSplash,
  SPLASH_BACKGROUND,
  SPLASH_SIZE,
  SPLASH_STATUS_TEXT,
  splashBounds,
  splashWindowOptions,
} from '../../desktop/src/splashWindow.ts';
import { secureWebPreferences } from '../../desktop/src/windowSecurity.ts';

const assets = new URL('../../desktop/assets/splash/', import.meta.url);
const IMAGE_SHA256 = '3c6bf305047dccbe6215d1f1e625c4a7846bd63dd97eae431c8180cb42e2457c';

/**
 * Фикстура webContents копит обработчики по событиям и запоминает обработчик window.open.
 * Тест вызывает их сам, поэтому Electron и настоящая навигация не нужны.
 */
function contentsFixture() {
  const handlers = new Map();

  return {
    handlers,
    open: null,
    on(event, handler) {
      handlers.set(event, [...handlers.get(event) ?? [], handler]);

      return this;
    },
    setWindowOpenHandler(handler) {
      this.open = handler;
    },
    emit(event, ...args) {
      for (const handler of handlers.get(event) ?? []) {
        handler(...args);
      }
    },
  };
}

/**
 * Сессия заставки получает только обработчики разрешений.
 * Фикстура сохраняет их для прямого вызова в проверке отказа.
 */
function sessionFixture() {
  return {
    request: null,
    check: null,
    setPermissionRequestHandler(handler) {
      this.request = handler;
    },
    setPermissionCheckHandler(handler) {
      this.check = handler;
    },
  };
}

/**
 * Отмена навигации наблюдается на самом событии, как у Electron.
 * Счётчик позволяет проверить, что каждый обработчик отменил её ровно один раз.
 */
function preventable() {
  let prevented = 0;

  return {
    url: 'https://example.org/',
    isMainFrame: true,
    preventDefault() {
      prevented += 1;
    },
    get prevented() {
      return prevented;
    },
  };
}

test('SP-01: опции заставки точно по решению, сессия — переданная', () => {
  const session = { splash: true };
  const bounds = {
    x: 600,
    y: 300,
    width: 720,
    height: 480,
  };
  const options = splashWindowOptions({
    icon: '/app/icon.png',
    packaged: true,
    bounds,
    session,
  });

  assert.deepEqual(options, {
    x: 600,
    y: 300,
    width: 720,
    height: 480,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    title: 'Кокпит',
    icon: '/app/icon.png',
    backgroundColor: '#15191f',
    webPreferences: {
      ...secureWebPreferences(true),
      session,
    },
  });
  assert.equal(options.webPreferences.session === session, true);

  for (const key of ['parent', 'modal', 'alwaysOnTop', 'focusable', 'type']) {
    assert.equal(Object.hasOwn(options, key), false, key);
  }

  assert.equal(splashWindowOptions({
    icon: '/app/icon.png',
    packaged: false,
    bounds,
    session,
  }).webPreferences.devTools, true);
  assert.deepEqual(SPLASH_SIZE, {
    width: 720,
    height: 480,
  });
  assert.equal(SPLASH_STATUS_TEXT, 'Загрузка…');
  assert.equal(SPLASH_BACKGROUND, '#15191f');
});

/**
 * Прямоугольник из четырёх чисел делает таблицу геометрии читаемой построчно.
 * Порядок аргументов совпадает с полями Electron Rectangle.
 */
function rect(x, y, width, height) {
  return {
    x,
    y,
    width,
    height,
  };
}

test('SP-02: геометрия 3:2 по центру рабочей области', () => {
  const cases = [
    [rect(0, 0, 1920, 1080), rect(600, 300, 720, 480)],
    [rect(0, 0, 640, 400), rect(20, 0, 600, 400)],
    [rect(0, 0, 300, 150), rect(38, 0, 225, 150)],
    [rect(1920, 40, 1920, 1040), rect(2520, 320, 720, 480)],
  ];

  for (const [area, expected] of cases) {
    const bounds = splashBounds(area);

    assert.deepEqual(bounds, expected, JSON.stringify(area));
    assert.equal(bounds.width * 2, bounds.height * 3);
  }
});

test('SP-03: охрана заставки отменяет навигацию, окна и разрешения', () => {
  const contents = contentsFixture();
  const session = sessionFixture();

  guardSplash(contents, session);

  for (const name of ['will-navigate', 'will-redirect', 'will-attach-webview']) {
    const event = preventable();

    assert.equal(contents.handlers.get(name)?.length, 1, name);
    contents.emit(name, event);
    assert.equal(event.prevented, 1, name);
  }

  assert.deepEqual(contents.open({ url: 'https://example.org/' }), { action: 'deny' });
  assert.deepEqual(contents.open({ url: 'file:///etc/passwd' }), { action: 'deny' });

  const answers = [];

  session.request(null, 'notifications', (allowed) => answers.push(allowed), {});
  session.request(null, 'media', (allowed) => answers.push(allowed), { mediaTypes: ['audio'] });
  assert.deepEqual(answers, [false, false]);
  assert.equal(session.check(null, 'notifications', 'file://', {}), false);
});

test('SP-04: документ заставки — картинка и единственный текст без скриптов', async () => {
  const html = await readFile(new URL('index.html', assets), 'utf8');
  const csp = "default-src 'none'; img-src 'self'; style-src 'self'";
  const text = html
    .replace(/<head>[\s\S]*<\/head>/u, '')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

  assert.match(html, /<html lang="ru">/u);
  assert.match(html, /<meta charset="utf-8">/u);
  assert.match(html, /<title>Кокпит<\/title>/u);
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${csp}">`));
  assert.match(html, /<link rel="stylesheet" href="style\.css">/u);
  assert.match(html, /<img src="illustration\.png" alt="" decoding="sync">/u);
  assert.equal(text, 'Загрузка…');
  assert.equal(html.includes('...'), false);
  assert.doesNotMatch(html, /<script|https?:\/\//iu);
});

test('SP-05: стиль — фон, отступы, шрифт и вписанная картинка', async () => {
  const css = await readFile(new URL('style.css', assets), 'utf8');

  assert.match(css, /background:\s*#15191f/u);
  assert.match(css, /object-fit:\s*contain/u);
  assert.match(css, /left:\s*24px/u);
  assert.match(css, /bottom:\s*24px/u);
  assert.match(css, /font:\s*14px\/[^;]*system-ui/u);
  assert.match(css, /color:\s*#e7eaf0/u);
  assert.doesNotMatch(css, /url\(|@import|https?:/u);
});

test('SP-06: картинка заставки совпадает с утверждённой', async () => {
  const image = await readFile(new URL('illustration.png', assets));

  assert.equal(createHash('sha256').update(image).digest('hex'), IMAGE_SHA256);
});
