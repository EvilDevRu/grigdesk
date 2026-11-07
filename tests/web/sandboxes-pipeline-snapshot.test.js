import assert from 'node:assert/strict';
import test from 'node:test';
import { compileModule, webFile } from './helpers/compile-vue.js';

const channel = `
const h = globalThis.__sandboxSnapshotHarness;
export const sandboxPipelineSnapshot = { get value() { return h.latest; } };
export const publishSandboxPipelineSnapshot = (value) => {
  h.publications.push(value);
  h.latest = value;
};
export const markSandboxPipelineSnapshotError = (error) => {
  h.errors.push(error);
  h.latest = { ...h.latest, error };
};
`;
/**
 * Настоящий watcher декодирует те же tasks и graph, что в рабочем окне.
 * Новый канал подменён на приёмник, поэтому исходный код падает на отсутствии публикации.
 */
async function watcher(t) {
    const tasks = [
        {
            task: '11',
            title: 'Работает',
            profile: 'demo-shop',
            daemonAlive: true
        },
        {
            task: '12',
            title: 'На воротах',
            profile: 'demo-shop',
            daemonAlive: false
        },
        {
            task: '13',
            title: 'Встал',
            profile: 'demo-tools',
            daemonAlive: true,
            stall: {
                kind: 'human',
                title: 'Нужно решение',
                stage: 'BUILD'
            },
        },
        {
            task: '14',
            title: 'Молчит',
            profile: 'demo-tools',
            daemonAlive: true,
            silence: {
                sec: 600,
                stage: 'BUILD',
                tool: 'shell'
            },
        },
        {
            task: '15',
            title: 'Полное неактивное название',
            profile: 'demo-shop',
            result: 'done'
        },
        {
            task: '16',
            title: 'Остановлена',
            profile: 'demo-tools',
            result: 'stopped'
        },
        {
            task: '17',
            title: 'Только чтение',
            profile: 'demo-tools',
            readOnly: true,
            daemonAlive: true
        },
    ];
    const harness = {
        tasks,
        fail: false,
        requests: [],
        publications: [],
        errors: [],
        latest: null,
        notifications: [],
    };

    globalThis.__sandboxSnapshotHarness = harness;
    t.after(() => {
        delete globalThis.__sandboxSnapshotHarness;
    });

    const stubs = {
        '../shared/apiClient.ts': `
export { failureText } from '${webFile('src/shared/apiClient.ts')}';
export const api = { async get(url) {
  const h = globalThis.__sandboxSnapshotHarness;
  h.requests.push(url);
  if (url === '/api/tasks?sources=1') {
    if (h.fail) throw new Error('Источник недоступен');
    return { tasks: h.tasks, silenceWindow: 300 };
  }
  return url === '/api/tasks/12/graph'
    ? { nodes: { gate_accept: ['gate', 'Принять'] }, statuses: { gate_accept: 'wait' } }
    : { nodes: {}, statuses: {}, progress: { done: 1, total: 2 } };
} };
`,
        '../shared/alerts.ts': `
export const alertUser = (value) => {
  globalThis.__sandboxSnapshotHarness.notifications.push(value);
};
export const dismissAlert = () => {};
`,
        '../shared/sandboxPipelineSnapshot.ts': channel,
        '../shared/sandboxPipelineSnapshot': channel,
    };
    const module = await compileModule(webFile('src/stores/notifyWatch.ts'), { stubs });
    const { createPinia, setActivePinia } = await import('../../web/node_modules/pinia/dist/pinia.mjs');

    setActivePinia(createPinia());
    t.mock.method(globalThis, 'setInterval', () => {
        throw new Error('check не должен запускать опрос');
    });

    return { store: module.useNotifyWatchStore(), harness };
}

test('полный снимок публикует и неактивную задачу без новых запросов', async (t) => {
    const { store, harness } = await watcher(t);

    await store.check(true);
    assert.equal(harness.publications.length, 1, 'После check публикуется полный снимок для песочниц');

    const published = harness.latest;

    assert.deepEqual(published.tasks.map(({ task, title, profile }) => ({
        task,
        title,
        profile
    })), harness.tasks.map(({ task, title, profile }) => ({
        task,
        title,
        profile
    })));
    assert.equal(published.tasks.find((task) => task.task === '17').readOnly, true);
    assert.equal(published.tasks.find((task) => task.task === '15').result, 'done');

    for (const key of ['running', 'waiting', 'stalled', 'silent', 'observedByTask']) {
        assert.deepEqual(published[key], JSON.parse(JSON.stringify(store[key])), key);
    }

    assert.deepEqual(published.waiting.map((item) => item.task), ['12']);
    assert.deepEqual(published.stalled.map((item) => item.task), ['13']);
    assert.deepEqual(published.silent.map((item) => item.task), ['14']);
    assert.equal(published.loadedAt, store.loadedAt);
    assert.equal(published.error, null);
    assert.deepEqual(harness.requests,
        ['/api/tasks?sources=1',
        ...harness.tasks.map((task) => `/api/tasks/${task.task}/graph`)]);
    assert.deepEqual(harness.notifications, []);
});
test('ошибка источника сохраняет снимок и помечает устаревание', async (t) => {
    const { store, harness } = await watcher(t);

    await store.check(true);
    assert.equal(harness.publications.length, 1, 'Есть успешный снимок перед отказом источника');

    const before = JSON.parse(JSON.stringify(harness.latest));

    harness.fail = true;
    await store.check(true);
    assert.equal(harness.publications.length, 1);
    assert.equal(harness.errors.length, 1);
    assert.deepEqual(harness.latest.tasks, before.tasks);
    assert.deepEqual(harness.latest.observedByTask, before.observedByTask);
    assert.equal(harness.latest.loadedAt, before.loadedAt);
    assert.match(String(harness.latest.error), /Источник недоступен/);
    assert.equal(harness.requests.at(-1), '/api/tasks?sources=1');
    assert.equal(harness.requests.length, harness.tasks.length + 2);
});
test('новый успешный снимок удаляет исчезнувшую задачу', async (t) => {
    const { store, harness } = await watcher(t);

    await store.check(true);
    assert.equal(harness.publications.length, 1, 'Есть первый снимок для сравнения');
    harness.fail = true;
    await store.check(true);
    harness.fail = false;
    harness.tasks = [harness.tasks[0]];
    await store.check(true);
    assert.equal(harness.publications.length, 2);
    assert.deepEqual(harness.latest.tasks.map((task) => task.task), ['11']);
    assert.deepEqual(Object.keys(harness.latest.observedByTask), ['11']);
    assert.deepEqual(harness.latest.waiting, []);
    assert.deepEqual(harness.latest.stalled, []);
    assert.deepEqual(harness.latest.silent, []);
    assert.equal(harness.latest.error, null);
});
