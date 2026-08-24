#!/usr/bin/env node

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(SCRIPT_DIR, '..');
const VIEWPORTS = [340, 360, 600, 759, 760, 899, 900, 1200, 1500];
const POLL_DELAY_MS = 40;
const START_TIMEOUT_MS = 15_000;
const PAGE_TIMEOUT_MS = 8_000;
const delay = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

/**
 * Сначала резервируем свободный loopback-порт, затем сразу освобождаем его для Vite/Chrome.
 * Короткое окно гонки приемлемо: оба процесса дополнительно запускаются со strict binding.
 */
async function freePort() {
  const server = net.createServer();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  await new Promise((resolve) => server.close(resolve));

  if (!port) {
    throw new Error('Не удалось выделить свободный loopback-порт');
  }

  return port;
}

/**
 * Вывод дочернего процесса хранится ограниченным хвостом: при старте он помогает диагностике,
 * но успешный geometry pass не засоряет TAP/CI тысячами строк Vite или Chrome.
 */
function captureProcessOutput(child) {
  let output = '';
  const append = (chunk) => {
    output = `${output}${String(chunk)}`.slice(-12_000);
  };

  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  return () => output.trim();
}

/**
 * HTTP readiness проверяется реальным fetch, чтобы не принять открытый порт за готовый entry.
 * Последняя сетевая ошибка прикладывается к сообщению и не теряет первопричину старта.
 */
async function waitForHttp(url, timeout, processState) {
  const deadline = Date.now() + timeout;
  let lastError = null;

  while (Date.now() < deadline) {
    if (processState?.child.exitCode !== null) {
      throw new Error(
        `Процесс завершился до готовности ${url}\n${processState.output()}`,
      );
    }

    try {
      const response = await fetch(url);

      if (response.ok) {
        return response;
      }

      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await delay(POLL_DELAY_MS);
  }

  throw new Error(
    `Не дождались ${url}: ${lastError?.message ?? 'timeout'}\n`
      + `${processState?.output() ?? ''}`,
  );
}

/**
 * Явный CHROME_BIN сильнее fallback-путей. Каждый кандидат проверяется как обычный файл,
 * поэтому CI не получает неясный spawn ENOENT после уже поднятого Vite.
 */
function resolveChromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/google-chrome',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);

      return candidate;
    } catch {
      // Следующий документированный fallback может существовать в другом образе CI.
    }
  }

  throw new Error(
    'Chrome не найден. Установи Google Chrome/Chromium или задай CHROME_BIN.',
  );
}

/**
 * Без внешнего URL gallery поднимается отдельным Vite-процессом без product auth/store.
 * Это оставляет browser baseline воспроизводимым и не перезапускает работающий Cockpit.
 */
async function startGalleryServer() {
  const externalBase = process.env.UI_GEOMETRY_BASE_URL;

  if (externalBase) {
    const base = externalBase.endsWith('/') ? externalBase : `${externalBase}/`;
    const galleryUrl = new URL('ui-gallery.html', base).href;

    await waitForHttp(galleryUrl, START_TIMEOUT_MS);

    return {
      child: null,
      output: () => '',
      galleryUrl,
    };
  }

  const port = await freePort();
  const viteEntry = path.join(WEB_ROOT, 'node_modules/vite/bin/vite.js');
  const child = spawn(
    process.execPath,
    [
      viteEntry,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      cwd: WEB_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const output = captureProcessOutput(child);
  const galleryUrl = `http://127.0.0.1:${port}/ui-gallery.html`;

  await waitForHttp(galleryUrl, START_TIMEOUT_MS, { child, output });

  return {
    child,
    output,
    galleryUrl,
  };
}

/**
 * Chrome получает отдельный временный profile и CDP-порт. Profile удаляется только после
 * остановки процесса, поэтому проверка не касается пользовательской browser-сессии.
 */
async function startChrome() {
  const binary = resolveChromeBinary();
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-ui-chrome-'));
  const child = spawn(
    binary,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const output = captureProcessOutput(child);
  const versionUrl = `http://127.0.0.1:${port}/json/version`;

  await waitForHttp(versionUrl, START_TIMEOUT_MS, { child, output });

  return {
    child,
    output,
    port,
    profile,
  };
}

/**
 * Минимальный CDP-клиент сопоставляет id ответа с Promise и сохраняет protocol error.
 * Встроенный WebSocket Node 22 убирает необходимость добавлять Playwright только ради CDP.
 */
async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let sequence = 0;

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));

    if (!message.id || !pending.has(message.id)) {
      return;
    }

    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);

    if (message.error) {
      reject(new Error(`${message.error.message}: ${JSON.stringify(message.error.data ?? {})}`));

      return;
    }

    resolve(message.result ?? {});
  });

  socket.addEventListener('close', () => {
    for (const { reject } of pending.values()) {
      reject(new Error('Chrome закрыл CDP-соединение'));
    }

    pending.clear();
  });

  return {
    call(method, params = {}) {
      const id = sequence += 1;

      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

/**
 * Runtime.evaluate всегда возвращает сериализуемое значение и превращает browser exception
 * в обычную ошибку Node, иначе сломанный selector выглядел бы как пустой geometry result.
 */
async function evaluate(cdp, expression) {
  const response = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });

  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description
        ?? response.exceptionDetails.text
        ?? 'Runtime.evaluate failed',
    );
  }

  return response.result?.value;
}

