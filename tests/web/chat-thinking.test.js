// Живая строка хода: слово о занятии, время хода и РАСХОД токенов.
//
// Проверки держат три правила, которые легко потерять при правках: слово называет
// незакрытый инструмент (а не «думаю» поверх работающей команды), время считается
// только по часам этого окна, а число показывает расход вывода — заполненность
// контекста живёт в кольце и в этой строке означала бы совсем другое.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  THINKING_WORDS,
  formatElapsed,
  formatTurnTokens,
  formatTurnTokensShort,
  runningTool,
  shuffledOrder,
  thinkingWord,
} from '../../web/src/views/chat/chatThinking.ts';

test('THINK-01: работающий инструмент называет действие, а не «думаю»', () => {
  const steps = [
    { k: 'think', at: 1 },
    { k: 'tool', id: 't1', name: 'Bash', at: 2 },
  ];

  assert.equal(runningTool(steps)?.name, 'Bash');
  assert.equal(thinkingWord(steps, 0), 'Выполняю команду');
  assert.equal(thinkingWord(steps, 5), 'Выполняю команду', 'слово действия не должно бегать по кругу');
});

test('THINK-02: закрытый инструмент возвращает строку к «думаю»', () => {
  const steps = [
    { k: 'tool', id: 't1', name: 'Read', at: 1 },
    { k: 'res', id: 't1', ok: true, at: 2 },
  ];

  assert.equal(runningTool(steps), null);
  assert.equal(thinkingWord(steps, 0), THINKING_WORDS[0]);
});

test('THINK-03: результат чужого вызова не закрывает работающий инструмент', () => {
  const steps = [
    { k: 'tool', id: 't1', name: 'Bash', at: 1 },
    { k: 'res', id: 't2', ok: true, at: 2 },
  ];

  assert.equal(runningTool(steps)?.id, 't1');
});

test('THINK-03b: подагент остаётся работающим, пока внутри него закрываются вложенные вызовы', () => {
  const steps = [
    { k: 'tool', id: 'task-1', name: 'Task', at: 1 },
    { k: 'tool', id: 'inner-1', name: 'Bash', parent: 'task-1', at: 2 },
    { k: 'res', id: 'inner-1', ok: true, at: 3 },
  ];

  // Последний вызов закрыт, но Task ещё открыт — слово называет его, а не «думаю».
  assert.equal(runningTool(steps)?.id, 'task-1');
  assert.equal(thinkingWord(steps, 0), 'Веду подагента');

  // Закрылся и подагент — инструментов в работе нет.
  assert.equal(runningTool([...steps, { k: 'res', id: 'task-1', ok: true, at: 4 }]), null);
  // Вызов без id закрыть нечем: за работающий он не считается.
  assert.equal(runningTool([{ k: 'tool', name: 'Bash', at: 1 }]), null);
});

test('THINK-04: слово меняется по тику и проходит весь список', () => {
  const seen = THINKING_WORDS.map((_, index) => thinkingWord([], index));

  assert.deepEqual(seen, THINKING_WORDS);
  assert.equal(thinkingWord([], THINKING_WORDS.length), THINKING_WORDS[0], 'круг не замкнулся');
  // Фразы короткие: резерв ячейки слова рассчитан на «Выполняю команду» с точками,
  // фраза длиннее сдвинула бы числа справа при каждом своём появлении. Дубли в списке —
  // повтор слова подряд после перетасовки, поэтому их тоже нет.
  for (const word of THINKING_WORDS) {
    assert.ok(word.length <= 'Выполняю команду'.length, `слишком длинная фраза: «${word}»`);
  }
  assert.equal(new Set(THINKING_WORDS).size, THINKING_WORDS.length, 'в списке фраз есть дубли');
  assert.ok(THINKING_WORDS.length >= 100, 'список фраз должен быть длинным — иначе строка заучивается');
});

