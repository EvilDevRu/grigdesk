import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTO_CONTINUE_DELAYS_MS,
  AUTO_CONTINUE_MAX_PER_TURN,
  COMMON_TURN_FAILURE_RULES,
  TURN_FAILURE_KINDS,
  TURN_FAILURE_LABELS,
  autoContinueBudget,
  autoContinueDelay,
  classifyTurnFailure,
} from '../../server/src/lib/chat/turnFailures.ts';
import {
  CLAUDE_TURN_FAILURE_RULES,
  claudeTurnFailure,
} from '../../server/src/lib/executors/_claudeTurnFailures.ts';
import {
  CODEX_TURN_FAILURE_RULES,
  codexTurnFailure,
} from '../../server/src/lib/executors/_codexTurnFailures.ts';
import {
  DSH_TURN_FAILURE_RULES,
  dshTurnFailure,
} from '../../server/src/lib/deepseek/turnFailureRules.ts';

// Реестр видов сбоя — единственное место, где ядро знает об ошибке исполнителя.
// Вендорные коды объявляет адаптер, поэтому таблицы общих правил и правила
// исполнителей проверяются здесь же, на одном наборе сигналов.

// Один ожидаемый случай таблицы: сигнал, вид и (необязательно) точное правило.
function expectation(signal, kind, ruleId = '') {
  return {
    signal,
    kind,
    ruleId,
  };
}

/**
 * Прогоняет таблицу случаев и требует ожидаемый вид, признак продолжения и — когда
 * он назван — точный ruleId: имя правила доказывает, что сработал нужный признак.
 */
function expectKind(cases, continuable) {
  for (const item of cases) {
    const verdict = classifyTurnFailure(item.signal);
    const label = JSON.stringify(item.signal);

    assert.equal(verdict.kind, item.kind, `вид для ${label}`);
    assert.equal(verdict.continuable, continuable, `продолжаемость для ${label}`);

    if (item.ruleId) {
      assert.equal(verdict.ruleId, item.ruleId, `правило для ${label}`);
    }
  }
}

// Правило адаптера для проверки приоритета: свой код, которого нет в общих правилах.
function adapterRule(id, kind, code) {
  return [{
    id,
    kind,
    codes: [code],
  }];
}

const NETWORK_RULE_X = adapterRule('test.x', 'network', 'X');
const OVERLOADED_RULE = adapterRule('test.overloaded', 'overloaded', 'serverOverloaded');
const AUTH_RULE = adapterRule('test.auth', 'auth', 'AUTH');

test('общие правила: сеть, перегрузка, сбой сервера и частота — продолжаемые', () => {
  const cases = [
    expectation(
      {
        message: 'Error running remote compact task: stream disconnected before completion: '
          + 'Transport error: network error: error decoding response body',
      },
      'network',
      'common.network-words',
    ),
    expectation({ message: 'API Error: Connection error.' }, 'network'),
    expectation({ message: 'socket hang up' }, 'network'),
    expectation({ message: 'Request timed out.' }, 'network'),
    expectation({ status: 529, message: 'x' }, 'overloaded', 'common.http-overloaded'),
    expectation({ message: 'Overloaded' }, 'overloaded'),
    expectation(
      { message: 'Selected model is at capacity. Please try a different model.' },
      'overloaded',
    ),
    expectation({ status: 503, message: 'x' }, 'server_error', 'common.http-server'),
    expectation({ message: 'Internal server error' }, 'server_error'),
    expectation({ status: 429, message: 'x' }, 'rate_limited', 'common.http-rate-limit'),
    expectation(
      { message: 'exceeded retry limit, last status: 429 Too Many Requests' },
      'rate_limited',
    ),
  ];

  expectKind(cases, true);
});

test('общие правила: лимит, вход, контекст и плохой запрос — не продолжаются', () => {
  const cases = [
    expectation(
      { message: "API Error: You've hit your weekly limit · resets Sep 18, 7am" },
      'usage_limit',
    ),
    expectation(
      { message: "You've hit your usage limit. Upgrade to Pro or try again at 5:00 PM." },
      'usage_limit',
    ),
    expectation({ message: 'Insufficient balance' }, 'usage_limit'),
    expectation({ status: 402, message: 'x' }, 'usage_limit'),
    expectation({ status: 401, message: 'x' }, 'auth'),
    expectation({ message: 'Invalid API key' }, 'auth'),
    expectation({ message: 'Prompt is too long' }, 'context_overflow'),
    expectation({ status: 413, message: 'x' }, 'context_overflow'),
    expectation({ status: 400, message: 'x' }, 'bad_request'),
    expectation({ message: 'Bad Request: unknown field' }, 'bad_request'),
  ];

  expectKind(cases, false);
});

