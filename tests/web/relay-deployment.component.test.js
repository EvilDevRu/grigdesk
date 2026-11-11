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

test('RD-UI-04: каждое задание открывается отдельно независимо от более позднего ready', async (t) => {
  const pending = {
    id: 'pending-job',
    revision: 4,
    state: 'awaiting_credentials',
    mode: 'restore',
    relayId: 'r12345678',
    steps: [],
    ssh: {
      host: 'pending.example.invalid',
      user: 'root',
      port: 22,
    },
  };
  const ready = {
    id: 'latest-ready',
    revision: 9,
    state: 'ready',
    mode: 'setup',
    name: 'Поздняя настройка',
    steps: [],
    public: { host: 'ready.example.invalid', port: 443 },
  };
  const h = await relayUi(t, { jobs: [pending, ready] });
  const buttons = [...document.querySelectorAll('[data-deployment-id]')]
    .map((article) => article.querySelector('button'));

  assert.equal(buttons.length, 2);
  buttons[0].click();
  await h.flushPromises();
  assert.equal(Boolean(document.querySelector('input[type=password]')), true);
  assert.match(h.text(), /Прежний доступ/u);
  await h.click(/Закрыть/iu);
  buttons[1].click();
  await h.flushPromises();
  assert.equal(Boolean(document.querySelector('input[type=password]')), false);
  assert.equal(Boolean(h.button(/Показать QR|QR/iu)), true);
});

test('RD-UI-04: lost create ACK восстанавливается чтением без повторного POST', async (t) => {
  let saved;
  const h = await relayUi(t, {
    answer: (call) => {
      if (call.url === '/api/mobile/deployments' && call.method === 'POST') {
        saved = {
          ...call.body,
          id: 'saved-job',
          revision: 1,
          state: 'draft',
          steps: [],
        };

        throw new Error('lost_create_response');
      }

      if (call.url === '/api/mobile/deployments' && call.method === 'GET' && saved) {
        return { jobs: [saved] };
      }
    },
  });

  await h.click(/Создать.*доступ/iu);
  await fillLabel(h, /Имя подключения/iu, 'Временный сервер');
  await fillLabel(h, /SSH.*адрес/iu, 'new.example.invalid');
  await h.click(/Проверить/iu);
  await h.click(/Закрыть/iu);
  assert.equal(Boolean(h.button(/Продолжить/iu)), true);
  await h.click(/Продолжить/iu);
  assert.equal(Boolean(h.button(/Проверить/iu)), true);
  assert.equal(h.requests.filter((call) => call.method === 'POST'
    && call.url === '/api/mobile/deployments').length, 1);
  assert.equal(h.requests.some((call) => call.url.endsWith('/probe')), false);
});

test('RD-UI-04: недоступное чтение после lost ACK сохраняет requestId того же черновика', async (t) => {
  let saved;
  let unavailable = true;
  const h = await relayUi(t, {
    answer: (call) => {
      if (call.url === '/api/mobile/deployments' && call.method === 'POST') {
        if (!saved) {
          saved = {
            ...call.body,
            id: 'deployment-0001',
            revision: 1,
            state: 'draft',
            steps: [],
          };

          throw new Error('lost_create_response');
        }

        return saved;
      }

      if (call.url === '/api/mobile/deployments' && call.method === 'GET' && saved) {
        if (unavailable) {
          throw new Error('connection_unavailable');
        }

        return { jobs: [saved] };
      }
    },
  });

  await h.click(/Создать.*доступ/iu);
  await fillLabel(h, /Имя подключения/iu, 'Временный сервер');
  await fillLabel(h, /SSH.*адрес/iu, 'new.example.invalid');
  await h.click(/Проверить/iu);
  unavailable = false;
  await h.click(/Проверить/iu);

  const created = h.requests.filter((call) => call.method === 'POST'
    && call.url === '/api/mobile/deployments');

  assert.equal(created.length, 2);
  assert.equal(created[0].body.requestId, created[1].body.requestId);
  assert.match(h.text(), /SHA256:fixture/u);
});

