// Приём хода чата отдельно от его исполнения. Раньше POST /api/chat держал HTTP-запрос
// до конца работы агента (и всё время ожидания в очереди чата): несколько параллельных
// ходов съедали лимит соединений браузера, а оборванный запрос оставлял неясным, был ли
// запуск. Теперь окно шлёт устойчивый turnId, сервер коротко подтверждает приём,
// повтор с тем же turnId ничего не запускает второй раз, а итог приходит через pending.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chatAppFixture,
  controlledExecutor,
  saveChat,
  turnBody,
  waitFor,
} from './helpers/chat-turns.js';

/**
 * Ответ на приём должен прийти, не дожидаясь исполнителя. Старый синхронный POST здесь
 * повис бы до конца хода — поэтому проверка падает по таймауту, а не зависает.
 */
async function quick(promise, what, ms = 1500) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: ответа нет за ${ms} мс`)), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function post(app, body) {
  return app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: body,
  });
}

async function pendingOf(app) {
  return (await app.inject({ method: 'GET', url: '/api/chat/pending' })).json().pending;
}

async function turnsOf(app, ids) {
  const response = await app.inject({ method: 'GET', url: `/api/chat/turns?ids=${ids.join(',')}` });

  assert.equal(response.statusCode, 200);

  return response.json().turns;
}

test('приём: короткое подтверждение до конца хода, итог в pending под тем же turnId', async (t) => {
  const { executor, runs, waitForRuns } = controlledExecutor();
  const { app, events } = await chatAppFixture(t, { executor });

  await saveChat(app, 'accept-chat');

  const accepted = await quick(post(app, turnBody('accept-chat', 'turn-accept-0001')), 'приём хода');

  assert.equal(accepted.statusCode, 202);
  assert.deepEqual(accepted.json(), {
    accepted: true,
    turnId: 'turn-accept-0001',
    state: 'started',
  });

  await waitForRuns(1);

  const active = (await app.inject({ method: 'GET', url: '/api/chat/active' })).json();

  assert.equal(active.active[0].chatKey, 'accept-chat');
  assert.equal(active.active[0].turnId, 'turn-accept-0001', 'после F5 окно узнаёт свой ход');
  assert.equal((await turnsOf(app, ['turn-accept-0001']))['turn-accept-0001'].state, 'running');

  runs[0].release('Готово');

  const [result] = await waitFor(async () => {
    const pending = await pendingOf(app);

    return pending.length ? pending : null;
  }, { what: 'итог хода в pending' });

  assert.equal(result.id, 'turn-accept-0001', 'id записи — turnId: окно сверяет ответ со своим сообщением');
  assert.equal(result.turnId, 'turn-accept-0001');
  assert.equal(result.chatKey, 'accept-chat');
  assert.equal(result.role, 'assistant');
  assert.equal(result.reply, 'Готово');
  assert.equal(result.userText, 'привет');

  const done = await waitFor(() => events.find((entry) => entry.event === 'chat-done'), {
    what: 'сигнал о завершении после записи pending',
  });

  assert.equal(done.data.turnId, 'turn-accept-0001');
  assert.equal(done.data.queued, 0);

  const orphan = events.find((entry) => entry.event === 'chat-orphan');

  assert.equal(orphan.data.turnId, 'turn-accept-0001');
  assert.ok(
    events.indexOf(orphan) < events.indexOf(done),
    'итог записан до сигнала о конце хода: окно, услышавшее chat-done, находит ответ',
  );
  assert.equal((await turnsOf(app, ['turn-accept-0001']))['turn-accept-0001'].state, 'done');
});

test('потерянный ACK: повтор той же отправки не запускает исполнителя второй раз', async (t) => {
  const { executor, runs, waitForRuns } = controlledExecutor();
  const { app } = await chatAppFixture(t, { executor });

  await saveChat(app, 'dup-chat');

  const body = turnBody('dup-chat', 'turn-dup-000001');

  const first = await quick(post(app, body), 'первый приём');
  const repeat = await quick(post(app, body), 'повтор приёма');

  assert.equal(first.statusCode, 202);
  assert.equal(repeat.statusCode, 202);
  assert.deepEqual(repeat.json(), {
    accepted: true,
    duplicate: true,
    turnId: 'turn-dup-000001',
    state: 'running',
  });

  await waitForRuns(1);
  await new Promise((resolve) => {
    setTimeout(resolve, 30);
  });
  assert.equal(runs.length, 1, 'повтор с тем же turnId исполнителя не будит');

  runs[0].release('Один раз');
  await waitFor(async () => (await pendingOf(app)).length === 1, { what: 'итог' });

  const late = await quick(post(app, body), 'поздний повтор после конца хода');

  assert.equal(late.json().duplicate, true);
  assert.equal(late.json().state, 'done');
  assert.equal(runs.length, 1, 'и после конца хода повтор ничего не запускает');
  assert.equal((await pendingOf(app)).length, 1, 'ответ один');
});

test('два одинаковых запроса, пришедших одновременно, дают один запуск', async (t) => {
  const { executor, runs, waitForRuns } = controlledExecutor();
  const { app } = await chatAppFixture(t, { executor });

  await saveChat(app, 'race-chat');

  const body = turnBody('race-chat', 'turn-race-00001');

  const [left, right] = await quick(Promise.all([post(app, body), post(app, body)]), 'гонка приёма');

  assert.deepEqual([left.statusCode, right.statusCode], [202, 202]);
  assert.equal([left.json(), right.json()].filter((item) => item.duplicate).length, 1);
  await waitForRuns(1);
  await new Promise((resolve) => {
    setTimeout(resolve, 30);
  });
  assert.equal(runs.length, 1);
  runs[0].release();
});

test('старый полный PUT без нового чата не удаляет запись принятого первого хода', async (t) => {
  const { executor, runs, waitForRuns } = controlledExecutor();
  const { app } = await chatAppFixture(t, { executor });

  await saveChat(app, 'new-chat');

  const accepted = await post(app, turnBody('new-chat', 'turn-preserve-chat'));

  assert.equal(accepted.statusCode, 202, accepted.body);
  await waitForRuns(1);

  const before = (await app.inject('/api/chat/store/chat/new-chat')).json().chat;

  assert.equal(before.workdirState, undefined, 'первый ход ещё не создал session state');

  const saved = await app.inject({
    method: 'PUT',
    url: '/api/chat/store',
    payload: { sessions: [], archived: [] },
  });

  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal((await app.inject('/api/chat/store/chat/new-chat')).json().chat.id, 'new-chat');
  runs[0].release('Разговор сохранён');

  const pending = await waitFor(async () => {
    const entries = await pendingOf(app);

    return entries.length ? entries : null;
  });

  assert.equal(pending[0].reply, 'Разговор сохранён');
  assert.equal(pending[0].role, 'assistant');
});

test('turnId принадлежит одному чату: чужой чат с тем же id получает отказ', async (t) => {
  const { executor, runs } = controlledExecutor();
  const { app } = await chatAppFixture(t, { executor });

  await saveChat(app, 'owner-chat');
  await saveChat(app, 'other-chat');

  await quick(post(app, turnBody('owner-chat', 'turn-owner-0001')), 'приём');

  const conflict = await quick(post(app, turnBody('other-chat', 'turn-owner-0001')), 'чужой приём');

  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error, 'turn_conflict');

  const bad = await quick(post(app, turnBody('owner-chat', 'плохой id')), 'кривой id');

  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'bad_turn_id');
  await waitFor(() => runs.length === 1, { what: 'единственный запуск' });
  runs[0].release();
});

test('отказ до приёма ничего не записывает и не запускает', async (t) => {
  const { executor, runs } = controlledExecutor();
  const { app } = await chatAppFixture(t, { executor });

  const refused = await quick(post(app, turnBody('never-saved', 'turn-refused-01')), 'отказ');

  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().error, 'unknown_chat');
  assert.deepEqual(await turnsOf(app, ['turn-refused-01']), { 'turn-refused-01': null });
  assert.equal(runs.length, 0);
});

test('несколько сообщений одного чата принимаются сразу и исполняются строго по очереди', async (t) => {
  const { executor, runs, waitForRuns } = controlledExecutor();
  const { app, events } = await chatAppFixture(t, { executor });

  await saveChat(app, 'queue-chat');

  const ids = ['turn-queue-0001', 'turn-queue-0002', 'turn-queue-0003'];
  const texts = ['первое', 'второе', 'третье'];
  const acks = [];

  for (const [index, turnId] of ids.entries()) {
    const accepted = await quick(post(app, turnBody('queue-chat', turnId, texts[index])), `приём ${index}`);

    acks.push(accepted.json());
  }

  assert.deepEqual(acks.map((ack) => ack.state), ['started', 'queued', 'queued']);
  await waitForRuns(1);

  const active = (await app.inject({ method: 'GET', url: '/api/chat/active' })).json();

  assert.deepEqual(active.queued.map((item) => item.turnId), ids.slice(1));
  assert.ok(active.queued.every((item) => item.chatKey === 'queue-chat'));

  for (let index = 0; index < ids.length; index += 1) {
    await waitForRuns(index + 1);
    assert.equal(runs.length, index + 1, 'следующий ход не стартует раньше конца предыдущего');
    assert.match(runs[index].message, new RegExp(texts[index]));
    runs[index].release(`Ответ ${index + 1}`);
  }

  const pending = await waitFor(async () => {
    const list = await pendingOf(app);

    return list.length === 3 ? list : null;
  }, { what: 'три итога' });

  assert.deepEqual(
    pending.sort((left, right) => left.at - right.at).map((item) => [item.id, item.reply]),
    [[ids[0], 'Ответ 1'], [ids[1], 'Ответ 2'], [ids[2], 'Ответ 3']],
  );

  // Pending записывается до chat-done: третий итог ещё не означает закрытие очереди.
  // Ждём число сигналов, а порядок и queued по-прежнему проверяем отдельными assertions.
  await waitFor(() => events.filter((entry) => entry.event === 'chat-done').length === ids.length, {
    what: 'сигналы завершения трёх ходов',
  });

  const starts = events
    .filter((entry) => entry.event === 'chat-turn-start')
    .map((entry) => entry.data.turnId);

  assert.deepEqual(starts, ids, 'окна знают, какое именно сообщение пошло в работу');

  const dones = events.filter((entry) => entry.event === 'chat-done').map((entry) => entry.data.queued);

  assert.deepEqual(dones, [2, 1, 0], 'пока в очереди есть ходы, окно не гасит «думает…»');
});

test('слив остановки: ход из очереди получает честный итог, а не тишину', async (t) => {
  const { executor, runs, waitForRuns } = controlledExecutor();
  const { app, drain } = await chatAppFixture(t, { executor });

  await saveChat(app, 'drain-queue');

  await quick(post(app, turnBody('drain-queue', 'turn-drain-0001', 'идёт')), 'первый');
  await quick(post(app, turnBody('drain-queue', 'turn-drain-0002', 'ждёт')), 'второй');
  await waitForRuns(1);

  await drain();

  const pending = await waitFor(async () => {
    const list = await pendingOf(app);

    return list.length === 2 ? list : null;
  }, { what: 'итоги обоих ходов' });
  const byId = Object.fromEntries(pending.map((item) => [item.id, item]));

  assert.equal(byId['turn-drain-0001'].stopped, true);
  assert.equal(byId['turn-drain-0001'].interruptedBy, 'server_shutdown');
  assert.equal(byId['turn-drain-0002'].role, 'error');
  assert.match(byId['turn-drain-0002'].reply, /перезапуск/);
  assert.equal(byId['turn-drain-0002'].userText, 'ждёт', 'вопрос человека сохранён рядом с итогом');
  assert.equal(runs.length, 1, 'ход из очереди на остановке не запускается');

  const turns = await turnsOf(app, ['turn-drain-0001', 'turn-drain-0002']);

  assert.equal(turns['turn-drain-0001'].state, 'done');
  assert.equal(turns['turn-drain-0002'].state, 'done');

  const refused = await quick(post(app, turnBody('drain-queue', 'turn-drain-0003')), 'после слива');

  assert.equal(refused.statusCode, 503);
  assert.equal(refused.json().error, 'server_restarting');
});

test('после падения сервера незавершённые ходы журнала получают итог-ошибку', async (t) => {
  const first = controlledExecutor();
  const crashed = await chatAppFixture(t, { executor: first.executor });

  await saveChat(crashed.app, 'crash-chat');

  await quick(post(crashed.app, turnBody('crash-chat', 'turn-crash-0001', 'шёл')), 'первый');
  await quick(post(crashed.app, turnBody('crash-chat', 'turn-crash-0002', 'ждал')), 'второй');
  await first.waitForRuns(1);

  // Падение: процесс исчез без слива — ни ответа, ни записи в pending.
  const second = controlledExecutor();
  const restarted = await chatAppFixture(t, { executor: second.executor, root: crashed.root });
  const pending = await waitFor(async () => {
    const list = await pendingOf(restarted.app);

    return list.length === 2 ? list : null;
  }, { what: 'итоги прерванных ходов' });
  const byId = Object.fromEntries(pending.map((item) => [item.id, item]));

  assert.equal(byId['turn-crash-0001'].role, 'error');
  assert.equal(byId['turn-crash-0001'].interruptedBy, 'server_shutdown', 'окно предложит продолжить ход');
  assert.equal(byId['turn-crash-0002'].role, 'error');
  assert.equal(byId['turn-crash-0002'].userText, 'ждал');
  assert.equal(second.runs.length, 0, 'после рестарта старые ходы сами не перезапускаются');

  const retry = await quick(post(restarted.app, turnBody('crash-chat', 'turn-crash-0002', 'ждал')), 'повтор');

  assert.equal(retry.json().duplicate, true, 'повтор с прежним turnId не превращается в новый запуск');
  assert.equal(second.runs.length, 0);
});

test('история объявляет протокол приёма, старый синхронный запуск без turnId сохранён', async (t) => {
  const { executor, runs, waitForRuns } = controlledExecutor();
  const { app } = await chatAppFixture(t, { executor });

  await saveChat(app, 'legacy-chat');

  const store = (await app.inject({ method: 'GET', url: '/api/chat/store' })).json();

  assert.equal(store.turnProtocol, 1);

  const legacy = post(app, {
    chatKey: 'legacy-chat',
    modelRef: { provider: 'test-provider', model: 'test-model' },
    message: 'без turnId',
  });

  await waitForRuns(1);
  runs[0].release('Синхронно');

  const response = await legacy;

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().reply, 'Синхронно', 'Telegram-пульт и старые окна получают ответ как прежде');
  assert.deepEqual(await pendingOf(app), []);
});

/**
 * Тестовый процесс переживает управляемый ход и открывает фон через hooks.
 * Запусками по-прежнему управляет исходный исполнитель, без настоящего CLI.
 */
function withLiveSession(executor) {
  const handles = [];

  executor.session = {
    mode: 'persistent',
    unsolicited: true,
    open(spec) {
      const handle = {
        spec,
        pid: 7000 + handles.length,
        alive: true,
        interrupted: 0,
        send: (turn) => executor.run({ ...spec, ...turn }),
        async interrupt() {
          handle.interrupted += 1;
        },
        async close() {
          handle.alive = false;
          spec.hooks?.onExit?.({ reason: 'закрыт' });
        },
      };

      handles.push(handle);

      return handle;
    },
  };

  return handles;
}

/**
 * Завершает первый ход перед каждым сценарием очереди на фоне.
 * Дожидается done, чтобы тест проверял именно фоновую, а не прежнюю занятость.
 */
async function backgroundFixture(t, options = {}) {
  const controlled = controlledExecutor();
  const handles = withLiveSession(controlled.executor);
  const f = await chatAppFixture(t, { executor: controlled.executor, ...options });

  await saveChat(f.app, 'bg-chat');
  await post(f.app, turnBody('bg-chat', 'turn-bg-0001'));
  await controlled.waitForRuns(1);
  controlled.runs[0].release();
  await waitFor(() => f.events.some((e) => e.event === 'chat-done'));

  const hooks = handles[0].spec.hooks;

  hooks.onBackgroundStart();

  return {
    ...f,
    ...controlled,
    handles,
    hooks,
  };
}

test('ходы, принятые во время фона, ждут его итога и идут по очереди', async (t) => {
  const f = await backgroundFixture(t);
  const ids = ['turn-bg-0002', 'turn-bg-0003'];
  const acks = [];

  for (const [index, id] of ids.entries()) {
    acks.push((await post(f.app, turnBody('bg-chat', id, index ? 'третий' : 'второй'))).json());
  }

  assert.deepEqual(acks.map((ack) => ack.state), ['queued', 'queued']);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.runs.length, 1);
  assert.ok(Object.values(await turnsOf(f.app, ids)).every((turn) => turn.state === 'queued'));
  assert.equal((await f.app.inject('/api/chat/active')).json().active[0].source, 'background');
  await f.hooks.onBackground({ reply: 'Фон готов', steps: [] });
  await f.waitForRuns(2);
  assert.match(f.runs[1].message, /второй/);
  f.runs[1].release();
  await f.waitForRuns(3);
  assert.match(f.runs[2].message, /третий/);
  f.runs[2].release();
  await waitFor(() => f.events.some((e) => e.event === 'chat-done' && e.data.turnId === ids[1]));

  const orphan = f.events.findIndex((e) => e.event === 'chat-orphan' && e.data.source === 'background');
  const done = f.events.findIndex((e) => e.event === 'chat-done' && e.data.source === 'background');
  const start = f.events.findIndex((e) => e.event === 'chat-turn-start' && e.data.turnId === ids[0]);

  assert.ok(orphan >= 0 && orphan < done && done < start);
  await post(f.app, turnBody('bg-chat', ids[0]));
  assert.equal(f.runs.length, 3);
});

test('старый синхронный запуск без turnId тоже ждёт фон', async (t) => {
  const f = await backgroundFixture(t);
  const body = turnBody('bg-chat', 'unused-turn');

  delete body.turnId;

  const legacy = post(f.app, body);
  // inject ленивый: начинаем HTTP-запрос до проверки очереди.
  const completed = legacy.then((response) => response);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.runs.length, 1);
  await f.hooks.onBackground({ reply: 'фон', steps: [] });
  await f.waitForRuns(2);
  f.runs[1].release();
  assert.equal((await completed).statusCode, 200);
});

test('фон, начавшийся сразу за ответом хода, объявляется после его chat-done тем же runId', async (t) => {
  const f = await backgroundFixture(t);

  await f.hooks.onBackground({ reply: 'старый фон', steps: [] });
  await post(f.app, turnBody('bg-chat', 'turn-bg-0002'));
  await f.waitForRuns(2);

  const offset = f.events.length;

  f.runs[1].release('Ответ 2');
  f.hooks.onBackgroundStart();
  f.hooks.onBackgroundStep({
    k: 'text',
    text: 'фон',
    at: 1,
  });
  assert.equal(f.events.slice(offset).filter((e) => e.data.source === 'background').length, 0);
  await waitFor(() => f.events.some((e) => e.event === 'chat-done' && e.data.turnId === 'turn-bg-0002'));

  const bg = f.events.slice(offset).filter((e) => e.data.source === 'background');

  assert.equal(bg.length, 1);
  assert.equal(bg[0].event, 'chat-turn-start');
  assert.equal(bg[0].data.restored, true);
  assert.equal(bg[0].data.steps.length, 1);
  assert.ok(bg[0].data.elapsedMs >= 0);

  const active = (await f.app.inject('/api/chat/active')).json().active;

  assert.equal(bg[0].data.runId, active[0].runId);
});

test('стоп фона прерывает его процесс и снимает спросы', async (t) => {
  const f = await backgroundFixture(t);
  const permission = f.app.inject({
    method: 'POST',
    url: '/api/chat/permission-request',
    payload: {
      tool_name: 'Bash',
      input: {},
      chatKey: 'bg-chat',
    },
  }).then((response) => response);

  await waitFor(() => f.events.some((e) => e.event === 'chat-permission'));

  const stopped = await f.app.inject({
    method: 'POST',
    url: '/api/chat/stop',
    payload: { chatKey: 'bg-chat' },
  });

  assert.equal(stopped.json().ok, true);
  assert.equal(stopped.json().source, 'background');
  assert.match(stopped.json().runId, /^run-/);
  assert.equal(f.handles[0].interrupted, 1);
  assert.equal(f.handles[0].alive, true);
  assert.equal((await permission).json().behavior, 'deny');
  assert.equal((await f.app.inject('/api/chat/active')).json().active.length, 1);
  await f.hooks.onBackground({
    reply: '⏹ Ход остановлен.',
    stopped: true,
    steps: [],
  });
  assert.deepEqual((await f.app.inject('/api/chat/active')).json().active, []);
});

test('фон, не ответивший на стоп, закрывается вместе с процессом', async (t) => {
  const f = await backgroundFixture(t, { backgroundStopGraceMs: 30 });
  const stopped = await f.app.inject({
    method: 'POST',
    url: '/api/chat/stop',
    payload: { chatKey: 'bg-chat' },
  });

  assert.equal(stopped.json().ok, true);
  await waitFor(() => f.handles[0].alive === false);
  assert.ok(f.events.some((e) => e.event === 'chat-done' && e.data.source === 'background'));
  assert.deepEqual((await f.app.inject('/api/chat/active')).json().active, []);
});

test('занятый фоном чат не сбрасывает память и не удаляется', async (t) => {
  const f = await backgroundFixture(t);
  const requests = [
    {
      method: 'POST',
      url: '/api/chat/session/reset',
      payload: { chatKey: 'bg-chat' },
    },
    { method: 'DELETE', url: '/api/chat/store/chat/bg-chat' },
    { method: 'DELETE', url: '/api/chat/sessions/bg-chat' },
  ];

  for (const request of requests) {
    const response = await f.app.inject(request);

    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'chat_busy');
  }

  const sessions = (await f.app.inject('/api/chat/sessions')).json().sessions;

  assert.equal(sessions[0].running, true);
  assert.equal(sessions[0].busy, true);
  assert.equal((await f.app.inject({ method: 'DELETE', url: '/api/chat/sessions' })).json().skipped, 1);

  const forced = await f.app.inject({ method: 'DELETE', url: '/api/chat/sessions/bg-chat?force=1' });

  assert.equal(forced.statusCode, 200);
  assert.equal(f.handles[0].alive, false);
  assert.ok(f.events.some((e) => e.event === 'chat-done' && e.data.source === 'background'));
});

test('слив остановки с фоном: ход из очереди получает итог и не стартует', async (t) => {
  const f = await backgroundFixture(t);
  const response = await post(f.app, turnBody('bg-chat', 'turn-bg-0002'));

  assert.equal(response.json().state, 'queued');
  await f.drain();

  const pending = (await pendingOf(f.app)).find((entry) => entry.turnId === 'turn-bg-0002');

  assert.ok(pending);
  assert.equal(pending.role, 'error');
  assert.match(pending.reply, /перезапуск/);
  assert.equal((await turnsOf(f.app, ['turn-bg-0002']))['turn-bg-0002'].state, 'done');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.runs.length, 1);
});