test('приоритет: окончательный вид побеждает переходный при любом порядке правил', () => {
  const cases = [
    expectation({ status: 429, message: 'insufficient balance' }, 'usage_limit'),
    expectation({ status: 502, message: 'Unauthorized' }, 'auth'),
    expectation({ message: 'invalid_request_error: prompt is too long' }, 'context_overflow'),
  ];

  expectKind(cases, false);

  const adapterDoesNotOverride = classifyTurnFailure(
    { code: 'X', message: 'Prompt is too long' },
    NETWORK_RULE_X,
  );

  assert.equal(adapterDoesNotOverride.kind, 'context_overflow');
  assert.equal(adapterDoesNotOverride.continuable, false);
});

test('правило адаптера дополняет общие: свой код распознан, ruleId называет правило', () => {
  const verdict = classifyTurnFailure(
    { code: 'serverOverloaded', message: 'x' },
    OVERLOADED_RULE,
  );

  assert.deepEqual(verdict, {
    kind: 'overloaded',
    ruleId: 'test.overloaded',
    continuable: true,
  });
});

test('нераспознанный сбой не продолжается', () => {
  const unknown = {
    kind: 'unknown',
    ruleId: '',
    continuable: false,
  };

  for (const signal of [{ message: 'No response requested.' }, {}, null]) {
    assert.deepEqual(classifyTurnFailure(signal), unknown, `сигнал ${JSON.stringify(signal)}`);
  }
});

test('паузы: по виду и номеру неуспешной попытки подряд, за пределом — null', () => {
  assert.equal(autoContinueDelay('network', 0), 10000);
  assert.equal(autoContinueDelay('network', 1), 60000);
  assert.equal(autoContinueDelay('network', 2), 180000);
  assert.equal(autoContinueDelay('network', 3), null);
  assert.equal(autoContinueDelay('overloaded', 0), 60000);
  assert.equal(autoContinueDelay('usage_limit', 0), null);
  assert.equal(autoContinueDelay('unknown', 0), null);
  assert.equal(autoContinueDelay('network', 1, { network: [5, 7] }), 7);
  assert.equal(autoContinueDelay('network', 2, { network: [5, 7] }), null);
  assert.equal(autoContinueBudget('network'), 3);
  assert.equal(autoContinueBudget('network', { network: [5] }), 1);
  assert.equal(autoContinueBudget('auth'), 0);
  assert.equal(AUTO_CONTINUE_MAX_PER_TURN, 10);
  assert.equal(AUTO_CONTINUE_DELAYS_MS.network.length, 3);
});

test('подписи есть у каждого вида и у unknown', () => {
  for (const kind of [...TURN_FAILURE_KINDS, 'unknown']) {
    const label = TURN_FAILURE_LABELS[kind];

    assert.equal(typeof label, 'string', `подпись ${kind}`);
    assert.ok(label.trim().length > 0, `подпись ${kind} непуста`);
  }
});

test('слишком длинный текст не даёт продолжение по обрезанному совпадению', () => {
  const padding = 'x'.repeat(4000);
  const long = `stream disconnected before completion ${padding} Authentication failed`;

  const truncated = classifyTurnFailure({ message: long });

  assert.equal(truncated.continuable, false, 'обрезанное совпадение не продолжается');
  assert.equal(truncated.kind, 'unknown', 'продолжаемый best за пределом текста — unknown');

  const short = classifyTurnFailure({ message: 'Authentication failed' });

  assert.equal(short.kind, 'auth');
  assert.equal(short.continuable, false);

  const adapterFinal = classifyTurnFailure(
    { code: 'AUTH', message: long },
    AUTH_RULE,
  );

  assert.equal(adapterFinal.kind, 'auth', 'окончательный код виден и в длинном тексте');
  assert.equal(adapterFinal.continuable, false);
});

test('таблицы правил заморожены, а порядок видов задаёт приоритет', () => {
  assert.deepEqual([...TURN_FAILURE_KINDS], [
    'auth',
    'usage_limit',
    'context_overflow',
    'policy',
    'bad_request',
    'rate_limited',
    'overloaded',
    'server_error',
    'network',
  ]);
  assert.ok(Array.isArray(COMMON_TURN_FAILURE_RULES));
  assert.ok(COMMON_TURN_FAILURE_RULES.length > 0);
});

