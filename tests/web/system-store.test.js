import { loadProductModule } from './helpers/compile-vue.js';
import { migrationUrl } from './helpers/compile-vue.js';
// Опрос нагрузки «мозга» для шапки. Раньше таймер запускал новый GET каждые три секунды,
// не дожидаясь прежнего: при забитых соединениях браузера опросы копились десятками, а
// любая ошибка стирала метрики (`data = null`), и CPU/RAM исчезали из топбара. Теперь
// опрос один за раз, сбой оставляет последние цифры с отметкой «устарело».
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const STORE = migrationUrl('src/stores/system.ts');
const PINIA = new URL('../../web/node_modules/pinia/dist/pinia.mjs', import.meta.url).href;

let instance = 0;

/**
 * Свежий стор метрик с ленивым прокси вместо API-клиента: стор снимает значение
 * импорта один раз, поэтому подменять транспорт нужно через globalThis.
 */
async function systemFixture() {
  const [{ createPinia, setActivePinia }, { useSystemStore }] = await Promise.all([
    import(PINIA),
    loadProductModule('src/stores/system.ts', {
      '../shared/apiClient.ts': `export const api = {
        get: (...args) => globalThis.__systemApi.get(...args),
      };`,
    }),
  ]);

  setActivePinia(createPinia());

  return useSystemStore();
}

/**
 * Сервер метрик, ответами которого управляет тест: каждый GET висит, пока тест не
 * вызовет resolve/reject, а параметры запроса видны в списке вызовов.
 */
function controlledApi() {
  const calls = [];

  globalThis.__systemApi = {
    get(url, options) {
      return new Promise((resolve, reject) => {
        calls.push({
          url,
          options,
          resolve,
          reject,
        });
      });
    },
  };

  return calls;
}

const tick = () => new Promise((resolve) => {
  setImmediate(resolve);
});

test('медленный опрос не накапливает запросы: следующий ждёт конца предыдущего', async (t) => {
  const calls = controlledApi();
  const system = await systemFixture();

  t.after(() => system.stopPolling());

  system.startPolling(5);
  await new Promise((resolve) => {
    setTimeout(resolve, 60);
  });

  assert.equal(calls.length, 1, 'пока первый GET висит, новые не создаются');
  assert.equal(calls[0].options?.retry, false, 'опрос сам себе повтор: встроенный второй GET не нужен');
  assert.ok(calls[0].options?.timeoutMs > 0 && calls[0].options.timeoutMs <= 10_000,
    'опрос не висит 2×30 с на забитом соединении');

  calls[0].resolve({ cpu: { percent: 5 }, mem: { percent: 40 } });
  await tick();
  await new Promise((resolve) => {
    setTimeout(resolve, 30);
  });
  assert.equal(calls.length, 2, 'после ответа опрос продолжается');
});

test('два одновременных load делят один запрос', async () => {
  const calls = controlledApi();
  const system = await systemFixture();

  const first = system.load();
  const second = system.load();

  assert.equal(calls.length, 1);
  calls[0].resolve({ cpu: { percent: 9 } });
  await Promise.all([first, second]);
  assert.equal(system.data.cpu.percent, 9);
});

test('сбой опроса оставляет последние метрики и честно помечает их устаревшими', async () => {
  const calls = controlledApi();
  const system = await systemFixture();

  const fresh = system.load();

  calls[0].resolve({ cpu: { percent: 12 }, mem: { percent: 50 } });
  await fresh;
  assert.equal(system.stale, false);

  const updatedAt = system.updatedAt;

  assert.ok(updatedAt > 0);

  const failed = system.load();

  const timeout = new Error('The operation was aborted due to timeout');

  timeout.name = 'TimeoutError';

  calls[1].reject(timeout);
  await failed;

  assert.equal(system.data.cpu.percent, 12, 'метрики не исчезают из шапки');
  assert.equal(system.stale, true, 'показанные цифры помечены как устаревшие');
  assert.equal(system.updatedAt, updatedAt, 'время — последнего УСПЕШНОГО снимка');
  assert.ok(system.error);

  const recovered = system.load();

  calls[2].resolve({ cpu: { percent: 3 }, mem: { percent: 45 } });
  await recovered;
  assert.equal(system.stale, false);
  assert.equal(system.error, '');
  assert.equal(system.data.cpu.percent, 3);
});

test('перезапуск опроса во время висящего GET не создаёт второй параллельный запрос', async () => {
  const calls = controlledApi();
  const system = await systemFixture();

  system.startPolling(1000);
  system.stopPolling();
  system.startPolling(1000);
  assert.equal(calls.length, 1, 'перезапуск опроса не создаёт второй параллельный GET');

  calls[0].resolve({ cpu: { percent: 20 } });
  await tick();
  assert.equal(system.data.cpu.percent, 20);
  system.stopPolling();
});
