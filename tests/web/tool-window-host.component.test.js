import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { hostFixture, detachButton, tick } from './helpers/tool-window-harness.js';
import { coordinatorFixture, snapshot, instance, scope } from './helpers/tool-window-coordinator.js';

/**
 * Выбор заголовка идёт по доступной надписи: проверяется настоящий control дока.
 * Отсутствующая кнопка на базе — требуемый RED, а не ошибка эмулятора Electron.
 */
async function detachedHost(t, options = {}) {
  const host = await hostFixture(t, options);

  host.dock.open('code');
  await host.settle();

  const button = detachButton(host.wrapper);

  assert.ok(button, 'В шапке Кода отсутствует подписанная кнопка «Открепить»');

  const f = await coordinatorFixture(t, { pinia: host.pinia, router: host.router });

  await button.trigger('click');
  await tick();
  await f.ready();
  await host.settle();

  return { ...host, f };
}

test('TW-U01: desktop windows показывает «Открепить»; переданная панель уходит из main', async (t) => {
  const host = await detachedHost(t);

  assert.equal(host.wrapper.findAll('[data-panel="code"]').length, 0);
  assert.equal(host.unmounts.filter((id) => id === 'code').length, 1);
  assert.equal(host.f.nativeCalls.filter(([method]) => method === 'open').length, 1);
  assert.equal(host.dock.isOpen, false);
});

test('TW-U02: tool document имеет одну registry-панель, шапку и не закрывается по Escape', async (t) => {
  const host = await hostFixture(t);
  const filename = webFile('src/views/ToolWindowPage.vue');
  const present = await access(filename).then(() => true, () => false);

  assert.equal(present, true, 'Отсутствует документ окна инструмента');

  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const channels = [];
  const originalChannel = globalThis.BroadcastChannel;

  globalThis.BroadcastChannel = class {
    onmessage = null;
    posted = [];
    constructor() {
      channels.push(this);
    }
    postMessage(data) {
      this.posted.push(data);
    }
    close() {
      this.onmessage = null;
    }
  };
  host.browser.location.href = 'http://grigdesk.test/?surface=tool&id=code&instance='
    + instance + '#/surface';
  t.after(() => {
    globalThis.BroadcastChannel = originalChannel;
  });

  const component = await compileVue(filename, {
    stubs: {

      '../stores/auth.ts': `export const useAuthStore = () => ({
        authenticated: true, clientScope: '${scope}'
      });`,

      '../stores/plugins.ts':
        'export const usePluginsStore = () => globalThis.__toolWindowHarness.plugins;',

      '../shared/tools/registry.ts': `
      export const toolsOf = () => globalThis.__toolWindowHarness.tools;
      export const toolById = (_, id) => toolsOf().find((item) => item.id === id);
      export const toolAvailability = () => 'enabled';
    `,

    }
  });
  const originalClose = window.close;
  let closes = 0;

  window.close = () => {
    closes += 1;
  };

  const child = mount(component, {

    props: {
      target: {

        kind: 'tool',

        id: 'code',

        instance

      },
      ready: true

    },

    global: { plugins: [host.pinia, host.router] },

    attachTo: document.body,

  });

  t.after(() => {
    child.unmount();
    window.close = originalClose;
  });
  await flushPromises();
  assert.equal(child.findAll('[data-panel="code"]').length, 0, 'До init панель не монтируется');

  const channel = channels.find(item => item.posted.some(message => message.type === 'ready'));

  assert.ok(channel, 'Child публикует ready до получения init');
  channel.onmessage({
    data: {

      version: 1,
      type: 'init',
      target: { kind: 'tool', id: 'code' },
      instance,

      scope,
      coordinatorEpoch: 'coordinator-aaaaaaaa',
      seq: 0,
      state: snapshot,

    }
  });
  await flushPromises();
  assert.equal(child.findAll('[data-panel="code"]').length, 1);
  assert.deepEqual(host.imports, [['code', snapshot]], 'Init передаёт снимок смонтированной панели');
  assert.equal(child.find('[data-panel="code"]').text(), 'page');
  assert.match(child.text(), /Вернуть в колонку/);
  assert.ok(child.findAll('button').some((button) => /Закрыть/.test(
    button.text() + ' ' + button.attributes('aria-label'),
  )));

  let escaped = 0;

  child.element.addEventListener('keydown', () => {
    escaped += 1;
  });
  await child.trigger('keydown', { key: 'Escape', code: 'Escape' });
  assert.equal(escaped, 1);
  assert.equal(closes, 0);

  const source = await readFile(filename, 'utf8');
  const app = await readFile(webFile('src/App.vue'), 'utf8');

  assert.match(source, /(?:-webkit-)?app-region:\s*drag/);
  assert.match(source, /(?:-webkit-)?app-region:\s*no-drag/);
  assert.match(app, /ToolWindowPage/);
  assert.match(app, /TaskWindowPage/);
});

test('TW-U03: return восстанавливает док один раз; обычное close оставляет док скрытым', async (t) => {
  const host = await detachedHost(t);

  await host.f.receive('return', { seq: 1, state: snapshot });
  await host.settle();
  assert.equal(host.wrapper.findAll('[data-panel="code"]').length, 1);
  assert.equal(host.dock.isOpen, true);
  assert.equal(host.f.channels.main.posted.at(-1).type, 'return-ack');
  await host.f.receive('return', { seq: 1, state: snapshot });
  await host.settle();
  assert.equal(host.wrapper.findAll('[data-panel="code"]').length, 1);
});

test(
  'TW-U03b: возврат при 899 px сохраняет файл/строку/черновик на странице или видимо отказывает',
  async (t) => {
    const host = await hostFixture(t, { width: 899 });
    const f = await coordinatorFixture(t, {

      pinia: host.pinia,

      router: host.router,

      canDock: () => false,

    });
    const opening = f.coordinator.detach('code');

    await tick();
    await f.ready();
    await opening;
    await f.receive('return', { seq: 1, state: snapshot });
    await host.settle();

    const reply = f.channels.main.posted.findLast((message) => message.type === 'return-ack');

    assert.ok(reply, 'Return должен подтвердить показ панели либо явный отказ');

    if(reply.accepted === false) {
      assert.equal(typeof reply.error, 'string');
      assert.ok(reply.error.length > 0);
      assert.equal(f.mounted.has('code'), false);
    } else {
      assert.equal(host.router.currentRoute.value.path, '/code');
      assert.deepEqual(f.events.find((event) => Array.isArray(event) && event[0] === 'mount:code'), [
        'mount:code', snapshot,
      ]);
      assert.equal(host.wrapper.findAll('[data-panel="code"]').length, 1);
    }
  });