/**
 * DOM-condition опрашивается внутри текущего target: CDP load events могут прийти раньше,
 * чем Vue смонтирует gallery или Transition физически удалит overlay после close.
 */
async function waitForExpression(cdp, expression, timeout = PAGE_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await evaluate(cdp, `Boolean(${expression})`)) {
      return;
    }

    await delay(POLL_DELAY_MS);
  }

  throw new Error(`Не выполнено browser-условие: ${expression}`);
}

const BASE_GEOMETRY_AUDIT = `(() => {
  const errors = [];
  const viewportWidth = window.innerWidth;
  const tolerance = 1;
  const rootStyle = getComputedStyle(document.documentElement);
  const expectedHeight = parseFloat(rootStyle.getPropertyValue('--control-height'));
  const expectedRadius = parseFloat(rootStyle.getPropertyValue('--control-radius'));
  const describe = (element) => {
    const marker = [...element.attributes]
      .find((attribute) => attribute.name.startsWith('data-geometry'));

    return marker
      ? '[' + marker.name + '=' + JSON.stringify(marker.value) + ']'
      : element.className || element.tagName.toLowerCase();
  };
  const inViewport = (element) => {
    const rect = element.getBoundingClientRect();

    return rect.left >= -tolerance
      && rect.top >= -tolerance
      && rect.right <= viewportWidth + tolerance;
  };

  for (const element of document.querySelectorAll(
    '.ui-gallery, .ui-gallery__section, [data-geometry-row], .ui-choice-list',
  )) {
    if (element.scrollWidth > element.clientWidth + tolerance) {
      errors.push(describe(element) + ': horizontal overflow '
        + element.scrollWidth + ' > ' + element.clientWidth);
    }
  }

  if (document.documentElement.scrollWidth > viewportWidth + tolerance) {
    errors.push('document: horizontal overflow '
      + document.documentElement.scrollWidth + ' > ' + viewportWidth);
  }

  for (const row of document.querySelectorAll('[data-geometry-row]')) {
    for (const child of row.children) {
      if (!inViewport(child)) {
        errors.push(describe(child) + ': вышел за viewport');
      }
    }
  }

  for (const row of document.querySelectorAll('[data-geometry-row="peer"]')) {
    const controls = [...row.children].filter((child) => (
      child.matches('.ui-button, .ui-action-link')
    ));

    for (const control of controls) {
      const rect = control.getBoundingClientRect();
      const style = getComputedStyle(control);
      const radius = parseFloat(style.borderTopLeftRadius);

      if (Math.abs(rect.height - expectedHeight) > tolerance) {
        errors.push(describe(control) + ': height ' + rect.height
          + ', ожидалось ' + expectedHeight);
      }
      if (Math.abs(radius - expectedRadius) > tolerance) {
        errors.push(describe(control) + ': radius ' + radius
          + ', ожидалось ' + expectedRadius);
      }
    }
  }

  const idle = document.querySelector('[data-geometry-loading="idle"]');
  const loading = document.querySelector('[data-geometry-loading="active"]');
  const disclosure = document.querySelector('[data-geometry-disclosure]');
  const composer = document.querySelector('[data-geometry-composer]');
  const composerInput = document.querySelector('[data-geometry-composer-input]');
  const contextRing = document.querySelector('[data-geometry-context-ring]');
  const dockActions = [...document.querySelectorAll('[data-geometry-dock-action]')];
  const chatListButtons = [
    ...document.querySelectorAll('[data-geometry-chat-list-button]'),
  ];
  const taskFooterButtons = [
    ...document.querySelectorAll('[data-geometry-task-footer-action]'),
  ];
  const topbarAction = document.querySelector('[data-geometry-topbar-action]');
  const topbarFooter = document.querySelector('[data-geometry-topbar-footer]');

  if (!idle || !loading) {
    errors.push('loading pair: отсутствуют контрольные кнопки');
  } else {
    const delta = Math.abs(
      idle.getBoundingClientRect().width - loading.getBoundingClientRect().width,
    );

    if (delta > tolerance) {
      errors.push('loading pair: ширина изменилась на ' + delta + 'px');
    }

    idle.focus({ preventScroll: true, focusVisible: true });
    const focusStyle = getComputedStyle(idle);
    const ringWidth = parseFloat(focusStyle.outlineWidth) || 0;
    const sectionRect = idle.closest('.ui-gallery__section').getBoundingClientRect();
    const idleRect = idle.getBoundingClientRect();

    if (focusStyle.outlineStyle === 'none' || ringWidth < 1) {
      errors.push('focus ring: у peer button нет видимого outline');
    } else if (
      idleRect.left - ringWidth < sectionRect.left
      || idleRect.top - ringWidth < sectionRect.top
      || idleRect.right + ringWidth > sectionRect.right
      || idleRect.bottom + ringWidth > sectionRect.bottom
    ) {
      errors.push('focus ring: outline обрезан секцией');
    }
  }

  if (!disclosure) {
    errors.push('disclosure: контрольная строка отсутствует');
  } else {
    const content = disclosure.querySelector(':scope > .ui-button__content');
    const label = disclosure.querySelector('.ui-button__label');
    const trailing = disclosure.querySelector('.ui-button__trailing');
    const style = getComputedStyle(disclosure);
    const innerWidth = disclosure.clientWidth
      - parseFloat(style.paddingLeft)
      - parseFloat(style.paddingRight);

    if (!content || content.getBoundingClientRect().width < innerWidth - tolerance) {
      errors.push('disclosure: content wrapper не занял полную ширину');
    }
    if (!label || getComputedStyle(label).display !== 'flex') {
      errors.push('disclosure: label не сохранил flex layout');
    }
    if (
      !trailing
      || trailing.getBoundingClientRect().right
        < disclosure.getBoundingClientRect().right
          - parseFloat(style.paddingRight)
          - tolerance
    ) {
      errors.push('disclosure: trailing chevron не прижат вправо');
    }
  }

  if (!composer || !composerInput) {
    errors.push('composer: контрольная композиция отсутствует');
  } else {
    composerInput.focus({ preventScroll: true, focusVisible: true });
    const inputStyle = getComputedStyle(composerInput);
    const composerStyle = getComputedStyle(composer);

    if (inputStyle.boxShadow !== 'none' || inputStyle.outlineStyle !== 'none') {
      errors.push('composer: primitive нарисовал внутреннюю рамку фокуса');
    }
    if (composerStyle.borderTopColor === 'rgba(0, 0, 0, 0)') {
      errors.push('composer: внешняя рамка фокуса потеряна');
    }
  }

  if (!contextRing) {
    errors.push('context ring: контрольная кнопка отсутствует');
  } else {
    const label = contextRing.querySelector('.ui-button__label');
    const svg = contextRing.querySelector('svg');

    if (!label || getComputedStyle(label).overflow !== 'visible') {
      errors.push('context ring: label по-прежнему обрезает SVG');
    }
    if (
      !label
      || !svg
      || svg.getBoundingClientRect().width > label.getBoundingClientRect().width + tolerance
      || svg.getBoundingClientRect().height > label.getBoundingClientRect().height + tolerance
    ) {
      errors.push('context ring: SVG не помещается в label');
    }
  }

  if (dockActions.length !== 3) {
    errors.push('dock actions: контрольная тройка отсутствует');
  } else {
    const heights = dockActions.map((action) => action.getBoundingClientRect().height);

    if (heights.some((height) => Math.abs(height - 30) > tolerance)) {
      errors.push('dock actions: разная высота ' + heights.join(', '));
    }
  }

  if (chatListButtons.length !== 3) {
    errors.push('chat list actions: контрольная тройка отсутствует');
  } else {
    const sizes = chatListButtons.map((button) => button.getBoundingClientRect().height);
    const transparent = chatListButtons.filter((button) => (
      getComputedStyle(button).backgroundColor === 'rgba(0, 0, 0, 0)'
    ));

    if (Math.abs(sizes[0] - 32) > tolerance || sizes.slice(1).some((size) => (
      Math.abs(size - 24) > tolerance
    ))) {
      errors.push('chat list actions: неверные размеры ' + sizes.join(', '));
    }
    if (transparent.length) {
      errors.push('chat list actions: кнопки снова прозрачны над текстом строки');
    }
  }

  if (taskFooterButtons.length !== 3) {
    errors.push('task footer: контрольная тройка отсутствует');
  } else {
    const heights = taskFooterButtons.map((button) => button.getBoundingClientRect().height);

    if (heights.some((height) => Math.abs(height - 36) > tolerance)) {
      errors.push('task footer: разная высота ' + heights.join(', '));
    }
  }

  if (!topbarAction || !topbarFooter) {
    errors.push('topbar popover: компактные actions отсутствуют');
  } else {
    const actionHeight = topbarAction.getBoundingClientRect().height;
    const footerHeight = topbarFooter.getBoundingClientRect().height;

    if (Math.abs(actionHeight - 28) > tolerance || Math.abs(footerHeight - 30) > tolerance) {
      errors.push('topbar popover: неверные высоты ' + actionHeight + ', ' + footerHeight);
    }
  }

  return {
    errors,
    viewportWidth,
  };
})()`;

