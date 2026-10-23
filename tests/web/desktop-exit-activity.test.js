import assert from 'node:assert/strict';
import test from 'node:test';

import { desktopExitApp } from './helpers/desktopExitApp.js';
import { catalogMessage } from './helpers/i18nCatalog.js';

/**
 * Сборщик проверяется через настоящий renderer inspect вместо импорта отсутствующего модуля.
 * Неподдержанный исходным App запрос даёт undefined и падает на сравнении состава активности.
 */
async function activeSnapshot(h) {
  const snapshot = await h.command('inspect');

  assert.ok(snapshot && Array.isArray(snapshot.chats) && Array.isArray(snapshot.pipelines),
    'К1/К3: inspect возвращает состав активной работы');

  return snapshot;
}

test('ACT01: active/background/queued объединяются по chatKey, Stop-допуск и raw titles', async (t) => {
  const h = await desktopExitApp(t, {
    active: {
      active: [{ chatKey: 'one' }, { chatKey: 'background', background: true }],
      queued: [{ chatKey: 'one', turnId: 'turn-duplicate' }, { chatKey: 'queued', turnId: 'turn-queued' }],
    },
    tasks: {
      tasks: [
        {
          task: '7',
          title: 'Задача <семь>',
          daemonAlive: true,
          readOnly: false,
        },
        {
          task: '8',
          title: 'На воротах',
          daemonAlive: false,
        },
        {
          task: '9',
          title: 'Архивная',
          daemonAlive: true,
          readOnly: true,
        },
      ],
    },
    titles: { background: 'Фоновый "чат"', queued: 'Очередь' },
  });

  h.chat.sessions = [{
    id: 'one',
    title: 'Загруженный <чат>',
    messages: [],
  },
    {
      id: 'idle',
      title: 'Неактивная сессия',
      messages: [],
    }];
  h.chat.loaded = true;

  const snapshot = await activeSnapshot(h);

  const actual = structuredClone(snapshot);

  actual.chats.sort((left, right) => left.chatKey.localeCompare(right.chatKey));
  assert.deepEqual(actual, {
    chats: [
      { chatKey: 'background', title: 'Фоновый "чат"' },
      { chatKey: 'one', title: 'Загруженный <чат>' },
      { chatKey: 'queued', title: 'Очередь' },
    ],
    pipelines: [{ task: '7', title: 'Задача <семь>' }],
  });
  assert.equal(h.control.calls.some((call) => call.path === '/api/chat/sessions'), false);
  assert.equal(h.control.calls.some((call) => call.path === '/api/chat/store/chat/one'), false);
  assert.equal(h.stops().length, 0);
});

test('ACT01/pipeline-only: задача с daemonAlive даёт активность без чатов', async (t) => {
  const h = await desktopExitApp(t, { active: { active: [], queued: [] } });
  const snapshot = await activeSnapshot(h);

  assert.deepEqual(snapshot.chats, []);
  assert.deepEqual(snapshot.pipelines, [{ task: '7', title: 'Задача <raw>' }]);
});

test('ACT01/idle: сессии и неподвижные ворота не считаются активностью', async (t) => {
  const h = await desktopExitApp(t, {
    active: { active: [], queued: [] },
    tasks: { tasks: [{
      task: '7',
      title: 'Вопрос',
      daemonAlive: false,
    }] },
  });

  h.chat.sessions = [{
    id: 'idle',
    title: 'Неактивный чат',
    messages: [],
  }];
  assert.deepEqual(await activeSnapshot(h), { chats: [], pipelines: [] });
});

test('ACT01/fallback: пустые заголовки дают переводимые имена из desktop.json', async (t) => {
  const h = await desktopExitApp(t, {
    active: { active: [{ chatKey: 'nameless' }], queued: [] },
    tasks: { tasks: [{
      task: '7',
      title: '',
      daemonAlive: true,
    }] },
    titles: {},
  });
  const snapshot = await activeSnapshot(h);

  const chat = await catalogMessage('desktop', 'Чат {id}');
  const task = await catalogMessage('desktop', 'Задача #{task}');

  assert.deepEqual(snapshot.chats, [{ chatKey: 'nameless', title: chat.ru.replace('{id}', 'nameless') }]);
  assert.deepEqual(snapshot.pipelines, [{ task: '7', title: task.ru.replace('{task}', '7') }]);
});

for (const failing of ['/api/chat/active', '/api/tasks']) {
  test(`ACT01-partial: ${failing} с ошибкой не превращает снимок в достоверно пустой`, async (t) => {
    const h = await desktopExitApp(t);

    h.control.handlers[failing] = () => new Response(JSON.stringify({ error: 'synthetic_failure' }), {
      status: 500,
    });

    const result = await h.command('inspect');

    assert.equal(result?.unavailable, true, 'B3: принят исходный вариант unavailable при частичном отказе');
    assert.equal(h.control.calls.filter((call) => call.path === failing).length, 1,
      'Inspect не повторяет основной запрос');
    assert.equal(h.stops().length, 0);
  });
}

