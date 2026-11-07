import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import { classifyGlmModelError } from '../../server/src/lib/glm/modelErrors.ts';
import {
  assertFactoryTurnResult,
  factoryRunnerErrorEvent,
} from '../../server/src/lib/factoryProviderRunner.ts';

import {
  classifyCodexFailure,
  inspectClaudeFailure,
  inspectCodexFailure,
  inspectDeepSeekFactoryFailure,
  inspectGlmFactoryFailure,
  inspectKimiFailure,
  inspectRunnerStderr,
  runnerFailureDetail,
  RUNNER_FAILURE_READERS,
} from '../../server/src/lib/runnerFailure.ts';

const capacity = 'Selected model is at capacity. Please try a different model.';
const failed = (message) => JSON.stringify({ type: 'turn.failed', error: { message } });
const stream = (...events) => events.map((event) => JSON.stringify(event)).join('\n');

test('для каждого встроенного раннера объявлен источник диагностики отказов', async () => {
  const files = await readdir(new URL('../../engine/lib/runners/', import.meta.url));
  const runners = files.filter((file) => file.endsWith('.sh'))
    .map((file) => file.slice(0, -3)).filter((id) => !['index', 'policy', 'catalog'].includes(id));

  assert.deepEqual(Object.keys(RUNNER_FAILURE_READERS).sort(), runners.sort());
});

test('Claude распознаёт реальные формы отказа подписки, авторизации, контекста и частоты', async () => {
  for (const [fixture, code] of [
    ['runtime-session-limit', 'usage_limit'],
    ['runtime-weekly-limit', 'usage_limit'],
    ['auth-expired', 'authentication'],
    ['context-overflow', 'context_overflow'],
    ['rate-limit', 'rate_limit'],
  ]) {
    const raw = await readFile(new URL(
      `../engine/fixtures/classifiers/claude-${fixture}/events.jsonl`, import.meta.url,
    ), 'utf8');

    assert.equal(inspectClaudeFailure(raw).code, code, fixture);
  }
});

test('Claude не берёт ошибки из текста модели и снимает отказ после восстановления', () => {
  const failure = {
    type: 'assistant',
    error: 'unknown',
    message: {
      model: '<synthetic>', content: [{ type: 'text', text: 'API Error: Connection error.' }],
    },
  };
  const rejected = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } };
  const success = { type: 'assistant', message: {
    model: 'claude-test', content: [{ type: 'text', text: 'quota exceeded, 401: текст задания' }],
  } };

  assert.equal(inspectClaudeFailure(stream(failure)).code, 'network');
  assert.equal(inspectClaudeFailure(stream(failure, { type: 'result', subtype: 'success' })).code, 'network');
  assert.equal(inspectClaudeFailure(stream(success)), null);
  assert.equal(inspectClaudeFailure(stream(rejected, success)), null);
  assert.equal(inspectClaudeFailure(stream(rejected, { type: 'rate_limit_event', rate_limit_info: {
    status: 'allowed_warning',
  } })), null);
  assert.equal(inspectClaudeFailure(stream(failure, { type: 'system', subtype: 'init' })), null);
  assert.match(inspectClaudeFailure(stream({
    type: 'result',
    is_error: true,
    errors: ['Provider E_NEW token=secret-value'],
  })).message, /Provider E_NEW token=\[скрыто\]/);
});

for (const [provider, inspect] of [
  ['DeepSeek', inspectDeepSeekFactoryFailure], ['GLM', inspectGlmFactoryFailure],
]) {
  test(`${provider}: коды модели и неизвестные отказы wrapper-а сохраняют причину`, () => {
    for (const [code, expected] of [
      ['AUTH', 'authentication'], ['QUOTA', 'usage_limit'], ['RATE_LIMIT', 'rate_limit'],
      ['TRANSPORT', 'network'], ['CONTEXT_WINDOW_EXCEEDED', 'context_overflow'],
    ]) {
      const failure = inspect(stream({
        event: 'wrapper_error',
        code,
        message: 'Model failure',
      }));

      assert.equal(failure.code, expected);
    }

    const raw = stream({
      event: 'wrapper_error',
      code: 'provider_custom',
      message: 'Provider E_NEW',
    });

    assert.match(runnerFailureDetail(inspect(raw)), /Provider E_NEW/);
    assert.equal(inspect(stream({ event: 'tool_result', message: 'quota exceeded' })), null);
    assert.equal(inspect(`${raw}\n${stream({ event: 'result', stopReason: 'end_turn' })}`), null);
    assert.equal(inspect(`${raw}\n${stream({ event: 'deepseek_start' })}`), null);
  });
}

