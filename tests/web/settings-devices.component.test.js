import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

test('устройства: список, подтверждённый отзыв и понятный отказ выключенного входа', async (t) => {
  await installUiBrowser(t);

  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const requests = [];
  const confirmations = [false, true];

  globalThis.__devicesConfirm = async () => confirmations.shift();
  globalThis.__devicesApi = {
    async get(url) {
      requests.push(['GET', url]);

      return {
        listener: {
          state: 'error',
          addresses: [],
          error: 'Клиентский вход не запущен (EADDRINUSE).'
        },
        currentDeviceId: 'device',
        devices: [{
          id: 'device',
          name: 'Планшет',
          scope: 'client',
          lastSeenAt: 1,
          revokedAt: null,
        }],
      };
    },
    async post(url) {
      requests.push(['POST', url]);

      if (url.endsWith('/pairing')) {
        throw Object.assign(new Error('Вход выключен'), { data: { error: 'client_listener_off' } });
      }

      return { ok: true };
    },
  };

  const component = await compileVue(webFile('src/views/settings/DevicesPanel.vue'), {
    stubs: {
      '../../shared/apiClient.ts': 'export const api = globalThis.__devicesApi;',
      '../../ui.ts': `
        export * from './src/ui.ts';
        export const confirmDialog = () => globalThis.__devicesConfirm();
      `,
    },
  });
  const wrapper = mount(component, { attachTo: document.body });

  t.after(() => wrapper.unmount());
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(wrapper.text(), /Планшет/);
  assert.match(wrapper.text(), /это устройство/);
  assert.match(wrapper.text(), /EADDRINUSE/);

  const button = wrapper.findAll('button').find((item) => item.text() === 'Отозвать');

  await button.trigger('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.some(([method]) => method === 'POST'), false);
  await button.trigger('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.some(([, url]) => url === '/api/devices/device/revoke'), true);
  await wrapper.findAll('button').find((item) => item.text() === 'Добавить устройство').trigger('click');
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(document.querySelector('input[placeholder="Например, desk.example:8145"]'));

  const input = document.querySelector('input');

  input.value = 'Планшет';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));

  const issue = [...document.querySelectorAll('button')]
    .find((item) => item.textContent.trim() === 'Получить код');

  issue.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(document.querySelector('.ui-dialog').textContent, /GRIGDESK_CLIENT_LISTEN/);

  globalThis.__devicesApi.post = async () => ({
    text: 'GRIGDESK:PAIR:1:SYNTHETIC',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" />',
    expiresAt: 1,
    expiresInMs: 600000,
  });
  issue.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.querySelector('textarea').value, 'GRIGDESK:PAIR:1:SYNTHETIC');
  assert.match(document.querySelector('.ui-dialog').textContent, /Осталось 600 с/);
});

test('устройства: медленный ответ API не передаёт строку привязки в журнал окна', async (t) => {
  const { api, setApiLogSink } = await import('../../web/src/shared/apiClient.ts');
  const previous = globalThis.fetch;
  const events = [];
  const secret = 'GRIGDESK:PAIR:1:SYNTHETIC_SECRET';
  let clock = 0;

  t.mock.method(performance, 'now', () => clock += 11000);
  setApiLogSink((event, data) => events.push({ event, data }));
  globalThis.fetch = async () => Response.json({ text: secret, svg: '<svg />' });
  t.after(() => {
    globalThis.fetch = previous;
    setApiLogSink(null);
  });

  const result = await api.post('/api/devices/pairing', { name: 'Планшет' });

  assert.equal(result.text, secret);
  assert.equal(events[0].event, 'api.slow');
  assert.equal(JSON.stringify(events).includes(secret), false);
});
