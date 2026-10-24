// Оповещение об аварии конвейера.
//
// У вотчера три беды, и авария — самая громкая: конвейер не «ждёт решения» и не «молчит»,
// он лежит. При этом звонили только двое: ворота и молчание. Прогон, оборвавшийся на
// глазах человека (выключили машину, погиб демон), не показывал ничего, кроме цифры на
// чипе, — а именно с этого вопроса «почему он просто так взял и оборвался» всё и началось.
//
// Здесь стережётся и обратная сторона: звонок обязан быть НА ПЕРЕХОДЕ. Авария живёт до
// явного действия человека, поэтому звонок на каждой проверке (раз в две минуты и на
// каждое событие шины) превратил бы оповещение в шум, от которого отключаются.
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveLocaleText } from '../../shared/i18n/catalogs.ts';

import { compileModule, webFile } from './helpers/compile-vue.js';

const CRASHED = {
  kind: 'crashed',
  stage: null,
  title: 'конвейер оборвался, не дойдя до конца',
  hint: 'демона нет, а конвейер не закрыт — запусти заново (resume продолжит с этого места)',
  since: '2026-08-27 00:59:18',
};

const NO_PROGRESS = {
  kind: 'human',
  stage: 'SKEPTIC',
  title: 'SKEPTIC: замкнутый набор замечаний расширен новыми id: shared-module',
  hint: 'блокирующие замечания пережили ремонт',
  since: '2026-08-27 01:10:00',
};

/**
 * Свежий модуль изолирует наборы отзвонившего, живущие на уровне модуля.
 * Общий канал собирает показ и гашение без браузерных оповещений.
 */
async function makeWatch(t) {
  const harness = {
    tasks: [],
    graphs: {},
    notifications: [],
    dismissed: [],
    failTasks: false,
  };
  globalThis.__notifyWatchHarness = harness;
  t.after(() => { delete globalThis.__notifyWatchHarness; });

  const module = await compileModule(webFile('src/stores/notifyWatch.ts'), {
    stubs: {
      '../shared/apiClient.ts': [
        `export { failureText } from ${JSON.stringify(webFile('src/shared/apiClient.ts'))};`,
        'export const api = {',
        '  async get(url) {',
        '    const harness = globalThis.__notifyWatchHarness;',
        '    if (harness.failTasks && url === "/api/tasks") throw new Error("нет сети");',
        '    if (url === "/api/tasks") return { tasks: harness.tasks, silenceWindow: 0 };',
        '    const taskId = url.match(/^\\/api\\/tasks\\/(\\d+)\\/graph$/)?.[1];',
        '    if (taskId && harness.graphs[taskId]) return harness.graphs[taskId];',
        '    return { nodes: {}, pos: {}, keys: {}, statuses: {} };',
        '  },',
        '};',
      ].join('\n'),
      '../shared/alerts.ts': [
        'export const alertUser = (notice) => {',
        '  globalThis.__notifyWatchHarness.notifications.push({',
        '    title: notice.title,',
        '    body: notice.body,',
        '    tag: notice.id,',
        '    notice,',
        '  });',
        '  return true;',
        '};',
        'export const dismissAlert = (id) => {',
        '  globalThis.__notifyWatchHarness.dismissed.push(id);',
        '};',
      ].join('\n'),
    },
  });

  const { createPinia, setActivePinia } = await import('../../web/node_modules/pinia/dist/pinia.mjs');
  setActivePinia(createPinia());
  return { store: module.useNotifyWatchStore(), harness };
}

const task = (id, stall) => ({ task: id, daemonAlive: false, stall });

