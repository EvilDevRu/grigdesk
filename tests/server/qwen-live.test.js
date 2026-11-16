import assert from 'node:assert/strict';
import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { qwenAdapter, qwenFixture, runInput, until } from '../helpers/qwenFixture.mjs';
import { qwenLiveFingerprint } from '../../server/src/lib/qwen/live.ts';

test('Qwen Host: два хода сохраняют один процесс и session', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });

  await fixture.fake({ metadata: { 'shared-model(openai)': { context: 32768 } } });

  const input = runInput(fixture, 'shared-model(openai)', {
    providerSettings: { allowHostAccess: true },
  });
  const handle = adapter.session?.open ? await adapter.session.open(input) : {
    send: (turn) => adapter.run({ ...input, ...turn }),
    close: async () => {},
  };

  t.after(() => handle.close());

  const first = await handle.send({ message: 'Первый', signal: AbortSignal.timeout(12000) });
  const second = await handle.send({ message: 'Второй', signal: AbortSignal.timeout(12000) });
  const spawns = (await fixture.records()).filter((entry) => entry.event === 'spawn');

  assert.equal(second.sessionId, first.sessionId);
  assert.equal(spawns.length, 1);
  assert.equal(second.reply, 'Новый ответ');
});

test('Qwen Host: отсутствие native guard ACK запрещает prompt', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });

  await fixture.fake({
    noAck: true, metadata: { 'shared-model(openai)': { context: 32768 } },
  });

  const input = runInput(fixture, 'shared-model(openai)', {
    providerSettings: { allowHostAccess: true },
  });
  const handle = adapter.session?.open ? await adapter.session.open(input) : {
    send: (turn) => adapter.run({ ...input, ...turn }),
    close: async () => {},
  };

  t.after(() => handle.close());
  await assert.rejects(handle.send({ message: 'Не запускать' }), /guard/);
  assert.equal((await fixture.records()).some((entry) => entry.frame?.method === 'session/prompt'), false);
});

for (const cron of [false, true]) {
  test(`Qwen Host: фон после ответа публикуется один раз, cron=${cron}`, async (t) => {
    const fixture = await qwenFixture(t);
    const adapter = await qwenAdapter({ runnable: true });
    const results = [];
    let starts = 0;

    await fixture.fake({
      ...(cron ? { cronAfterPrompt: true } : { backgroundAfterPrompt: true }),
      metadata: { 'shared-model(openai)': { context: 32768 } },
    });

    const input = runInput(fixture, 'shared-model(openai)', {
      providerSettings: { allowHostAccess: true },
      hooks: {
        onBackgroundStart: () => {
          starts += 1;
        },
        onBackground: (result) => results.push(result),
      },
    });
    const handle = adapter.session?.open ? await adapter.session.open(input) : {
      send: (turn) => adapter.run({ ...input, ...turn }),
      close: async () => {},
      alive: true,
    };

    t.after(() => handle.close());
    await handle.send({ message: 'Начни фон.', signal: AbortSignal.timeout(12000) });
    await until(() => results.length === 1, 'публикация фона');
    assert.equal(starts, 1);
    assert.equal(results[0].reply, cron ? 'CRON_SENTINEL' : 'BG_SENTINEL');
    assert.ok(handle.alive);
  });
}

/**
 * Родитель управляет только тестовым ACP child через собственный файл.
 * Барьеры заданы событиями; таймер read-loop не используется как критерий успеха.
 */
async function controlledLive(t, options = {}) {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const control = path.join(fixture.workspace, 'control.jsonl');
  const results = [];
  const tasks = [];
  const steps = [];
  const exits = [];
  let starts = 0;

  await writeFile(control, '');
  await fixture.fake({
    metadata: { 'shared-model(openai)': { context: 32768 } },
    control,
    ...options,
  });

  const input = runInput(fixture, 'shared-model(openai)', {
    providerSettings: { allowHostAccess: true },
    hooks: {
      onBackgroundStart: () => {
        starts += 1;
      },
      onBackground: (result) => results.push(result),
      onBackgroundTasks: (value) => tasks.push(value),
      onBackgroundStep: (value) => steps.push(value),
      onExit: (value) => exits.push(value),
    },
  });
  const handle = adapter.session?.open ? await adapter.session.open(input) : {
    send: (turn) => adapter.run({ ...input, ...turn }),
    interrupt: async () => {},
    close: async () => {},
    alive: true,
  };

  t.after(() => handle.close());

  return {
    fixture,
    handle,
    results,
    tasks,
    steps,
    exits,
    starts: () => starts,
    async frame(value) {
      await appendFile(control, JSON.stringify(value) + '\n');
    },
  };
}

