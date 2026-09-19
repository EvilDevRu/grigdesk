// Регрессия ложного ролика: другая модалка, отсутствующая подсказка, новая кнопка
// вне карты и запрос запуска. Проверяются реальные DOM и события браузера.
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { startEgressGuard } from '../../server/src/lib/showcase/browserPolicy.ts';
import { launchBrowser, recordChain } from '../../server/src/lib/showcase/render/recorder.ts';
import { rehearseScript } from '../../server/src/lib/showcase/script/rehearsal.ts';
import {
  actionTarget, assertObservedSurfaces, observeScreen,
} from '../../server/src/lib/showcase/script/observation.ts';
import { parseScriptReplyResult } from '../../server/src/lib/showcase/script/writer.ts';
import {
  briefHashOf,
  compactObservations,
  fitFrames,
  MAX_REHEARSALS,
  MAX_REVIEW_INPUT_CHARS,
  readScriptProof,
  scriptHashOf,
  SCRIPT_VERIFICATION_VERSION,
  verifyAndRepairScript,
  writeScriptProof,
} from '../../server/src/lib/showcase/script/verification.ts';

const STYLE = { width: 1280, height: 720, fps: 30, locale: 'ru-RU', theme: 'light', burnSubtitles: false };
const SCREEN = {
  id: 'positions', title: 'Позиции', path: '/', readySelector: 'h1',
  elements: [
    { id: 'settings', selector: '#settings', title: 'Настройки колонки' },
    { id: 'cell', selector: '#cell', title: 'Ячейка частоты' },
    { id: 'settingsDialog', selector: '[role=dialog]:has-text("Колонка")', title: 'Колонка' },
    { id: 'settingsLink', selector: '#settings-link', title: 'Настройки проекта' },
  ],
};
const CONTEXT = {
  taskTitle: 'Выбор частоты', taskText: 'Обновление выбранного типа частоты',
  diff: '', diffBase: '', diffHead: '', diffTruncated: false, screens: [SCREEN], maxScenes: 8,
};

function scene(actions, narration = 'Открывается окно «Обновить частоту».') {
  return {
    title: 'Типы частоты', screenId: 'positions', continuesPrevious: false,
    narration, caption: 'Обновить частоту', subtitleText: narration, actions, syncCues: null,
  };
}

/** Модель возвращает публичную форму сценария, без внутренних syncCues. */
function modelScript(actions) {
  const { syncCues, ...draft } = scene(actions);

  return { scenes: [draft], gaps: [] };
}

async function browserPathOf() {
  const require = createRequire(new URL('../../server/package.json', import.meta.url));
  const registry = require(path.join(path.dirname(require.resolve('playwright-core')), 'browsers.json'));
  const revision = registry.browsers.find((item) => item.name === 'chromium').revision;
  const file = process.env.COCKPIT_SHOWCASE_BROWSER
    || path.join(os.homedir(), '.cache/ms-playwright', `chromium-${revision}`, 'chrome-linux64/chrome');

  return access(file).then(() => file).catch(() => null);
}

