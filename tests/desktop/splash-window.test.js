import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
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
const SPLASH_HASHES = {
  'background.png': 'dfdcded22be22703db57e8a5b96e2ab34019f7789d1e9ff6e142021ea43a9188',
  'wordmark.svg': '732ca732444dd5df453748cbec861562ec5fa344c124210f43fb6b7dd8925ba7',
  'index.html': 'acf8133f47d09ab8e2b49842fd25f16551197434df3cdbe10a19bc082a1a65e5',
  'style.css': 'b8a9538d1b90ec7792923f708d61a2ef2b5f94680883821a7522cd8b914aa18f',
};

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
    title: 'GrigDesk',
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

test('GS-01: документ заставки — фон, надпись и статус без скриптов', async () => {
  const html = await readFile(new URL('index.html', assets), 'utf8');
  const csp = "default-src 'none'; img-src 'self'; style-src 'self'";
  const text = html
    .replace(/<head>[\s\S]*<\/head>/u, '')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

  assert.match(html, /<html lang="ru">/u);
  assert.match(html, /<meta charset="utf-8">/u);
  assert.match(html, /<title>GrigDesk<\/title>/u);
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${csp}">`));
  assert.match(html, /<link rel="stylesheet" href="style\.css">/u);
  assert.equal([...html.matchAll(/<img\b/g)].length, 2);
  assert.match(html, /<img class="background" src="background\.png" alt="" decoding="sync">/u);
  assert.match(html, /<img class="wordmark" src="wordmark\.svg" alt="GrigDesk" decoding="sync">/u);
  assert.equal(text, 'Загрузка…');
  assert.equal(html.includes('...'), false);
  assert.doesNotMatch(html, /<script|https?:\/\//iu);
});

test('SP-05: стиль — фон, отступы, шрифт и вписанная картинка', async () => {
  const css = await readFile(new URL('style.css', assets), 'utf8');

  assert.match(css, /background:\s*#15191f/u);
  assert.match(css, /width:\s*min\(100vw, 150vh\)/u);
  assert.match(css, /width:\s*40%/u);
  assert.match(css, /left:\s*24px/u);
  assert.match(css, /bottom:\s*24px/u);
  assert.match(css, /font:\s*14px\/[^;]*system-ui/u);
  assert.match(css, /color:\s*#e7eaf0/u);
  assert.doesNotMatch(css, /url\(|@import|https?:/u);
});

test('GS-01: четыре файла заставки совпадают с утверждёнными хешами', async () => {
  assert.deepEqual((await readdir(assets)).sort(), Object.keys(SPLASH_HASHES).sort());

  for (const [name, expected] of Object.entries(SPLASH_HASHES)) {
    const image = await readFile(new URL(name, assets));

    assert.equal(createHash('sha256').update(image).digest('hex'), expected, name);
  }
});

test('GS-04: SVG надписи не загружает внешние ресурсы и не выполняет код', async () => {
  assert.ok((await readdir(assets)).includes('wordmark.svg'));

  const svg = await readFile(new URL('wordmark.svg', assets), 'utf8');

  assert.doesNotMatch(svg, /href|<script|url\(/i);
});