test('Codex различает квоту и обычный HTTP 429', () => {
  const quota = inspectCodexFailure(stream({ type: 'usage_limit_reached', message: 'Usage limit reached' }));
  const frequency = inspectCodexFailure(failed('429 Too many requests'));

  assert.equal(runnerFailureDetail(quota.failure), 'Закончилась квота');
  assert.equal(frequency.failure.code, 'rate_limit');
});

test('GLM сохраняет различие квоты Coding Plan и недостаточного баланса или пакета', () => {
  for (const [providerCode, expected] of [['1310', /лимит/i], ['1113', /баланс|пакет|средств/i]]) {
    const error = classifyGlmModelError({
      code: 'RATE_LIMIT',
      message: `429 {"error":{"code":"${providerCode}","message":"fixture"}}`,
    });
    const failure = inspectGlmFactoryFailure(stream({
      event: 'wrapper_error',
      code: error.code,
      message: error.message,
    }));

    assert.match(runnerFailureDetail(failure), expected);
    assert.notEqual(runnerFailureDetail(failure), 'Закончилась квота');
  }
});

test('DSH сохраняет HTTP-статус без кода через отказ wrapper-а и различает 429 с квотой', () => {
  for (const [status, expected] of [[429, 'rate_limit'], [402, 'usage_limit']]) {
    assert.throws(() => assertFactoryTurnResult({
      deliveryFailure: true,
      turnFailure: { message: 'HTTP failure', status },
    }, 'deepseek_turn_failed', 'fallback'), (error) => {
      const event = factoryRunnerErrorEvent(error, error.code, error.message);

      assert.equal(event.status, status);
      assert.equal(inspectDeepSeekFactoryFailure(stream(event)).code, expected);

      return true;
    });
  }

  assert.deepEqual(factoryRunnerErrorEvent({ status: '429', privateField: 'secret' }, 'failure', 'failed'), {
    event: 'wrapper_error',
    code: 'failure',
    message: 'failed',
  });
});