const heartbeat = (seq, holds, extraSessions = []) => ({
  method: 'qwen/notify/channel/active-work',
  params: {
    v: 1,
    seq,
    sessions: [{ sessionId: '$session', holds }, ...extraSessions],
  },
});
const chunk = (kind, text, meta = {}) => ({
  method: 'session/update',
  params: {
    sessionId: '$session',
    update: {
      sessionUpdate: kind,
      content: { type: 'text', text },
      _meta: meta,
    },
  },
});

/**
 * Cron начинает собственный цикл только после завершения managed-ответа.
 * Busy heartbeat соответствует native порядку: он может предшествовать user chunk.
 */
async function startCron(h) {
  await h.frame(heartbeat(1, [{ category: 'session', id: 'session:active-turn' }]));
  await h.frame(chunk('user_message_chunk', 'cron', { source: 'cron' }));
  await h.frame(chunk('agent_message_chunk', 'CRON_PARTIAL'));
  await until(() => h.starts() === 1, 'native cron start');
}

test('Qwen Host: Stop cron сохраняет частичный ответ и один stopped без потери PID', async (t) => {
  const h = await controlledLive(t);

  await h.handle.send({ message: 'Начни.', signal: AbortSignal.timeout(12000) });

  const pid = h.handle.pid;

  await startCron(h);
  await h.handle.interrupt();
  await h.frame(heartbeat(2, []));
  await h.frame(heartbeat(3, []));
  await until(() => h.results.length === 1, 'stopped cron');
  assert.equal(h.results[0].stopped, true);
  assert.equal(h.results[0].reply, 'CRON_PARTIAL');
  assert.ok(h.results[0].steps.some((step) => step.k === 'text'));
  await h.handle.send({ message: 'Продолжим.', signal: AbortSignal.timeout(12000) });
  assert.equal(h.handle.pid, pid);
  assert.equal((await h.fixture.records()).filter((entry) => entry.event === 'spawn').length, 1);
});

test('Qwen Host: Stop foreground и следующий send сохраняют исправный канал', async (t) => {
  const h = await controlledLive(t, { holdFirst: true });
  const controller = new AbortController();
  const first = h.handle.send({ message: 'Долгий.', signal: controller.signal });
  let stopped;
  const rejected = assert.rejects(first, (error) => {
    stopped = error;

    return error.stopped === true;
  });

  await until(async () => (await h.fixture.records()).some((entry) =>
    entry.frame?.method === 'session/prompt'), 'первый prompt');
  controller.abort();
  await rejected;
  assert.equal(stopped.stopped, true);
  assert.ok(stopped.steps.some((step) => step.k === 'text'));

  const second = await h.handle.send({ message: 'Новый.', signal: AbortSignal.timeout(12000) });

  assert.equal(second.sessionId, stopped.sessionId);
  assert.equal(second.reply, 'Новый ответ');
  assert.equal((await h.fixture.records()).filter((entry) => entry.event === 'spawn').length, 1);
});

test('Qwen Host: abort ожидания фона не ждёт native cancel и не запускает поздний prompt', async (t) => {
  const h = await controlledLive(t, { ignoreCancel: true });

  await h.handle.send({ message: 'Начни.', signal: AbortSignal.timeout(12000) });
  await startCron(h);

  const controller = new AbortController();
  const waiting = h.handle.send({ message: 'Этот prompt отменён.', signal: controller.signal });
  const failure = assert.rejects(waiting, (error) => error.stopped === true);

  controller.abort();
  await h.handle.interrupt();
  await failure;
  await until(() => h.exits.length === 1, 'backstop закрыл только свой неответивший CLI');
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].stopped, true);
  assert.equal((await h.fixture.records()).filter((entry) =>
    entry.frame?.method === 'session/prompt').length, 1);
});

