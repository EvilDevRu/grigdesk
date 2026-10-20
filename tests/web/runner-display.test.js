import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attemptCostLabel,
  attemptCostTitle,
  attemptResultLabel,
  PROVIDER_LABELS,
  providerLabel,
  runnerAttemptModelLabel,
  runnerChainLabel,
  runnerEffortLabel,
  runnerModelEffortLabel,
  runnerModelLabel,
  runnerNodeLabel,
  runnerReasonLabel,
} from '../../web/src/shared/runnerDisplay.ts';

test('runner labels remain readable for built-in and future providers', () => {
  assert.equal(providerLabel('claude'), 'Claude');
  assert.equal(providerLabel('codex'), 'Codex');
  assert.equal(providerLabel('new-ai'), 'New ai');
});

test('kimi label comes from PROVIDER_LABELS, not from the id fallback', () => {
  // providerLabel('kimi') через fallback тоже дал бы 'Kimi', поэтому проверяем
  // саму каноническую запись в PROVIDER_LABELS, а не только результат функции.
  assert.ok(
    Object.hasOwn(PROVIDER_LABELS, 'kimi'),
    'kimi has a canonical entry in PROVIDER_LABELS',
  );
  assert.equal(PROVIDER_LABELS.kimi, 'Kimi');
  assert.equal(providerLabel('kimi'), 'Kimi');
});

test('deepseek label comes from PROVIDER_LABELS, not from the id fallback', () => {
  assert.ok(Object.hasOwn(PROVIDER_LABELS, 'deepseek'));
  assert.equal(PROVIDER_LABELS.deepseek, 'DeepSeek');
  assert.equal(providerLabel('deepseek'), 'DeepSeek');
});

test('glm label comes from PROVIDER_LABELS, not from the id fallback', () => {
  assert.ok(Object.hasOwn(PROVIDER_LABELS, 'glm'));
  assert.equal(PROVIDER_LABELS.glm, 'GLM');
  assert.equal(providerLabel('glm'), 'GLM');
});

test('provider_unavailable attempt result has a human-readable label', () => {
  const label = attemptResultLabel('provider_unavailable');
  assert.equal(label, 'провайдер недоступен');
  assert.notEqual(label, 'provider_unavailable');
});

test('chain and emergency switch are visible without model-version hardcoding', () => {
  const runner = {
    primary: 'claude',
    failover: ['codex'],
    chain: ['claude', 'codex'],
    actual: 'codex',
    reason: 'fallback_limit',
    switched: true,
    model: 'gpt-5.6-sol',
    models: {
      claude: { family: 'opus', version: 'latest', effort: 'max' },
      codex: { family: 'sol', version: 'latest', effort: 'max' },
    },
    attempts: [
      { runner: 'claude', model: 'opus', effort: 'high' },
      { runner: 'codex', model: 'gpt-5.6-sol', effort: 'ultra' },
    ],
  };
  assert.equal(runnerChainLabel(runner), 'Claude → Codex');
  assert.equal(runnerNodeLabel(runner), 'Codex · резерв');
  assert.equal(runnerModelLabel(runner), 'gpt-5.6-sol');
  assert.equal(runnerModelLabel(runner, 'claude'), 'opus');
  assert.equal(runnerEffortLabel(runner), 'ultra');
  assert.equal(runnerModelEffortLabel(runner), 'gpt-5.6-sol · effort ultra');
  assert.equal(runnerModelEffortLabel(runner, 'claude'), 'opus · effort high');
  assert.equal(runnerAttemptModelLabel(runner.attempts[0]), 'opus · effort high');
  assert.equal(runnerReasonLabel(runner.reason), 'закончился лимит');
  assert.equal(attemptResultLabel('manual_switch'), 'переключён вручную');
});

test('missing attempt telemetry falls back to runner policy', () => {
  const runner = {
    primary: 'codex', actual: 'codex', model: 'gpt-5.6-sol',
    attempts: [{ runner: 'codex', model: 'gpt-5.6-sol' }],
    models: { codex: { family: 'sol', version: 'latest', effort: 'max' } },
  };
  assert.equal(runnerModelEffortLabel(runner), 'gpt-5.6-sol · effort max');
});

// Цена запуска важнее объёма токенов: она позволяет сравнивать узлы
// маршрута, а разбивка по кэшу остаётся в подсказке.
test('attempt cost prefers money over token volume', () => {
  const attempt = {
    tokens: {
      in: 2_400_000, out: 100_000, cacheRead: 2_200_000, cacheWrite: 0, costUsd: 0.5,
    },
  };
  assert.equal(attemptCostLabel(attempt), '$0.50');
  assert.match(attemptCostTitle(attempt), /из кэша 2\s200\s000/u);
  assert.match(attemptCostTitle(attempt), /стоимость \$0\.5000/u);
});

test('attempt cost falls back to token total when the CLI never named a price', () => {
  assert.equal(
    attemptCostLabel({ tokens: { in: 20, out: 800, cacheRead: 90000, cacheWrite: 9000 } }),
    '100к ток.',
  );
  assert.equal(
    attemptCostLabel({ tokens: { in: 0, out: 100000, cacheRead: 2200000, cacheWrite: 0 } }),
    '2.3М ток.',
  );
});

test('schema-2 runner telemetry остаётся exact, различает partial и measured zero', () => {
  const huge = {
    tokens: {
      exact: {
        in: '9007199254740993', out: '7', cacheRead: '3', cacheWrite: '7',
        costUsd: '2.9762492000000008', completeness: 'complete', provenance: 'exact',
      },
    },
  };
  assert.equal(attemptCostLabel(huge), '$2.98');
  assert.match(attemptCostTitle(huge), /вход 9 007 199 254 740 993/u);
  assert.match(attemptCostTitle(huge), /стоимость \$2\.9762/u);

  const partial = {
    tokens: {
      exact: {
        in: '20', out: '800', cacheRead: '90000', cacheWrite: '9000',
        costUsd: null, completeness: 'partial', provenance: 'exact',
      },
    },
  };
  assert.equal(attemptCostLabel(partial), '≥100к ток.');
  assert.match(attemptCostTitle(partial), /учтённая часть/u);

  const zero = {
    tokens: {
      exact: {
        in: '0', out: '0', cacheRead: '0', cacheWrite: '0',
        costUsd: '0', completeness: 'complete', provenance: 'exact',
      },
    },
  };
  assert.equal(attemptCostLabel(zero), '$0.00');
  assert.notEqual(attemptCostTitle(zero), '');
});

// Раннер без метода `usage` (ACP-мост kimi) расхода не публикует. Пустая метка
// честнее нуля: «бесплатно» и «неизвестно» — разные утверждения.
test('attempt without usage telemetry shows nothing', () => {
  assert.equal(attemptCostLabel({ runner: 'kimi', model: 'k2' }), '');
  assert.equal(attemptCostTitle({ runner: 'kimi' }), '');
  assert.equal(attemptCostLabel({ tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } }), '');
});