const OVERLAY_GEOMETRY_AUDIT = `(() => {
  const errors = [];
  const tolerance = 1;
  const surface = document.querySelector('[data-geometry-provider-popover]');
  const trigger = document.querySelector('[data-geometry-popover-trigger]');
  const providerLink = document.querySelector('[data-geometry-provider-link]');
  const providerSwitch = document.querySelector('[data-geometry-provider-switch]');

  if (!surface || !trigger) {
    return { errors: ['popover: trigger или surface отсутствует'] };
  }

  const rect = surface.getBoundingClientRect();

  if (
    rect.left < -tolerance
    || rect.top < -tolerance
    || rect.right > window.innerWidth + tolerance
    || rect.bottom > window.innerHeight + tolerance
  ) {
    errors.push('popover: surface вне viewport ' + JSON.stringify({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    }));
  }
  if (surface.getAttribute('role') !== 'dialog') {
    errors.push('popover: потерян role=dialog');
  }
  if (trigger.getAttribute('aria-controls') !== surface.id) {
    errors.push('popover: aria-controls не связан с surface');
  }
  if (surface.scrollWidth > surface.clientWidth + tolerance) {
    errors.push('provider popover: horizontal overflow '
      + surface.scrollWidth + ' > ' + surface.clientWidth);
  }

  if (!providerLink) {
    errors.push('provider popover: внешняя resource-link отсутствует');
  } else {
    const linkStyle = getComputedStyle(providerLink);

    if (linkStyle.whiteSpace !== 'normal' || !linkStyle.textDecorationLine.includes('underline')) {
      errors.push('provider popover: resource-link потеряла перенос или подчёркивание');
    }
    if (providerLink.scrollWidth > providerLink.clientWidth + tolerance) {
      errors.push('provider popover: resource-link переполняет свою ширину');
    }
  }

  if (!providerSwitch) {
    errors.push('provider popover: контрольный switch отсутствует');
  } else {
    const track = providerSwitch.nextElementSibling;
    const thumb = track?.firstElementChild;
    const trackRect = track?.getBoundingClientRect();
    const thumbRect = thumb?.getBoundingClientRect();

    if (
      !trackRect
      || Math.abs(trackRect.width - 30) > tolerance
      || Math.abs(trackRect.height - 17) > tolerance
    ) {
      errors.push('provider popover: switch track не равен 30×17');
    }
    if (
      !thumbRect
      || Math.abs(thumbRect.width - 11) > tolerance
      || Math.abs(thumbRect.height - 11) > tolerance
    ) {
      errors.push('provider popover: switch thumb не равен 11×11');
    }
  }

  return { errors };
})()`;

