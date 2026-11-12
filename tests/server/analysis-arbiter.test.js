import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Analyzer } from '../../server/src/lib/analysis/analyzer.ts';

const ARBITER_URL = new URL('../../server/src/lib/analysis/arbiter.ts', import.meta.url);

/** До появления модуля возвращает явный красный результат вместо suite-level import error. */
async function createArbiter(options) {
  try {
    const module = await import(ARBITER_URL.href);
    return new module.AnalysisArbiter(options);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return {
      async arbitrate() {
        return { ok: false, error: 'analysis_arbiter_not_implemented' };
      },
    };
  }
}

function markerEntries(markdown) {
  return [...String(markdown || '').matchAll(
    /<!-- grigdesk-clarification:v1 ([A-Za-z0-9_-]+) -->/g,
  )].map((match) => JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')));
}

/** Собирает настоящий локальный analysis log и заменяет только внешний model-run. */
async function fixture(t, { autoArbitrate = false, reply, questions = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'analysis-arbiter-'));
  const analysisDir = path.join(root, 'analysis');
  t.after(() => rm(root, { recursive: true, force: true }));
  const analyzer = new Analyzer({
    config: {
      analysisDir,
      chatsDir: path.join(root, 'chats'),
      factoryHome: root,
      profilesDir: path.join(root, 'profiles'),
      factoryProfile: '',
    },
    claudeAuth: null,
    tracker: null,
    factoryState: { async primaryProfile() { return null; } },
    prefs: { read: () => ({}) },
    log: null,
  });
  await analyzer._ready;
  await writeFile(path.join(analysisDir, 't42.analysis.json'), JSON.stringify({
    task: 42,
    questions: questions || [
      { id: 'q-code', text: 'Есть ли поле effort в meta?', options: [] },
      { id: 'q-product', text: 'Какой сценарий выбрать?', options: [] },
      { id: 'q-priority', text: 'Что важнее: скорость или полнота?', options: [] },
      { id: 'q-scope', text: 'Добавить ли в задачу новую интеграцию?', options: [] },
    ],
  }));
  let reevaluations = 0;
  analyzer.enqueue = async () => {
    reevaluations += 1;
    return { outcome: 'queued' };
  };
  const calls = [];
  const executor = {
    id: 'codex',
    scopedWorkspace: true,
    async run(options) {
      calls.push(options);
      return { reply: typeof reply === 'function' ? reply() : reply };
    },
  };
  const settings = () => ({
    triageModel: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
    autoArbitrate,
  });
  const arbiter = await createArbiter({
    analyzer,
    pluginEnabled: () => true,
    pluginSettings: settings,
    providerRegistry: async () => ({ codex: [{ id: 'gpt-5.6-sol', efforts: ['high'] }] }),
    executorFor: async () => executor,
    log: null,
  });

  return {
    analyzer,
    arbiter,
    calls,
    reevaluations: () => reevaluations,
  };
}

