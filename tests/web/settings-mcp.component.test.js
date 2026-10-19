import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const REAL_MCP = {
  state: 'ok',
  checkedAt: Date.parse('2026-08-07T10:20:30Z'),
  groups: [{
    id: 'account',
    label: 'claude.ai',
    hint: 'Коннекторы аккаунта: локально их живость не проверяется.',
  }],
  servers: [
    {
      name: 'playwright',
      target: 'node /home/u/cli.js',
      scope: 'user',
      state: 'ok',
      detail: 'Connected',
    },
    {
      name: 'bitrix',
      target: 'docker run -i --rm bitrix-mcp',
      scope: 'user',
      state: 'failed',
      detail: 'Failed to connect — -32000: MCP error -32000: Connection closed',
    },
    {
      name: 'claude.ai Google Drive',
      target: 'https://drivemcp.googleapis.com/mcp/v1',
      scope: 'account',
      state: 'needs-auth',
      detail: 'Needs authentication',
      hint: 'Авторизуется в настройках коннекторов на claude.ai, не из GrigDesk.',
    },
    // Коннектор аккаунта, про который локально известно только имя.
    {
      name: 'claude.ai Canva',
      target: '',
      scope: 'account',
      state: 'remote',
      detail: '',
    },
  ],
};


test('MCP: реальные группы, состояния, причины, HTML как текст и refresh', async (t) => {
  await installUiBrowser(t);

  const [{ mount }, Component] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/views/settings/ProviderMcpStatus.vue')),
  ]);
  const wrapper = mount(Component, { props: {
    providerId: 'future',
    providerName: 'Будущий',
    status: REAL_MCP,
  } });

  t.after(() => wrapper.unmount());
  assert.deepEqual(wrapper.findAll('.mcpgrpttl').map((item) => item.text()),
    ['Пользователь (2)', 'claude.ai (2)']);
  assert.deepEqual(wrapper.findAll('.mcpst').map((item) => item.text()),
    ['Подключён', 'Не подключился', 'Нужна авторизация', 'Включён на claude.ai']);
  assert.deepEqual(wrapper.findAll('.mcpdot').map((item) => item.classes().filter((c) => c !== 'mcpdot')),
    [['ok'], ['err'], ['warn'], ['idle']]);
  assert.match(wrapper.text(), /Connection closed/);
  assert.match(wrapper.text(), /локально их живость не проверяется/);
  assert.equal(wrapper.findAll('.mcpname')[1].attributes('data-ui-tooltip'),
    'docker run -i --rm bitrix-mcp');
  await wrapper.get('.mcpbtn').trigger('click');
  assert.equal(wrapper.emitted('refresh').length, 1);

  for (const state of ['configured', 'disabled', 'unknown', 'remote']) {
    await wrapper.setProps({ status: {
      state: 'ok',
      note: 'Живая проверка недоступна',
      servers: [{
        name: '<img src=x onerror=alert(1)>',
        scope: 'user',
        state,
      }],
    } });
    assert.equal(wrapper.find('img').exists(), false);
    assert.match(wrapper.text(), /<img src=x onerror=alert/);
    assert.equal(wrapper.find('.mcpdot').classes().includes('ok'), false);
    assert.match(wrapper.text(), /Живая проверка недоступна/);
  }

  await wrapper.setProps({ status: {
    state: 'error',
    error: 'Сбой MCP',
    servers: [],
  } });
  assert.match(wrapper.get('.msg.err').text(), /Сбой MCP/);
  assert.equal(wrapper.find('.mcpgrp').exists(), false);
  await wrapper.setProps({ status: {
    state: 'ok',
    servers: [],
    emptyText: 'Пусто от адаптера',
  } });
  assert.match(wrapper.text(), /Пусто от адаптера/);
  await wrapper.setProps({ status: { state: 'ok', servers: [] } });
  assert.match(wrapper.text(), /Серверов не настроено/);
});
