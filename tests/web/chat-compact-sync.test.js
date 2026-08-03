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
