import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ArbiterCardsStore } from '../../server/src/lib/arbiter-cards.js';

// Карточка арбитра — единственное место, где машинный вердикт узла превращается в
// человеческую формулировку. До 28.08.2026 она нигде не сохранялась: HTTP-путь показывал
// её одноразовым диалогом, автоматический вотчер отбрасывал вовсе. Ход живого агента
// тратился, понятный ответ писался — и пропадал.

const ATTEMPT = 'a_0123456789abcdef0123456789abcdef';
const OTHER_ATTEMPT = 'a_fedcba9876543210fedcba9876543210';

const card = (what = 'проверил по коду: импорта между модулями нет') => ({
  what, why: 'потому что', proof: 'поиском по каталогу', risk: 'ошибка вылезет на приёмке',
});

async function store() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arbiter-cards-'));
  return new ArbiterCardsStore(path.join(dir, 'arbiter-cards.json'));
}

test('сохранённый разбор читается по задаче и попытке', async () => {
  const cards = await store();
  await cards.save('900042', {
    attempt: ATTEMPT,
    verdict: 'human',
    card: card(),
    scopeChange: true,
    model: 'claude/claude-opus-5',
    node: 'hyposkeptic',
    stop: 'human',
  });

  const record = cards.read('900042', ATTEMPT);

  assert.equal(record.verdict, 'human');
  assert.equal(record.scopeChange, true);
  assert.equal(record.node, 'hyposkeptic');
  assert.equal(record.card.what, 'проверил по коду: импорта между модулями нет');
  assert.equal(typeof record.at, 'string');
});

// После `resume` или нового запуска прежний разбор относится к работе, которой больше нет.
test('разбор чужой попытки не выдаётся за свежий', async () => {
  const cards = await store();
  await cards.save('900042', { attempt: ATTEMPT, verdict: 'human', card: card() });

  assert.notEqual(cards.read('900042', ATTEMPT), null);
  assert.equal(cards.read('900042', OTHER_ATTEMPT), null);
});

test('новая остановка задачи перекрывает прежний разбор', async () => {
  const cards = await store();
  await cards.save('900042', { attempt: ATTEMPT, verdict: 'human', card: card('первое') });
  await cards.save('900042', { attempt: ATTEMPT, verdict: 'resolve', card: card('второе') });

  const record = cards.read('900042', ATTEMPT);

  assert.equal(record.verdict, 'resolve');
  assert.equal(record.card.what, 'второе');
});

// Текст пишет модель, то есть это недоверенные данные, которые уезжают в браузер.
test('управляющие символы и длина полей ограничены', async () => {
  const cards = await store();
  await cards.save('1', {
    attempt: ATTEMPT,
    verdict: 'human',
    card: { what: `с\u0000управляющим\u001b символом`, why: 'я'.repeat(3000) },
  });

  const record = cards.read('1', ATTEMPT);

  assert.equal(/[\u0000-\u001f\u007f]/.test(record.card.what), false);
  assert.equal(record.card.why.length <= 1201, true);
  // Незаполненное поле остаётся пустой строкой, а не исчезает: потребитель проверяет их
  // по одному и не должен различать «пусто» и «нет ключа».
  assert.equal(record.card.proof, '');
});

test('неизвестный вердикт не сохраняется', async () => {
  const cards = await store();
  await cards.save('1', { attempt: ATTEMPT, verdict: 'что-то своё', card: card() });

  assert.equal(cards.read('1', ATTEMPT), null);
});

test('нечисловая задача отвергается', async () => {
  const cards = await store();
  await cards.save('../../evil', { attempt: ATTEMPT, verdict: 'human', card: card() });

  assert.equal(cards.read('../../evil', ATTEMPT), null);
});

// Подсказка человеку не имеет права ронять страницу конвейера: битый файл читается как
// отсутствующий, а не как ошибка.
test('битый файл читается как пустой', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arbiter-cards-'));
  const file = path.join(dir, 'arbiter-cards.json');
  await fs.writeFile(file, '{битый');
  const cards = new ArbiterCardsStore(file);

  assert.equal(cards.read('900042', ATTEMPT), null);
  await cards.save('900042', { attempt: ATTEMPT, verdict: 'human', card: card() });
  assert.notEqual(cards.read('900042', ATTEMPT), null);
});

test('набор не растёт без предела: давние записи вытесняются', async () => {
  const cards = await store();
  for (let i = 1; i <= 55; i += 1) {
    await cards.save(String(i), { attempt: ATTEMPT, verdict: 'human', card: card(`разбор ${i}`) });
  }

  assert.notEqual(cards.read('55', ATTEMPT), null, 'свежая запись на месте');
  assert.equal(cards.read('1', ATTEMPT), null, 'самая давняя вытеснена');
});

test('запись переживает пересоздание store', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arbiter-cards-'));
  const file = path.join(dir, 'arbiter-cards.json');
  await new ArbiterCardsStore(file).save('900042', {
    attempt: ATTEMPT, verdict: 'human', card: card('пережил рестарт'),
  });

  assert.equal(new ArbiterCardsStore(file).read('900042', ATTEMPT).card.what, 'пережил рестарт');
});

// Ворота стали единственной точкой контроля человека, поэтому «что решалось по дороге»
// обязано доехать до них целиком, а не одной последней записью.
test('история решений копится по попытке и обнуляется на новой', async () => {
  const cards = await store();

  await cards.save('900042', {
    attempt: ATTEMPT, verdict: 'deferred', card: card('первое'), node: 'plan', stop: 'human',
  });
  await cards.save('900042', {
    attempt: ATTEMPT, verdict: 'resolve', card: card('второе'), node: 'build', stop: 'no-progress',
  });

  const record = cards.read('900042', ATTEMPT);
  assert.equal(record.history.length, 2);
  assert.equal(record.history[0].card.what, 'второе', 'свежее решение идёт первым');
  assert.equal(record.history[1].card.what, 'первое');

  // Новая попытка — прежние решения относятся к работе, которой больше нет.
  await cards.save('900042', {
    attempt: OTHER_ATTEMPT, verdict: 'resolve', card: card('третье'), node: 'plan', stop: 'human',
  });
  const fresh = cards.read('900042', OTHER_ATTEMPT);
  assert.equal(fresh.history.length, 1);
  assert.equal(fresh.history[0].card.what, 'третье');
});