test('Qwen Host: повреждённый целый heartbeat не сбрасывает задачи, seq и cron', async (t) => {
  const h = await controlledLive(t);

  await h.handle.send({ message: 'Начни.', signal: AbortSignal.timeout(12000) });
  await startCron(h);
  await h.frame(heartbeat(2, [{ category: 'shell', id: 'command-one' },
    { category: 'session', id: 'session:active-turn' }]));
  await until(() => h.tasks.at(-1)?.[0]?.id === 'command-one', 'задача в snapshot');

  const before = h.tasks.length;
  const bad = [
    heartbeat(3, [{ category: 'sessoin', id: 'bad' }]),
    heartbeat(3, [], [{ sessionId: 'foreign', holds: [{ category: 'unknown', id: 'bad' }] }]),
    heartbeat(3, [{ category: 'shell', id: 'same' }, { category: 'shell', id: 'same' }]),
    heartbeat(3, [], [{ sessionId: '$session', holds: [] }]),
  ];

  for (const frame of bad) {
    await h.frame(frame);
  }

  await until(() => h.steps.filter((step) => step.level === 'warn').length === bad.length,
    'повреждённые DTO диагностированы');
  assert.equal(h.tasks.length, before);
  assert.equal(h.results.length, 0);
  await h.frame(heartbeat(3, []));
  await until(() => h.results.length === 1, 'тот же seq принят после повреждённого snapshot');
});

test('Qwen Host: поздний end A не завершает новый cron B', async (t) => {
  const h = await controlledLive(t);

  await h.handle.send({ message: 'Начни.', signal: AbortSignal.timeout(12000) });
  await h.frame({ method: '_qwencode/start_turn', params: {
    sessionId: '$session', source: 'goal',
  } });
  await until(() => h.starts() === 1, 'goal A');

  const endA = {
    method: '_qwencode/end_turn',
    params: {
      sessionId: '$session',
      source: 'goal',
      promptId: '$session########1',
      reason: 'end_turn',
    },
  };

  await h.frame(endA);
  await until(() => h.results.length === 1, 'итог A');
  await h.frame(heartbeat(1, [{ category: 'session', id: 'session:active-turn' }]));
  await h.frame(chunk('user_message_chunk', 'B', { source: 'cron' }));
  await until(() => h.starts() === 2, 'cron B');
  await h.frame(endA);
  await h.frame(heartbeat(2, [{ category: 'session', id: 'session:active-turn' }]));
  await until(() => h.tasks.length >= 2, 'барьер после позднего end A');
  assert.equal(h.results.length, 1);
  await h.frame(heartbeat(3, []));
  await until(() => h.results.length === 2, 'настоящий release B');
});

for (const partial of [false, true]) {
  test(`Qwen Host: EOF фона не публикует выдуманный Stop, partial=${partial}`, async (t) => {
    const h = await controlledLive(t);

    await h.handle.send({ message: 'Начни.', signal: AbortSignal.timeout(12000) });
    await h.frame({ method: '_qwencode/start_turn', params: {
      sessionId: '$session', source: 'goal',
    } });
    await until(() => h.starts() === 1, 'фон до EOF');

    if (partial) {
      await h.frame(chunk('agent_message_chunk', 'PARTIAL_BEFORE_EOF'));
    }

    await h.frame({ fixtureExit: true });
    await until(() => h.exits.length === 1, 'native EOF');
    assert.equal(h.results.length, 0, 'Нет поддельного финального сообщения от пользователя');
    assert.equal(h.handle.alive, false);
    assert.deepEqual(h.tasks.at(-1), []);
    assert.equal((await h.fixture.records()).filter((entry) =>
      entry.frame?.method === 'session/prompt').length, 1, 'Нет автоматического replay');
  });
}

test('Qwen Host: нет configOptions или heartbeat ACK — нет prompt и старого set_model', async (t) => {
  for (const options of [{ metadata: undefined }, { noHeartbeat: true,
    metadata: { 'shared-model(openai)': { context: 32768 } } }]) {
    const h = await controlledLive(t, options);

    await assert.rejects(h.handle.send({ message: 'Не запускать.' }), /config|модел|heartbeat/);

    const calls = (await h.fixture.records()).filter((entry) => entry.frame?.method);

    assert.equal(calls.some((entry) => entry.frame.method === 'session/prompt'), false);
    assert.equal(calls.some((entry) => entry.frame.method === 'session/set_model'), false);
  }
});

test('Qwen Host: replay cron не забирает следующий пользовательский ответ', async (t) => {
  const h = await controlledLive(t, { replayCron: true });

  await h.handle.send({ message: 'Первый.', signal: AbortSignal.timeout(12000) });

  const pid = h.handle.pid;

  await startCron(h);
  await h.frame(heartbeat(2, []));
  await until(() => h.results.length === 1, 'настоящий первый cron завершён');

  const starts = h.starts();
  const second = await h.handle.send({ message: 'Следующий.', signal: AbortSignal.timeout(12000) });

  assert.equal(second.reply, 'Новый ответ');
  assert.equal(h.starts(), starts, 'Исторический cron не начал новый background');
  assert.equal(h.results.length, 1);
  assert.equal(h.handle.pid, pid);
  assert.equal(JSON.stringify(second).includes('HISTORICAL_CRON'), false);

  const third = await h.handle.send({ message: 'Ещё один.', signal: AbortSignal.timeout(12000) });

  assert.equal(third.reply, 'Новый ответ');
  assert.equal(third.sessionId, second.sessionId);
});

