import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

test('MW-01…MW-05: посредники, QR, отзыв с подтверждением и обновление через общую SSE-шину', async (t) => {
  await installUiBrowser(t);

  const { mount, flushPromises, DOMWrapper } =
    await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const requests = [];
  let event;
  let confirmed = false;
  let expiredQr = false;
  let qrError = false;
  let releaseStatus;
  let statusGate = new Promise((resolve) => {
    releaseStatus = resolve;
  });
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
      {
        id: 'd87654321',
        name: 'Старый телефон',
        revokedAt: 1,
      },
    ],
  };

  globalThis.__mobileSettingsApi = {
    async get(url) {
      requests.push({
        method: 'GET',
        url,
      });

      await statusGate;

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

      if (url.endsWith('/qr') && qrError) {
        throw new Error('Не удалось получить QR');
      }

      return url.endsWith('/qr')
        ? {
            svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
            text: 'grigdesklink:1:test',
            expiresAt: body.pair ? Date.now() + (expiredQr ? -1000 : 600000) : null,
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
  const body = new DOMWrapper(document.body);

  t.after(() => wrapper.unmount());
  await flushPromises();
  assert.equal(wrapper.find('.mobile-access').attributes('aria-busy'), 'true');
  assert.equal(wrapper.findAll('.mobile-card').length, 2);
  assert.equal(wrapper.findAll('.mobile-skeleton').length, 3);
  assert.equal(wrapper.find('[data-testid="mobile-open-add"]').attributes('disabled') !== undefined, true);
  releaseStatus();
  await flushPromises();
  assert.equal(wrapper.find('.mobile-access').attributes('aria-busy'), 'false');
  assert.match(wrapper.text(), /Приложение на телефоне/);
  assert.match(wrapper.text(), /Подключение через посредника/);
  assert.match(wrapper.text(), /Привязанные телефоны/);
  assert.match(wrapper.text(), /Ждёт VPN/);
  assert.equal(wrapper.text().includes('Старый телефон'), false);
  await wrapper.find('[aria-controls="mobile-revoked-devices"]').trigger('click');
  assert.match(wrapper.text(), /Старый телефон/);
  assert.equal(wrapper.findAll('[data-testid="mobile-revoke"]').length, 1);
  assert.equal(wrapper.find('#mobile-relay-name').exists(), false);
  await wrapper.find('[data-testid="mobile-open-add"]').trigger('click');
  await body.find('#mobile-relay-name').setValue('Новый');
  await body.find('#mobile-relay-host').setValue('192.168.1.20');
  await body.find('#mobile-relay-port').setValue('0');
  await body.find('#mobile-relay-form').trigger('submit');
  assert.equal(requests.some((item) => item.url === '/api/mobile/relays'), false);
  await body.find('#mobile-relay-port').setValue('443');
  await body.find('#mobile-relay-form').trigger('submit');
  await flushPromises();
  assert.deepEqual(requests.find((item) => item.url === '/api/mobile/relays').body, {
    name: 'Новый',
    host: '192.168.1.20',
    port: 443,
  });
  assert.match(wrapper.text(), /docker compose/);
  assert.equal(body.find('[role="dialog"]').exists(), false);
  await wrapper.find('[data-testid="mobile-phone-qr"]').trigger('click');
  await flushPromises();
  assert.equal(document.body.querySelectorAll('[role="dialog"]').length, 1);
  assert.equal(body.find('#mobile-qr-text').exists(), false);
  await body.find('[aria-controls="mobile-qr-manual"]').trigger('click');
  assert.equal(body.find('#mobile-qr-text').element.value, 'grigdesklink:1:test');
  assert.deepEqual(requests.find((item) => item.url.endsWith('/qr')).body, { pair: true });
  await body.find('[data-testid="mobile-copy-qr"]').trigger('click');
  await flushPromises();
  assert.match(body.text(), /Код скопирован/);
  await body.findAll('button').find((button) => button.text() === 'Закрыть').trigger('click');
  await flushPromises();
  assert.equal(body.find('#mobile-qr-text').exists(), false);
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

  statusGate = new Promise((resolve) => {
    releaseStatus = resolve;
  });
  event('mobile-changed', {});
  await flushPromises();
  assert.equal(wrapper.findAll('.mobile-skeleton').length, 0);
  assert.equal(wrapper.findAll('[data-testid="mobile-revoke"]').length, 1);
  releaseStatus();
  await flushPromises();
  assert.equal(requests.filter((item) => item.method === 'GET').length, before + 1);

  expiredQr = true;
  await wrapper.find('[data-testid="mobile-phone-qr"]').trigger('click');
  await flushPromises();
  assert.match(body.text(), /Срок действия QR-кода истёк/);
  assert.equal(body.find('[role="dialog"] img').exists(), false);
  assert.equal(body.find('[data-testid="mobile-copy-qr"]').attributes('disabled') !== undefined, true);
  expiredQr = false;
  await body.find('[data-testid="mobile-refresh-qr"]').trigger('click');
  await flushPromises();
  assert.equal(body.find('[role="dialog"] img').exists(), true);
  await body.findAll('button').find((button) => button.text() === 'Закрыть').trigger('click');
  await wrapper.findAll('button').find((button) => button.text() === 'QR посредника').trigger('click');
  await flushPromises();
  assert.equal(requests.filter((item) => item.url.endsWith('/qr')).at(-1).body.pair, false);
  assert.equal(body.find('[role="dialog"]').text().includes('Код действует'), false);
  await body.findAll('button').find((button) => button.text() === 'Закрыть').trigger('click');
  qrError = true;
  await wrapper.find('[data-testid="mobile-phone-qr"]').trigger('click');
  await flushPromises();
  assert.match(body.find('[role="dialog"] [role="alert"]').text(), /Не удалось получить QR/);
  qrError = false;
  await body.findAll('button').find((button) => button.text() === 'Повторить загрузку QR').trigger('click');
  await flushPromises();
  assert.equal(body.find('[role="dialog"] img').exists(), true);
});
