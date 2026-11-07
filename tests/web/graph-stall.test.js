import assert from 'node:assert/strict';
import test from 'node:test';

import { graphStallView } from '../../web/src/shared/graphStall.ts';

test('graph stall presentation keeps the affected node, explicit reason and recovery hint visible', () => {
  const view = graphStallView({
    nodes: { review: ['agent', '🤖 Ревью', ''] },
    stall: {
      node: 'review',
      stage: 'REVIEW',
      title: 'REVIEW: агент трижды не отчитался о результате',
      hint: 'Проверь лимиты и доступность инструментов.',
      fails: 113,
    },
  });

  assert.deepEqual({
    node: view.node,
    stage: view.stage,
    nodeLabel: view.nodeLabel,
    title: view.title,
    hint: view.hint,
    fails: view.fails,
  }, {
    node: 'review',
    stage: 'REVIEW',
    nodeLabel: 'Ревью',
    title: 'REVIEW: агент трижды не отчитался о результате',
    hint: 'Проверь лимиты и доступность инструментов.',
    fails: 113,
  });
});

test('healthy graph has no stall presentation', () => {
  assert.equal(graphStallView({ stall: null }), null);
});

const details = {
  what: 'Три захода завершились без результата.',
  cause: 'Исполнитель исчерпал время.',
  retained: 'Если черновик записан, он достанется следующему заходу.',
  action: 'Продолжите прогон.',
};

test('короткий вид отделяет причину метки и полки', () => {
  const stall = {
    node: 'ship',
    stage: 'SHIP',
    title: 'SHIP: раннер не получил результат — 3 захода без результата',
    hint: 'Полная подсказка для модалки узла.',
    fails: 0,
    presentation: {
      reason: 'агент не вернул результат',
      summary: 'Продолжите с сохранённого черновика, если он есть.',
      details,
      attempts: 3,
      returns: 2,
      lastFailure: 'причина не названа',
      model: 'example-sol',
    },
  };
  const view = graphStallView({ nodes: { ship: ['agent', '🚢 Вливание в dev'] }, stall });

  assert.equal(view.reason, stall.presentation.reason);
  assert.equal(view.summary, stall.presentation.summary);
  assert.deepEqual(view.details, details);
  assert.equal(view.attempts, 3);
  assert.equal(view.returns, 2);
  assert.equal(view.fails, 0);
  assert.equal(view.lastFailure, 'причина не названа');
  assert.equal(view.model, 'example-sol');
  assert.equal(view.nodeLabel, 'Вливание в dev');
  assert.equal(view.title, stall.title);
  assert.equal(view.hint, stall.hint);
});

test('старый DTO не даёт пустой остановки и сохраняет полную прозу', () => {
  const stall = {
    stage: 'SHIP',
    title: 'SHIP: раннер не получил результат — последний — unknown',
    hint: 'Черновик t<TASK>.<этап>.checkpoint.md; смотри logs/tNNNN.stages.log.',
  };
  const view = graphStallView({ nodes: {}, stall });

  assert.ok(view.reason?.trim());
  assert.ok(view.summary?.trim());
  assert.ok(view.details?.what?.trim());
  assert.ok(view.details?.action?.trim());
  assert.doesNotMatch([view.reason, view.summary, JSON.stringify(view.details)].join(' '),
    /t<TASK>|tNNNN|\bunknown\b/);
  assert.match(view.title, /раннер не получил результат/);
  assert.match(view.hint, /Черновик/);
  assert.match(stall.title, /unknown/, 'адаптер не переписывает входной DTO');
});

const sandboxGraph = {
  nodes: { plan: ['agent', '📋 План'], sandbox: ['infra', '🧪 Стенд'] },
  keys: { plan: 'PLAN' },
  stall: {
    node: 'sandbox',
    stage: 'SANDBOX',
    title: 'стенд не поднялся',
    hint: 'h',
  },
};

test('узел стенда берётся из графа, а не сырым ключом: исходный барьер', () => {
  assert.equal(graphStallView(sandboxGraph).nodeLabel, 'Стенд');
});

test('узел стенда берётся из графа, а не сырым ключом: сводка без node', () => {
  const view = graphStallView(sandboxGraph, {
    kind: 'human',
    stage: 'SANDBOX',
    title: 'стенд не поднялся',
    hint: 'h',
  });
  const unknown = graphStallView(sandboxGraph, { stage: 'XYZ', title: 'остановка' });

  assert.equal(view.nodeLabel, 'Стенд');
  assert.equal(unknown.nodeLabel, 'Конвейер');
  assert.notEqual(view.nodeLabel, 'SANDBOX');
  assert.notEqual(unknown.nodeLabel, 'XYZ');
});

test('кривая presentation даёт запасной вид из title и hint', () => {
  const view = graphStallView({
    nodes: {},
    stall: {
      title: 'T',
      hint: 'H',
      presentation: { reason: 5, details: 'x' },
    },
  });

  assert.equal(view.reason, 'T');
  assert.equal(view.summary, 'H');
  assert.equal(view.details.what, 'T');
  assert.equal(view.details.action, 'H');
});

test('короткий вид берёт фактическую модель узла раньше политики и запасной модели', () => {
  const stall = {
    stage: 'SHIP',
    title: 'SHIP: остановка',
    hint: 'Продолжите.',
    presentation: {
      reason: 'агент не вернул результат',
      summary: 'Кратко.',
      details: { what: 'Что случилось.', action: 'Продолжите.' },
      model: 'evidence-model',
    },
  };
  const graph = {
    nodes: { ship: ['agent', 'Вливание в dev'] },
    keys: { ship: 'SHIP' },
    nodeMeta: {
      ship: {
        runner: {
          actual: 'codex',
          model: 'actual-model',
          models: { codex: { exact: 'policy-model' } },
        },
      },
    },
  };
  const view = graphStallView(graph, stall);

  assert.ok(view, 'сводочная остановка используется и без graph.stall');
  assert.equal(view.nodeLabel, 'Вливание в dev');
  assert.equal(view.model, 'actual-model');
});

test('старый DTO сохраняет все предложения полных title и hint в полках', () => {
  const title = 'SHIP: Вопрос; уточните шаг. Потом вернитесь.';
  const hint = 'Первый шаг; затем второй. Не теряйте хвост.';
  const view = graphStallView({ nodes: {}, stall: {
    title,
    hint,
    stage: 'SHIP',
  } });

  assert.equal(view.reason, 'Вопрос; уточните шаг. Потом вернитесь.');
  assert.equal(view.summary, hint);
  assert.deepEqual(view.details, { what: title, action: hint });
});

test('короткий вид не показывает бесконечные и отсутствующие счётчики сбоев', () => {
  for (const fails of [Infinity, NaN, undefined]) {
    const view = graphStallView({ nodes: {}, stall: { title: 'Остановка', fails } });

    assert.equal(view.fails, null);
  }
});