test('Qwen Host: настоящий cron в окне load публикуется и не вклеивается в ответ', async (t) => {
  const h = await controlledLive(t, { cronDuringLoad: true });

  await h.handle.send({ message: 'Первый.', signal: AbortSignal.timeout(12000) });

  const pid = h.handle.pid;

  const second = await h.handle.send({ message: 'Следующий.', signal: AbortSignal.timeout(12000) });

  assert.equal(second.reply, 'Новый ответ');
  assert.equal(JSON.stringify(second).includes('CRON_WINDOW'), false);
  await until(() => h.starts() === 1, 'настоящий cron начат после хода');
  await h.frame(heartbeat(2, []));
  await until(() => h.results.length === 1, 'настоящий cron опубликован');
  assert.equal(h.results[0].reply, 'CRON_WINDOW');
  assert.equal(h.handle.pid, pid);
  assert.equal((await h.fixture.records()).filter((entry) => entry.event === 'spawn').length, 1);
});

test('Qwen Host: cron завершившийся в окне load публикуется один раз с полным текстом', async (t) => {
  const h = await controlledLive(t, { cronDuringLoad: true, cronReleaseDuringLoad: true });

  await h.handle.send({ message: 'Первый.', signal: AbortSignal.timeout(12000) });

  const pid = h.handle.pid;

  const second = await h.handle.send({ message: 'Следующий.', signal: AbortSignal.timeout(12000) });

  assert.equal(second.reply, 'Новый ответ');
  assert.equal(JSON.stringify(second).includes('CRON_WINDOW'), false);
  await until(() => h.results.length === 1, 'наблюдённый held→released публикует завершённый cron');
  assert.equal(h.starts(), 1);
  assert.equal(h.results[0].reply, 'CRON_WINDOW');
  assert.equal(h.results[0].stopped, undefined);
  assert.equal(h.handle.pid, pid);
  assert.equal((await h.fixture.records()).filter((entry) => entry.event === 'spawn').length, 1);
});

test('Qwen Host: cron завершившийся во время foreground публикуется после остановки хода', async (t) => {
  const h = await controlledLive(t, { holdFirst: true });
  const controller = new AbortController();
  const first = h.handle.send({ message: 'Долгий.', signal: controller.signal });
  const stopped = assert.rejects(first, (error) => error.stopped === true);

  await until(async () => (await h.fixture.records()).some((entry) =>
    entry.frame?.method === 'session/prompt'), 'первый prompt');
  await h.frame(chunk('user_message_chunk', 'cron', { source: 'cron' }));
  await h.frame(chunk('agent_message_chunk', 'CRON_FOREGROUND'));
  await h.frame(heartbeat(1, [{ category: 'session', id: 'session:active-turn' }]));
  await until(() => h.tasks.length >= 1, 'session hold наблюдён во время foreground');
  await h.frame(heartbeat(2, []));
  await until(() => h.tasks.length >= 2, 'release наблюдён во время foreground');
  controller.abort();
  await stopped;
  await until(() => h.results.length === 1, 'завершённый фон опубликован после остановки хода');
  assert.equal(h.starts(), 1);
  assert.equal(h.results[0].reply, 'CRON_FOREGROUND');
  assert.equal(h.results[0].stopped, undefined);
});

test('Qwen Host: fingerprint меняется от прав и scope, но не от картинок', async (t) => {
  const fixture = await qwenFixture(t);
  const base = runInput(fixture, 'shared-model(openai)', {
    providerSettings: { allowHostAccess: true },
  });
  const first = await qwenLiveFingerprint(base);

  assert.equal(await qwenLiveFingerprint({
    ...base,
    attachmentPaths: [path.join(fixture.root, 'a.png')],
  }), first);
  assert.equal(await qwenLiveFingerprint({ ...base, attachmentsDir: fixture.root }), first);
  assert.notEqual(await qwenLiveFingerprint({ ...base, workToolScopeKey: 'two' }), first);
  assert.notEqual(await qwenLiveFingerprint({
    ...base, providerSettings: { allowHostAccess: false },
  }), first);
  assert.notEqual(await qwenLiveFingerprint({ ...base, permissionMode: 'plan' }), first);
  assert.notEqual(await qwenLiveFingerprint({ ...base, extraDirs: [fixture.root] }), first);
});
