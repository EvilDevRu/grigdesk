// Мост «триаж → конвейер»: открытые вопросы из t<ID>.analysis.json вклеиваются
// в immutable ticket (ticketSections), чтобы планировщик начинал с них,
// а не переспрашивал человека с нуля.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Analyzer } from '../../server/src/lib/analysis/analyzer.ts';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'analysis-open-questions-'));
  const analyzer = new Analyzer({
    config: { analysisDir: dir },
    claudeAuth: null,
    tracker: null,
    factoryState: {},
    log: null,
  });
  // Конструктор запускает _init() фоном: без ожидания t.after мог удалить tmp-каталог
  // посреди readdir — unhandledRejection валил весь файл-тест под параллельной нагрузкой.
  await analyzer._ready;
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  return analyzer;
}

test('readOpenQuestions: analysis.json отсутствует → null', async (t) => {
  const analyzer = await fixture(t);
  assert.equal(await analyzer.readOpenQuestions('4242'), null);
});

test('readOpenQuestions: вопросы и неизвестные читаются и чистятся', async (t) => {
  const analyzer = await fixture(t);
  await writeFile(path.join(analyzer.dir, 't4242.analysis.json'), JSON.stringify({
    task: 4242,
    questions: ['  Метка нужна для обоих движков?  ', '', 42, null],
    unknowns: ['За какой день показывать метку'],
  }));
  assert.deepEqual(await analyzer.readOpenQuestions('4242'), {
    questions: ['Метка нужна для обоих движков?'],
    unknowns: ['За какой день показывать метку'],
  });
});

test('readOpenQuestions: пустые списки → null (секция в тикет не нужна)', async (t) => {
  const analyzer = await fixture(t);
  await writeFile(path.join(analyzer.dir, 't4242.analysis.json'), JSON.stringify({
    task: 4242,
    questions: [],
    unknowns: [],
  }));
  assert.equal(await analyzer.readOpenQuestions('4242'), null);
});

// Каждый заход триажа пишет questions[] заново, а id вопроса считается по его тексту:
// переформулированный на слово вопрос получал другой id, ответ человека отвязывался,
// и уже решённое уезжало в конвейер секцией «Открытые вопросы триажа».
test('readOpenQuestions: ответ переживает переформулировку вопроса', async (t) => {
  const analyzer = await fixture(t);
  await writeFile(path.join(analyzer.dir, 't4242.analysis.json'), JSON.stringify({
    task: 4242,
    questions: [{
      id: 'q-regions',
      text: 'По каким регионам снимать частотность?',
      options: [{ id: 'o-all', label: 'По всем' }],
    }],
    unknowns: [],
  }));
  await analyzer.appendClarificationBatch('4242', [{ questionId: 'q-regions', optionIds: ['o-all'] }]);

  // Второй заход: тот же вопрос другими словами и, как следствие, с другим id.
  await writeFile(path.join(analyzer.dir, 't4242.analysis.json'), JSON.stringify({
    task: 4242,
    questions: [{
      id: 'q-regions-2',
      text: 'По каким регионам снимать частотность',
      options: [{ id: 'o-all', label: 'По всем' }],
    }],
    unknowns: [],
  }));

  assert.equal(await analyzer.readOpenQuestions('4242'), null);
});
