// Внутренний вызов ручки через `fastify.inject` обязан нести токен.
//
// Гард закрывает ВЕСЬ `/api`, включая GET (см. docs/cockpit/gotchas.md), поэтому inject
// без заголовка получает 401. Беда в том, что молча: вотчер арбитра читал пустой список
// задач и потому не разобрал НИ ОДНОЙ остановки за всё время своей жизни — при включённой
// настройке и ноле строк в журнале. Отказ был невидим, потому что пустой список это
// штатное «нечего разбирать».
//
// Проверка статическая: динамически поймать такое можно только полным подъёмом сервера с
// живой фабрикой, а цена ошибки — молчащая автоматика.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../../server/src/app.js', import.meta.url));

test('каждый fastify.inject в app.js передаёт x-cockpit-internal', () => {
  const src = readFileSync(APP, 'utf8');
  const calls = [...src.matchAll(/fastify\.inject\(\{/g)];

  assert.ok(calls.length > 0, 'в app.js не нашлось ни одного fastify.inject — проверка устарела');

  for (const call of calls) {
    // Объект вызова: от `{` до первой строки, закрывающей его на том же отступе.
    const from = call.index + call[0].length - 1;
    const tail = src.slice(from, from + 800);
    const end = tail.indexOf('\n    });');
    const body = end === -1 ? tail : tail.slice(0, end);
    const line = src.slice(0, call.index).split('\n').length;

    assert.match(
      body,
      /'x-cockpit-internal'/,
      `fastify.inject в app.js:${line} идёт без внутреннего токена — гард ответит 401`,
    );
  }
});