// ── Сигналы исполнителей: адаптер переводит своё событие в общий сигнал ──

test('Claude: код синтетического сообщения и статус из текста', () => {
  const apiError = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}';
  const overloaded = claudeTurnFailure(apiError, 'overloaded');

  assert.deepEqual(overloaded, {
    code: 'overloaded',
    status: 529,
    message: apiError,
  });

  assert.deepEqual(claudeTurnFailure('API Error: Connection error.', ''), {
    message: 'API Error: Connection error.',
  });
});

test('Claude: виды по правилам адаптера', () => {
  const cases = [
    {
      signal: { code: 'rate_limit', message: "API Error: You've hit your limit · resets 5pm" },
      kind: 'usage_limit',
    },
    { signal: { code: 'rate_limit', message: 'API Error: 429 rate_limit_error' }, kind: 'rate_limited' },
    { signal: { code: 'authentication_failed', message: 'x' }, kind: 'auth' },
    { signal: { code: 'billing_error', message: 'Credit balance is too low' }, kind: 'usage_limit' },
    {
      signal: {
        code: 'invalid_request',
        message: 'API Error: 400 duplicate tool_use ID in conversation history.',
      },
      kind: 'bad_request',
    },
    {
      signal: {
        message: 'API Error: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)',
      },
      kind: 'network',
    },
    { signal: { message: 'Please run /login · API Error: 401' }, kind: 'auth' },
    { signal: { code: 'server_error', message: 'API Error: 500 {}' }, kind: 'server_error' },
    { signal: { message: 'No response requested.' }, kind: 'unknown' },
  ];

  for (const item of cases) {
    const verdict = classifyTurnFailure(item.signal, CLAUDE_TURN_FAILURE_RULES);

    assert.equal(verdict.kind, item.kind, `Claude ${JSON.stringify(item.signal)}`);
  }
});

test('Codex: codexErrorInfo строкой и объектом даёт код и статус', () => {
  assert.deepEqual(
    codexTurnFailure({
      message: 'm',
      codexErrorInfo: 'serverOverloaded',
      additionalDetails: null,
    }),
    { code: 'serverOverloaded', message: 'm' },
  );

  assert.deepEqual(
    codexTurnFailure({
      message: 'stream disconnected before completion',
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
      additionalDetails: 'details',
    }),
    {
      code: 'responseStreamDisconnected',
      status: 502,
      message: 'stream disconnected before completion: details',
    },
  );

  assert.deepEqual(
    codexTurnFailure({
      message: 'm',
      codexErrorInfo: null,
      additionalDetails: null,
    }),
    { message: 'm' },
  );

  assert.deepEqual(codexTurnFailure('строка'), { message: 'строка' });
  assert.deepEqual(codexTurnFailure(null), { message: 'ход завершился ошибкой' });
});

test('Codex: виды по правилам адаптера', () => {
  const incident = 'Error running remote compact task: stream disconnected before completion: '
    + 'Transport error: network error: error decoding response body';
  const transport = classifyTurnFailure(
    { code: 'other', message: incident },
    CODEX_TURN_FAILURE_RULES,
  );

  assert.equal(transport.kind, 'network');
  assert.equal(transport.continuable, true);

  const codes = [
    {
      code: 'responseStreamDisconnected',
      kind: 'network',
      ruleId: 'codex.transport',
    },
    {
      code: 'responseTooManyFailedAttempts',
      status: 429,
      kind: 'rate_limited',
    },
    {
      code: 'responseStreamConnectionFailed',
      status: 401,
      kind: 'auth',
    },
    { code: 'usageLimitExceeded', kind: 'usage_limit' },
    { code: 'contextWindowExceeded', kind: 'context_overflow' },
    { code: 'cyberPolicy', kind: 'policy' },
    { code: 'serverOverloaded', kind: 'overloaded' },
    { code: 'internalServerError', kind: 'server_error' },
  ];

  for (const item of codes) {
    const verdict = classifyTurnFailure(
      {
        code: item.code,
        ...(item.status ? { status: item.status } : {}),
        message: 'x',
      },
      CODEX_TURN_FAILURE_RULES,
    );

    assert.equal(verdict.kind, item.kind, `Codex ${item.code}`);

    if (item.ruleId) {
      assert.equal(verdict.ruleId, item.ruleId, `Codex ${item.code} правило`);
    }
  }
});

