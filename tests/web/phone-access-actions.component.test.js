import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred, phoneHarness } from './helpers/phoneAccess.js';

process.env.NODE_ENV = 'test';
// Раздел ретранслятора подписывается на общую шину SSE; в happy-dom её заменяет пустой поток.
globalThis.EventSource ??= class {
  addEventListener() {}
  close() {}
};

const PROGRESS_WAIT_MS = 2200;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dialogText() {
  return document.querySelector('.phone-connect')?.textContent ?? '';
}

function requestsOf(h, method, url) {
  return h.requests.filter((call) => call.method === method && (!url || call.url === url));
}

/**
 * Значение поля задаётся через событие input, как при вводе человеком.
 * Vue-модель видит изменение до следующего действия теста.
 */
async function type(h, element, value) {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  await h.flushPromises();
}

/**
 * Связь сервера с ретранслятором в форме DTO сервера: состояние, совместимость и код ошибки.
 * Ожидаемый текст объясняет причину, а не просит обновить исправный ретранслятор.
 */
function relayLink(state, lastError, text, compatibility = 'unknown') {
  return {
    state,
    compatibility,
    lastError,
    text,
  };
}

function relay(link, extra = {}) {
  return {
    id: 'r1',
    name: 'Ретранслятор',
    enabled: true,
    phoneEligible: false,
    phoneError: link.state,
    link,
    ...extra,
  };
}

for (const link of [
  relayLink('offline', null, /Нет связи сервера/),
  relayLink('connecting', null, /[Пп]одключ/),
  relayLink('online', null, /совместимость.*проверяется/),
  relayLink('error', 'relay_pin_mismatch', /Сертификат ретранслятора/),
]) {
  test(`PHONE-A5: ретранслятор ${link.state}/${link.compatibility} назван по причине`, async (t) => {
    const h = await phoneHarness(t);

    h.status.relays = [relay(link, { phoneError: link.state === 'online' ? 'unknown' : link.state })];
    h.issued.includedRelayId = null;
    await h.click(/Подключить телефон/);

    const text = dialogText();

    assert.doesNotMatch(text, /Обновите ретранслятор/);
    assert.doesNotMatch(text, /relay_pin_mismatch/, 'код relayLink не показывается сырым');
    assert.match(text, link.text);
    assert.match(text, /вне дома/i, 'QR без ретранслятора предупреждает об этом');
  });
}

test('PHONE-A5: QR с ретранслятором не предупреждает о его отсутствии', async (t) => {
  const h = await phoneHarness(t);

  h.status.relays = [relay(relayLink('online', null, null, 'supported'), {
    phoneEligible: true,
    phoneError: null,
  })];
  h.issued.includedRelayId = 'r1';
  await h.click(/Подключить телефон/);
  assert.match(dialogText(), /Готов к подключению/);
  assert.doesNotMatch(dialogText(), /вне дома/i);
});

test('PHONE-A6: подключение убирает QR, код, таймеры и опрос, оставляя переименование', async (t) => {
  const h = await phoneHarness(t);

  h.issued.expiresInMs = 3500;
  await h.click(/Подключить телефон/);
  h.connected();
  await wait(PROGRESS_WAIT_MS);
  await h.flushPromises();

  const dialog = document.querySelector('.phone-connect');

  assert.match(dialog.textContent, /подключён/i);
  assert.equal(Boolean(dialog.querySelector('img')), false);
  assert.equal(Boolean(dialog.querySelector('textarea')), false);
  assert.doesNotMatch(dialog.textContent, /Копировать|осталось/i);
  assert.ok(dialog.querySelector('input'));

  const count = h.requests.length;

  await wait(PROGRESS_WAIT_MS);
  await h.flushPromises();
  assert.equal(h.requests.length, count, 'после успеха опрос остановлен');
  assert.doesNotMatch(dialog.textContent, /истёк/i);
});

test('PHONE-A6: телефон, подключившийся во время смены порта, сохраняет успех', async (t) => {
  const put = deferred();
  const h = await phoneHarness(t, { answers: { 'PUT /api/devices/access/direct': () => put.promise } });

  await h.click(/Подключить телефон/);
  await h.dialogClick(/Настроить прямой доступ/);
  await type(h, document.querySelector('.phone-connect select'), '192.0.2.10');
  await h.dialogClick(/Применить сеть и порт/);
  h.connected();
  await wait(PROGRESS_WAIT_MS);
  await h.flushPromises();
  assert.match(dialogText(), /подключён/i);

  const posts = requestsOf(h, 'POST', '/api/devices/phone-pairing').length;

  put.resolve(structuredClone(h.status));
  await h.flushPromises();
  assert.match(dialogText(), /подключён/i, 'успех не затёрт новым QR');
  assert.equal(requestsOf(h, 'POST', '/api/devices/phone-pairing').length, posts);
  assert.equal(Boolean(document.querySelector('.phone-qr')), false);
});