test('оборвавшийся прогон звонит, и в звонке сказано, что делать', async (t) => {
  const { store, harness } = await makeWatch(t);
  harness.tasks = [task(8324, CRASHED)];

  await store.check();

  assert.equal(harness.notifications.length, 1, 'авария обязана звонить');
  const [call] = harness.notifications;

  assert.match(resolveLocaleText(call.title), /Конвейер оборвался — #8324/);
  // Заголовок карточки у аварии общий, поэтому в теле — подсказка: она единственная
  // говорит, что делать. Иначе оповещение дублировало бы само себя.
  assert.match(call.body, /запусти заново/);
});

test('первый снимок молчит: заход в GrigDesk — не событие', async (t) => {
  const { store, harness } = await makeWatch(t);
  harness.tasks = [task(8324, CRASHED)];

  await store.check(true);

  assert.equal(harness.notifications.length, 0);
  assert.equal(store.stalled.length, 1, 'но чип аварию видит сразу');
});

test('повторная проверка той же аварии не звонит второй раз', async (t) => {
  const { store, harness } = await makeWatch(t);
  harness.tasks = [task(8324, CRASHED)];

  await store.check();
  await store.check();
  await store.check();

  assert.equal(harness.notifications.length, 1);
});

test('прогон продолжили и он оборвался снова — звоним снова', async (t) => {
  const { store, harness } = await makeWatch(t);
  harness.tasks = [task(8324, CRASHED)];
  await store.check();

  harness.tasks = [{ task: 8324, daemonAlive: true, stall: null }];
  await store.check();
  assert.equal(store.stalled.length, 0);

  harness.tasks = [task(8324, CRASHED)];
  await store.check();

  assert.equal(harness.notifications.length, 2, 'новая авария — новый звонок');
});

test('другой узел, вставший так же, — отдельная беда и отдельный звонок', async (t) => {
  const { store, harness } = await makeWatch(t);
  harness.tasks = [task(900022, NO_PROGRESS)];
  await store.check();

  harness.tasks = [task(900022, { ...NO_PROGRESS, stage: 'REVIEW', title: 'REVIEW: то же самое' })];
  await store.check();

  assert.equal(harness.notifications.length, 2);
  // У затыка полезен именно заголовок: он называет узел и причину, а подсказка общая.
  assert.match(harness.notifications[0].body, /замкнутый набор замечаний/);
  assert.match(resolveLocaleText(harness.notifications[1].title), /Конвейер встал — #900022/);
});

test('наблюдаемая проекция несёт уже загруженные этап и прогресс графа', async (t) => {
  const { store, harness } = await makeWatch(t);
  harness.tasks = [{
    task: 8324,
    title: 'Проверить всплывашку',
    attempt: 'a_1',
    daemonAlive: true,
    result: null,
    stall: null,
  }];
  harness.graphs['8324'] = {
    nodes: { review: [1, '🔎 Проверка в браузере'] },
    statuses: { review: 'run' },
    progress: { done: 3, total: 7, current: 'review' },
  };

  await store.check(true);

  assert.deepEqual(store.observedByTask['8324'], {
    attempt: 'a_1',
    daemon: 'running',
    result: null,
    stall: null,
    gateKnown: true,
    gate: null,
    progress: { done: 3, total: 7 },
    stage: { id: 'review', label: 'Проверка в браузере', state: 'run' },
  });
  assert.deepEqual(store.topbarItems, [{
    task: '8324',
    title: 'Проверить всплывашку',
    kind: 'running',
    stateLabel: 'В работе',
    detail: '',
    stage: 'Проверка в браузере',
    progress: { done: 3, total: 7 },
  }]);
});

test('авария: срочное оповещение с целью конвейера', async (t) => {
  const { store, harness } = await makeWatch(t);

  harness.tasks = [task(8324, CRASHED)];
  await store.check();

  const notice = harness.notifications[0].notice;

  assert.equal(notice?.id, 'stall-8324:crashed:');
  assert.equal(notice.scope, 'task:8324');
  assert.equal(notice.tone, 'danger');
  assert.equal(notice.sticky, true);
  assert.deepEqual(notice.target, { kind: 'pipeline', taskId: '8324' });
});

test('снятая авария гасит оповещение', async (t) => {
  const { store, harness } = await makeWatch(t);

  harness.tasks = [task(8324, CRASHED)];
  await store.check();
  harness.tasks = [{
    task: 8324,
    daemonAlive: true,
    stall: null,
  }];
  await store.check();
  assert.deepEqual(harness.dismissed, ['stall-8324:crashed:']);
});

/**
 * Граф держит задачу на воротах, не добавляя аварию или молчание.
 * Это отделяет правило ворот от остальных причин оповещения.
 */
function gateGraph(status = 'wait') {
  return {
    route: 'feature',
    nodes: {
      gate_plan: ['gate', 'Подтвердить план'],
    },
    pos: {
      gate_plan: [0, 0],
    },
    keys: {},
    statuses: {
      gate_plan: status,
    },
  };
}

test('ворота: срочный тост ждёт решения человека', async (t) => {
  const { store, harness } = await makeWatch(t);

  harness.tasks = [task(900001, null)];
  harness.graphs['900001'] = gateGraph();
  await store.check();

  const notice = harness.notifications[0]?.notice;

  assert.equal(notice?.id, 'conveyor-900001');
  assert.match(resolveLocaleText(notice.title), /Конвейер ждёт тебя — #900001/);
  assert.equal(notice.tone, 'warning');
  assert.equal(notice.sticky, true);
});

test('пройденные ворота гасят оповещение', async (t) => {
  const { store, harness } = await makeWatch(t);

  harness.tasks = [task(900001, null)];
  harness.graphs['900001'] = gateGraph();
  await store.check();
  harness.graphs['900001'] = gateGraph('done');
  await store.check();
  assert.deepEqual(harness.dismissed, ['conveyor-900001']);
});

test('ошибка списка задач сохраняет срочные оповещения', async (t) => {
  const { store, harness } = await makeWatch(t);

  harness.tasks = [task(8324, CRASHED)];
  await store.check();
  harness.failTasks = true;
  await store.check();
  assert.deepEqual(harness.dismissed, []);
});

test('human уведомляет исходным непустым заголовком', async (t) => {
  const { store, harness } = await makeWatch(t);
  const title = 'SKEPTIC: проверка просит решение по спорному требованию';

  await store.check(true);

  harness.tasks = [task(8324, {
    ...NO_PROGRESS,
    title,
    hint: 'Полная подсказка для карточки.',
    presentation: {
      reason: 'нужно решение человека',
      summary: 'Откройте вопрос.',
      details: { what: 'Вопрос исполнителя', action: 'Ответьте.' },
    },
  })];

  await store.check();
  await store.check();

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].body, title);
});
