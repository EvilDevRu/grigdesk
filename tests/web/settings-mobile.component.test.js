import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

test('MW-01…MW-05: посредники, QR, отзыв с подтверждением и обновление через общую SSE-шину', async (t) => {
  await installUiBrowser(t);

  const { mount, flushPromises } =
    await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const requests = [];
  let event;
  let confirmed = false;
  const relay = {
    id: 'r12345678',
    name: 'Дом',
    host: '127.0.0.1',
    port: 443,
    fp: 'a'.repeat(64),
  };
  const status = {
    server: {
      up: true,
      port: 8144,
      error: null,
    },
    relays: [
      {
        ...relay,
        link: {
          state: 'waiting_vpn',
          since: 1,
          pipes: 0,
          lastError: null,
        },
      },
    ],
    devices: [
      {
        id: 'd12345678',
        name: 'Телефон',
        revokedAt: null,
        lastSeenAt: 1,
      },
    ],
  };

  globalThis.__mobileSettingsApi = {
    async get(url) {
      requests.push({
        method: 'GET',
        url,
      });

      return status;
    },
    /**
     * Админский stub записывает точное решение интерфейса для проверки запроса.
     * Pair и QR посредника имеют разные сроки действия и не взаимозаменяются.
     */
    async post(url, body) {
      requests.push({
        method: 'POST',
        url,
        body,
      });

      return url.endsWith('/qr')
        ? {
            svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
            text: 'cockpitlink:1:test',
            expiresAt: body.pair ? Date.now() + 600000 : null,
          }
        : { relay };
    },
  };
  globalThis.__mobileSettingsSubscribe = (listener) => {
    event = listener;
  };
  globalThis.__mobileSettingsConfirm = async () => confirmed;
  t.after(() => {
    delete globalThis.__mobileSettingsApi;
    delete globalThis.__mobileSettingsSubscribe;
    delete globalThis.__mobileSettingsConfirm;
  });

  const Component = await compileVue(webFile('src/views/settings/MobileAccess.vue'), {
    stubs: {
      '../../shared/apiClient.ts': 'export const api = globalThis.__mobileSettingsApi;',
      '../../composables/useSse.ts':
        'export const useSse = (fn) => { globalThis.__mobileSettingsSubscribe(fn); return {}; };',
      './services/dialogs': `
      export const confirmDialog = (...args) => globalThis.__mobileSettingsConfirm(...args);
      export const alertDialog = async () => {};
      export const promptDialog = async () => null;
    `,
    },
  });
  const wrapper = mount(Component, { attachTo: document.body });

  t.after(() => wrapper.unmount());
  await flushPromises();
  assert.match(wrapper.text(), /Приложение на телефоне/);
  assert.match(wrapper.text(), /Посредники/);
  assert.match(wrapper.text(), /Телефоны/);
  assert.match(wrapper.text(), /Ждёт VPN/);
  await wrapper.find('#mobile-relay-name').setValue('Новый');
  await wrapper.find('#mobile-relay-host').setValue('192.168.1.20');
  await wrapper.find('[data-testid="mobile-add-relay"]').trigger('click');
  await flushPromises();
  assert.deepEqual(requests.find((item) => item.url === '/api/mobile/relays').body, {
    name: 'Новый',
    host: '192.168.1.20',
    port: 443,
  });
  assert.match(wrapper.text(), /docker compose/);
  await wrapper.find('[data-testid="mobile-phone-qr"]').trigger('click');
  await flushPromises();
  assert.equal(document.body.querySelectorAll('[role="dialog"]').length, 1);
  assert.equal(document.body.querySelector('#mobile-qr-text').value, 'cockpitlink:1:test');
  assert.deepEqual(requests.find((item) => item.url.endsWith('/qr')).body, { pair: true });
  await wrapper.find('[data-testid="mobile-revoke"]').trigger('click');
  await flushPromises();
  assert.equal(
    requests.some((item) => item.url.endsWith('/revoke')),
    false,
  );
  confirmed = true;
  await wrapper.find('[data-testid="mobile-revoke"]').trigger('click');
  await flushPromises();
  assert.equal(requests.filter((item) => item.url.endsWith('/revoke')).length, 1);

  const before = requests.filter((item) => item.method === 'GET').length;

  event('mobile-changed', {});
  await flushPromises();
  assert.equal(requests.filter((item) => item.method === 'GET').length, before + 1);
});
