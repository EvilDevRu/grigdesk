import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const PERMISSION_PATH = webFile('src/views/chat/ChatPermission.vue');

async function mountPermission(t, req) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/chats');
  globalThis.__dbPermissionPrompt = async () => null;
  const [{ mount, flushPromises }, component] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(PERMISSION_PATH, {
      stubs: {
        './services/dialogs': `
          export const promptDialog = (value) => globalThis.__dbPermissionPrompt(value);
          export const confirmDialog = () => Promise.resolve(false);
          export const alertDialog = () => Promise.resolve();
        `,
      },
    }),
  ]);
  const wrapper = mount(component, {
    attachTo: browser.document.querySelector('#mount'),
    props: { req },
  });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__dbPermissionPrompt;
  });
  await flushPromises();
  return wrapper;
}

function textOf(wrapper, selector) {
  const element = wrapper.find(selector);
  return element.exists() ? element.text() : null;
}

test('DB-карточка показывает профиль движок прод класс таблицы и оценку записи', async (t) => {
  const wrapper = await mountPermission(t, {
    pid: 'db-p1',
    origin: 'db',
    kind: 'perm',
    tool: 'supervised_db',
    profile: { label: 'Прод-заказы', role: 'write' },
    engine: { id: 'mysql', label: 'MySQL' },
    prod: true,
    query: 'UPDATE orders SET state = ? WHERE id = ?',
    queryClass: 'write',
    tables: ['orders'],
    rowEstimate: 1,
    autoReadReason: { code: 'not_read', message: 'Запись всегда подтверждает человек' },
  });

  assert.deepEqual({
    profile: textOf(wrapper, '[data-db-profile]'),
    engine: textOf(wrapper, '[data-db-engine]'),
    prod: textOf(wrapper, '[data-db-prod]'),
    query: textOf(wrapper, '[data-db-query]'),
    queryClass: textOf(wrapper, '[data-db-class]'),
    tables: textOf(wrapper, '[data-db-tables]'),
    rowEstimate: textOf(wrapper, '[data-db-row-estimate]'),
    remember: wrapper.find('input[type="checkbox"]').exists(),
  }, {
    profile: 'Прод-заказы — запись',
    engine: 'MySQL',
    prod: 'прод',
    query: 'UPDATE orders SET state = ? WHERE id = ?',
    queryClass: 'запись',
    tables: 'orders',
    rowEstimate: '1',
    remember: false,
  });
});

test('DB-карточка называет причину неприменённого auto-read', async (t) => {
  const wrapper = await mountPermission(t, {
    pid: 'db-p2',
    origin: 'db',
    kind: 'perm',
    tool: 'supervised_db',
    profile: { label: 'Прод-заказы', role: 'read' },
    engine: { id: 'clickhouse', label: 'ClickHouse' },
    prod: true,
    query: 'SELECT id FROM orders',
    queryClass: 'read',
    tables: ['orders'],
    rowEstimate: null,
    autoReadReason: {
      code: 'prod_auto_read_disabled',
      message: 'Авточтение на проде выключено',
    },
  });

  assert.equal(
    textOf(wrapper, '[data-db-auto-read-reason]'),
    'Авточтение на проде выключено',
  );
});