const DIALOG_GEOMETRY_AUDIT = `(() => {
  const errors = [];
  const tolerance = 1;
  const surface = document.querySelector('[data-geometry-dialog]');

  if (!surface) {
    return { errors: ['dialog: surface отсутствует'] };
  }

  const rect = surface.getBoundingClientRect();

  if (
    rect.left < -tolerance
    || rect.top < -tolerance
    || rect.right > window.innerWidth + tolerance
    || rect.bottom > window.innerHeight + tolerance
  ) {
    errors.push('dialog: surface вне viewport ' + JSON.stringify({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    }));
  }
  if (surface.scrollWidth > surface.clientWidth + tolerance) {
    errors.push('dialog: horizontal overflow '
      + surface.scrollWidth + ' > ' + surface.clientWidth);
  }
  if (surface.getAttribute('aria-modal') !== 'true') {
    errors.push('dialog: потерян aria-modal=true');
  }

  return { errors };
})()`;

/**
 * Каждый viewport загружает gallery заново, поэтому состояния overlays и focus не текут
 * между соседними точками матрицы. Ошибка всегда получает точную ширину и selector-контекст.
 */
async function auditViewport(cdp, galleryUrl, width) {
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: width,
    screenHeight: 1000,
  });
  await cdp.call('Page.navigate', { url: galleryUrl });
  await waitForExpression(
    cdp,
    "document.readyState === 'complete' && document.querySelector('.ui-gallery')",
  );
  await evaluate(
    cdp,
    "document.fonts?.ready ? document.fonts.ready.then(() => true) : true",
  );

  const base = await evaluate(cdp, BASE_GEOMETRY_AUDIT);
  const errors = [...(base?.errors ?? [])];

  if (base?.viewportWidth !== width) {
    errors.push(`viewport: Chrome вернул ${base?.viewportWidth}px вместо ${width}px`);
  }

  await evaluate(cdp, `(() => {
    const trigger = document.querySelector('[data-geometry-popover-trigger]');
    trigger?.scrollIntoView({ block: 'center', inline: 'nearest' });
    trigger?.click();
  })()`);
  await waitForExpression(cdp, "document.querySelector('.ui-popover')");
  errors.push(...((await evaluate(cdp, OVERLAY_GEOMETRY_AUDIT))?.errors ?? []));
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
  });
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
  });
  await waitForExpression(cdp, "!document.querySelector('.ui-popover')");

  await evaluate(cdp, `(() => {
    const trigger = document.querySelector('[data-geometry-dialog-trigger]');
    trigger?.scrollIntoView({ block: 'center', inline: 'nearest' });
    trigger?.focus({ preventScroll: true, focusVisible: true });
    trigger?.click();
  })()`);
  await waitForExpression(cdp, "document.querySelector('[data-geometry-dialog]')");
  errors.push(...((await evaluate(cdp, DIALOG_GEOMETRY_AUDIT))?.errors ?? []));
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
  });
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
  });
  await waitForExpression(cdp, "!document.querySelector('.ui-dialog-overlay')");

  const returnedFocus = await evaluate(
    cdp,
    "document.activeElement?.matches('[data-geometry-dialog-trigger]') === true",
  );

  if (!returnedFocus) {
    errors.push('dialog: focus не вернулся к trigger после Escape');
  }

  return errors.map((error) => `[${width}px] ${error}`);
}

