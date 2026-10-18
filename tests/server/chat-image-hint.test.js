import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { chatImageHint, withChatImageHint } from '../../server/src/lib/chat/imageHint.ts';
import { withChatTitleHook } from '../../server/src/lib/chat/titleHook.ts';
import {
  chatAppFixture, controlledExecutor, saveChat, TEST_MODEL_REF, turnBody, waitFor,
} from './helpers/chat-turns.js';

const FIXED_HINT = [
  '[Подсказка GrigDesk: картинки в ответе]',
  'Чтобы показать картинку, вставь Markdown ![подпись](путь).',
  'Поддержаны PNG, JPEG, GIF и WebP до 10 МБ из рабочей папки разговора и папки артефактов.',
  'Относительный путь считается от основной папки; абсолютный — также из дополнительных папок.',
  'Новые картинки, снимки и временные файлы сохраняй в /data/artifacts/<тема>/.',
  'В .state/ папки кода не пиши. Нет доступа к папке артефактов — скажи об этом человеку.',
  'Файл вне этих папок сначала скопируй в папку артефактов. SVG не поддержан.',
  'Для пути с пробелами используй ![подпись](<путь с пробелами.png>).',
  '[/Подсказка]',
].join('\n');
// Ход фикстуры называет её папку артефактов; остальные строки те же.
const liveHint = (root) => chatImageHint(path.join(root, 'artifacts'));

test('CHAT-HINT-01: helper добавляет точный блок и сохраняет исходный текст', () => {
  assert.equal(withChatImageHint('  просьба\n', '/data/artifacts'), '  просьба\n\n\n' + FIXED_HINT);
});

test('CHAT-HINT-02: пользовательский маркер не подавляет серверный блок', () => {
  const original = '[Подсказка GrigDesk: картинки в ответе]\nЦитирую пример';

  assert.equal(withChatImageHint(original, '/data/artifacts'), original + '\n\n' + FIXED_HINT);
});

test('CHAT-HINT-03: обычный ход получает одну подсказку перед title hook', async (t) => {
  const control = controlledExecutor();
  const { app, root } = await chatAppFixture(t, { executor: control.executor });

  await saveChat(app, 'hint-chat');

  const accepted = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('hint-chat', 'hint-turn-0001', 'Покажи картинку', { requestTitle: true }),
  });

  assert.equal(accepted.statusCode, 202);

  const [run] = await control.waitForRuns(1);

  assert.equal(run.message, withChatTitleHook('Покажи картинку\n\n' + liveHint(root), true));
  assert.equal(run.message.split('[Подсказка GrigDesk: картинки в ответе]').length - 1, 1);
  assert.equal(run.message.endsWith('[/Служебный хук GrigDesk]'), true);
  run.release('Готово');
});