test('арбитр отвечает на factual-вопрос, а выбор и границу оставляет человеку', async (t) => {
  const reply = JSON.stringify({
    answers: [
      {
        questionId: 'q-code',
        kind: 'factual',
        status: 'answered',
        text: 'Поле effort уже записывается в meta.',
        proof: ['server/src/lib/analysis/analyzer.js:420'],
      },
      {
        questionId: 'q-product',
        kind: 'product_choice',
        status: 'answered',
        text: 'Выбрать автоматический сценарий.',
        proof: [],
      },
      {
        questionId: 'q-priority',
        kind: 'priority',
        status: 'answered',
        text: 'Выбрать скорость.',
        proof: [],
      },
      {
        questionId: 'q-scope',
        kind: 'scope_change',
        status: 'answered',
        text: 'Добавить интеграцию.',
        proof: [],
      },
    ],
  });
  const { analyzer, arbiter, calls, reevaluations } = await fixture(t, { reply });

  const result = await arbiter.arbitrate('42', { automatic: false });
  const entries = markerEntries(await analyzer.readClarifications('42'));

  assert.deepEqual({
    completed: result?.ok !== false,
    calls: calls.length,
    reevaluations: reevaluations(),
    entries: entries.map((entry) => ({
      questionId: entry.questionId,
      actor: entry.actor,
      status: entry.status,
      text: entry.text,
      proof: entry.proof,
    })),
  }, {
    completed: true,
    calls: 1,
    reevaluations: 1,
    entries: [
      {
        questionId: 'q-code',
        actor: 'grigdesk-arbiter',
        status: 'answered',
        text: 'Поле effort уже записывается в meta.',
        proof: ['server/src/lib/analysis/analyzer.js:420'],
      },
      {
        questionId: 'q-product',
        actor: 'grigdesk-arbiter',
        status: 'human_required',
        text: '',
        proof: [],
      },
      {
        questionId: 'q-priority',
        actor: 'grigdesk-arbiter',
        status: 'human_required',
        text: '',
        proof: [],
      },
      {
        questionId: 'q-scope',
        actor: 'grigdesk-arbiter',
        status: 'human_required',
        text: '',
        proof: [],
      },
    ],
  });
});

test('auto=false блокирует только автоматический вызов, а ручной остаётся доступен', async (t) => {
  const reply = JSON.stringify({
    answers: [{
      questionId: 'q-code',
      kind: 'factual',
      status: 'answered',
      text: 'Поле есть.',
      proof: ['server/src/lib/analysis/analyzer.js:420'],
    }],
  });
  const { arbiter, calls } = await fixture(t, {
    autoArbitrate: false,
    reply,
    questions: [{ id: 'q-code', text: 'Есть ли поле effort в meta?', options: [] }],
  });

  await arbiter.arbitrate('42', { automatic: true });
  const afterAutomatic = calls.length;
  await arbiter.arbitrate('42', { automatic: false });

  assert.deepEqual({ afterAutomatic, calls: calls.length }, {
    afterAutomatic: 0,
    calls: 1,
  });
});

test('auto=true запускает разбор один раз и не переоткрывает уже отмеченный questionId', async (t) => {
  const reply = JSON.stringify({
    answers: [{
      questionId: 'q-code',
      kind: 'factual',
      status: 'answered',
      text: 'Поле есть.',
      proof: ['server/src/lib/analysis/analyzer.js:420'],
    }],
  });
  const { arbiter, calls, reevaluations } = await fixture(t, {
    autoArbitrate: true,
    reply,
    questions: [{ id: 'q-code', text: 'Есть ли поле effort в meta?', options: [] }],
  });

  await arbiter.arbitrate('42', { automatic: true });
  const afterFirst = { calls: calls.length, reevaluations: reevaluations() };
  await arbiter.arbitrate('42', { automatic: true });

  assert.deepEqual({ afterFirst, calls: calls.length, reevaluations: reevaluations() }, {
    afterFirst: { calls: 1, reevaluations: 1 },
    calls: 1,
    reevaluations: 1,
  });
});

// Следующий заход триажа пишет questions[] заново, и id вопроса меняется вместе с его
// формулировкой. По одному id арбитр брался за тот же вопрос второй раз — поверх уже
// полученного ответа человека, снова помечая его «нужно решение человека».
test('арбитр не берётся за вопрос, переформулированный после ответа человека', async (t) => {
  const { analyzer, arbiter, calls } = await fixture(t, {
    questions: [{ id: 'q-mode', text: 'Какой режим оставить?', options: [{ id: 'o-manual', label: 'Ручной' }] }],
    reply: JSON.stringify({ answers: [] }),
  });
  await analyzer.appendClarificationBatch('42', [{ questionId: 'q-mode', optionIds: ['o-manual'] }]);
  await writeFile(path.join(analyzer.dir, 't42.analysis.json'), JSON.stringify({
    task: 42,
    questions: [{ id: 'q-mode-2', text: 'Какой режим оставить', options: [] }],
  }));

  const result = await arbiter.arbitrate('42', { automatic: false });

  assert.deepEqual({ outcome: result?.outcome, calls: calls.length }, {
    outcome: 'nothing_to_do',
    calls: 0,
  });
});

