// Сжатие контекста должно быть видно на ВСЕХ устройствах, а не только в том окне,
// где нажали кнопку: правда о ходе живёт на сервере (activeRuns → SSE `chat-turn-start`
// и `GET /api/chat/active`). У родного компакта нет ни шагов, ни прогресса, поэтому
// пропущенное событие догнать больше нечем — отсюда сверка активных ходов.
import assert from 'node:assert/strict';
import test from 'node:test';

import { apiHarness, chatStoreFixture, sseOf } from './helpers/chat-store.js';

// Второе устройство: история уже загружена, своих запросов нет — только SSE и сверки.
function fixture() {
  return chatStoreFixture({
    sessions: [{
      id: 'c1', taskId: null, title: 'Чат', messages: [], sessionId: 'sess-1',
      contextTokens: 120000, sending: false, compacting: false, steps: [], draft: '',
    }],
  });
}

test('WEB-01: чужое окно узнаёт о сжатии из chat-turn-start и снимает его по chat-done', async () => {
  const chat = await fixture();
  const sse = sseOf(chat);
  const sess = chat.sessions[0];

  sse('chat-turn-start', { chatKey: 'c1', at: 1, compact: true });
  assert.equal(sess.compacting, true, 'кольцо должно крутиться и во втором окне');
  assert.equal(sess.sending, false, '«думает…» не спорит с кольцом сжатия');

  // Исполнитель без родного компакта шлёт прогресс — он не должен подменять кольцо.
  sse('chat-progress', { chatKey: 'c1', tokens: 42 });
  assert.equal(sess.sending, false);
  assert.equal(sess.compacting, true);

  sse('chat-done', { chatKey: 'c1' });
  assert.equal(sess.compacting, false);
});

test('WEB-02: обычный ход остаётся «думает…», а не сжатием', async () => {
  const chat = await fixture();
  const sse = sseOf(chat);
  const sess = chat.sessions[0];

  sse('chat-turn-start', { chatKey: 'c1', at: 1 });
  assert.equal(sess.sending, true);
  assert.equal(sess.compacting, false);
});

test('WEB-03: сверка активных ходов поднимает пропущенное сжатие', async () => {
  const chat = await fixture();
  const sess = chat.sessions[0];
  apiHarness.get = async (url) => {
    assert.equal(url, '/api/chat/active');
    return { active: [{ chatKey: 'c1', startedAt: 1, tokens: 0, steps: [], compact: true }] };
  };

  await chat._loadActive();
  assert.equal(sess.compacting, true, 'после F5/переподключения сжатие видно снова');
  assert.equal(sess.sending, false);
});

test('WEB-04: ход, которого на сервере уже нет, снимает и «думает…», и кольцо', async () => {
  const chat = await fixture();
  const sess = chat.sessions[0];
  sess.sending = true;
  sess.compacting = true;
  sess.progressTokens = 999;

  await chat._loadActive(); // сервер отвечает пустым списком (рестарт, ход кончился в офлайне)
  assert.equal(sess.sending, false);
  assert.equal(sess.compacting, false);
  assert.equal(sess.progressTokens, 0);
});

test('WEB-05: своё незакрытое сжатие сверка не размораживает', async () => {
  const chat = await fixture();
  const sess = chat.sessions[0];
  let release;
  apiHarness.post = () => new Promise((resolve) => { release = resolve; });

  const running = chat.compact('c1');
  assert.equal(sess.compacting, true);

  // Сервер ещё не успел показать ход в activeRuns — заморозку снимать нельзя.
  await chat._loadActive();
  assert.equal(sess.compacting, true);
  sseOf(chat)('chat-done', { chatKey: 'c1' });
  assert.equal(sess.compacting, true);

  release({ compact: { kind: 'native' } });
  await running;
  assert.equal(sess.compacting, false, 'разморозил собственный ответ');
});

test('WEB-06: прерванное сжатие не выдаёт себя за успешное', async () => {
  const chat = await fixture();
  const sess = chat.sessions[0];
  apiHarness.post = async () => ({ reply: '⏹ Ход остановлен.', stopped: true });

  await chat.compact('c1');
  assert.equal(sess.contextTokens, 120000, 'контекст остался прежним — счётчик не обнуляем');
  assert.equal(sess.compactedAt, undefined);
  assert.equal(sess.compacting, false);
  assert.match(sess.messages.at(-1).text, /прервано/);
});

