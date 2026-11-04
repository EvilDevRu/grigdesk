import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { openCodexSession } from '../../server/src/lib/executors/codex.ts';
import {
  codexAsyncQuestionPresentation, codexAsyncQuestionResponse,
} from '../../server/src/lib/executors/_codexQuestions.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const question = { title: 'Разрешить диагностику?', options: ['Разрешить', 'Только журналы'] };
const item = { delivery: 'async', questions: [question] };

/**
 * Каждый тест получает отдельный процесс и trace только с синтетическими данными.
 * Закрытие сессии и удаление её папки происходят даже после неудачного утверждения.
 */
async function fixture(t, scenario = 'hold') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-async-questions-'));
  const bin = path.join(dir, 'app-server.mjs');
  const trace = path.join(dir, 'trace.jsonl');

  await copyFile(path.join(ROOT, 'tests/fixtures/codex-app-server/async-question-0.166.0.mjs'), bin);
  await chmod(bin, 0o755);

  const session = openCodexSession({
    config: { codexBin: bin },
    cwd: dir,
    env: {
      ...process.env,
      GRIGDESK_ASYNC_QUESTION_SCENARIO: scenario,
      GRIGDESK_ASYNC_QUESTION_TRACE: trace,
    },
    providerSettings: { blockDirectSsh: false },
    tokenInfoReader: async () => null,
  });

  t.after(async () => {
    await session.close();
    await rm(dir, { recursive: true, force: true });
  });

  return {
    session,
    trace: async () => (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((give) => {
    resolve = give;
  });

  return { promise, resolve };
}

function accept(presentation, value = 'Только журналы') {
  return { action: 'accept', answers: [{ key: presentation.questions[0].key, value }] };
}

test('async-вопросы сохраняют варианты, свободный текст и одинаковые заголовки', () => {
  const presentation = codexAsyncQuestionPresentation({ ...item, questions: [question, question] });

  assert.equal(presentation.blocking, false);
  assert.equal(presentation.requiresExplicitUser, true);
  assert.equal(presentation.canRemember, false);
  assert.notEqual(presentation.questions[0].key, presentation.questions[1].key);
  assert.equal(presentation.questions[0].inputType, 'choice-or-text');
  assert.equal(presentation.questions[0].allowFreeText, true);
  assert.deepEqual(presentation.questions[0].options.map((option) => option.label), question.options);

  for (const options of [undefined, null, []]) {
    const text = codexAsyncQuestionPresentation({
      ...item,
      questions: [{ title: 'Что проверить?', options }],
    });

    assert.equal(text.questions[0].inputType, 'text');
    assert.match(codexAsyncQuestionResponse(text, accept(text, 'Только состояние сети')), /состояние сети/);
  }
});

test('неизвестная форма вопроса и повреждённые ответы не становятся согласием', () => {
  for (const invalid of [
    { ...item, delivery: 'inline' }, { ...item, questions: [] },
    { ...item, questions: Array(4).fill(question) },
    { ...item, questions: [{ title: 1 }] },
    { ...item, questions: [{ ...question, options: ['Один', 'Один'] }] },
    { ...item, questions: [{ ...question, options: [null] }] },
    { ...item, questions: [{ ...question, title: 'x'.repeat(4001) }] },
  ]) {
    assert.equal(codexAsyncQuestionPresentation(invalid), null);
  }

  const presentation = codexAsyncQuestionPresentation(item);

  for (const decision of [undefined, {}, { action: 'accept', answers: [] },
    { action: 'accept', answers: [{ key: 'foreign', value: 'Разрешить' }] },
    accept(presentation, 'x'.repeat(4001))]) {
    assert.equal(codexAsyncQuestionResponse(presentation, decision), null);
  }

  assert.match(codexAsyncQuestionResponse(presentation, { action: 'cancel' }), /согласие.*не дано/);
});

for (const scenario of ['hold', 'duplicate', 'empty-text']) {
  test(`async-карточка и ответ в том же ходе: ${scenario}`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t, scenario);
    const answer = deferred();
    const shown = deferred();
    const independent = deferred();
    let cards = 0;
    const run = f.session.send({
      message: 'Проверить приложение',
      onPermission: (presentation) => {
        cards += 1;
        shown.resolve(presentation);

        return answer.promise;
      },
      onAssistantMessage: (message) => {
        if (message.assistantMessageId === 'independent-work') {
          independent.resolve();
        }
      },
    });
    const presentation = await shown.promise;

    await independent.promise;
    assert.equal(cards, 1);
    assert.equal((await f.trace()).some((message) => message.method === 'turn/steer'), false);
    answer.resolve(accept(presentation));

    const result = await run;
    const trace = await f.trace();
    const steers = trace.filter((message) => message.method === 'turn/steer');

    assert.equal(result.reply, 'Исходная задача завершена.');
    assert.equal(steers.length, 1);
    assert.equal(steers[0].params.threadId, 'synthetic-thread');
    assert.equal(steers[0].params.expectedTurnId, 'turn-1');
    assert.match(steers[0].params.input[0].text, /Разрешить диагностику\?[\s\S]*Ответ: Только журналы/);
    assert.match(steers[0].params.input.at(-1).text, /вернись к ранее поставленной задаче/);
    assert.equal(trace.filter((message) => message.method === 'turn/start').length, 1);
    assert.equal(trace.some((message) => message.method === 'turn/interrupt'), false);
    assert.equal(presentation.signal.aborted, true);
  });
}