test('DSH: код из reason.error', () => {
  assert.deepEqual(dshTurnFailure({ code: 'TRANSPORT', message: 'Connection error.' }), {
    code: 'TRANSPORT',
    message: 'Connection error.',
  });

  assert.deepEqual(
    dshTurnFailure({
      code: 'RATE_LIMIT',
      status: 429,
      message: '429',
    }),
    {
      code: 'RATE_LIMIT',
      status: 429,
      message: '429',
    },
  );

  assert.deepEqual(dshTurnFailure({}, 'Ошибка модели'), { message: 'Ошибка модели' });
});

test('DSH: виды по правилам адаптера', () => {
  const codes = [
    { code: 'TRANSPORT', kind: 'network' },
    { code: 'TIMEOUT', kind: 'network' },
    { code: 'SERVER', kind: 'server_error' },
    { code: 'EMPTY_RESPONSE', kind: 'server_error' },
    { code: 'RATE_LIMIT', kind: 'rate_limited' },
    { code: 'QUOTA', kind: 'usage_limit' },
    { code: 'AUTH', kind: 'auth' },
    { code: 'CONTEXT_WINDOW_EXCEEDED', kind: 'context_overflow' },
  ];

  for (const item of codes) {
    const verdict = classifyTurnFailure(
      { code: item.code, message: 'x' },
      DSH_TURN_FAILURE_RULES,
    );

    assert.equal(verdict.kind, item.kind, `DSH ${item.code}`);
  }

  const quotaWords = classifyTurnFailure(
    { code: 'RATE_LIMIT', message: 'Insufficient balance' },
    DSH_TURN_FAILURE_RULES,
  );

  assert.equal(quotaWords.kind, 'usage_limit', 'слова лимита сильнее кода частоты');
});

test('правила всех исполнителей: id уникальны, виды известны, у каждого есть признак', () => {
  const all = [
    ...COMMON_TURN_FAILURE_RULES,
    ...CLAUDE_TURN_FAILURE_RULES,
    ...CODEX_TURN_FAILURE_RULES,
    ...DSH_TURN_FAILURE_RULES,
  ];
  const seen = new Set();

  for (const rule of all) {
    assert.ok(rule.id, 'правило названо');
    assert.equal(seen.has(rule.id), false, `id ${rule.id} не повторяется`);
    seen.add(rule.id);
    assert.ok(TURN_FAILURE_KINDS.includes(rule.kind), `вид ${rule.kind} известен`);

    const hasCodes = Array.isArray(rule.codes) && rule.codes.length > 0;
    const hasStatuses = Array.isArray(rule.statuses) && rule.statuses.length > 0;
    const hasPattern = rule.pattern instanceof RegExp;

    assert.ok(hasCodes || hasStatuses || hasPattern, `у ${rule.id} есть признак`);

    if (hasPattern) {
      assert.equal(rule.pattern.global, false, `у ${rule.id} нет флага g`);
      assert.equal(rule.pattern.sticky, false, `у ${rule.id} нет флага y`);
    }
  }
});

test('декларации адаптеров: свои таблицы, Kimi контракт не объявляет', async () => {
  const { getProviderAdapters } = await import('../../server/src/lib/executors/index.ts');
  const adapters = await getProviderAdapters();
  const declared = {
    claude: CLAUDE_TURN_FAILURE_RULES,
    codex: CODEX_TURN_FAILURE_RULES,
    deepseek: DSH_TURN_FAILURE_RULES,
    glm: DSH_TURN_FAILURE_RULES,
  };

  for (const [id, rules] of Object.entries(declared)) {
    const adapter = adapters.get(id);

    assert.ok(adapter, `адаптер ${id} подключён`);
    assert.equal(adapter.turnFailureRules, rules, `${id} объявляет свою таблицу`);
  }

  const kimi = adapters.get('kimi');

  assert.ok(kimi, 'адаптер kimi подключён');
  assert.equal(kimi.turnFailureRules, undefined, 'Kimi контракт не подтверждает');
});

test('ядро не ветвится по id адаптера', async () => {
  const { readFile } = await import('node:fs/promises');
  const sources = [
    '../../server/src/lib/chat/autoContinue.ts',
    '../../server/src/lib/chat/turnFailures.ts',
  ];

  for (const relative of sources) {
    const url = new URL(relative, import.meta.url);
    const text = await readFile(url, 'utf8');

    for (const vendor of ['claude', 'codex', 'deepseek', 'glm', 'kimi']) {
      assert.equal(
        new RegExp(`['"\`]${vendor}['"\`]`, 'u').test(text),
        false,
        `${relative} не называет исполнителя ${vendor}`,
      );
    }
  }
});
