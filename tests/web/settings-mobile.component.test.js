import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

test('MW-01…MW-05: загрузка, посредники add/env/delete, ошибка, SSE; v1 QR и телефонов нет', async (t) => {
  await installUiBrowser(t);

  const { mount, flushPromises, DOMWrapper } =
    await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const requests = [];
  let event;
  let confirmed = false;
  let failLoad = false;
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
      fp: 'b'.repeat(64),
      error: null,
    },
    relays: [{
      ...relay,
      link: {
        state: 'waiting_vpn',
        since: 1,
        pipes: 0,
        lastError: null,
      },
    }],
  };

  globalThis.__mobileSettingsApi = {
    /**
     * До разрешения промиса удерживает загрузку для проверки каркаса.
     * Затем возвращает текущий снимок и позволяет имитировать отказ сети.
     */
    async get(url) {
      requests.push({ method: 'GET', url });
      await statusGate;

      if (failLoad) {
        throw new Error('сеть недоступна');
      }

      return status;
    },
    async post(url, body) {
      requests.push({
        method: 'POST',
        url,
        body,
      });

      return { relay };
    },
    async downloadGet(url) {
      requests.push({ method: 'GET', url });

      return { blob: new Blob(['relay.env']) };
    },
    async del(url) {
      requests.push({ method: 'DELETE', url });

      return { ok: true };
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

  // Загрузка: busy, skeleton, кнопка добавления заблокирована.
  await flushPromises();
  assert.equal(wrapper.find('.mobile-access').attributes('aria-busy'), 'true');
  assert.equal(wrapper.findAll('.mobile-skeleton').length >= 1, true);
  assert.equal(wrapper.find('[data-testid="mobile-open-add"]').attributes('disabled') !== undefined, true);
  releaseStatus();
  await flushPromises();

  // v1-поверхности отсутствуют; одна карточка посредников.
  assert.equal(wrapper.find('[data-testid="mobile-phone-qr"]').exists(), false);
  assert.equal(wrapper.find('[data-testid="mobile-revoke"]').exists(), false);
  assert.equal(wrapper.text().includes('Привязанные телефоны'), false);
  assert.equal(wrapper.findAll('.mobile-card').length, 1);
  assert.match(wrapper.text(), /Подключение через посредника/);
  assert.match(wrapper.text(), /Ждёт VPN/);

  // Валидация порта: 0 не отправляет запрос.
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
  // Подсказка установки relay.env остаётся (блок mobile-install).
  assert.equal(wrapper.find('.mobile-install pre').exists(), true);

  // Скачивание relay.env.
  await wrapper.findAll('button').find((b) => b.text() === 'Скачать relay.env').trigger('click');
  await flushPromises();
  assert.equal(requests.some((item) => item.url.endsWith('/env')), true);

  // Удаление посредника подтверждается общим диалогом.
  confirmed = true;
  await wrapper.findAll('button').find((b) => b.text() === 'Удалить посредника').trigger('click');
  await flushPromises();
  assert.equal(requests.filter((item) => item.method === 'DELETE').length, 1);

  // Ошибка загрузки и повтор.
  failLoad = true;
  event('mobile-changed', {});
  await flushPromises();
  assert.match(wrapper.text(), /сеть недоступна/);
  failLoad = false;
  await wrapper.findAll('button').find((b) => b.text() === 'Повторить загрузку').trigger('click');
  await flushPromises();
  assert.equal(wrapper.find('.mobile-access').attributes('aria-busy'), 'false');

  // Ошибка хаба/личности видна в danger-блоке; v1-warning «ещё не запущен» отсутствует.
  status.server.error = 'Хаб не запущен';
  event('mobile-changed', {});
  await flushPromises();
  assert.match(wrapper.get('.ui-inline-message--danger').text(), /Хаб не запущен/);
  assert.equal(wrapper.text().includes('Мобильный доступ ещё не запущен'), false);

  // Пустое состояние посредников не обещает QR.
  status.server.error = null;
  status.relays = [];
  event('mobile-changed', {});
  await flushPromises();
  assert.match(wrapper.text(), /Статус посредника появится здесь/);
  assert.equal(wrapper.text().includes('QR для телефона'), false);
});
