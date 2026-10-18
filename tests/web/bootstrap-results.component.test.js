import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from '../../web/node_modules/happy-dom/lib/index.js';
import { compileVue, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

const browser = new Window({ url: 'http://grigdesk.test/#/pipeline' });

for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement',
  'SVGElement', 'Event', 'CustomEvent']) {
  const value = key === 'window' ? browser : browser[key];

  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

const { mount, flushPromises } = await import(
  '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
);
const textareaFile = webFile('src/components/primitives/UiTextarea.vue');
const uiStub = [
  `export { default as UiButton } from ${JSON.stringify(webFile('src/components/primitives/UiButton.vue'))};`,
  `export { default as UiTextarea } from ${JSON.stringify(textareaFile)};`,
].join('\n');
const stubs = {
  '../../shared/apiClient.ts': 'export const api = globalThis.__bootstrapApi;',
  '../../ui': (uiStub) +
    "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";",
};

/**
 * Каждый mount получает свой API, но документ Vue общий на весь файл.
 * Проверяем настоящий SFC и публичные controls без сетевого сервера.
 */
async function component(t, name, props, api) {
  globalThis.__bootstrapApi = api;

  const wrapper = mount(await compileVue(webFile(`src/views/pipeline/${name}.vue`), { stubs }), { props });

  t.after(() => wrapper.unmount());
  await flushPromises();

  return wrapper;
}

test('приёмка показывает bootstrap deferred, ошибка удерживает ready до повторного чтения', async (t) => {
  let broken = true;
  const props = {
    task: 7,
    profile: 'demo',
    attempt: 'a_current',
  };
  const wrapper = await component(t, 'DeferredFindings', props, {
    async get() {
      if (broken) {
        throw new Error('Источник повреждён');
      }

      return {
        taskId: '7',
        profile: props.profile,
        attemptId: props.attempt,
        findings: { deferred: [{
          id: 'external-check',
          sourceNode: 'scout',
          summary: 'Проверка целевой среды',
          source: { phase: 'bootstrap' },
        }] },
      };
    },
  });

  assert.match(wrapper.text(), /Источник повреждён/);
  assert.deepEqual(wrapper.emitted('ready').at(-1), [false]);
  broken = false;
  await wrapper.get('button').trigger('click');
  await flushPromises();
  assert.match(wrapper.text(), /Разведка SCOUT/);
  assert.match(wrapper.text(), /Проверка целевой среды/);
  assert.deepEqual(wrapper.emitted('ready').at(-1), [true]);
});

test('устаревший HTTP не подменяет находки новой attempt', async (t) => {
  let oldReply;
  const wrapper = await component(t, 'DeferredFindings', {
    task: 7,
    profile: 'demo',
    attempt: 'a_old',
  }, {
    get(url) {
      if (url.includes('a_old')) {
        return new Promise((resolve) => {
          oldReply = resolve;
        });
      }

      return Promise.resolve({
        profile: 'demo',
        attemptId: 'a_new',
        findings: { deferred: [] },
      });
    },
  });

  await wrapper.setProps({ attempt: 'a_new' });
  await flushPromises();
  oldReply({
    profile: 'demo',
    attemptId: 'a_old',
    findings: { deferred: [{ id: 'old', summary: 'Чужая находка' }] },
  });
  await flushPromises();

  assert.match(wrapper.text(), /Отложенных замечаний нет/);
  assert.doesNotMatch(wrapper.text(), /Чужая находка/);
  assert.deepEqual(wrapper.emitted('ready').at(-1), [true]);
});

test('отказ resume не теряет записанный ответ, повтор запуска не дублирует решение', async (t) => {
  const calls = [];
  const stop = {
    state: 'waiting',
    phase: 'bootstrap',
    node: 'scout',
    visitId: `b_${'a'.repeat(32)}`,
    recordHash: 'b'.repeat(64),
    reason: 'Нужен выбор владельца',
    verdict: { findings: [{ id: 'owner-choice', summary: 'Какой вариант выбрать?' }] },
  };
  const wrapper = await component(t, 'BootstrapDecision', {
    task: 7,
    profile: 'demo',
    attempt: 'a_current',
    stop,
  }, {
    async post(url, body) {
      calls.push([url, body]);

      if (url.endsWith('/resume')) {
        throw new Error('Раннер недоступен');
      }

      return { ok: true, decision: { visitId: stop.visitId, stopHash: stop.recordHash } };
    },
  });

  assert.equal(wrapper.get('button').element.disabled, true);
  await wrapper.get('textarea').setValue('Выбери первый вариант.\nВторая строка решения.');
  await wrapper.get('button').trigger('click');
  await flushPromises();

  assert.match(wrapper.text(), /Ответ сохранён, продолжение не запустилось/);
  assert.equal(calls[0][1].phase, 'bootstrap');
  assert.equal(calls[0][1].visitId, stop.visitId);
  assert.match(calls[0][1].answer, /Вторая строка решения/);
  assert.deepEqual(calls[1], ['/api/tasks/7/resume', { profile: 'demo', attempt: 'a_current' }]);

  await wrapper.get('button').trigger('click');
  await flushPromises();

  assert.equal(calls.filter(([url]) => url.endsWith('/bootstrap-answer')).length, 1);
  assert.equal(calls.filter(([url]) => url.endsWith('/resume')).length, 2);
});

test('чужой ответ CAS не подтверждает решение и не запускает resume', async (t) => {
  const calls = [];
  const stop = {
    state: 'waiting',
    visitId: `b_${'a'.repeat(32)}`,
    recordHash: 'b'.repeat(64),
    reason: 'Вопрос',
  };
  const wrapper = await component(t, 'BootstrapDecision', {
    task: 7,
    profile: 'demo',
    attempt: 'a_current',
    stop,
  }, {
    async post(url) {
      calls.push(url);

      return { ok: true, decision: { visitId: `b_${'c'.repeat(32)}`, stopHash: stop.recordHash } };
    },
  });

  await wrapper.get('textarea').setValue('Ответ');
  await wrapper.get('button').trigger('click');
  await flushPromises();

  assert.match(wrapper.text(), /Сохранение ответа не подтверждено/);
  assert.deepEqual(calls, ['/api/tasks/7/bootstrap-answer']);
});

test('решение из обновления графа того же stop предлагает только отдельный resume', async (t) => {
  const calls = [];
  const stop = {
    state: 'waiting',
    visitId: `b_${'a'.repeat(32)}`,
    recordHash: 'b'.repeat(64),
    reason: 'Вопрос',
    decision: null,
  };
  const wrapper = await component(t, 'BootstrapDecision', {
    task: 7,
    profile: 'demo',
    attempt: 'a_current',
    stop,
  }, {
    async post(url, body) {
      calls.push([url, body]);

      return { ok: true };
    },
  });

  await wrapper.setProps({ stop: {
    ...stop,
    state: 'answered',
    decision: {
      recordHash: 'c'.repeat(64),
      answer: 'Решение в другой вкладке',
    },
  } });
  await flushPromises();

  assert.match(wrapper.text(), /Ответ сохранён/);
  assert.equal(wrapper.find('textarea').exists(), false);
  await wrapper.get('button').trigger('click');
  await flushPromises();
  assert.deepEqual(calls, [['/api/tasks/7/resume', { profile: 'demo', attempt: 'a_current' }]]);
});

test.after(() => browser.close());
