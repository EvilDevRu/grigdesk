import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { chatAppFixture, TEST_MODEL_REF, waitFor } from './helpers/chat-turns.js';

/**
 * Настоящие HTTP-маршруты работают с временным cwd и фейковым исполнителем.
 * Выжимка и первый ход новой сессии наблюдаются на границе executor.run.
 */
async function fixture(t) {
  const runs = [];
  const executor = {
    id: 'test-provider',
    workdir: { switch: 'reseed', roots: 'single' },
    async run(input) {
      runs.push(input);

      if (executor.respond) {
        return executor.respond(input);
      }

      return { reply: 'Рабочая память разговора', sessionId: `session-${runs.length}` };
    },
  };
  const f = await chatAppFixture(t, { executor });
  const first = path.join(f.root, 'first');
  const second = path.join(f.root, 'second');
  const third = path.join(f.root, 'third');

  await Promise.all([first, second, third].map((dir) => fs.mkdir(dir)));

  const response = await f.app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        id: 'moving-chat',
        modelRef: TEST_MODEL_REF,
        messages: [],
        workdir: { kind: 'path', path: first },
        createdAt: Date.now(),
      }
    },
  });

  assert.equal(response.statusCode, 200, response.body);

  return {
    ...f,
    first,
    second,
    third,
    runs,
    executor
  };
}

async function read(app) {
  return (await app.inject('/api/chat/store/chat/moving-chat')).json().chat;
}

async function send(app, turnId) {
  return app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'moving-chat',
      modelRef: TEST_MODEL_REF,
      message: 'Продолжай',
      ...(turnId ? { turnId } : {}),
    }
  });
}

/**
 * Переход собирается из реального предпросмотра, включая CAS и эффективные корни.
 * Повтор использует неизменное исходное тело, как при потере HTTP-ответа.
 */
async function change(f, directory, transfer, operationId) {
  const candidate = { taskId: null, workdir: { kind: 'path', path: directory } };
  const preview = await f.app.inject({
    method: 'POST',
    url: '/api/chat/workdir/preview',
    payload: { chatKey: 'moving-chat', candidate },
  });

  assert.equal(preview.statusCode, 200, preview.body);

  const body = {
    chatKey: 'moving-chat',
    ...candidate,
    operationId,
    transfer,
    expectedRevision: preview.json().revision,
    expectedWorkspaceKey: preview.json().workspaceKey,
  };
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/chat/workdir/change',
    payload: body
  });

  return { body, response };
}

test('явный null в preview не подменяется сохранённой папкой', async (t) => {
  const f = await fixture(t);
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/chat/workdir/preview',
    payload: { chatKey: 'moving-chat', candidate: { taskId: null, workdir: null } },
  });

  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error, 'bad_workdir');
  assert.equal((await read(f.app)).workdir.path, f.first);
  assert.equal(f.runs.length, 0);
});

test('A → B → C сохраняет seed; replay не повторяет summary', async (t) => {
  const f = await fixture(t);

  assert.equal((await send(f.app)).statusCode, 200);
  assert.equal(f.runs[0].cwd, f.first);

  const first = await change(f, f.second, 'summary', 'operation-first');

  assert.equal(first.response.statusCode, 200, first.response.body);
  assert.equal(f.runs[1].cwd, f.first);
  assert.equal(first.response.json().chat.workdirState.seed, 'Рабочая память разговора');
  assert.equal(first.response.json().chat.sessionId, null);

  const replay = await f.app.inject({
    method: 'POST',
    url: '/api/chat/workdir/change',
    payload: first.body,
  });

  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(f.runs.length, 2);

  const second = await change(f, f.third, 'summary', 'operation-second');

  assert.equal(second.response.statusCode, 200, second.response.body);
  assert.equal(f.runs.length, 2);
  assert.equal((await send(f.app)).statusCode, 200);
  assert.equal(f.runs[2].cwd, f.third);
  assert.match(f.runs[2].message, /Рабочая память разговора/u);
  assert.equal((await read(f.app)).workdirState.seed, '');
  await send(f.app);
  assert.doesNotMatch(f.runs[3].message, /Выжимка предыдущего/u);
});

