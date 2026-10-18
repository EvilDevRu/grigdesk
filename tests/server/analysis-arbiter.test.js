import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    b24: null,
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
