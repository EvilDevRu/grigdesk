import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { phoneBrowser } from './helpers/phoneBrowser.js';

process.env.NODE_ENV = 'test';

test('устройства: список, подтверждённый отзыв и понятный отказ выключенного входа', async (t) => {
  phoneBrowser();

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
  assert.match(document.querySelector('.ui-dialog').textContent, /Доступ к серверу|[Вв]ключ/);

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
  assert.ok(events.some((event) => event.event === 'api.slow'));
  assert.equal(JSON.stringify(events).includes(secret), false);
});


for (const action of ['rename', 'revoke']) {
  test(`PHONE-15: ${action} не смешивается между серверами`, async (t) => {
    const { deferred, phoneHarness } = await import('./helpers/phoneAccess.js');
    const pending = deferred();
    const method = action === 'rename' ? 'PATCH' : 'POST';
    const endpoint = action === 'rename' ? '/api/devices/d12345678' : '/api/devices/d12345678/revoke';
    const h = await phoneHarness(t, {
      settings: true,
      answers: {
        'GET /api/devices': () => ({
          devices: [{
            id: 'd12345678',
            name: 'Телефон А',
            scope: 'client',
            lastSeenAt: 1,
            revokedAt: null,
          }],
          listener: { state: 'online', addresses: [] },
        }),
        [`${method} ${endpoint}`]: () => pending.promise,
      },
    });

    await h.click(action === 'rename' ? /Переименовать/ : /Отозвать/);

    if (action === 'rename') {
      const input = document.querySelector('.ui-dialog input');

      input.value = 'Изменённое имя А';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const caption = action === 'rename' ? /Сохранить/ : /Отозвать/;
    const confirm = [...document.querySelector('.ui-dialog').querySelectorAll('button')]
      .find((button) => caption.test(button.textContent));

    assert.ok(confirm);
    confirm.click();
    await new Promise((resolve) => setImmediate(resolve));

    const callsBefore = h.requests.length;

    h.shell.apply({
      rev: 2,
      status: 'online',
      profile: {
        id: 'b',
        name: 'Сервер Б',
        kind: 'remote',
        address: 'https://b.example:443'
      },
      profiles: [],
      localAvailable: false,
      capabilities: [],
    });
    h.auth.clientScope = 'scope-b';
    h.answers['GET /api/devices'] = () => ({
      devices: [],
      listener: { state: 'online', addresses: [] },
    });
    await h.flushPromises();
    pending.resolve({ ok: true });
    await h.flushPromises();
    assert.equal(Boolean(document.querySelector('.ui-dialog')), false);
    assert.doesNotMatch(h.wrapper.text(), /Изменённое имя А|Телефон А/);

    const repeated = h.requests.slice(callsBefore)
      .some((call) => call.method === method && call.url === endpoint);

    assert.equal(repeated, false);
  });
}


test('PHONE-12: поздний legacy QR после close/reopen не подменяет новый', async (t) => {
  phoneBrowser();

  const { deferred } = await import('./helpers/phoneAccess.js');
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const pending = deferred();
  const current = {
    text: 'GRIGDESK:PAIR:1:CURRENT',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" />',
    expiresInMs: 600000,
  };
  let calls = 0;

  globalThis.__legacyPhoneApi = {
    post: () => ++calls === 1 ? pending.promise : Promise.resolve(current),
  };

  const component = await compileVue(webFile('src/views/settings/PairDeviceDialog.vue'), {
    expose: ['issue'],
    stubs: {
      '../../shared/apiClient.ts': 'export const api = globalThis.__legacyPhoneApi;',
    },
  });
  const wrapper = mount(component, {
    attachTo: document.body,
    props: { open: true, draft: { name: 'Компьютер', address: 'desk.example:8145' } },
    global: {
      stubs: {
        UiDialog: {
          props: ['open'],
          template: '<div v-if="open"><slot /><slot name="footer" /></div>',
        },
      },
    },
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__legacyPhoneApi;
  });

  const previous = wrapper.vm.issue();

  await wrapper.setProps({ open: false });
  await wrapper.setProps({ open: true });
  await wrapper.vm.issue();
  pending.resolve({ ...current, text: 'GRIGDESK:PAIR:1:STALE' });
  await previous;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(wrapper.find('textarea').exists(), true, 'Новый QR должен быть показан до позднего ответа');
  assert.equal(wrapper.find('textarea').element.value, current.text);
});