test('устаревший маршрут задачи не запускает исполнителя', async (t) => {
  const f = await fixture(t);

  await send(f.app);

  const original = f.runs[0];
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/tasks/12/chat',
    payload: {
      chatKey: 'moving-chat',
      modelRef: TEST_MODEL_REF,
      message: 'Не запускать',
    }
  });

  assert.equal(response.statusCode, 409, response.body);
  assert.equal(f.runs.length, 1);
  assert.equal(original.cwd, f.first);
});

test('ошибка summary сохраняет старую сессию, после отказа можно выбрать reset', async (t) => {
  const f = await fixture(t);

  await send(f.app);
  f.executor.respond = () => {
    throw new Error('summary failed');
  };

  const failed = await change(f, f.second, 'summary', 'operation-failed');

  assert.equal(failed.response.statusCode, 500);

  const old = await read(f.app);

  assert.equal(old.workdir.path, f.first);
  assert.equal(old.sessionId, 'session-1');
  assert.equal(old.workdirState.transition.phase, 'failed');

  const reset = await change(f, f.second, 'reset', 'operation-reset');

  assert.equal(reset.response.statusCode, 200, reset.response.body);
  assert.equal(reset.response.json().chat.workdirState.seed, '');
  assert.equal(f.runs.length, 2);
});

test('во время summary draft сохраняется, сообщения и переход не теряются, новый ход отклонён', async (t) => {
  const f = await fixture(t);

  await send(f.app);

  let release;

  f.executor.respond = () => new Promise((resolve) => {
    release = resolve;
  });

  const changing = change(f, f.second, 'summary', 'operation-blocked');

  await waitFor(() => release);

  const current = await read(f.app);
  const saving = await f.app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        ...current,
        draft: 'Набран во время выжимки',
        messages: [{
          role: 'user',
          text: 'Ещё сообщение'
        }]
      },
    }
  });

  assert.equal(saving.statusCode, 200, saving.body);
  assert.equal((await send(f.app)).statusCode, 409);
  release({ reply: 'Память старой сессии', sessionId: 'session-1' });

  const changed = await changing;

  assert.equal(changed.response.statusCode, 200, changed.response.body);

  const stored = await read(f.app);

  assert.equal(stored.draft, 'Набран во время выжимки');
  assert.ok(stored.messages.some((m) => m.text === 'Ещё сообщение'));
  assert.equal(stored.messages.filter((m) => m.operationId === 'operation-blocked').length, 1);
});

test('цель исчезла во время summary: failed освобождает чат для выбора третьей папки', async (t) => {
  const f = await fixture(t);

  await send(f.app);
  f.executor.respond = async () => {
    await fs.rmdir(f.second);

    return { reply: 'Новая выжимка', sessionId: 'session-1' };
  };

  const failed = await change(f, f.second, 'summary', 'operation-missing');

  assert.equal(failed.response.statusCode, 409, failed.response.body);
  assert.equal((await read(f.app)).workdirState.transition.phase, 'failed');

  const corrected = await change(f, f.third, 'reset', 'operation-correct');

  assert.equal(corrected.response.statusCode, 200, corrected.response.body);
});

test('исчезнувшую старую папку можно исправить без запуска в случайном cwd', async (t) => {
  const f = await fixture(t);

  await fs.rmdir(f.first);

  const changed = await change(f, f.second, 'resume', 'operation-repair');

  assert.equal(changed.response.statusCode, 200, changed.response.body);
  assert.equal(f.runs.length, 0);
});