test('пропуск карточки передаёт отсутствие согласия', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);

  await f.session.send({ message: 'Вопрос', onPermission: () => ({ action: 'cancel' }) });

  const steer = (await f.trace()).find((message) => message.method === 'turn/steer');

  assert.match(steer.params.input[0].text, /Пользователь пропустил/);
  assert.match(steer.params.input[0].text, /согласие.*не дано/);
});

test('стоп снимает карточку; поздний ответ не попадает в новый ход', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const answer = deferred();
  const shown = deferred();
  const first = f.session.send({ message: 'Первый ход', onPermission: (presentation) => {
    shown.resolve(presentation);

    return answer.promise;
  } });
  const stopped = assert.rejects(first, /остановлен/i);
  const presentation = await shown.promise;

  await f.session.interrupt();
  await stopped;
  assert.equal(presentation.signal.aborted, true);

  let secondCards = 0;

  await f.session.send({ message: 'Второй ход', onPermission: (next) => {
    secondCards += 1;
    answer.resolve(accept(presentation, 'Поздний ответ первого хода'));

    return accept(next);
  } });

  const steers = (await f.trace()).filter((message) => message.method === 'turn/steer');

  assert.equal(secondCards, 1);
  assert.equal(steers.length, 1);
  assert.equal(steers[0].params.expectedTurnId, 'turn-2');
  assert.doesNotMatch(steers[0].params.input[0].text, /Поздний ответ/);
});

for (const scenario of ['completed', 'question-only']) {
  test(`конец хода снимает async-вопрос: ${scenario}`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t, scenario);
    const answer = deferred();
    let presentation;
    const run = f.session.send({ message: 'Вопрос', onPermission: (next) => {
      presentation = next;

      return answer.promise;
    } });

    if (scenario === 'question-only') {
      await assert.rejects(run, /codex не вернул ответ/);
    } else {
      assert.equal((await run).reply, 'Исходная задача завершена.');
    }

    assert.equal(presentation.signal.aborted, true);
    answer.resolve(accept(presentation));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await f.trace()).some((message) => message.method === 'turn/steer'), false);
  });
}

for (const scenario of ['foreign', 'unscoped']) {
  test(`без подтверждённого владельца нет async-карточки: ${scenario}`, {
    timeout: 5000,
  }, async (t) => {
    const f = await fixture(t, scenario);

    await f.session.send({ message: 'Вопрос', onPermission: () => assert.fail('Чужой вопрос') });

    assert.equal((await f.trace()).some((message) => message.method === 'turn/steer'), false);
  });
}

test('закрытие процесса снимает async-карточку без позднего steer', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const shown = deferred();
  const answer = deferred();
  const run = f.session.send({ message: 'Вопрос', onPermission: (presentation) => {
    shown.resolve(presentation);

    return answer.promise;
  } });
  const closed = assert.rejects(run, /завершился до ответа/);
  const presentation = await shown.promise;

  await f.session.close();
  await closed;
  assert.equal(presentation.signal.aborted, true);
  answer.resolve(accept(presentation));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.trace()).some((message) => message.method === 'turn/steer'), false);
});

test('отказ steer виден в ленте и не повторяется', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, 'reject-steer');
  const failed = deferred();
  const run = f.session.send({
    message: 'Вопрос',
    onPermission: (presentation) => accept(presentation),
    onStep: (step) => {
      if (step.k === 'note' && step.text.includes('Не удалось передать ответ')) {
        failed.resolve(step);
      }
    },
  });
  const stopped = assert.rejects(run, /остановлен/i);
  const note = await failed.promise;

  assert.equal(note.level, 'warn');
  assert.match(note.text, /Синтетический отказ доставки/);
  assert.equal((await f.trace()).filter((message) => message.method === 'turn/steer').length, 1);
  await f.session.interrupt();
  await stopped;
});