test('ACT02: только параллельные Stop, stop_sent ждёт daemonAlive=false', async (t) => {
  const h = await desktopExitApp(t, {
    tasks: { tasks: [7, 8].map((task) => ({
      task: String(task),
      title: `Задача ${task}`,
      daemonAlive: true,
    })) },
  });
  const snapshot = await activeSnapshot(h);
  const first = Promise.withResolvers();
  let finished = false;

  t.after(() => first.resolve(new Response(JSON.stringify({ ok: true, outcome: 'stop_sent' }))));
  h.control.handlers['/api/tasks/7/stop'] = () => first.promise;
  h.control.handlers['/api/tasks/8/stop'] = () => new Response(JSON.stringify({
    ok: true,
    outcome: 'not_running',
  }));
  await h.command('stopping', { snapshot });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });

  const stopping = h.command('stop-pipelines', { snapshot }).then(() => {
    finished = true;
  });

  await h.flushPromises();
  assert.deepEqual(h.stops().map((call) => call.path).sort(), ['/api/tasks/7/stop', '/api/tasks/8/stop']);
  assert.ok(h.stops().every((call) => call.method === 'POST' && !call.body));
  assert.ok(h.stops().every((call) => call.signal));
  assert.equal(finished, false);
  first.resolve(new Response(JSON.stringify({ ok: true, outcome: 'stop_sent' })));
  await h.flushPromises();
  t.mock.timers.tick(500);
  await h.flushPromises();
  assert.equal(finished, false, 'HTTP stop_sent ещё не означает окончания остановки');
  h.control.tasks = { tasks: [{ task: '7', daemonAlive: false }, { task: '8', daemonAlive: false }] };
  t.mock.timers.tick(500);
  await h.flushPromises();

  // command после ответа renderer выполняет собственный flushPromises.
  // Ждём его завершения без продвижения часов, сохраняя проверку срока остановки.
  await h.flushPromises();
  assert.equal(finished, true);
  await stopping;
  assert.equal(h.control.calls.some((call) => /chat\/stop|abandon|resume|close|down/.test(call.path)), false);
});

test('ACT03: N зависших Stop и ошибка укладываются в единый срок 20 секунд без повторов', async (t) => {
  const h = await desktopExitApp(t, {
    tasks: { tasks: [7, 8, 9].map((task) => ({
      task: String(task),
      daemonAlive: true,
      title: 'Задача',
    })) },
  });
  const snapshot = await activeSnapshot(h);
  const deferred = [];
  let finished = false;

  t.after(() => deferred.forEach((pending) => pending.resolve(new Response('{}'))));

  for (const task of ['7', '8']) {
    h.control.handlers[`/api/tasks/${task}/stop`] = (call) => {
      const pending = Promise.withResolvers();

      deferred.push(pending);
      assert.ok(call.signal, 'Deadline передаётся также в зависший HTTP Stop');
      call.signal.addEventListener('abort', () => pending.reject(new Error('Остановка по сроку')), {
        once: true,
      });

      return pending.promise;
    };
  }

  h.control.handlers['/api/tasks/9/stop'] = () => new Response('{"error":"synthetic_failure"}', {
    status: 500,
  });
  await h.command('stopping', { snapshot });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });

  const stopping = h.command('stop-pipelines', { snapshot }).then(() => {
    finished = true;
  });

  await h.flushPromises();
  assert.equal(h.stops().length, 3, 'Все Stop начались до завершения первого');
  t.mock.timers.tick(20000);
  await h.flushPromises();

  // Ответ Stop и последующий flush помощника завершаются в разных оборотах очереди.
  // Дополнительное ожидание не увеличивает проверяемый общий бюджет в 20 секунд.
  await h.flushPromises();
  assert.equal(finished, true, 'К9: общий бюджет, а не N отдельных сроков');
  await stopping;
  assert.equal(h.stops().length, 3);
  t.mock.timers.tick(60000);
  await h.flushPromises();
  assert.equal(h.stops().length, 3);
});

test('ACT03/poll: stop_sent с вечно живым daemon ограничен общим deadline', async (t) => {
  const h = await desktopExitApp(t);
  const snapshot = await activeSnapshot(h);
  let finished = false;

  h.control.handlers['/api/tasks/7/stop'] = () => new Response(JSON.stringify({
    ok: true,
    outcome: 'stop_sent',
  }));
  await h.command('stopping', { snapshot });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });

  const stopping = h.command('stop-pipelines', { snapshot }).then(() => {
    finished = true;
  });

  for (let elapsed = 0; elapsed < 20000; elapsed += 500) {
    await h.flushPromises();
    t.mock.timers.tick(500);
  }

  await h.flushPromises();

  // Сначала завершается renderer, затем собственный flush внутри command.
  // Часы остаются на deadline: ожидаем только доставку результата в finished.
  await h.flushPromises();
  assert.equal(finished, true, 'К9: polling stop_sent не бесконечен');
  await stopping;
  assert.equal(h.stops().length, 1);

  const polls = h.control.calls.filter((call) => call.path === '/api/tasks').length;

  assert.ok(polls <= 42, 'Опрос не чаще одного раза в 500 мс');
  t.mock.timers.tick(60000);
  await h.flushPromises();
  assert.equal(h.control.calls.filter((call) => call.path === '/api/tasks').length, polls);
});