test('ошибка и stop первого хода сохраняют seed и не возвращают id сброшенной сессии', async (t) => {
  const f = await fixture(t);

  await send(f.app);
  await change(f, f.second, 'summary', 'operation-seed');
  f.executor.respond = async (input) => {
    await input.onSessionCreated('partial-session');

    throw Object.assign(new Error('Прервано'), { stopped: true, sessionId: 'partial-session' });
  };

  const stopped = await send(f.app);

  assert.equal(stopped.statusCode, 200, stopped.body);
  assert.equal(stopped.json().sessionId, null);
  assert.equal(stopped.json().sessionReset, true);
  assert.equal((await read(f.app)).workdirState.seed, 'Рабочая память разговора');
  f.executor.respond = () => {
    throw new Error('Запуск не удался');
  };
  assert.equal((await send(f.app)).statusCode, 500);
  assert.equal((await read(f.app)).workdirState.seed, 'Рабочая память разговора');
  f.executor.respond = null;
  assert.equal((await send(f.app)).statusCode, 200);
  assert.equal(f.runs.at(-1).sessionId, null);
  assert.match(f.runs.at(-1).message, /Рабочая память разговора/u);
  assert.equal((await read(f.app)).workdirState.seed, '');
});

test('рестарт после seedClaim сбрасывает частичную сессию и сохраняет выжимку', async (t) => {
  const f = await fixture(t);

  await send(f.app);
  await change(f, f.second, 'summary', 'operation-restart');
  await f.app.close();

  const { ChatHistoryStore } = await import('../../server/src/lib/chat/historyStore.ts');
  const history = new ChatHistoryStore({ chatsDir: f.config.chatsDir });

  await history.patchExecution('moving-chat', (record) => ({
    sessionId: 'partial',
    workdirState: { ...record.workdirState, seedClaim: { id: 'claimed-turn' } },
  }));

  const next = await chatAppFixture(t, { root: f.root, executor: f.executor });
  const recovered = await read(next.app);

  assert.equal(recovered.sessionId, null);
  assert.equal(recovered.workdirState.seedClaim, null);
  assert.equal(recovered.workdirState.seed, 'Рабочая память разговора');
  assert.equal((await send(next.app)).statusCode, 200);
  assert.match(f.runs.at(-1).message, /Рабочая память разговора/u);
});

test('служебная slash-команда после перехода не потребляет выжимку', async (t) => {
  const f = await fixture(t);

  f.executor.commands = () => [{
    cmd: '/status',
    run: 'prompt',
    desc: 'Статус'
  }];
  await send(f.app);
  await change(f, f.second, 'summary', 'operation-slash');

  const response = await f.app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'moving-chat',
      modelRef: TEST_MODEL_REF,
      message: '/status',
      slashCommand: '/status',
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(f.runs.at(-1).message, '/status');
  assert.equal((await read(f.app)).workdirState.seed, 'Рабочая память разговора');

  const before = f.runs.length;
  const second = await change(f, f.third, 'summary', 'operation-after-slash');

  assert.equal(second.response.statusCode, 200, second.response.body);
  assert.equal(f.runs.length, before, 'сессия slash-команды не заменяет непотреблённую выжимку');
  await send(f.app);
  assert.equal(f.runs.at(-1).cwd, f.third);
  assert.match(f.runs.at(-1).message, /Рабочая память разговора/u);
});

test('принятый queued ход отказывает при изменении realpath и блокирует переход', async (t) => {
  const f = await fixture(t);

  await fs.rmdir(f.first);
  await fs.symlink(f.second, f.first);

  let release;

  f.executor.respond = () => new Promise((resolve) => {
    release = resolve;
  });
  assert.equal((await send(f.app, 'accepted-first')).statusCode, 202);
  await waitFor(() => release);
  assert.equal((await send(f.app, 'accepted-second')).statusCode, 202);

  const blocked = await change(f, f.third, 'reset', 'operation-queued');

  assert.equal(blocked.response.statusCode, 409);
  await fs.unlink(f.first);
  await fs.symlink(f.third, f.first);
  release({ reply: 'Готово', sessionId: 'old-session' });
  await waitFor(async () => {
    const statuses = (await f.app.inject('/api/chat/turns?ids=accepted-second')).json();

    return statuses.turns['accepted-second']?.state === 'done';
  });
  assert.equal(f.runs.length, 1);

  const pending = (await f.app.inject('/api/chat/pending')).json();
  const refused = pending.pending.find((item) => item.turnId === 'accepted-second');

  assert.equal(refused.error, 'stale_chat_workdir');
});