test('PHONE-A7: при готовом доступе настройка сети свёрнута, QR сразу', async (t) => {
  const h = await phoneHarness(t);

  await h.click(/Подключить телефон/);
  assert.ok(document.querySelector('.phone-qr'));
  assert.equal(Boolean(document.querySelector('.phone-connect select')), false);
  await h.dialogClick(/Настроить прямой доступ/);
  assert.ok(document.querySelector('.phone-connect select'));
  assert.ok(document.querySelector('.phone-connect input[type=number]'));
  assert.match(dialogText(), /Выключить прямой доступ/);
});

test('PHONE-A7: выключение спрашивает общий диалог; отмена ничего не меняет', async (t) => {
  const h = await phoneHarness(t, {
    answers: {
      'PUT /api/devices/access/direct': (call) => {
        if (call.body.enabled === false) {
          h.status.direct = {
            enabled: false,
            state: 'disabled',
            addresses: [],
            error: null,
          };
        }

        return structuredClone(h.status);
      },
    },
  });

  await h.click(/Подключить телефон/);
  await h.dialogClick(/Настроить прямой доступ/);
  await h.dialogClick(/^\s*Выключить прямой доступ\s*$/);
  assert.equal(requestsOf(h, 'PUT').length, 0);

  const cancel = [...document.querySelectorAll('.ui-dialog-host__actions button')]
    .find((button) => /Отмена/.test(button.textContent));

  assert.ok(cancel, 'подтверждение показано общим диалогом');
  cancel.click();
  await h.flushPromises();
  assert.equal(requestsOf(h, 'PUT').length, 0);
  await h.dialogClick(/^\s*Выключить прямой доступ\s*$/);

  const approve = [...document.querySelectorAll('.ui-dialog-host__actions button')]
    .find((button) => !/Отмена|Закрыть|×/.test(button.textContent));

  approve.click();
  await h.flushPromises();
  assert.equal(requestsOf(h, 'PUT')[0].body.enabled, false);
  assert.equal(Boolean(document.querySelector('.phone-qr')), false, 'QR с выключенным адресом убран');
});

test('PHONE-A7: сломанный сохранённый вход можно выключить; отказ назван выключением', async (t) => {
  const h = await phoneHarness(t, {
    answers: {
      'PUT /api/devices/access/direct': () => {
        throw new Error('disk');
      },
    },
  });

  h.status.direct = {
    enabled: true,
    state: 'error',
    addresses: [{ host: '192.0.2.10', port: 8145 }],
    error: 'Сохранённая сеть или порт недоступны.',
  };
  await h.click(/Подключить телефон/);
  await h.dialogClick(/^\s*Выключить прямой доступ\s*$/);
  [...document.querySelectorAll('.ui-dialog-host__actions button')]
    .find((button) => !/Отмена|Закрыть|×/.test(button.textContent)).click();
  await h.flushPromises();
  assert.match(dialogText(), /Не удалось выключить прямой доступ/);
  assert.doesNotMatch(dialogText(), /Не удалось включить/);
});

test('PHONE-A7: смена порта отправляется явно, имя телефона меняется после подключения', async (t) => {
  const h = await phoneHarness(t, {
    answers: { 'PATCH /api/devices/d12345678': () => ({ device: { id: 'd12345678', name: 'Мой телефон' } }) },
  });

  await h.click(/Подключить телефон/);
  await h.dialogClick(/Настроить прямой доступ/);
  await type(h, document.querySelector('.phone-connect select'), '192.0.2.10');
  await type(h, document.querySelector('.phone-connect input[type=number]'), '8445');
  await h.dialogClick(/Применить сеть и порт/);
  assert.equal(requestsOf(h, 'PUT')[0].body.addresses[0].port, 8445);
  h.connected();
  await wait(PROGRESS_WAIT_MS);
  await h.flushPromises();
  await type(h, document.querySelector('.phone-connect input'), 'Мой телефон');
  await h.dialogClick(/^\s*Сохранить\s*$/);
  assert.equal(requestsOf(h, 'PATCH')[0].body.name, 'Мой телефон');
});

test('PHONE-A7: сужение входа «все сети» предупреждает до применения', async (t) => {
  const h = await phoneHarness(t);

  h.status.direct.addresses = ['0.0.0.0:8145'];
  await h.click(/Подключить телефон/);
  await h.dialogClick(/Настроить прямой доступ/);
  assert.match(dialogText(), /оставит только выбранную сеть/);
});

