import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AnalysisContractError,
  parseAnalysisArbiter,
  parseAnalysisClarifications,
  parseAnalysisDetail,
  parseAnalysisQueue,
  parseAnalysisRows,
} from '../../shared/analysisContracts.ts';
import { api } from '../../web/src/shared/apiClient.ts';
import { analysisApi, analysisDisabledFailure } from '../../web/src/shared/analysisApi.ts';

const question = {
  id: 'q-1',
  text: 'Показывать ли архивные записи?',
  options: [{ id: 'o-1', label: 'Показывать', description: null }],
  recommendation: null,
};
const analysis = {
  complexity: 3,
  risk: 2,
  diff_size: 'M',
  confidence: 'high',
  summary: 'Сквозная правка по готовым паттернам.',
  needs_clarification: false,
  risk_markers: ['очередь'],
  files: ['be:src/app.js'],
  unknowns: [],
  questions: [question],
  route_guess: 'feature',
  route_kind: 'feature',
  route_depth: 'mid',
  route_reason: 'сложность 3, риск 2',
  title: 'Задача 42',
  generated_at: '2026-09-08T08:00:00.000Z',
  meta: {
    provider: 'claude',
    model: 'claude-opus-5',
    effort: null,
    requestedModel: null,
    warning: null,
    duration_ms: 61000,
    cost_usd: 0.42,
    context_tokens: 120000,
  },
};
const status = {
  task: 42,
  state: 'done',
  queuedAt: 1757318400000,
  startedAt: 1757318401000,
  finishedAt: 1757318461000,
  durationMs: 60000,
  error: null,
  note: null,
};
const detail = {
  task: 42, analysis, note: 'Разведнота.', stale: ['be:src/app.js'], status,
};
const clarifications = {
  text: '## Ответ человека — Оставить режим?\nВыбрано: Да\nДа.',
  entries: [{
    id: 'answer-1',
    questionId: 'q-1',
    // Вопрос и подпись варианта хранит сама запись: оценку триажа перезапишет
    // следующий заход, и по одному id ответ потерял бы свой вопрос.
    questionText: 'Оставить режим?',
    actor: 'human',
    status: 'answered',
    selection: ['o-1'],
    selectionLabels: ['Да'],
    text: 'Да.',
    attachments: [{ file: 'a1.png', name: 'скрин.png' }],
    proof: [],
  }],
};
const contracts = [
  [parseAnalysisRows, [{ task: 42, analysis, status }]],
  [parseAnalysisDetail, detail],
  [parseAnalysisQueue, { outcome: 'queued', position: 2 }],
  [parseAnalysisClarifications, clarifications],
  [parseAnalysisArbiter, {
    ok: true, outcome: 'answered', answered: 1, error: null,
  }],
];

test('контракты триажа принимают ответ сервера и отбрасывают посторонние поля', () => {
  for (const [parse, payload] of contracts) {
    const source = Array.isArray(payload)
      ? payload.map((row) => ({ ...row, ignored: 'лишнее' }))
      : { ...payload, ignored: 'лишнее' };

    assert.deepEqual(parse(source), payload);
  }
  for (const invalid of [null, 'text', 12, false]) {
    assert.throws(() => parseAnalysisRows(invalid), AnalysisContractError);
    assert.throws(() => parseAnalysisDetail(invalid), AnalysisContractError);
  }
});

test('оценка модели переживает отсутствие необязательных полей', () => {
  const bare = parseAnalysisRows([{ task: 42, analysis: { complexity: 2 } }]);

  assert.deepEqual(bare[0].analysis.risk, null, 'поля, которого нет, — пустое место');
  assert.deepEqual(bare[0].analysis.questions, null);
  assert.deepEqual(bare[0].status, null, 'задача без статуса очереди законна');
  assert.deepEqual(parseAnalysisDetail({ task: 42 }), {
    task: 42, analysis: null, note: null, stale: null, status: null,
  });
});

test('состояние очереди и решение по вопросу закрыты перечислением', () => {
  assert.throws(() => parseAnalysisRows([{ task: 42, status: { task: 42, state: 'думает' } }]),
    /analysisRows\[0\]\.status\.state/);
  assert.throws(() => parseAnalysisQueue({ outcome: 'ok' }), /analysisQueue\.outcome/);
  assert.throws(
    () => parseAnalysisClarifications({
      text: '',
      entries: [{ ...clarifications.entries[0], actor: 'робот' }],
    }),
    /clarifications\.entries\[0\]\.actor/,
  );
  assert.throws(() => parseAnalysisRows([{ task: -1 }]), /analysisRows\[0\]\.task/);
});

test('выключенный плагин отличается от поломки по машинному коду', () => {
  assert.equal(analysisDisabledFailure({ code: 'plugin_disabled' }), true);
  assert.equal(analysisDisabledFailure({ data: { error: 'plugin_disabled' } }), true);
  assert.equal(analysisDisabledFailure(new Error('Failed to fetch')), false);
});

test('адаптер кодирует номер задачи и подтверждает форму каждого ответа', async (t) => {
  const seen = [];
  t.mock.method(api, 'get', async (url) => {
    seen.push(['GET', url]);
    return url.endsWith('/clarifications') ? clarifications : detail;
  });
  t.mock.method(api, 'post', async (url, body) => {
    seen.push(['POST', url, body]);
    return url.endsWith('/arbitrate') ? { ok: true, answered: 0 } : { outcome: 'queued' };
  });
  t.mock.method(api, 'del', async (url) => {
    seen.push(['DELETE', url]);
    return { outcome: 'dismissed' };
  });

  await analysisApi.detail('42 и/или 43');
  await analysisApi.enqueue(42);
  await analysisApi.dismiss(42);
  await analysisApi.clarifications(42);
  await analysisApi.arbitrate(42);

  const id = encodeURIComponent('42 и/или 43');

  assert.deepEqual(seen, [
    ['GET', `/api/analysis/${id}`],
    ['POST', '/api/tasks/42/analyze', undefined],
    ['DELETE', '/api/analysis/42/status'],
    ['GET', '/api/tasks/42/clarifications'],
    ['POST', '/api/tasks/42/analysis/arbitrate', {}],
  ]);
});

test('повреждённый ответ сети не становится оценкой на доске', async (t) => {
  t.mock.method(api, 'get', async () => [{ task: 42, analysis: { complexity: 'высокая' } }]);
  t.mock.method(api, 'post', async () => ({ outcome: 'queued', position: -1 }));

  await assert.rejects(analysisApi.rows(), AnalysisContractError);
  await assert.rejects(analysisApi.enqueue(42), AnalysisContractError);
});