test('LOCAL-ARBITER-01: factual использует beta, продуктовый выбор остаётся человеку', async (t) => {
  const reply = JSON.stringify({ answers: [
    {
      questionId: 'q-code',
      kind: 'factual',
      status: 'answered',
      text: 'Поле есть в beta.',
      proof: ['src/beta.ts:1'],
    },
    {
      questionId: 'q-product',
      kind: 'product_choice',
      status: 'answered',
      text: 'Автоматический режим',
      proof: [],
    },
  ] });
  const fx = await fixture(t, { reply });
  const { ownTask, seedTasks } = await import('./helpers/grigdesk-tasks.js');
  const task = ownTask();
  const config = fx.analyzer.config;

  config.grigdeskTasksPath = path.join(config.factoryHome, 'tasks.json');
  config.factoryProfile = 'alpha';
  await seedTasks(config, [task]);

  for (const name of ['alpha', 'beta']) {
    const directory = path.join(config.profilesDir, name);

    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'profile.sh'), `PROFILE_CTX='Контекст ${name}'\n`);
  }

  await writeFile(path.join(fx.analyzer.dir, `t${task.id}.analysis.json`), JSON.stringify({
    task: Number(task.id),
    questions: [
      {
        id: 'q-code',
        text: 'Есть ли поле?',
        options: []
      },
      {
        id: 'q-product',
        text: 'Какой режим?',
        options: []
      },
    ],
  }));

  const profiles = [];

  fx.analyzer._sources.acquire = async (profile) => {
    profiles.push(profile.name);

    return {
      repos: [],
      roots: [],
      async release() {}
    };
  };

  await fx.arbiter.arbitrate(task.id, { automatic: false });

  const entries = markerEntries(await fx.analyzer.readClarifications(task.id));

  assert.deepEqual(profiles, ['beta']);
  assert.equal(entries.find((entry) => entry.questionId === 'q-code').status, 'answered');
  assert.equal(entries.find((entry) => entry.questionId === 'q-product').status, 'human_required');
  assert.equal(fx.reevaluations(), 1);
});

/**
 * Получает два пакета через настоящий Analyzer и меняет только ответы внешних моделей.
 * Перезапуск удерживается на границе enqueue: проверяемая маршрутизация арбитра остаётся настоящей.
 */
async function sourceArbiterFixture(t) {
  const {
    analysisSourceFixture, completed, eventually, MODEL, modelRegistry,
  } = await import('./helpers/analysisSource.js');
  const { AnalysisArbiter } = await import('../../server/src/lib/analysis/arbiter.ts');
  const fx = await analysisSourceFixture(t, {
    resultFor: (label) => ({
      questions: [
        {
          id: `fact-${label}`,
          text: `Факт ${label}`,
          kind: 'factual',
          options: [],
        },
        {
          id: `choice-${label}`,
          text: `Выбор ${label}`,
          kind: 'product_choice',
          options: [],
        },
      ],
    }),
  });

  for (const source of [fx.a.source, fx.b.source]) {
    const response = await fx.request('POST', '/api/tasks/42/analyze', { source });

    assert.equal(response.statusCode, 200, response.body);
    await completed(fx, source);
    await eventually(() => fx.analyzer._jobs.size, (size) => size === 0);
  }

  const enqueued = [];
  const prompts = [];

  fx.analyzer.enqueue = async (...args) => {
    enqueued.push(args);

    return { outcome: 'queued' };
  };

  const arbiter = new AnalysisArbiter({
    analyzer: fx.analyzer,
    pluginEnabled: () => true,
    pluginSettings: () => ({ triageModel: MODEL, autoArbitrate: true }),
    providerRegistry: modelRegistry,
    executorFor: async () => ({
      id: 'codex',
      scopedWorkspace: true,
      async run(options) {
        prompts.push(options.message);

        return { reply: JSON.stringify({ answers: [
          {
            questionId: 'fact-A',
            kind: 'factual',
            status: 'answered',
            text: 'Ответ A по коду',
            proof: ['fixture.ts:7'],
          },
          {
            questionId: 'choice-A',
            kind: 'product_choice',
            status: 'answered',
            text: 'Навязанный выбор запрещён',
            proof: ['fixture.ts:8'],
          },
        ] }) };
      },
    }),
  });

  return {
    ...fx,
    arbiter,
    enqueued,
    arbiterPrompts: prompts,
  };
}