for (const locale of ['ru', 'en']) {
  for (const code of ['previous_installation_restored', 'remote_rollback_failed']) {
    test(`RD-UI-05: результат rollback имеет точную подпись, ${locale}/${code}`, async (t) => {
      const h = await relayUi(t, { locale, jobs: [{
        id: 'rollback-job',
        revision: 8,
        state: 'failed',
        mode: 'restore',
        error: { code },
        steps: [{ name: 'rollback', state: code === 'remote_rollback_failed' ? 'failed' : 'completed' }],
      }] });

      await h.click(locale === 'ru' ? /Продолжить/iu : /Continue|Resume/iu);
      assert.match(h.text(), locale === 'ru'
        ? /Восстановление прежней службы/u : /Restore the previous service/u);

      if (code === 'remote_rollback_failed') {
        assert.match(h.text(), locale === 'ru'
          ? /Откат на VPS не подтверждён/u : /rollback was not confirmed/u);
      } else {
        assert.match(h.text(), locale === 'ru'
          ? /Прежняя служба VPS восстановлена/u : /previous VPS service was restored/u);
      }
    });
  }
}

test('RD-UI-06: завершение ожидания требует подтверждения и не удаляет ключи', async (t) => {
  const pending = {
    id: 'waiting-job',
    revision: 4,
    state: 'awaiting_credentials',
    mode: 'restore',
    relayId: 'r12345678',
    steps: [],
  };
  const cancelled = {
    ...pending,
    revision: 5,
    state: 'interrupted',
    error: { code: 'deployment_cancelled' },
  };
  let accepted = false;
  const h = await relayUi(t, { jobs: [pending], answer: (call) => {
    if (call.url === '/api/mobile/deployments/waiting-job/cancel') {
      accepted = true;

      return cancelled;
    }

    if (call.method === 'GET' && call.url === '/api/mobile/deployments' && accepted) {
      return { jobs: [cancelled] };
    }
  } });

  await h.click(/Продолжить/iu);
  await h.click(/Завершить ожидание/iu);
  assert.equal(h.requests.some((call) => call.url.endsWith('/cancel')), false);
  assert.match(h.confirmations.join('\n'), /ещё не начала установку/u);
  assert.match(h.confirmations.join('\n'), /ключи и устройства/u);
  h.confirm(true);
  await h.click(/Завершить ожидание/iu);

  const requests = h.requests.filter((call) => call.url.endsWith('/cancel'));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.revision, 4);
  assert.equal(typeof requests[0].body.requestId, 'string');
  assert.match(h.text(), /Ожидание завершено/u);
  assert.equal(Boolean(h.button(/Завершить ожидание/iu)), false);
  assert.equal(h.requests.some((call) => /revoke|DELETE|\/remove/u.test(call.url)), false);
});

test('RD-UI-06: принятая установка не предлагает завершать ожидание', async (t) => {
  const h = await relayUi(t, { jobs: [{
    id: 'installing-job',
    revision: 6,
    state: 'installing',
    mode: 'restore',
    steps: [],
  }] });

  assert.equal(Boolean(h.button(/Завершить ожидание/iu)), false);
  await h.click(/Продолжить/iu);
  assert.equal(Boolean(h.button(/Завершить ожидание/iu)), false);
  assert.equal(h.requests.some((call) => call.url.endsWith('/cancel')), false);
});

test('RD-UI-06: установка, принятая во время подтверждения, не получает cancel', async (t) => {
  const h = await relayUi(t, { jobs: [{
    id: 'changing-job',
    revision: 6,
    state: 'awaiting_confirmation',
    mode: 'restore',
    steps: [],
  }] });
  let confirm;
  const pending = new Promise((resolve) => confirm = resolve);

  globalThis.__relayUi.confirm = async () => pending;
  await h.click(/Продолжить/iu);
  await h.click(/Завершить ожидание/iu);
  h.status.jobs[0].state = 'installing';
  h.status.jobs[0].revision += 1;

  for (const listener of h.events) {
    listener('mobile-changed', {});
  }

  await h.flushPromises();
  confirm(true);
  await h.flushPromises();
  assert.equal(h.requests.some((call) => call.url.endsWith('/cancel')), false);
});