test('рестарт из ready завершает commit без повторной выжимки', async (t) => {
  const f = await fixture(t);

  await send(f.app);
  await change(f, f.second, 'summary', 'operation-ready');
  await f.app.close();

  const { ChatHistoryStore } = await import('../../server/src/lib/chat/historyStore.ts');
  const history = new ChatHistoryStore({ chatsDir: f.config.chatsDir });

  await history.patchExecution('moving-chat', (record) => ({
    workdir: { kind: 'path', path: f.first },
    sessionId: 'session-1',
    // Плашка перехода пишется только в чат с разговором: пустому чату переносить нечего.
    messages: [{ role: 'user', text: 'Вопрос до перехода' }],
    workdirState: {
      ...record.workdirState,
      committed: record.workdirState.sessionWorkspace,
      transition: { ...record.workdirState.transition, phase: 'ready' },
    },
  }));

  const next = await chatAppFixture(t, { root: f.root, executor: f.executor });
  const recovered = await read(next.app);

  assert.equal(recovered.workdir.path, f.second);
  assert.equal(recovered.sessionId, null);
  assert.equal(recovered.workdirState.transition.phase, 'done');
  assert.equal(f.runs.length, 2);
  assert.equal(recovered.messages.filter((entry) => entry.operationId === 'operation-ready').length, 1);
});

/**
 * Разговор, начатый до выбора папки: сообщения есть, а сессии и снимка workspace нет.
 * Так выглядят все чаты, которые шли на прежнем сервере.
 */
async function withConversation(f) {
  const current = await read(f.app);
  const saved = await f.app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        ...current,
        messages: [
          { role: 'user', text: 'Старый вопрос' },
          { role: 'assistant', text: 'Старый ответ' },
        ],
      },
    },
  });

  assert.equal(saved.statusCode, 200, saved.body);
}

function notesOf(chat) {
  return (chat.messages || []).filter((message) => message.role === 'note').map((message) => message.text);
}

test('плашка перехода называет исходную папку разговора, начатого до выбора папки', async (t) => {
  const f = await fixture(t);

  await withConversation(f);

  const moved = await change(f, f.second, 'resume', 'operation-named');

  assert.equal(moved.response.statusCode, 200, moved.response.body);
  assert.deepEqual(notesOf(await read(f.app)), [
    `📁 Папка: ${await fs.realpath(f.first)} → ${await fs.realpath(f.second)}`,
  ]);
});

test('пустой чат и выбор той же папки меняют выбор без плашки в истории', async (t) => {
  const f = await fixture(t);
  const empty = await change(f, f.second, 'resume', 'operation-empty');

  assert.equal(empty.response.statusCode, 200, empty.response.body);
  assert.equal((await read(f.app)).workdir.path, f.second);
  assert.deepEqual(notesOf(await read(f.app)), []);

  await withConversation(f);
  assert.equal((await send(f.app)).statusCode, 200);

  const same = await change(f, f.second, 'resume', 'operation-same');

  assert.equal(same.response.statusCode, 200, same.response.body);
  assert.deepEqual(notesOf(await read(f.app)), []);
});

test('обычный ход записывает исполняемое состояние чата одной записью', async (t) => {
  const f = await fixture(t);
  const before = (await read(f.app)).revision;

  assert.equal((await send(f.app)).statusCode, 200);
  assert.equal((await read(f.app)).revision, before + 1);
});