test('CHAT-HINT-04: подсказка только порту, оригинал в истории, this сохранён', async (t) => {
  const control = controlledExecutor();

  control.executor.inTurnInput = {
    protocol: 1,
    text: true,
    confirmation: 'forwarded',
  };

  const { app, events, root } = await chatAppFixture(t, { executor: control.executor });

  await saveChat(app, 'hint-chat');
  await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('hint-chat', 'hint-turn-0001'),
  });

  const [run] = await control.waitForRuns(1);
  const delivered = [];
  const closed = [];
  const port = {
    async deliver(input) {
      assert.equal(this === port, true);
      delivered.push(input);

      return { ok: true, state: 'forwarded' };
    },
    close(reason) {
      assert.equal(this === port, true);
      closed.push(reason);
    },
  };

  run.options.onInTurnReady(port);

  const active = (await app.inject('/api/chat/active')).json().active.find((entry) =>
    entry.chatKey === 'hint-chat');
  const payload = {
    chatKey: 'hint-chat',
    targetRunId: active.runId,
    messageId: 'hint-message-0001',
    text: 'Покажи также второй кадр',
  };
  const accepted = await app.inject({
    method: 'POST',
    url: '/api/chat/in-turn',
    payload,
  });

  assert.equal(accepted.statusCode, 202, accepted.body);
  await waitFor(() => delivered.length === 1);
  assert.deepEqual(delivered[0], {
    messageId: payload.messageId,
    text: payload.text + '\n\n' + liveHint(root),
    sequence: 1,
  });

  const page = await app.inject(`/api/chat/in-turn?chatKey=hint-chat&runId=${active.runId}`);

  assert.equal(page.json().entries[0].text, payload.text);
  assert.equal(page.json().entries[0].state, 'forwarded');
  assert.equal(events.filter((event) => event.event === 'chat-in-turn')
    .some((event) => JSON.stringify(event.data).includes('[Подсказка GrigDesk:')), false);
  run.release('Готово');
  await waitFor(async () => (await app.inject('/api/chat/active')).json().active.length === 0);

  await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('hint-chat', 'hint-turn-0002', 'Продолжи'),
  });

  const runs = await control.waitForRuns(2);

  runs[1].release('Продолжение готово');

  const history = await app.inject('/api/chat/store/chat/hint-chat');

  assert.equal(history.json().chat.messages.some((message) => message.text === payload.text), true);
  assert.equal(JSON.stringify(history.json()).includes('[Подсказка GrigDesk:'), false);
  assert.equal(closed.length > 0, true);
});

test('CHAT-HINT-05: retry и ход без title собираются из оригинала с одной подсказкой', async (t) => {
  const calls = [];
  const executor = {
    id: 'test-provider',
    async run(options) {
      calls.push(options.message);

      return calls.length === 1 ? {
        reply: '',
        steps: [],
        emptyRun: true,
      } : { reply: 'Готово' };
    },
  };
  const { app, root } = await chatAppFixture(t, { executor });
  const response = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: { modelRef: TEST_MODEL_REF, message: 'Покажи кадр' },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(calls, ['Покажи кадр\n\n' + liveHint(root), 'Покажи кадр\n\n' + liveHint(root)]);
});

test('CHAT-HINT-06: native slash и обе ветки compaction побайтово прежние', async (t) => {
  const calls = [];
  const executor = {
    id: 'test-provider',
    commands: async () => [{
      cmd: '/status',
      desc: 'Статус',
      run: 'prompt',
    }],
    async run(options) {
      calls.push(options.message);

      return { reply: 'Выжимка', sessionId: 'fixture-session' };
    },
  };
  const { app } = await chatAppFixture(t, { executor });
  const slash = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      modelRef: TEST_MODEL_REF,
      message: '/status',
      slashCommand: '/status',
      requestTitle: true,
    },
  });

  assert.equal(slash.statusCode, 200, slash.body);
  assert.equal(calls[0], '/status');
  executor.compaction = { kind: 'native', message: '/compact' };

  const native = await app.inject({
    method: 'POST',
    url: '/api/chat/compact',
    payload: { modelRef: TEST_MODEL_REF, sessionId: 'fixture-session' },
  });

  assert.equal(native.statusCode, 200, native.body);
  assert.equal(calls[1], '/compact');
  executor.compaction = { kind: 'summary' };

  const summary = await app.inject({
    method: 'POST',
    url: '/api/chat/compact',
    payload: { modelRef: TEST_MODEL_REF, sessionId: 'fixture-session' },
  });

  assert.equal(summary.statusCode, 200, summary.body);
  assert.equal(calls[2], [
    'Сожми наш разговор в рабочую выжимку, чтобы продолжить его в новой сессии с чистым контекстом.',
    'Верни ТОЛЬКО текст выжимки, без вступлений и без вопросов. Обязательно сохрани:',
    '— задачу, которую решаем, и текущее состояние;',
    '— уже принятые решения и причины, по которым они приняты;',
    '— файлы и места в коде, которых касались (с путями);',
    '— что уже сделано и что осталось;',
    '— договорённости и ограничения, о которых просил человек.',
  ].join('\n'));
  assert.equal(calls.length, 3);
});