// ── Итог сжатия и следующий ход, доехавшие через pending ──────────────────────
// Окно перезагрузили посреди сжатия или посреди первого хода после него. Сервер
// помнит весь текст запроса вместе с блоком выжимки, а итог сжатия кладёт в pending
// как обычный ответ: ни то ни другое в переписке показываться не должно.

const SEED = 'Задача: собрать ролик. Сделано: этапы 0–9. Осталось: живая приёмка.';
const SEEDED = `[Выжимка предыдущего разговора — продолжаем с этого места]\n${SEED}\n[/Выжимка]\n\n`;

test('WEB-07: вопрос из pending восстанавливается без блока выжимки', async () => {
  const chat = await fixture();
  const sess = chat.sessions[0];
  sess.sessionId = null;
  // Человек отправил только скриншот: в истории его сообщение с пустым текстом.
  sess.messages.push({ role: 'user', text: '', sentAt: 10, attachments: [{ name: 'image.png' }] });
  apiHarness.get = async (url) => (url === '/api/chat/pending'
    ? {
      pending: [{
        id: 'o1', chatKey: 'c1', role: 'assistant', reply: 'Продолжаю приёмку.',
        userText: SEEDED, userSentAt: 10, sessionId: 'sess-2', at: 20,
      }],
    }
    : { active: [] });

  await chat._collectPending();

  assert.deepEqual(sess.messages.map((m) => m.role), ['user', 'assistant'],
    'выжимка не всплывает отдельным «сообщением пользователя»');
  assert.equal(sess.messages.at(-1).text, 'Продолжаю приёмку.');
  assert.equal(sess.sessionId, 'sess-2');
});

test('WEB-08: потерянный вместе с окном вопрос восстанавливается видимой частью', async () => {
  const chat = await fixture();
  const sess = chat.sessions[0];
  apiHarness.get = async (url) => (url === '/api/chat/pending'
    ? {
      pending: [{
        id: 'o2', chatKey: 'c1', role: 'assistant', reply: 'Готово.',
        userText: `${SEEDED}посмотри скриншот`, userSentAt: 30, at: 40,
      }],
    }
    : { active: [] });

  await chat._collectPending();

  assert.deepEqual(sess.messages.map((m) => [m.role, m.text]), [
    ['user', 'посмотри скриншот'],
    ['assistant', 'Готово.'],
  ]);
});

test('WEB-09: итог сжатия из pending засевает новую сессию, а не ложится ответом агента', async () => {
  const chat = await fixture();
  const sess = chat.sessions[0];
  sess.compacting = true;
  const deleted = [];
  apiHarness.get = async (url) => (url === '/api/chat/pending'
    ? {
      pending: [{
        id: 'o3', chatKey: 'c1', role: 'assistant', reply: '🗜 Контекст сжат.',
        compact: { kind: 'summary', seed: SEED }, sessionId: null, contextTokens: 0, at: 50,
      }],
    }
    : { active: [] });
  apiHarness.del = async (url) => { deleted.push(url); return {}; };

  await chat._collectPending();

  assert.equal(sess.pendingSeed, SEED, 'выжимка ждёт следующего сообщения');
  assert.equal(sess.sessionId, null, 'старая сессия забыта — следующий ход начнёт новую');
  assert.equal(sess.contextTokens, 0);
  assert.equal(sess.compacting, false);
  assert.deepEqual(sess.messages.map((m) => [m.role, m.pid]), [['note', 'o3']]);
  assert.match(sess.messages[0].text, /было 120\D000 токенов/);
  assert.deepEqual(deleted, ['/api/chat/pending/o3']);

  // Повторная сверка до подтверждения DELETE не засевает дважды и не дублирует плашку.
  sess.pendingSeed = '';
  await chat._collectPending();
  assert.equal(sess.pendingSeed, '');
  assert.equal(sess.messages.length, 1);
});
