import assert from 'node:assert/strict';
import test from 'node:test';

import { fillLabel, relayUi } from './helpers/relayDeployment.js';

process.env.NODE_ENV = 'test';

for (const locale of ['ru', 'en']) {
  test(`RD-UI-01: существующая страница содержит setup/restore и preview, ${locale}`, async (t) => {
    const h = await relayUi(t, { locale });

    assert.match(h.text(), locale === 'ru' ? /Удалённый доступ/u : /Remote access/iu);
    await h.click(locale === 'ru'
      ? /(?:Создать|Настроить|Новый).*доступ/iu : /(?:Set up|New|Create).*access/iu);
    await fillLabel(h, locale === 'ru' ? /имя|название/iu : /name/iu, 'Доступ стенда');
    await fillLabel(h, /SSH.*(?:адрес|сервер|host)|(?:адрес|host).*SSH/iu, '127.0.0.1');
    await fillLabel(h, locale === 'ru' ? /пользователь|логин/iu : /user/iu, 'root');
    await h.click(locale === 'ru' ? /Проверить|Продолжить/iu : /Check|Continue/iu);

    assert.equal(h.requests.filter((call) => call.method === 'POST'
      && call.url === '/api/mobile/deployments').length, 1);
    assert.match(h.text(), /SHA256:fixture/u);
    assert.equal(h.requests.some((call) => call.url.endsWith('/credentials')), false);
    await h.click(locale === 'ru' ? /Довер|Подтвердить отпечаток/iu : /Trust|Confirm fingerprint/iu);

    const password = document.querySelector('input[type=password]');

    assert.equal(Boolean(password), true, 'Пароль скрыт публичным UiPasswordInput');
    password.value = 'RD_UI_PASSWORD_SENTINEL';
    password.dispatchEvent(new Event('input', { bubbles: true }));
    await h.flushPromises();
    await h.click(locale === 'ru' ? /Проверить|Продолжить/iu : /Check|Continue/iu);
    assert.match(h.text(), /служб|service/iu);

    const credentials = h.requests.filter((call) => call.method === 'POST_BYTES');

    assert.equal(credentials.length, 1, 'SSH-секрет отправлен отдельным binary body');
    assert.equal(credentials.length, h.requests.filter((call) =>
      call.url.endsWith('/credentials')).length, 'Сеть не повторяет отправку секрета автоматически');
    assert.equal(document.querySelector('input[type=password]')?.value ?? '', '');
    assert.equal(h.requests.some((call) => call.url.endsWith('/start')), false);
    assert.equal(JSON.stringify(piniaState(h)).includes('RD_UI_PASSWORD_SENTINEL'), false);
    assert.equal(h.text().includes('RD_UI_PASSWORD_SENTINEL'), false);
    assert.equal(window.localStorage.length, 0);
    assert.equal(window.sessionStorage.length, 0);
  });
}

test('RD-UI-02: doubleclick, закрытие и reopen восстанавливают одно задание через GET', async (t) => {
  const h = await relayUi(t);

  assert.match(h.text(), /Удалённый доступ/u);
  await h.click(/(?:Создать|Настроить|Новый).*доступ/iu);
  await fillLabel(h, /имя|название/iu, 'Доступ стенда');
  await fillLabel(h, /SSH.*(?:адрес|сервер)|адрес.*SSH/iu, '127.0.0.1');
  await fillLabel(h, /пользователь|логин/iu, 'root');

  const proceed = h.button(/Проверить|Продолжить/iu);

  assert.equal(Boolean(proceed), true);
  proceed.click();
  proceed.click();
  await h.flushPromises();
  assert.equal(h.requests.filter((call) => call.method === 'POST'
    && call.url === '/api/mobile/deployments').length, 1);
  await h.click(/Закрыть/iu);

  const before = h.requests.length;

  h.job.revision = 2;

  for (const listener of h.events) {
    listener('mobile-changed', {
      deploymentId: h.job.id,
      revision: 2,
      at: 1
    });
    listener('hello', {});
    listener('reconnect', {});
  }

  await h.flushPromises();
  assert.ok(h.requests.slice(before).some((call) => call.method === 'GET'
    && call.url.startsWith('/api/mobile/deployments')));
  assert.equal(h.requests.some((call) => /cancel|delete/iu.test(call.url)), false);
  await h.click(/Продолжить|Открыть.*(?:задан|настрой)|Посмотреть.*(?:задан|настрой)/iu);
  assert.match(h.text(), /SHA256:fixture/u);
  assert.equal(h.requests.filter((call) => call.method === 'POST'
    && call.url === '/api/mobile/deployments').length, 1);
});