test('Kimi распознаёт квоту, авторизацию и сеть в окончательном stderr CLI', () => {
  for (const [message, code] of [
    ["provider.auth_error: 403 You've reached your usage limit for this billing cycle.", 'usage_limit'],
    ['You have reached your 5-hour usage limit.', 'usage_limit'],
    ['provider.auth_error: 403 Forbidden', 'authentication'],
    ['No model configured. Run `kimi` and use /login to sign in.', 'authentication'],
    ['provider.rate_limit_error: 429 Too Many Requests', 'rate_limit'],
    ['config.invalid: Model "unknown" is not configured in config.toml.', 'bad_request'],
    ['internal: OAuth request to https://auth.kimi.com/api/oauth/token failed: fetch failed', 'network'],
    ['Provider E_NEW', 'unknown'],
  ]) {
    const failure = inspectKimiFailure(`error: failed to run prompt: ${message}\nSee log: /private/log\n`);

    assert.equal(failure.code, code, message);
    assert.doesNotMatch(failure.message, /See log|private\/log|https:\/\//);

    if (code === 'usage_limit') {
      assert.equal(runnerFailureDetail(failure), 'Закончилась квота');
    }
  }
});

test('Kimi берёт последний отказ CLI, не принимает чужой вывод и скрывает секреты', () => {
  const quota = 'error: failed to run prompt: You have reached your 5-hour usage limit.';

  assert.equal(inspectKimiFailure('You have reached your 5-hour usage limit.'), null);
  assert.equal(inspectKimiFailure(JSON.stringify({ role: 'tool', content: quota })), null);
  assert.equal(inspectKimiFailure(`${quota}\nerror: failed to run prompt: Provider E_NEW`).code, 'unknown');

  const failure = inspectKimiFailure('error: failed to run prompt: Provider E_NEW token=secret-value '
    + 'Bearer hidden-token ' + 'x'.repeat(900));

  assert.doesNotMatch(failure.message, /secret-value|hidden-token/);
  assert.ok(failure.message.length <= 500);
  assert.match(runnerFailureDetail(failure), /Provider E_NEW/);
});

test('запасная диагностика stderr сохраняет новую ошибку без стека, адресов и секретов', () => {
  const failure = inspectRunnerStderr('Error: CLI_E_NEW token=private-value https://private.invalid\n'
    + '    at main (/private/runner.js:5:2)\n}\nNode.js v24.0.0\nSee log: /private/log\n');

  assert.equal(failure.code, 'stderr');
  assert.match(runnerFailureDetail(failure), /Последнее сообщение исполнителя: Error: CLI_E_NEW/);
  assert.doesNotMatch(failure.message, /private-value|private\/|private\.invalid|Node\.js|main/);
  assert.equal(inspectRunnerStderr('\nSee log: /private/log\n'), null);
});

test('код GLM дополняет исходную причину, а секреты не попадают в подпись ошибки', () => {
  const failure = inspectGlmFactoryFailure(stream({
    event: 'wrapper_error',
    code: 'glm_key_missing',
    message: 'GLM недоступен: проверь карточку api_key=private-value',
  }));

  assert.match(runnerFailureDetail(failure), /GLM недоступен: проверь карточку/);
  assert.match(runnerFailureDetail(failure), /\(glm_key_missing\)$/);
  assert.doesNotMatch(runnerFailureDetail(failure), /private-value/);
});

test('перегрузка после работы остаётся transient и получает понятное пояснение', () => {
  const raw = stream(
    { type: 'item.completed', item: { type: 'command_execution', exit_code: 0 } },
    { type: 'error', message: capacity },
    { type: 'turn.failed', error: { message: capacity } },
  );
  const evidence = inspectCodexFailure(raw);

  assert.equal(classifyCodexFailure(raw, 1, true), 'transient');
  assert.equal(evidence.failure.code, 'capacity');
  assert.equal(evidence.failure.message, capacity);
  assert.match(runnerFailureDetail(evidence.failure, 'example-sol'), /модель «example-sol» перегружена/);
});

test('неизвестный отказ сохраняет текст, не разрешая смену исполнителя', () => {
  const raw = failed('Unexpected provider failure E_CUSTOM');
  const evidence = inspectCodexFailure(raw);

  assert.equal(classifyCodexFailure(raw, 1, true), 'unknown');
  assert.match(runnerFailureDetail(evidence.failure), /Unexpected provider failure E_CUSTOM/);
});

test('ошибки в командах и сообщениях агента не становятся ошибками провайдера', () => {
  const raw = stream({
    type: 'item.completed',
    item: { type: 'command_execution', aggregated_output: failed(capacity) },
  });

  assert.equal(inspectCodexFailure(raw).failure, null);
  assert.equal(classifyCodexFailure(raw, 1, true), 'unknown');
});

test('восстановившийся ход не наследует предыдущий отказ', () => {
  for (const event of [
    { type: 'turn.completed', usage: {} },
    { type: 'turn.started' },
    { type: 'thread.started' },
    { type: 'item.started', item: { type: 'command_execution' } },
  ]) {
    const raw = `${failed(capacity)}\n${JSON.stringify(event)}`;

    assert.equal(inspectCodexFailure(raw).failure, null);
  }
});

test('auth после работы или повреждения потока не разрешает переключение', () => {
  const auth = JSON.stringify({ type: 'turn.failed', error: { type: 'authentication_error', status: 401 } });

  assert.equal(classifyCodexFailure(auth, 1, true), 'provider_unavailable');
  assert.equal(classifyCodexFailure(`bad json\n${auth}`, 1, true), 'unknown');
  assert.equal(classifyCodexFailure(`{"type":"new.unknown.event"}\n${auth}`, 1, true), 'unknown');
  assert.equal(classifyCodexFailure(`{"type":"item.started"}\n${auth}`, 1, true), 'unknown');
  assert.equal(classifyCodexFailure(auth, 1, false), 'unknown');
});

test('код завершения важнее текста прошлой ошибки', () => {
  assert.equal(classifyCodexFailure(failed(capacity), 0, true), 'ok');
  assert.equal(classifyCodexFailure(failed(capacity), 124, true), 'timeout');
});

test('сообщение ограничено одной строкой и не раскрывает типичные секреты', () => {
  const raw = failed('Bearer secret-value token=another-secret https://host.invalid/?key=hidden\n'
    + '\u001b[31mFAIL\u001b[0m\u202e' + 'x'.repeat(1500));
  const message = inspectCodexFailure(raw).failure.message;

  assert.doesNotMatch(message, /secret-value|another-secret|hidden|\n|\u001b|\u202e/);
  assert.ok(message.length <= 500);
  assert.match(message, /FAIL/);
});

test('native Auto-review denial не становится отказом провайдера или поводом для failover', () => {
  const raw = stream(
    { type: 'item.autoApprovalReview.completed', review: { status: 'denied' } },
    { type: 'item.completed', item: {
      type: 'command_execution',
      exit_code: 1,
      aggregated_output: 'sandbox_denied: Тестовый отказ reviewer',
    } },
    { type: 'item.completed', item: {
      type: 'agent_message',
      text: 'Выполнена разрешённая альтернатива; первый запрос denied.',
    } },
    { type: 'turn.completed', usage: {} },
  );

  assert.equal(inspectCodexFailure(raw).failure, null);
  assert.equal(classifyCodexFailure(raw, 0, true), 'ok');
  assert.equal(classifyCodexFailure(raw, 1, true), 'unknown');
  assert.equal(classifyCodexFailure(stream({
    type: 'turn.failed',
    error: { type: 'sandbox_denied' },
  }), 1, true), 'denied');
});
