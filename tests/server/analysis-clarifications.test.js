import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Analyzer } from '../../server/src/lib/analysis/analyzer.ts';
import analysisModule from '../../server/src/modules/analysis/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

test('пакет ответов хранится в единственном markdown с серверной отметкой человека', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'analysis-clarifications-'));
  const analyzer = new Analyzer({
    config: { analysisDir: dir },
    claudeAuth: null,
    b24: null,
    factoryState: {},
    log: null,
  });
  await analyzer._ready;
  await writeFile(path.join(dir, 't42.analysis.json'), JSON.stringify({
    task: 42,
    questions: [{
      id: 'q-mode',
      text: 'Какой режим оставить?',
      options: [
        { id: 'o-auto', label: 'Автоматический' },
        { id: 'o-manual', label: 'Ручной' },
      ],
    }],
  }));
  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', () => true);
  await app.register(analysisModule, { analyzer });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/42/clarifications',
    payload: {
      actor: 'cockpit-arbiter',
      answers: [{
        questionId: 'q-mode',
        optionIds: ['o-manual'],
        text: 'Так безопаснее для старых установок',
        attachments: [],
      }],
    },
  });
  const markdown = await analyzer.readClarifications('42');

  assert.deepEqual({
    status: response.statusCode,
    human: /Ответ человека/.test(markdown),
    machine: /Разбор арбитра/.test(markdown),
    marker: /cockpit-clarification:v1/.test(markdown),
    files: (await readdir(dir)).filter((file) => file.includes('clarif')),
  }, {
    status: 200,
    human: true,
    machine: false,
    marker: true,
    files: ['t42.clarify.md'],
  });
});

test('клиентский абсолютный путь вложения не становится полномочием на чтение', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'analysis-attachment-escape-'));
  const analyzer = new Analyzer({
    config: { analysisDir: dir },
    claudeAuth: null,
    b24: null,
    factoryState: {},
    log: null,
  });
  await analyzer._ready;
  await writeFile(path.join(dir, 't42.analysis.json'), JSON.stringify({
    task: 42,
    questions: [{ id: 'q-proof', text: 'Есть снимок?', options: [] }],
  }));
  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', () => true);
  await app.register(analysisModule, { analyzer });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/42/clarifications',
    payload: {
      text: 'Снимок приложен',
      answers: [{
        questionId: 'q-proof',
        optionIds: [],
        text: 'Снимок приложен',
        attachments: [{
          file: 'safe-token.png',
          name: 'proof.png',
          path: '/etc/passwd',
        }],
      }],
    },
  });

  assert.deepEqual({
    status: response.statusCode,
    error: response.json().error,
    clarification: await analyzer.readClarifications('42'),
  }, {
    status: 400,
    error: 'invalid_attachment',
    clarification: '',
  });
});

test('GET уточнений возвращает server-owned actor и status машинного ответа', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'analysis-clarification-read-'));
  const entry = {
    id: 'answer-code',
    questionId: 'q-code',
    actor: 'cockpit-arbiter',
    status: 'answered',
    selection: [],
    text: 'Поле уже есть.',
    attachments: [],
    proof: ['web/src/Form.vue:42'],
  };
  const marker = Buffer.from(JSON.stringify(entry)).toString('base64url');
  await writeFile(path.join(dir, 't42.clarify.md'), [
    '## Разбор арбитра — машинный',
    'Поле уже есть.',
    `<!-- cockpit-clarification:v1 ${marker} -->`,
    '',
  ].join('\n'));
  const analyzer = new Analyzer({
    config: { analysisDir: dir },
    claudeAuth: null,
    b24: null,
    factoryState: {},
    log: null,
  });
  await analyzer._ready;
  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', () => true);
  await app.register(analysisModule, { analyzer });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const response = await app.inject({ method: 'GET', url: '/api/tasks/42/clarifications' });

  // Запись, сделанная до появления копии вопроса, читается с пустыми новыми полями:
  // старый файл остаётся валидным и не переписывается.
  assert.deepEqual(response.json().entries, [{ ...entry, questionText: '', selectionLabels: [] }]);
});