test('PHONE-A8: choose_address раскрывает выбор сети и выдаёт QR на действующий порт', async (t) => {
  const h = await phoneHarness(t);

  h.status.direct.addresses = ['0.0.0.0:8145'];
  h.status.networks.push({ name: 'vpn', address: '192.0.2.20' });
  h.answers['POST /api/devices/phone-pairing'] = (call) => {
    if (!call.body.direct) {
      throw h.apiError(409, { error: 'choose_address', message: 'Выберите сеть или введите адрес сервера.' });
    }

    return structuredClone(h.issued);
  };
  await h.click(/Подключить телефон/);
  assert.doesNotMatch(dialogText(), /Код истёк/);
  assert.match(dialogText(), /несколько сетей/);
  await type(h, document.querySelector('.phone-connect select'), '192.0.2.20');
  await type(h, document.querySelector('.phone-connect input[type=number]'), '9000');
  await h.dialogClick(/Обновить код/);

  const posts = requestsOf(h, 'POST', '/api/devices/phone-pairing');

  assert.deepEqual(posts.at(-1).body.direct, [{ host: '192.0.2.20', port: 8145 }],
    'порт берётся у действующего входа, а не из неприменённого поля');
  assert.ok(document.querySelector('.phone-qr'));
});

test('PHONE-A8: loopback-вход не выдаёт QR на сеть, где сервер не слушает', async (t) => {
  const h = await phoneHarness(t);

  h.status.direct.addresses = ['127.0.0.1:8145'];
  h.answers['POST /api/devices/phone-pairing'] = () => {
    throw h.apiError(409, { error: 'access_unavailable', message: 'Включите прямой доступ.' });
  };
  await h.click(/Подключить телефон/);
  assert.match(dialogText(), /только локально/);
  await type(h, document.querySelector('.phone-connect select'), '192.0.2.10');
  await h.dialogClick(/Обновить код/);
  assert.equal(requestsOf(h, 'POST', '/api/devices/phone-pairing').at(-1).body.direct, undefined);
});

test('PHONE-A8: без сетей IPv4 есть объяснение и повтор статуса', async (t) => {
  const h = await phoneHarness(t);

  h.status.direct = {
    state: 'online',
    addresses: ['127.0.0.1:8145'],
    error: null,
  };
  h.status.networks = [];
  h.answers['POST /api/devices/phone-pairing'] = () => {
    throw h.apiError(409, { error: 'access_unavailable', message: 'Включите прямой доступ.' });
  };
  await h.click(/Подключить телефон/);
  assert.match(dialogText(), /нет подходящих.*IPv4/i);
  assert.match(dialogText(), /Обновить список сетей/);
});

test('PHONE-A8: двойное «Обновить код» выпускает один код', async (t) => {
  const post = deferred();
  const h = await phoneHarness(t);

  h.status.relays = [relay(relayLink('offline', null, null))];
  h.issued.includedRelayId = null;
  await h.click(/Подключить телефон/);
  h.answers['POST /api/devices/phone-pairing'] = () => post.promise;

  const before = requestsOf(h, 'POST', '/api/devices/phone-pairing').length;
  const refresh = [...document.querySelectorAll('.phone-connect button')]
    .find((button) => /Обновить код/.test(button.textContent));

  refresh.click();
  refresh.click();
  await h.flushPromises();
  post.resolve(structuredClone(h.issued));
  await h.flushPromises();
  assert.equal(requestsOf(h, 'POST', '/api/devices/phone-pairing').length, before + 1);
});

test('PHONE-A9: повторный переход к настройке ретранслятора снова раскрывает список', async (t) => {
  const h = await phoneHarness(t, { settings: true });

  h.settings.requestOpen({ pageId: 'connections.devices', entityId: 'relay' });
  await h.flushPromises();
  assert.match(document.body.textContent, /Добавить посредника/);

  const panelToggle = [...document.querySelectorAll('.server-access button')]
    .find((button) => /Настроить ретранслятор/.test(button.textContent));

  panelToggle.click();
  await h.flushPromises();
  assert.doesNotMatch(document.body.textContent, /Добавить посредника/, 'список свёрнут человеком');
  await h.click(/Подключить телефон/);
  await h.dialogClick(/Настроить ретранслятор/);
  assert.match(document.body.textContent, /Добавить посредника/);
});

for (const status of ['expired', 'connected', 'error']) {
  test(`PHONE-A10: поздний ${status} прежнего кода не меняет новый QR`, async (t) => {
    const pending = deferred();
    let held = false;
    const h = await phoneHarness(t, {
      answers: {
        'GET /api/devices/phone-pairing/attempt-a': () => {
          held = true;

          return pending.promise;
        },
      },
    });

    await h.click(/Подключить телефон/);
    await wait(PROGRESS_WAIT_MS);
    assert.ok(held);
    h.issued.attemptId = 'attempt-b';
    h.issued.text = 'GRIGDESK:PHONE:2:SECOND';
    await h.phone.issue();

    if (status === 'error') {
      pending.reject(new Error('late'));
    } else {
      pending.resolve({ status, device: { id: 'other' } });
    }

    await h.flushPromises();
    assert.equal(h.phone.code.attemptId, 'attempt-b');
    assert.equal(h.phone.progress, 'pending');
    assert.equal(h.phone.progressError, '');
    await wait(PROGRESS_WAIT_MS);
    assert.ok(h.requests.some((call) => call.url === '/api/devices/phone-pairing/attempt-b'));
  });
}