async function fixture(t) {
  const browserPath = await browserPathOf();

  if (!browserPath) {
    t.skip('Chromium не установлен: живая проверка не выполнена');

    return null;
  }

  let launches = 0;
  // Страница настроек, которой нет в карте: сюда уводит клик по ссылке в сайдбаре
  // (SPA-переход без перезагрузки), и сюда же запись открывает найденный экран по адресу.
  const settingsPage = '<h2>Частота</h2><p>Расписание съёма</p>'
    + '<div data-testid="schedule-summary">По расписанию снимется: W</div>';
  const settingsHtml = JSON.stringify(settingsPage).replace(/"/gu, '&quot;');
  const server = http.createServer((request, response) => {
    if (request.url === '/launch') {
      launches += 1;
    }

    response.setHeader('content-type', 'text/html; charset=utf-8');

    if (request.url === '/settings/volume') {
      response.end(`<!doctype html><html><body>${settingsPage}</body></html>`);

      return;
    }

    response.end(`<!doctype html><html><body><h1>Проверка позиций</h1>
      <div id="cell">12</div>
      <button id="settings" onclick="settingsDialog.hidden=false">Настройка колонки</button>
      <a id="settings-link" href="#settings"
        onclick="history.pushState({}, '', '/settings/volume');
          document.body.innerHTML=${settingsHtml}">Настройки проекта</a>
      <button data-testid="types" onclick="menu.hidden=false">Типы частоты</button>
      <div id="menu" role="menu" hidden>
        <div role="menuitem">Выбранный тип
          <svg class="lucide lucide-refresh-cw-icon" width="24" height="24"
            onclick="event.stopPropagation();frequencyDialog.hidden=false;menu.hidden=true">
            <rect width="24" height="24" fill="blue"/>
          </svg>
        </div>
      </div>
      <div id="settingsDialog" role="dialog" hidden><h2>Колонка «Частота»</h2>Устройства</div>
      <div id="frequencyDialog" data-testid="frequency-dialog" role="dialog" hidden>
        <h2>Обновить частоту</h2><p>Какие частотности собираем</p>
        <button data-testid="launch"
          onclick="fetch('/launch',{method:'POST'}).catch(()=>{})">Запустить</button>
      </div>
      </body></html>`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const guard = await startEgressGuard({ allowedOrigins: [origin], allowedMethods: ['GET', 'HEAD', 'POST'] });
  const browser = await launchBrowser({ executablePath: browserPath, proxyPort: guard.port });
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'showcase-rehearsal-'));

  t.after(async () => {
    await browser.close();
    await guard.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(workDir, { recursive: true, force: true });
  });

  return {
    browser, workDir, origin, launches: () => launches,
    input: {
      browser, workDir, baseUrl: origin, allowedOrigins: [origin], allowedMethods: ['GET', 'HEAD', 'POST'],
      screens: [SCREEN], scenes: [], style: STYLE, loginState: null,
    },
  };
}

test('плагин обнаруживает неверный показ и находит новые кнопки при повторных проходах', async (t) => {
  const item = await fixture(t);

  if (!item) {
    return;
  }

  const wrong = { scenes: [scene([
    { kind: 'hover', targetId: 'cell' },
    { kind: 'click', targetId: 'settings' },
    { kind: 'waitVisible', targetId: 'settingsDialog' },
  ])], gaps: [] };
  let latest;
  let rounds = 0;
  const verified = await verifyAndRepairScript({
    context: CONTEXT, brief: ['Показать обновление'], draft: wrong,
    rehearse: async (draft, previous) => {
      latest = await rehearseScript({ ...item.input, scenes: draft.scenes,
        screens: previous?.screens ?? item.input.screens });
      rounds += 1;

      return latest;
    },
    runModel: async (prompt) => {
      assert.doesNotMatch(prompt, /"selector":/);
      const elements = latest.screens[0].elements;
      const types = elements.find((entry) => entry.observed?.text === 'Типы частоты');
      const refresh = elements.find((entry) => entry.observed?.tag === 'svg'
        && entry.observed.text.includes('refresh-cw-icon'));

      if (rounds === 1) {
        assert.equal(latest.completed, true, 'успешные клики сами по себе не подтверждают рассказ');
        assert.deepEqual(latest.observations[1].surfaces, [], 'подсказка действительно отсутствует');
        assert.deepEqual(latest.observations.at(-1).surfaces, ['dialog: Колонка «Частота»']);
      }

      if (latest.observations.at(-1).surfaces.includes('dialog: Обновить частоту')) {
        return JSON.stringify({
          accepted: true,
          reason: 'Нужное окно видно после обновления.',
          script: null,
          coverage: [{ pointIndex: 0, status: 'shown', sceneIndices: [0], reason: 'Открыто нужное окно' }],
        });
      }

      const actions = [{ kind: 'click', targetId: types.id }];

      if (refresh) {
        actions.push({ kind: 'click', targetId: refresh.id });
      }

      return JSON.stringify({
        accepted: false,
        reason: 'Нужное окно ещё не открыто.',
        script: modelScript(actions),
        coverage: [{ pointIndex: 0, status: 'explore', sceneIndices: [], reason: 'Проверить меню' }],
      });
    },
  });

  assert.equal(rounds, 3, 'исправленный сценарий тоже исполняется заново');
  assert.equal(verified.draft.scenes[0].actions.length, 2);
  assert.deepEqual(verified.rehearsal.observations.at(-1).surfaces, ['dialog: Обновить частоту']);

  const launch = verified.rehearsal.screens[0].elements.find((entry) => entry.observed?.text === 'Запустить');
  const blocked = await rehearseScript({ ...item.input, screens: verified.rehearsal.screens,
    scenes: [scene([...verified.draft.scenes[0].actions, { kind: 'click', targetId: launch.id }])] });

  assert.equal(blocked.completed, false);
  assert.match(blocked.observations.at(-1).error, /запрещённого запроса/);
  assert.equal(item.launches(), 0, 'найденная кнопка не получает право запускать операцию');
});

// Кадр репетиции — доказательство для модели, и его размер входит в предел входа:
// полный JPEG 1080p не оставлял места ни кадрам, ни наблюдениям.
test('кадры репетиции сохраняются сжатым WebP не шире 1600 px', async (t) => {
  const item = await fixture(t);

  if (!item) {
    return;
  }

  await rehearseScript({ ...item.input, scenes: [scene([{ kind: 'click', targetId: 'settings' }])] });

  const frame = path.join(item.workDir, 'scene-0-action-0.webp');
  const bytes = await readFile(frame);

  assert.equal(bytes.subarray(0, 4).toString('latin1'), 'RIFF', 'кадр в контейнере WebP');
  assert.ok(bytes.length < 60_000, `кадр пустого стенда компактен: ${bytes.length} байт`);
  await assert.rejects(access(path.join(item.workDir, 'scene-0-action-0.full.jpg')), 'полный снимок убран');
});

// Ролик 8702: карта знала только позиции, клик сцены увёл в настройки проекта, а следующая
// сцена продолжала «позиции» — ожидание каркаса позиций роняло всю сборку сырым таймаутом
// Playwright вместо наблюдения, по которому модель могла бы перестроить сцену.
test('уход с экрана: продолжение получает наблюдение, а головной экран — понятный отказ', async (t) => {
  const item = await fixture(t);

  if (!item) {
    return;
  }

  const input = { ...item.input, readyTimeoutMs: 1500 };
  const result = await rehearseScript({ ...input, scenes: [
    scene([{ kind: 'click', targetId: 'settingsLink' }]),
    { ...scene([{ kind: 'hover', targetId: 'cell' }]), continuesPrevious: true },
  ] });
  const last = result.observations.at(-1);
  const found = result.screens.find((screen) => screen.id === 'page:/settings/volume');

  assert.equal(result.completed, false);
  assert.deepEqual([last.sceneIndex, last.actionIndex], [1, -1], 'сцена сорвалась до своих действий');
  assert.match(last.error, /Экран «positions» не готов .* увели с этого экрана/u);
  assert.match(last.error, /continuesPrevious: false/u, 'модели названы оба выхода');
  assert.doesNotMatch(last.error, /locator|h1/u, 'селектор и текст Playwright в модель не идут');
  assert.match(last.text, /Частота/u, 'наблюдение несёт то, что открылось на самом деле');
  await access(path.join(item.workDir, 'scene-1-action--1.webp'));

  // Страница, на которую увёл клик, стала найденным экраном: модели есть что назвать.
  assert.ok(found, 'экран найден по адресу из браузера');
  assert.equal(found.title, 'Частота');
  assert.equal(found.readySelector, 'h2:has-text("Частота")');
  assert.deepEqual(
    [result.observations[1].screenId, result.observations[1].path],
    ['page:/settings/volume', '/settings/volume'],
    'наблюдение после клика лежит на найденном экране и несёт адрес',
  );
  assert.ok(found.elements.some((element) => element.observed?.text === 'По расписанию снимется: W'));

  const stale = [{ ...SCREEN, readySelector: '#absent' }];

  await assert.rejects(
    () => rehearseScript({ ...input, screens: stale, scenes: [scene([])] }),
    /Экран «positions» не открылся: условие готовности не выполнилось за 2 с/u,
  );
});

// Автомат вместо ручной карты: страница фичи, которой в карте нет, находится браузером,
// а модель называет её головой сцены — запись открывает адрес сама, без пути кликами.
test('найденный экран становится головой сцены, а его элементы доступны любой сцене', async (t) => {
  const item = await fixture(t);

  if (!item) {
    return;
  }

  const input = { ...item.input, readyTimeoutMs: 3000 };
  const explore = scene([{ kind: 'click', targetId: 'settingsLink' }]);
  const explored = await rehearseScript({ ...input, scenes: [explore] });
  const found = explored.screens.find((screen) => screen.id === 'page:/settings/volume');
  const summary = found.elements.find((element) => element.observed?.text === 'По расписанию снимется: W');

  assert.equal(explored.completed, true);
  assert.ok(summary, 'сводка найдена на новой странице');

  // Модель называет найденный экран головой, а найденный элемент — из сцены другого экрана.
  const { syncCues, ...publicScene } = scene([]);
  const reply = JSON.stringify({ scenes: [
    { ...publicScene, actions: [
      { kind: 'click', targetId: 'settingsLink' }, { kind: 'waitVisible', targetId: summary.id },
    ] },
    { ...publicScene, screenId: 'page:/settings/volume', actions: [
      { kind: 'highlight', targetId: summary.id },
    ] },
  ] });
  const parsed = parseScriptReplyResult(reply, explored.screens, 8);

  assert.ok(parsed.draft, 'сценарий с найденным экраном и чужим найденным элементом принят');
  assert.equal(parsed.draft.scenes[1].screenId, 'page:/settings/volume');

  const verified = await rehearseScript({ ...input, screens: explored.screens, scenes: parsed.draft.scenes });
  const head = verified.observations.find((step) => step.sceneIndex === 1 && step.actionIndex === -1);
  const shown = verified.observations.at(-1).elements.find((element) => element.id === summary.id);

  assert.equal(verified.completed, true, JSON.stringify(verified.observations.map((step) => step.error)));
  assert.equal(head.screenId, 'page:/settings/volume');
  assert.equal(head.path, '/settings/volume', 'голова открыла найденный адрес сама');
  assert.equal(shown.visible, true);
  await access(path.join(item.workDir, 'scene-1-action-0.webp'));
});

test('настоящая запись отвергает другое окно и неоднозначный селектор', async (t) => {
  const item = await fixture(t);

  if (!item) {
    return;
  }

  const page = await item.browser.newPage();

  await page.goto(item.origin);
  await page.locator('#settings').click();
  await assert.rejects(() => assertObservedSurfaces(page, ['dialog: Обновить частоту']),
    (error) => error.code === 'screen_result_changed');
  await assert.rejects(() => actionTarget(page, { id: 'button', selector: 'button' }),
    (error) => error.code === 'target_ambiguous');
  await page.close();

  await assert.rejects(() => recordChain({
    browser: item.browser,
    baseUrl: item.origin,
    allowedOrigins: [item.origin],
    outDir: item.workDir,
    style: STYLE,
    loginState: null,
    settleQuietMs: 50,
    settleCapMs: 100,
    scenes: [{
      scene: { ...scene([{ kind: 'click', targetId: 'settings' }]), id: 'scene-rehearsal' },
      screen: SCREEN,
      observations: [{ sceneIndex: 0, actionIndex: 0, surfaces: ['dialog: Обновить частоту'] }],
    }],
  }), (error) => error.code === 'screen_result_changed');
});

test('изменившаяся сводка получает новый ID, прежнее состояние не объявляется видимым', async (t) => {
  const item = await fixture(t);

  if (!item) {
    return;
  }

  const page = await item.browser.newPage();
  const screen = structuredClone(SCREEN);

  await page.goto(item.origin);
  await observeScreen(page, screen, 0, -1);
  const before = screen.elements.find((entry) => entry.observed?.text === 'Типы частоты');

  await page.locator('[data-testid=types]').evaluate((node) => {
    node.textContent = 'Выбраны два типа';
  });
  const observation = await observeScreen(page, screen, 0, 0);
  const after = screen.elements.find((entry) => entry.observed?.text === 'Выбраны два типа');

  assert.notEqual(before.id, after.id);
  assert.equal(observation.elements.find((entry) => entry.id === before.id).visible, false);
  assert.equal(observation.elements.find((entry) => entry.id === after.id).visible, true);
  await assert.rejects(() => actionTarget(page, before), (error) => error.code === 'target_changed');
  assert.ok(await actionTarget(page, after));
  await page.close();
});

test('модель не может принять сорвавшийся проход даже явным accepted=true', async () => {
  let calls = 0;

  await assert.rejects(() => verifyAndRepairScript({
    context: CONTEXT, brief: ['Показать обновление'], draft: { scenes: [scene([])], gaps: [] },
    rehearse: async () => ({ screens: [SCREEN], completed: false,
      observations: [{ sceneIndex: 0, actionIndex: 0, error: 'Нет элемента' }] }),
    runModel: async () => {
      calls += 1;

      return JSON.stringify({ accepted: true, reason: 'Всё готово', script: null,
        coverage: [{ pointIndex: 0, status: 'shown', sceneIndices: [0], reason: 'Готово' }] });
    },
  }), (error) => error.code === 'script_not_verified');
  assert.equal(calls, MAX_REHEARSALS);
});

test('правдивые сцены не проходят приёмку, пока основной пункт плана ещё не исследован', async () => {
  await assert.rejects(() => verifyAndRepairScript({
    context: CONTEXT,
    brief: ['Показать обновление'],
    draft: { scenes: [scene([])], gaps: ['Окно обновления ещё не открывали'] },
    rehearse: async () => ({
      screens: [SCREEN], completed: true, observations: [{ sceneIndex: 0, actionIndex: -1 }],
    }),
    runModel: async () => JSON.stringify({
      accepted: true,
      reason: 'Оставшиеся сцены правдивы',
      script: null,
      coverage: [{ pointIndex: 0, status: 'explore', sceneIndices: [], reason: 'Окно ещё не открывали' }],
    }),
  }), (error) => error.code === 'script_not_verified');
});

test('неэкранированные кавычки в пояснении исправляются без повторных кликов браузера', async () => {
  let passes = 0;
  let calls = 0;

  const result = await verifyAndRepairScript({
    context: CONTEXT,
    brief: ['Показать обновление'],
    draft: { scenes: [scene([])], gaps: [] },
    rehearse: async () => {
      passes += 1;

      return { screens: [SCREEN], completed: true, observations: [{ sceneIndex: 0, actionIndex: -1 }] };
    },
    runModel: async () => {
      calls += 1;

      return calls === 1 ? '{"accepted":true,"reason":"Видно "окно"","script":null}'
        : JSON.stringify({
          accepted: true,
          reason: 'Видно «окно»',
          script: null,
          coverage: [{ pointIndex: 0, status: 'shown', sceneIndices: [0], reason: 'Окно видно' }],
        });
    },
  });

  assert.equal(result.rehearsal.completed, true);
  assert.equal(passes, 1);
  assert.equal(calls, 2);
});

// Полная карта из сотен элементов повторялась в каждом наблюдении, и текст одного
// прохода превышал предел входа модели. Модель получает видимое целиком один раз,
// дальше — изменения относительно предыдущего наблюдения.
test('наблюдения для модели несут видимое один раз, дальше — только изменения', () => {
  const element = (id, text, visible = true, state = '') => ({ id, text, visible, state });
  const first = {
    screenId: 'positions', sceneIndex: 0, actionIndex: -1, text: 'Таблица', surfaces: [],
    elements: [element('a', 'Частота'), element('b', 'не виден', false), element('c', 'Тип', true, 'closed')],
  };
  const second = {
    ...first, actionIndex: 0, surfaces: ['dialog: Обновить частоту'],
    elements: [element('a', 'Частота', false), element('b', 'Обновить'), element('c', 'Тип', true, 'open')],
  };
  const third = { ...second, screenId: 'projects', sceneIndex: 1, actionIndex: -1, text: 'Проекты' };
  const compact = compactObservations([first, second, third]);

  assert.deepEqual(compact[0], {
    screenId: 'positions', sceneIndex: 0, actionIndex: -1, text: 'Таблица', surfaces: [],
    visible: [{ id: 'a', text: 'Частота' }, { id: 'c', text: 'Тип', state: 'closed' }],
  });
  assert.deepEqual(compact[1], {
    screenId: 'positions', sceneIndex: 0, actionIndex: 0, text: '(без изменений)',
    surfaces: ['dialog: Обновить частоту'],
    changed: [{ id: 'b', text: 'Обновить' }, { id: 'c', text: 'Тип', state: 'open' }],
    hidden: ['a'],
    unchanged: 0,
  });
  assert.ok(compact[2].visible, 'новый экран описан целиком');
  assert.equal(compact[2].text, 'Проекты');
  assert.ok(JSON.stringify(compact).length < JSON.stringify([first, second, third]).length);
  assert.deepEqual(
    compactObservations([{ sceneIndex: 0, actionIndex: -1 }]),
    [{ screenId: undefined, sceneIndex: 0, actionIndex: -1, text: '', surfaces: [], visible: [] }],
    'отчёт без карты элементов не роняет проверку',
  );
});

test('кадры проверки отбираются по остатку предела входа, важные — первыми', () => {
  const frame = (sceneIndex, size) => ({
    sceneIndex, actionIndex: -1, mediaType: 'image/webp', data: 'A'.repeat(size),
  });
  const frames = [frame(0, 1000), frame(1, 1000), frame(0, 5000), frame(1, 1000)];

  assert.deepEqual(fitFrames(frames, 3500).map((item) => item.data.length), [1000, 1000, 1000]);
  assert.deepEqual(fitFrames(frames, 100), []);
  assert.ok(MAX_REVIEW_INPUT_CHARS < 1_048_576, 'предел ниже строки stream-json Claude CLI');
});

test('проверка отдаёт модели только кадры, уместившиеся в предел входа', async () => {
  const big = 'B'.repeat(400_000);
  let received = null;
  let promptLength = 0;

  const result = await verifyAndRepairScript({
    context: CONTEXT,
    brief: ['Показать обновление'],
    draft: { scenes: [scene([])], gaps: [] },
    rehearse: async () => ({
      screens: [SCREEN],
      completed: true,
      observations: [{ sceneIndex: 0, actionIndex: -1 }],
      frames: [0, 1, 2, 3].map((index) => ({
        sceneIndex: 0, actionIndex: index, mediaType: 'image/webp', data: big,
      })),
    }),
    runModel: async (prompt, images) => {
      received = images;
      promptLength = prompt.length;

      return JSON.stringify({
        accepted: true,
        reason: 'Видно окно',
        script: null,
        coverage: [{ pointIndex: 0, status: 'shown', sceneIndices: [0], reason: 'Окно видно' }],
      });
    },
  });

  assert.equal(result.rehearsal.completed, true);
  assert.equal(received.length, 2, 'два кадра по 400 КБ — всё, что умещается вместе с текстом');
  assert.ok(promptLength + received.length * big.length <= MAX_REVIEW_INPUT_CHARS);

  // Список кадров в промпте перечисляет только отобранные: кадр, не уместившийся
  // в предел, не обещается модели.
  let prompt = '';

  await verifyAndRepairScript({
    context: CONTEXT,
    brief: ['Показать обновление'],
    draft: { scenes: [scene([])], gaps: [] },
    rehearse: async () => ({
      screens: [SCREEN], completed: true, observations: [{ sceneIndex: 0, actionIndex: -1 }],
      frames: [{ sceneIndex: 0, actionIndex: 7, mediaType: 'image/webp', data: 'C'.repeat(950_000) }],
    }),
    runModel: async (text, images) => {
      prompt = text;
      assert.deepEqual(images, []);

      return JSON.stringify({
        accepted: true, reason: 'ок', script: null,
        coverage: [{ pointIndex: 0, status: 'shown', sceneIndices: [0], reason: 'ок' }],
      });
    },
  });

  assert.doesNotMatch(prompt, /действие 7 /u);
  assert.match(prompt, /Кадры недоступны/u);
});

test('проверка ручного сценария сохраняет авторский текст при предложении его заменить', async () => {
  const draft = { scenes: [scene([], 'Авторский текст.')], gaps: [] };

  await assert.rejects(() => verifyAndRepairScript({
    context: CONTEXT,
    brief: ['Показать обновление'],
    draft,
    allowRepair: false,
    rehearse: async () => ({
      screens: [SCREEN], completed: true, observations: [{ sceneIndex: 0, actionIndex: -1 }],
    }),
    runModel: async () => JSON.stringify({
      accepted: false, reason: 'Нужен другой текст', script: modelScript([]), coverage: [],
    }),
  }), (error) => error.code === 'script_not_verified');
  assert.equal(draft.scenes[0].narration, 'Авторский текст.');
});

test('приёмка перестаёт действовать после изменения текста или политики стенда', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'showcase-proof-'));

  t.after(() => rm(dir, { recursive: true, force: true }));
  const scenes = [{ ...scene([]), order: 1 }];
  const project = { scenes, brief: ['Показать обновление'], target: { status: 'ready', scope: {
    targetFingerprint: 'target', policyRevision: 'policy', dataRevision: 'data',
  } } };

  project.scriptProofHash = await writeScriptProof(dir, {
    version: SCRIPT_VERIFICATION_VERSION, targetFingerprint: 'target', policyRevision: 'policy',
    dataRevision: 'data',
    briefHash: briefHashOf(project.brief),
    scriptHash: scriptHashOf(scenes), rehearsal: { screens: [SCREEN], observations: [], completed: true },
  });
  assert.ok(await readScriptProof(dir, project));
  project.brief.push('Показать другое действие');
  assert.equal(await readScriptProof(dir, project), null);
  project.brief.pop();
  project.scenes[0].narration = 'Теперь другой рассказ.';
  assert.equal(await readScriptProof(dir, project), null);
  project.scenes = [{ ...scene([]), order: 1 }];
  project.target.scope.policyRevision = 'new-policy';
  assert.equal(await readScriptProof(dir, project), null);
});

test('сброс отклонённого CONNECT не убивает исполнителя проверки', async () => {
  const guard = await startEgressGuard({ allowedOrigins: [], allowedMethods: ['GET', 'HEAD'] });

  try {
    await Promise.all(Array.from({ length: 12 }, () => new Promise((resolve) => {
      const client = net.connect(guard.port, '127.0.0.1', () => {
        client.write('CONNECT denied.invalid:443 HTTP/1.1\r\nHost: denied.invalid:443\r\n\r\n');
      });

      client.once('data', () => client.resetAndDestroy());
      client.on('error', () => client.destroy());
      client.once('close', resolve);
    })));
    assert.equal(guard.blocked.length, 12);
  } finally {
    await guard.close();
  }
});
