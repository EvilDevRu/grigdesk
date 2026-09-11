import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Analyzer } from '../../server/src/lib/analysis/analyzer.ts';
import { CAP_CLARIFICATIONS, buildTriagePrompt } from '../../server/src/lib/analysis/prompt.ts';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'analysis-questions-'));
  const analyzer = new Analyzer({
    config: { analysisDir: dir },
    claudeAuth: null,
    b24: null,
    factoryState: {},
    log: null,
  });
  await analyzer._ready;
  t.after(() => rm(dir, { recursive: true, force: true }));

  return { analyzer, dir };
}

test('промпт требует у каждого вопроса варианты и отдельную рекомендацию', () => {
  const prompt = buildTriagePrompt({
    task: 42,
    title: 'Задача',
    description: '',
    comments: [],
    clarifications: '',
    discussion: '',
    profile: { ctx: '', markers: '', repos: [] },
    jsonPath: '/tmp/t42.analysis.json',
    notePath: '/tmp/t42.md',
  });

  assert.match(
    prompt,
    /"questions":\s*\[\s*\{[\s\S]*"text"[\s\S]*"options"[\s\S]*"recommendation"/,
  );
});

test('структурные вопросы передаются конвейеру текстом, а не объектом', async (t) => {
  const { analyzer, dir } = await fixture(t);
  await writeFile(path.join(dir, 't42.analysis.json'), JSON.stringify({
    task: 42,
    questions: [
      { id: 'q-first', text: 'Как подписать кнопку?', options: [] },
      { id: 'q-second', text: '  Оставить старый сценарий?  ', options: [] },
    ],
    unknowns: ['Где хранится флаг'],
  }));

  assert.deepEqual(await analyzer.readOpenQuestions('42'), {
    questions: ['Как подписать кнопку?', 'Оставить старый сценарий?'],
    unknowns: ['Где хранится флаг'],
  });
});

test('старая строка открывается как вопрос без вариантов и не переписывает файл', async (t) => {
  const { analyzer, dir } = await fixture(t);
  const file = path.join(dir, 't42.analysis.json');
  const source = JSON.stringify({ task: 42, questions: ['Как вести себя кнопке?'] }, null, 2);
  await writeFile(file, source);

  const detail = await analyzer.get('42');
  const question = detail.analysis.questions[0];

  assert.deepEqual({
    text: question?.text,
    options: question?.options,
    source: await readFile(file, 'utf8'),
  }, {
    text: 'Как вести себя кнопке?',
    options: [],
    source,
  });
});

test('ответ арбитра закрывает factual-вопрос, а human_required оставляет продуктовый открытым', async (t) => {
  const { analyzer, dir } = await fixture(t);
  await writeFile(path.join(dir, 't42.analysis.json'), JSON.stringify({
    task: 42,
    questions: [
      { id: 'q-code', text: 'Есть ли поле в форме?', options: [] },
      { id: 'q-product', text: 'Какой сценарий выбрать?', options: [] },
    ],
    unknowns: [],
  }));
  const entries = [
    {
      id: 'answer-code',
      questionId: 'q-code',
      actor: 'cockpit-arbiter',
      status: 'answered',
      text: 'Поле уже есть.',
      proof: ['web/src/Form.vue:42'],
    },
    {
      id: 'answer-product',
      questionId: 'q-product',
      actor: 'cockpit-arbiter',
      status: 'human_required',
      text: '',
      proof: [],
    },
  ];
  const markdown = entries.map((entry) => [
    '## Разбор арбитра — машинный',
    entry.text || 'Нужно решение человека.',
    `<!-- cockpit-clarification:v1 ${Buffer.from(JSON.stringify(entry)).toString('base64url')} -->`,
  ].join('\n')).join('\n\n');
  await writeFile(path.join(dir, 't42.clarify.md'), `${markdown}\n`);

  assert.deepEqual(await analyzer.readOpenQuestions('42'), {
    questions: ['Какой сценарий выбрать?'],
    unknowns: [],
  });
});

// Разведчик видел в уточнениях только реплики ответов без самих вопросов — и штатно
// задавал те же вопросы заново, обнуляя работу человека. Пары «вопрос → ответ» и
// прямой запрет повтора собираются анализатором из его же записей уточнений.
test('закрытые вопросы уезжают в промпт парами и с запретом спрашивать снова', async (t) => {
  const { analyzer, dir } = await fixture(t);
  await writeFile(path.join(dir, 't42.analysis.json'), JSON.stringify({
    task: 42,
    questions: [{
      id: 'q-mode',
      text: 'Какой режим оставить?',
      options: [{ id: 'o-manual', label: 'Ручной' }],
    }],
  }));
  await analyzer.appendClarificationBatch('42', [{
    questionId: 'q-mode',
    optionIds: ['o-manual'],
    text: 'Автоматика ломает старые установки',
  }]);

  const prompt = buildTriagePrompt({
    task: 42,
    title: 'Задача',
    description: '',
    comments: [],
    clarifications: await analyzer.readClarifications('42'),
    answered: await analyzer.readAnsweredQuestions('42'),
    discussion: '',
    profile: { ctx: '', markers: '', repos: [] },
    jsonPath: '/tmp/t42.analysis.json',
    notePath: '/tmp/t42.md',
  });

  assert.deepEqual({
    block: prompt.includes('[Закрытые вопросы — на них уже ответили, повторно НЕ спрашивай]'),
    pair: prompt.includes('1. Вопрос: Какой режим оставить?')
      && prompt.includes('Ответ (человек): Выбрано: Ручной. Автоматика ломает старые установки'),
    ban: prompt.includes('НЕ выноси эти вопросы в questions[] ни в какой формулировке'),
  }, { block: true, pair: true, ban: true });
});

test('уточнения доезжают до промпта целиком вплоть до общего предела', () => {
  // Файл уточнений копит base64-маркеры ответов: пять-шесть ответов — уже больше прежних
  // 6000 символов, и последний ответ человека (самый свежий) отрезался первым.
  const tail = 'ПОСЛЕДНИЙ-ОТВЕТ-ЧЕЛОВЕКА';
  const fitting = 'x'.repeat(CAP_CLARIFICATIONS - tail.length) + tail;
  const overflowing = 'x'.repeat(CAP_CLARIFICATIONS) + tail;
  const render = (clarifications) => buildTriagePrompt({
    task: 42,
    title: 'Задача',
    description: '',
    comments: [],
    clarifications,
    discussion: '',
    profile: { ctx: '', markers: '', repos: [] },
    jsonPath: '/tmp/t42.analysis.json',
    notePath: '/tmp/t42.md',
  });

  assert.deepEqual({
    aboveOldCap: CAP_CLARIFICATIONS > 6000,
    fitting: render(fitting).includes(tail),
    overflowing: render(overflowing).includes(tail),
  }, { aboveOldCap: true, fitting: true, overflowing: false });
});