test('RD-UI-02: поздний ответ A не меняет B и не отправляет B SSH-секрет', async (t) => {
  let release;
  const pending = new Promise((resolve) => release = resolve);
  const h = await relayUi(t, {
    answer: (call) => call.url === '/api/mobile/deployments' && call.method === 'GET'
      ? call.owner === 'a' ? pending : { jobs: [] } : undefined,
  });

  assert.match(h.text(), /Удалённый доступ/u);
  h.shell.profile = {
    ...h.shell.profile,
    id: 'b',
    name: 'Сервер Б'
  };
  h.auth.clientScope = 'scope-b';
  await h.nextTick();
  release({
    jobs: [{
      ...h.job,
      name: 'Чужой результат А',
      state: 'ready'
    }]
  });
  await h.flushPromises();
  assert.equal(h.text().includes('Чужой результат А'), false);
  assert.equal(h.requests.filter((call) => call.owner === 'b'
    && call.url.endsWith('/credentials')).length, 0);
});

test('RD-UI-03: offline предлагает restore, служба и телефон имеют разные статусы', async (t) => {
  const h = await relayUi(t);

  assert.match(h.text(), /Удалённый доступ/u);
  assert.match(h.text(), /Нет связи/u);
  await h.click(/Восстановить/iu);
  assert.match(h.text(), /Прежний доступ/u);
  assert.doesNotMatch(h.text(), /телефон подключён/iu);
  await h.click(/Закрыть|Отмена/iu);
  assert.equal(h.requests.some((call) => call.method === 'DELETE' || call.method === 'DEL'), false);
});

/**
 * Проверяется действительное состояние всех Pinia stores, а не DTO-заглушка сети.
 * Секрет не должен попасть туда даже на время открытого preview.
 */
function piniaState(h) {
  return h.pinia.state.value;
}

for (const state of ['empty', 'loading', 'error']) {
  test(`RD-UI-02: ${state} имеет понятное состояние и доступный следующий шаг`, async (t) => {
    const pending = new Promise(() => { });
    const h = await relayUi(t, {
      answer: (call) => {
        if (call.url !== '/api/mobile/deployments' || call.method !== 'GET') {
          return undefined;
        }

        if (state === 'loading') {
          return pending;
        }

        if (state === 'error') {
          throw new Error('Синтетический отказ загрузки');
        }

        return { jobs: [] };
      },
    });

    assert.match(h.text(), /Удалённый доступ/u);

    if (state === 'loading') {
      assert.equal(Boolean(document.querySelector('[aria-busy=true]')), true);
    } else if (state === 'error') {
      assert.match(h.text(), /не удалось|ошиб|недоступ/iu);
      assert.equal(Boolean(h.button(/Повтор|Загрузить/iu)), true);
    } else {
      assert.equal(Boolean(h.button(/(?:Создать|Настроить|Новый).*доступ/iu)), true);
    }
  });
}

test('RD-UI-03: удаление объясняет последствия, cancel не мутирует, confirm удаляет', async (t) => {
  const h = await relayUi(t);

  assert.match(h.text(), /Удалённый доступ/u);
  await h.click(/Удалить/iu);
  assert.equal(h.requests.some((call) => call.method === 'DEL'), false);
  assert.match(h.confirmations.join('\n'), /маршрут|ключ|личност/iu);
  h.confirm(true);
  await h.click(/Удалить/iu);
  assert.equal(h.requests.filter((call) => call.method === 'DEL').length, 1);
  assert.equal(h.requests.some((call) => call.url.endsWith('/revoke')), false);
});

test('RD-UI-03: исторический ready и новый адрес не объявляют телефон подключённым', async (t) => {
  const h = await relayUi(t, {
    jobs: [{
      id: 'ready-job',
      revision: 5,
      state: 'ready',
      mode: 'restore',
      expectedServerFp: 'a'.repeat(64),
      relayId: 'r12345678',
      service: { state: 'running' },
      channel: { state: 'verified' },
      public: { host: 'new-relay.example.invalid', port: 443 },
      ssh: {
        host: '127.0.0.1',
        port: 22,
        user: 'root'
      },
      steps: [],
      routeUpdateRequired: true,
    }]
  });

  assert.match(h.text(), /Удалённый доступ/u);
  assert.match(h.text(), /Нет связи/u);
  assert.doesNotMatch(h.text(), /телефон подключён/iu);
  assert.match(h.text(), /обнов.*маршрут|маршрут.*телефон/iu);
  assert.equal(h.requests.some((call) => call.url.endsWith('/revoke')), false);
});
