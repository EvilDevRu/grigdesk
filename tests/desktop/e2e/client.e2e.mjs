import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { clientFixture } from '../../server/helpers/clientAccess.js';
import { encodePairing } from '../../../shared/client/pairingPayload.ts';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { freePort } from '../../server/helpers/pluginBootFixture.js';
import { launchDesktopRaw } from './launch.mjs';

/**
 * Каждое окно использует отдельный профиль и окружение без установки GrigDesk.
 * Случайный адрес сервера исключает обращение к работающему экземпляру.
 */
async function start(t, args = [], key) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-client-e2e-'));
  const dataDir = path.join(root, 'profile');

  await mkdir(dataDir, { mode: 0o700 });

  await mkdir(path.join(root, 'auth'), { mode: 0o700 });

  if (key) {
    await writeFile(path.join(root, 'auth/key'), key, { mode: 0o600 });
  }

  const { app } = await launchDesktopRaw({
    root,
    dataDir,
    isolateEnv: true,
    args: [process.env.GRIGDESK_E2E_CLIENT_ENTRY || path.resolve('desktop'),
      '--password-store=gnome-libsecret', ...args],
    env: {
      GRIGDESK_HOME: path.join(root, 'server-data'),
      GRIGDESK_WINDOW_KEY_PATH: path.join(root, 'auth/key'),
      GRIGDESK_CLIENT_UI_DIR: process.env.GRIGDESK_E2E_CLIENT_UI,
    },
  });

  t.after(async () => {
    await app.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  return {
    app,
    root,
    dataDir,
  };
}

/**
 * Наблюдение проверяет реальную видимость BrowserWindow, а не только загрузку документа.
 * Предел проверки оставляет запас над тридцатью секундами местного ожидания.
 */
async function visibleMain(app, timeout = 40_000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const page = app.windows().find((value) => value.url().startsWith('http://127.0.0.1:'));
    const visible = page && await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .some((window) => window.isVisible() && window.webContents.getURL().startsWith('http:')));

    if (visible) {
      return page;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.fail('Окно должно показывать встроенный интерфейс при выключенном сервере.');
}

/**
 * Состояние читается через настоящее API оболочки после завершения навигации.
 * Ограниченный срок оставляет ошибку подключения наблюдаемой в тесте.
 */
async function waitState(page, status) {
  await page.waitForFunction(async (expected) => {
    const state = await (await fetch('/__shell/state')).json();

    return state.status === expected;
  }, status);
}

/**
 * Время отсчитывается от наблюдаемого показа заставки в главном процессе.
 * Ожидание не скрывает ранний показ main и не включает запуск Electron.
 */
async function splashShownAt(app) {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const shown = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .some((window) => window.isVisible()
        && window.webContents.getURL().endsWith('/splash/index.html')));

    if (shown) {
      return Date.now();
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.fail('Заставка не показана за 10 с.');
}

test('UC-E01: явный местный адрес недоступен — мягкий показ по сроку',
  { timeout: 60_000 }, async (t) => {
    const port = await freePort();
    const { app } = await start(t, [`--grigdesk-url=http://127.0.0.1:${port}`]);
    const shownAt = await splashShownAt(app);
    const page = await visibleMain(app);
    const elapsed = Date.now() - shownAt;

    assert.ok(elapsed >= 25_000 && elapsed <= 35_000, `Первый показ через ${elapsed} мс от заставки.`);
    assert.ok((await page.locator('.workspace-connection-message').textContent()).trim());
    assert.equal(await page.locator('.connections').count(), 0);
    assert.equal(app.process().exitCode, null);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    await page.locator('[data-context="connection-trigger"]').click();
    await page.getByRole('button', { name: 'Все машины', exact: true }).click();
    await page.getByRole('heading', { name: 'Машины', exact: true }).waitFor();
    assert.notEqual(new URL(page.url()).port, String(port));
  });

test('UC-E02: без установки открыт интерфейс, машины доступны по кнопке', { timeout: 30000 }, async (t) => {
  const { app } = await start(t);
  const page = await visibleMain(app);

  await page.locator('.shell').waitFor();
  assert.equal(await page.locator('.connections').count(), 0);

  const state = await page.evaluate(() => fetch('/__shell/state').then((response) => response.json()));

  assert.equal(state.profile, null);
  assert.equal(state.profiles.length, 0);
  assert.equal(state.localAvailable, false);
  await page.locator('[data-context="connection-trigger"]').click();
  await page.getByRole('button', { name: 'Все машины', exact: true }).click();
  await page.getByRole('heading', { name: 'Машины', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Вернуться к работе', exact: true }).click();
  await page.locator('.shell').waitFor();
});

test('UC-E03: явный местный адрес ждёт listen и вход; сессия остаётся в трубе',
  { timeout: 60_000 }, async (t) => {
    const port = await freePort();
    const key = randomBytes(32).toString('base64url');
    const server = http.createServer((req, res) => {
      res.setHeader('X-GrigDesk-Api', '0.1');
      res.setHeader('Content-Type', 'application/json');

      if (req.url === '/api/auth/window-session') {
        res.setHeader('Set-Cookie', 'grigdesk_sid=test-local; HttpOnly');
        res.end('{}');
      } else if (req.url === '/api/auth/state') {
        res.end(JSON.stringify({
          configured: true,
          authenticated: req.headers.cookie === 'grigdesk_sid=test-local',
        }));
      } else {
        res.end('{}');
      }
    });
    const listening = once(server, 'listening');
    let timer;

    t.after(async () => {
      clearTimeout(timer);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });

    const { app } = await start(t, [`--grigdesk-url=http://127.0.0.1:${port}`], key);
    let hidden;
    const documentDeadline = Date.now() + 10_000;

    while (!hidden && Date.now() < documentDeadline) {
      hidden = app.windows().find((page) => page.url().startsWith('http://127.0.0.1:'));

      if (!hidden) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    assert.ok(hidden, 'Труба создаёт скрытый документ до готовности сервера.');
    await waitState(hidden, 'offline');

    const offlineAt = Date.now();
    let listenAt;

    await hidden.locator('.shell').waitFor();
    await hidden.locator('.shell').evaluate((element) => element.dataset.startupRetained = 'true');
    timer = setTimeout(() => {
      server.listen(port, '127.0.0.1', () => {
        listenAt = Date.now();
      });
    }, 3000);

    const page = await visibleMain(app);

    assert.equal(server.listening, true, 'Первый показ должен следовать listen местного сервера.');
    await listening;
    assert.ok(listenAt - offlineAt <= 5000,
      `Предусловие повторов: listen через ${listenAt - offlineAt} мс после первого offline.`);

    const snapshot = await page.evaluate(async () => ({
      state: await (await fetch('/__shell/state')).json(),
      waiting: Boolean(document.querySelector('.workspace-waiting')),
    }));

    assert.equal(snapshot.state.status, 'online');
    assert.equal(snapshot.waiting, false, 'Рабочая область готова при первом показе.');
    assert.equal(await page.locator('.connections').count(), 0);

    const result = await page.evaluate(async () => ({
      state: await (await fetch('/api/auth/state')).json(),
      cookie: document.cookie,
    }));

    assert.equal(result.state.authenticated, true, JSON.stringify(result.state));
    assert.equal(result.cookie.includes('grigdesk_sid'), false);
    assert.equal(result.cookie.includes('grigdesk_pipe'), false);
    assert.equal(await page.locator('.shell').getAttribute('data-startup-retained'), 'true');
  });

/**
 * TLS-стенд обслуживает только синтетический API и не обращается к исполнителям ИИ.
 * Переменная версии позволяет проверить защёлку после уже успешного подключения.
 */
async function machine(t, name) {
  let version = '0.1';
  const fixture = await clientFixture(t, {
    /**
     * Маршруты дают только тестовые данные и реальный поток WebSocket.
     * Версия меняется до HTTP-ответа, как при обновлении удалённой машины.
     */
    async register({ app, identity }) {
      const requireServer = createRequire(new URL('../../../server/package.json', import.meta.url));

      await app.register(requireServer('@fastify/websocket'));
      app.addHook('onRequest', async (_req, reply) => {
        reply.header('X-GrigDesk-Api', version);
        reply.raw.setHeader('X-GrigDesk-Api', version);
      });
      app.get('/api/client/hello', async () => ({ name, fp: identity.fp }));
      app.get('/api/ws', { websocket: true }, (socket) => {
        socket.on('message', (data, binary) => socket.send(data, { binary }));
      });
      app.get('/api/test-events', (_req, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' });
        reply.raw.write('data: first\n\n');
        setTimeout(() => reply.raw.end('data: second\n\n'), 1000);
      });
      app.setNotFoundHandler((_req, reply) => reply.send({
        tasks: [],
        projects: [],
        providers: [],
        plugins: [],
      }));
    },
  });
  const issued = fixture.pairing.issue({ name: 'Окно теста', scope: 'client' });

  return {
    fixture,
    version(value) {
      version = value;
    },
    pairing: encodePairing({
      host: '127.0.0.1',
      port: fixture.port,
      fp: fixture.identity.fp,
      code: issued.code,
    }),
  };
}

test('UC-E04–06: привязка, SSE/WS, версии, разные origin и отзыв без повторов',
  { timeout: 90000 }, async (t) => {
    const first = await machine(t, 'Машина A');
    const second = await machine(t, 'Машина B');
    const { app } = await start(t);
    const page = await visibleMain(app);

    await page.locator('[data-context="connection-trigger"]').click();
    await page.getByRole('button', { name: 'Добавить машину', exact: true }).click();
    await page.getByRole('textbox').fill(first.pairing);
    await page.getByRole('button', { name: 'Добавить', exact: true }).click();
    await page.waitForURL((url) => Number(url.port) >= 47101, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('domcontentloaded');
    await waitState(page, 'online');

    const originA = new URL(page.url()).origin;
    const binary = await page.evaluate(() => new Promise((resolve, reject) => {
      const socket = new WebSocket(location.origin.replace('http:', 'ws:') + '/api/ws');

      socket.binaryType = 'arraybuffer';
      socket.onopen = () => socket.send(new Uint8Array([0, 255, 3]));
      socket.onmessage = (event) => {
        socket.close();
        resolve([...new Uint8Array(event.data)]);
      };
      socket.onerror = reject;
    }));

    assert.deepEqual(binary, [0, 255, 3]);

    const event = await page.evaluate(async () => {
      const response = await fetch('/api/test-events');
      const reader = response.body.getReader();
      const chunk = await reader.read();

      await reader.cancel();

      return new TextDecoder().decode(chunk.value);
    });

    assert.match(event, /first/);
    await page.evaluate(() => localStorage.setItem('profile-probe', 'A'));
    await page.locator('[data-context="connection-trigger"]').click();
    await page.locator('[data-connection-menu]').getByText('Добавить машину', { exact: true }).click();
    await page.getByRole('textbox').fill(second.pairing);
    await page.getByRole('button', { name: 'Добавить', exact: true }).click();
    await page.waitForURL((url) => url.origin !== originA);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(async () =>
      (await (await fetch('/__shell/state')).json()).profile?.name === 'Машина B');

    assert.notEqual(new URL(page.url()).origin, originA);
    assert.equal(await page.evaluate(() => localStorage.getItem('profile-probe')), null);

    const originB = new URL(page.url()).origin;

    await page.evaluate(() => localStorage.setItem('removed-profile-probe', 'B'));
    // Удаление меняет документ. Нажатие кнопки не ждёт ответ в уничтожаемом evaluate-контексте.
    await page.locator('[data-context="connection-trigger"]').click();
    await page.getByRole('button', { name: 'Все машины', exact: true }).click();
    await page.locator('.machine-row').filter({ hasText: 'Машина B' })
      .getByRole('button', { name: 'Удалить', exact: true }).click();
    await page.getByRole('dialog', { name: 'Подтверди действие', exact: true })
      .getByRole('button', { name: 'Да', exact: true }).click();
    await page.waitForURL((url) => url.port === '47100');
    await page.locator('[data-context="connection-trigger"]').click();
    await page.getByRole('button', { name: 'Добавить машину', exact: true }).click();
    await page.getByRole('textbox').fill(second.pairing);
    await page.getByRole('button', { name: 'Добавить', exact: true }).click();
    await page.waitForURL((url) => url.port !== '47100');
    await waitState(page, 'online');
    assert.equal(new URL(page.url()).origin, originB, 'Удалённый профиль освободил свой порт.');
    assert.equal(await page.evaluate(() => localStorage.getItem('removed-profile-probe')), null,
      'Новая привязка не наследует хранилище удалённого профиля.');

    const profiles = await page.evaluate(async () => (await (await fetch('/__shell/state')).json()).profiles);
    const profileA = profiles.find((profile) => profile.name === 'Машина A');

    await page.locator('[data-context="connection-trigger"]').click();
    await page.locator('[data-connection-menu]').getByText('Машина A', { exact: true }).click();
    await page.waitForURL(originA + '/**');
    assert.equal(await page.evaluate(() => localStorage.getItem('profile-probe')), 'A');
    first.version('1.0');

    const versionStatus = await page.evaluate(async () => (await fetch('/api/private')).status);

    assert.equal(versionStatus, 426);
    await waitState(page, 'incompatible');
    assert.equal(await page.locator('.connections').count(), 0);
    await page.locator('[data-context="connection-trigger"]').click();
    await page.getByRole('button', { name: 'Все машины', exact: true }).click();
    await page.getByText('Нужна версия приложения не ниже 1.0.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Вернуться к работе', exact: true }).click();
    first.version('0.1');
    await page.evaluate(() => fetch('/__shell/connect', { method: 'POST' }));
    await waitState(page, 'online');

    const device = (await first.fixture.devices.list())[0];

    await first.fixture.devices.revoke(device.id);
    first.fixture.listener.disconnect(device.fp);
    await page.evaluate(() => fetch('/api/private').catch(() => {}));
    await waitState(page, 'revoked');
    assert.equal(await page.locator('.connections').count(), 0);
    await page.locator('[data-context="connection-trigger"]').click();
    await page.getByText('устройство отозвано', { exact: false }).first().waitFor();

    const lookups = t.mock.method(first.fixture.devices, 'findByFp', first.fixture.devices.findByFp);

    await new Promise((resolve) => setTimeout(resolve, 1400));
    assert.equal(lookups.mock.callCount(), 0, 'после отзыва автоматических соединений нет');
    assert.equal(profileA.id.length > 0, true);
  });