/**
 * SIGTERM сначала даёт Vite/Chrome освободить дочерние ресурсы, а короткий timeout не
 * оставляет проверку висеть, если процесс уже потерял event loop.
 */
async function stopProcess(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(2_000)]);

  if (child.exitCode === null) {
    child.kill('SIGKILL');
  }
}

/**
 * Главный сценарий владеет Vite, временным Chrome profile и CDP target целиком.
 * Cleanup выполняется и при геометрической ошибке, и при проблеме запуска браузера.
 */
async function main() {
  let gallery = null;
  let chrome = null;
  let cdp = null;

  try {
    gallery = await startGalleryServer();
    chrome = await startChrome();

    const targetResponse = await fetch(
      `http://127.0.0.1:${chrome.port}/json/new?${encodeURIComponent(gallery.galleryUrl)}`,
      { method: 'PUT' },
    );

    if (!targetResponse.ok) {
      throw new Error(`Chrome /json/new вернул HTTP ${targetResponse.status}`);
    }

    const target = await targetResponse.json();

    if (!target.webSocketDebuggerUrl) {
      throw new Error('Chrome не вернул webSocketDebuggerUrl для gallery target');
    }

    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.call('Page.enable');
    await cdp.call('Runtime.enable');

    const errors = [];

    for (const width of VIEWPORTS) {
      const viewportErrors = await auditViewport(cdp, gallery.galleryUrl, width);

      if (viewportErrors.length === 0) {
        process.stdout.write(`UI geometry: ${width}px OK\n`);
      }

      errors.push(...viewportErrors);
    }

    if (errors.length > 0) {
      throw new Error(`UI geometry нарушена:\n- ${errors.join('\n- ')}`);
    }

    process.stdout.write('UI geometry matrix: OK\n');
  } finally {
    cdp?.close();
    await stopProcess(chrome?.child);
    await stopProcess(gallery?.child);

    if (chrome?.profile) {
      fs.rmSync(chrome.profile, {
        recursive: true,
        force: true,
      });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