test('SOURCE-ARBITER-01: ручной и automatic повтор читают и меняют только A42', async (t) => {
  const { sourceQuery, packageBytes } = await import('./helpers/analysisSource.js');

  for (const automatic of [false, true]) {
    await t.test(automatic ? 'automatic' : 'manual', async (st) => {
      const fx = await sourceArbiterFixture(st);
      const before = await packageBytes(fx.config.analysisDir);
      const bUrl = `/api/tasks/42/clarifications?${sourceQuery(fx.b.source)}`;
      const bBefore = (await fx.request('GET', bUrl)).body;
      const result = await fx.arbiter.arbitrate('42', { automatic, source: fx.a.source });

      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.answered, 1, 'Арбитр A должен увидеть factual-вопрос A, а не B');
      assert.equal(fx.arbiterPrompts.length, 1);
      assert.match(fx.arbiterPrompts[0], /Факт A/);
      assert.doesNotMatch(fx.arbiterPrompts[0], /Факт B/);
      assert.equal(fx.enqueued.length, 1);
      assert.equal(String(fx.enqueued[0][0]), '42');
      assert.ok(JSON.stringify(fx.enqueued[0].slice(1)).includes(fx.a.source));

      const a = (await fx.request('GET', `/api/tasks/42/clarifications?${sourceQuery(fx.a.source)}`)).json();
      const b = await fx.request('GET', `/api/tasks/42/clarifications?${sourceQuery(fx.b.source)}`);

      assert.equal(a.entries.find((entry) => entry.questionId === 'fact-A')?.status, 'answered');
      assert.equal(a.entries.find((entry) => entry.questionId === 'choice-A')?.status, 'human_required');
      assert.equal(b.body, bBefore);
      assert.doesNotMatch(a.text, /Навязанный выбор запрещён/);

      const after = await packageBytes(fx.config.analysisDir);

      for (const [file, bytes] of Object.entries(before)) {
        assert.equal(after[file], bytes, 'Существующие оценки и статус B не переписываются');
      }

      await fx.arbiter.arbitrate('42', { automatic, source: fx.a.source });
      assert.equal(fx.enqueued.length, 1, 'Повтор не дублирует ответы и переоценку');
    });
  }
});

test('SOURCE-ARBITER-01: callback worker передаёт источник автоматическому повтору', async (t) => {
  const { analysisSourceFixture, eventually } = await import('./helpers/analysisSource.js');
  const fx = await analysisSourceFixture(t);
  const callbacks = [];

  fx.analyzer.onAnalyzed = (...args) => {
    callbacks.push(args);
  };
  await fx.request('POST', '/api/tasks/42/analyze', { source: fx.a.source });
  await eventually(() => callbacks, (calls) => calls.length > 0);

  assert.equal(String(callbacks[0][0]), '42');
  assert.ok(JSON.stringify(callbacks[0].slice(1)).includes(fx.a.source),
    'Автоматический арбитр должен получить A вместе с номером');
});