test('THINK-08: порядок слов на ход — перетасовка без повторов, а не круг по списку', () => {
  // Детерминированный «случай»: тесту важен не конкретный порядок, а его свойства.
  let seed = 7;
  const random = () => {
    seed = (seed * 48271) % 2147483647;

    return seed / 2147483647;
  };
  const order = shuffledOrder(THINKING_WORDS.length, random);
  const seen = THINKING_WORDS.map((_, tick) => thinkingWord([], tick, order));

  assert.deepEqual([...seen].sort(), [...THINKING_WORDS].sort(), 'круг прошёл не весь список');
  assert.notDeepEqual(seen, THINKING_WORDS, 'порядок совпал со списком — перетасовки нет');
  for (let tick = 1; tick < seen.length * 2; tick += 1) {
    assert.notEqual(
      thinkingWord([], tick, order), thinkingWord([], tick - 1, order),
      `слово повторилось подряд на тике ${tick}`,
    );
  }
  // Два хода — два разных порядка: строка не заучивается.
  assert.notDeepEqual(shuffledOrder(THINKING_WORDS.length, random), order);
  // Порядок чужой длины (список вырос, а порядок старый) не роняет слово — список идёт как есть.
  assert.equal(thinkingWord([], 1, [0, 1]), THINKING_WORDS[1]);
  const beyond = order.map(() => THINKING_WORDS.length + 5);
  assert.equal(thinkingWord([], 0, beyond), 'Думаю', 'выход за список даёт запасное слово');
});

test('THINK-05: MCP и незнакомый инструмент называют себя честно', () => {
  assert.equal(
    thinkingWord([{ k: 'tool', id: 'm1', name: 'mcp__playwright__browser_click' }], 0),
    'Работаю через playwright',
  );
  assert.equal(
    thinkingWord([{ k: 'tool', id: 'x1', name: 'НеведомаяШтука' }], 0),
    'Работаю с инструментом',
  );
});

test('THINK-06: время хода — секундомером м:сс, после часа ч:мм:сс; без начала хода молчит', () => {
  const start = 1_000_000;

  assert.equal(formatElapsed(0, start), '', 'без начала хода время показывать нельзя');
  // Цифровая форма: ширина не меняется на границе минуты («1 мин» ↔ «1 мин 1 с»
  // двигали бы расход справа), а табличные цифры держат её на тике секунд.
  assert.equal(formatElapsed(start, start + 45_000), '0:45');
  assert.equal(formatElapsed(start, start + 60_000), '1:00');
  assert.equal(formatElapsed(start, start + 125_000), '2:05');
  assert.equal(formatElapsed(start, start + 3_725_000), '1:02:05');
  // Часы окна и сервера могут разойтись: «минус» — не повод показать выдуманное время.
  assert.equal(formatElapsed(start, start - 5_000), '');
});

test('THINK-07: расход хода; ноль значит «неизвестно», а не «ноль токенов»', () => {
  assert.equal(formatTurnTokens(0, false), '', 'ноль показывать нельзя — это «нет данных»');
  assert.equal(formatTurnTokens(undefined, false), '');
  assert.equal(formatTurnTokens(-5, false), '');
  assert.equal(formatTurnTokens(12.5, false), '');
  assert.equal(
    formatTurnTokens(1234, false).replace(/\u00a0/g, ' '),
    '1 234 ток.',
  );
  assert.equal(
    formatTurnTokens(1234, true).replace(/\u00a0/g, ' '),
    '≈ 1 234 ток.',
    'оценку (Claude и DeepSeek считают вывод по символам) обязан помечать знак «≈»',
  );
});

test('THINK-07b: в строке хода большой расход сокращён и не мельтешит на каждом тике', () => {
  const short = (tokens, estimate = false) => formatTurnTokensShort(tokens, estimate).replace(/\u00a0/g, ' ');

  assert.equal(short(0), '', 'ноль по-прежнему значит «нет данных»');
  assert.equal(short(9_999), '9 999', 'до десяти тысяч число точное');
  assert.equal(short(113_437, true), '≈ 113 тыс.');
  assert.equal(short(113_999), '113 тыс.', 'округление вниз: тысяча не «прыгает» раньше времени');
  assert.equal(short(1_250_000), '1,2 млн');
});
