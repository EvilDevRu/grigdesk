// Рантайм-поля живой строки хода: отметка начала хода и признак оценки расхода.
//
// Обе — свойства ОКНА, а не истории: они не едут на сервер и не должны переживать ход.
// Начало хода берётся по часам этого окна (серверное время бывает с другой машины):
// после F5 посреди хода отметка восстанавливается из ДЛИТЕЛЬНОСТИ, которую назвал сервер,
// а не из его `startedAt`; без длительности таймер молчит.
import assert from 'node:assert/strict';
import test from 'node:test';

import { apiHarness, chatStoreFixture, sseOf } from './helpers/chat-store.js';

function fixture() {
  return chatStoreFixture({
    sessions: [{
      id: 'c1', taskId: null, title: 'Чат', messages: [], sessionId: 'sess-1',
      contextTokens: 120000, sending: false, compacting: false, steps: [], draft: '',
    }],
  });
}

test('MET-01: начало хода ставит отметку времени, завершение — снимает её', async () => {
  const chat = await fixture();
  const sse = sseOf(chat);
  const sess = chat.sessions[0];

  sse('chat-turn-start', { chatKey: 'c1', at: 1 });
  assert.ok(sess.turnStartedAt > 0, 'ход идёт без отметки начала');
  assert.equal(sess.progressTokensEstimate, false);

  sse('chat-done', { chatKey: 'c1' });
  assert.equal(sess.turnStartedAt, 0, 'отметка пережила ход');
  assert.equal(sess.progressTokensEstimate, false);
});

test('MET-02: оценку расхода окно помечает, точный замер снимает пометку', async () => {
  const chat = await fixture();
  const sse = sseOf(chat);
  const sess = chat.sessions[0];

  sse('chat-turn-start', { chatKey: 'c1', at: 1 });
  sse('chat-progress', { chatKey: 'c1', tokens: 900, tokensIsEstimate: true });
  assert.equal(sess.progressTokens, 900);
  assert.equal(sess.progressTokensEstimate, true, 'оценка показана как замер');

  // Точный замер приходит следующим событием — «≈» обязана сняться.
  sse('chat-progress', { chatKey: 'c1', tokens: 950 });
  assert.equal(sess.progressTokensEstimate, false);
});

test('MET-03: сверка активных ходов возвращает расход и время — по длительности от сервера', async () => {
  const chat = await fixture();
  const sess = chat.sessions[0];
  apiHarness.get = async (url) => {
    assert.equal(url, '/api/chat/active');
    // `startedAt` — часы сервера (здесь нарочно «эпоха»): брать его напрямую нельзя.
    return {
      active: [{
        chatKey: 'c1', startedAt: 1, elapsedMs: 95_000, tokens: 700, tokensIsEstimate: true, steps: [],
      }],
    };
  };

  const before = Date.now();
  await chat._loadActive();
  const after = Date.now();
  assert.equal(sess.sending, true);
  assert.equal(sess.progressTokens, 700);
  assert.equal(sess.progressTokensEstimate, true);
  // Отметка — на часах ЭТОГО окна: «сейчас минус сколько идёт», а не серверная единица.
  assert.ok(sess.turnStartedAt >= before - 95_000 && sess.turnStartedAt <= after - 95_000,
    `время хода после F5 потеряно: ${sess.turnStartedAt}`);
});

test('MET-03b: без длительности от сервера время не выдумывается', async () => {
  const chat = await fixture();
  const sess = chat.sessions[0];
  let active = [{ chatKey: 'c1', startedAt: 1, tokens: 700, steps: [] }];
  apiHarness.get = async () => ({ active });

  // Старый сервер: длительности нет — серверный `startedAt` за своё время не выдаём.
  await chat._loadActive();
  assert.equal(sess.sending, true);
  assert.equal(sess.turnStartedAt, 0, 'время чужого начала хода показано как своё');

  // Мусор вместо длительности — тоже молчание, а не отметка в будущем.
  for (const elapsedMs of [-5, 'мусор', null]) {
    active = [{ chatKey: 'c1', startedAt: 1, elapsedMs, tokens: 700, steps: [] }];
    await chat._loadActive();
    assert.equal(sess.turnStartedAt, 0, `длительность ${String(elapsedMs)} дала отметку`);
  }

  // Ход только что начался: нулевая длительность — честная отметка «сейчас».
  active = [{ chatKey: 'c1', startedAt: 1, elapsedMs: 0, tokens: 700, steps: [] }];
  const before = Date.now();
  await chat._loadActive();
  assert.ok(sess.turnStartedAt >= before, 'нулевая длительность принята за отсутствие');
});

test('MET-04: сжатие не показывает ни времени хода, ни расхода', async () => {
  const chat = await fixture();
  const sse = sseOf(chat);
  const sess = chat.sessions[0];

  sess.progressTokensEstimate = true;
  sess.turnStartedAt = Date.now();
  sse('chat-turn-start', { chatKey: 'c1', at: 1, compact: true });

  assert.equal(sess.compacting, true);
  assert.equal(sess.turnStartedAt, 0);
  assert.equal(sess.progressTokensEstimate, false);
});

test('MET-05: отметки не уезжают в историю чата', async () => {
  const chat = await fixture();
  const sess = chat.sessions[0];
  sess.turnStartedAt = Date.now();
  sess.progressTokensEstimate = true;

  const sent = [];
  apiHarness.put = async (url, body) => { sent.push({ url, body }); return {}; };

  await chat._saveChatNow(sess);
  const payload = JSON.stringify(sent.map((call) => call.body));

  assert.ok(sent.length > 0, 'история чата не сохранялась — проверять нечего');
  assert.equal(payload.includes('turnStartedAt'), false, 'отметка начала хода попала в историю');
  assert.equal(payload.includes('progressTokensEstimate'), false, 'признак оценки попал в историю');
});