test('выбор доезжает до записи, а чужой вопрос и чужой вариант отвергаются', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'analysis-selection-'));
  const analyzer = new Analyzer({
    config: { analysisDir: dir },
    claudeAuth: null,
    b24: null,
    factoryState: {},
    log: null,
  });
  await analyzer._ready;
  await writeFile(path.join(dir, 't77.analysis.json'), JSON.stringify({
    task: 77,
    questions: [{
      id: 'q-mode',
      text: 'Какой режим оставить?',
      options: [
        { id: 'o-auto', label: 'Автоматический' },
        { id: 'o-manual', label: 'Ручной' },
      ],
    }],
  }));
  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', () => true);
  await app.register(analysisModule, { analyzer });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const answer = (payload) => app.inject({
    method: 'POST',
    url: '/api/tasks/77/clarifications',
    payload: { answers: [payload] },
  });

  // Запрос называет выбор optionIds, сохранённая запись — selection.
  const saved = await answer({ questionId: 'q-mode', optionIds: ['o-manual', 'o-auto'] });
  const entries = await analyzer.readClarificationEntries('77');
  const unknownQuestion = await answer({ questionId: 'q-нет', optionIds: [] });
  const unknownOption = await answer({ questionId: 'q-mode', optionIds: ['o-чужой'] });

  assert.deepEqual({
    saved: saved.statusCode,
    selection: entries.at(-1)?.selection,
    actor: entries.at(-1)?.actor,
    question: [unknownQuestion.statusCode, unknownQuestion.json().error],
    option: [unknownOption.statusCode, unknownOption.json().error],
  }, {
    saved: 200,
    selection: ['o-manual', 'o-auto'],
    actor: 'human',
    question: [400, 'invalid_question'],
    option: [400, 'invalid_option'],
  });
});

// Видимый текст записи читают не глазами: этот markdown целиком уезжает в промпт
// следующего триажа и в описание тикета конвейера. Ответ одним выбором варианта
// попадал туда заглушкой «Нужно решение человека» — оба агента спрашивали снова.
test('ответ выбором варианта виден в markdown вопросом и подписью варианта', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'analysis-visible-answer-'));
  const analyzer = new Analyzer({
    config: { analysisDir: dir },
    claudeAuth: null,
    b24: null,
    factoryState: {},
    log: null,
  });
  await analyzer._ready;
  await writeFile(path.join(dir, 't77.analysis.json'), JSON.stringify({
    task: 77,
    questions: [{
      id: 'q-mode',
      text: 'Какой режим оставить?',
      options: [
        { id: 'o-auto', label: 'Автоматический' },
        { id: 'o-manual', label: 'Ручной' },
      ],
    }],
  }));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  await analyzer.appendClarificationBatch('77', [{ questionId: 'q-mode', optionIds: ['o-manual'] }]);
  const markdown = await analyzer.readClarifications('77');

  assert.deepEqual({
    question: markdown.includes('Какой режим оставить?'),
    choice: markdown.includes('Выбрано: Ручной'),
    stub: markdown.includes('Нужно решение человека.'),
    answered: await analyzer.readAnsweredQuestions('77'),
  }, {
    question: true,
    choice: true,
    stub: false,
    answered: [{
      question: 'Какой режим оставить?',
      answer: 'Выбрано: Ручной',
      actor: 'human',
    }],
  });
});

// Вопрос, оставленный человеку, обязан остаться видимым именно как «решай ты»:
// иначе арбитр молчит, а карточка показывает пустой ответ.
test('human_required арбитра остаётся видимым требованием решения', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'analysis-human-required-'));
  const analyzer = new Analyzer({
    config: { analysisDir: dir },
    claudeAuth: null,
    b24: null,
    factoryState: {},
    log: null,
  });
  await analyzer._ready;
  await writeFile(path.join(dir, 't77.analysis.json'), JSON.stringify({
    task: 77,
    questions: [{ id: 'q-price', text: 'Как показывать стоимость?', options: [] }],
  }));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  await analyzer.appendClarificationBatch(
    '77',
    [{ questionId: 'q-price', status: 'human_required' }],
    { actor: 'cockpit-arbiter' },
  );
  const markdown = await analyzer.readClarifications('77');

  assert.deepEqual({
    question: markdown.includes('Как показывать стоимость?'),
    verdict: markdown.includes('Нужно решение человека.'),
    // Вердикт «решай ты» ответом не считается: вопрос остаётся открытым для конвейера.
    open: (await analyzer.readOpenQuestions('77'))?.questions,
  }, {
    question: true,
    verdict: true,
    open: ['Как показывать стоимость?'],
  });
});
