import assert from 'node:assert/strict';

/**
 * Общие продуктовые инварианты на нормализованном trace настоящего адаптера.
 * Каждый вызывающий тест подставляет свой wire fixture и собирает свидетельства из него.
 */
export function assertInTurnConformance(witness) {
  assert.equal(witness.capability?.protocol, 1, `${witness.name}: объявлен протокол`);
  assert.equal(witness.capability?.text, true, `${witness.name}: текстовый канал`);
  assert.equal(witness.turns, 1, `${witness.name}: один исходный ход`);
  assert.equal(witness.steers, 1, `${witness.name}: один ввод в тот же ход`);
  assert.equal(witness.cancels, 0, `${witness.name}: ввод не отменил инструмент/ход`);
  assert.equal(witness.forwarded, true, `${witness.name}: transport подтвердил ввод`);
  assert.equal(witness.answerBeforeFinal, true, `${witness.name}: ответ до финала`);
  assert.equal(witness.answerCopies, 1, `${witness.name}: одна завершённая копия ответа`);
  assert.match(witness.finalReply, /Второй файл проверен/u,
    `${witness.name}: исходная задача продолжилась`);
  assert.equal(witness.lateRejected, true, `${witness.name}: поздний ввод не уходит в новый ход`);
}
