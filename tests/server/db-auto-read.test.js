import assert from 'node:assert/strict';
import test from 'node:test';

async function evaluator() {
  let module;
  try {
    module = await import('../../server/src/lib/db/autoRead.ts');
  } catch (error) {
    assert.fail(`единая политика автоподтверждения чтения ещё не реализована: ${error.message}`);
  }
  const operation = module.evaluateAutoRead || module.decideAutoRead || module.default;
  assert.equal(typeof operation, 'function', 'auto-read модуль обязан экспортировать evaluator');
  return operation;
}

function eligible(overrides = {}) {
  return {
    settings: {
      enabled: true,
      prodEnabled: true,
      maxRows: 1000,
      maxBytes: 256 * 1024,
      timeoutMs: 15_000,
      maxPerMinute: 10,
      ...overrides.settings,
    },
    profile: { prod: false, ...overrides.profile },
    rights: { confirmedReadOnly: true, ...overrides.rights },
    connection: { readOnlyActive: true, ...overrides.connection },
    analysis: {
      queryClass: 'read',
      single: true,
      forbidden: [],
      tableFunctions: [],
      ...overrides.analysis,
    },
    limits: {
      rows: 100,
      bytes: 4096,
      timeoutMs: 1000,
      ...overrides.limits,
    },
    rate: { used: 0, ...overrides.rate },
  };
}

async function decision(overrides) {
  const evaluate = await evaluator();
  return evaluate(eligible(overrides));
}

test('право записи по grants или ACL запрещает автоподтверждение', async () => {
  const result = await decision({ rights: { confirmedReadOnly: false, writable: true } });

  assert.deepEqual({ eligible: result.eligible, code: result.reason?.code }, {
    eligible: false,
    code: 'writable_rights',
  });
});

test('соединение без активного read-only запрещает автоподтверждение', async () => {
  const result = await decision({ connection: { readOnlyActive: false } });

  assert.deepEqual({ eligible: result.eligible, code: result.reason?.code }, {
    eligible: false,
    code: 'connection_not_read_only',
  });
});

test('несколько statement запрещают автоподтверждение', async () => {
  const result = await decision({ analysis: { single: false } });

  assert.deepEqual({ eligible: result.eligible, code: result.reason?.code }, {
    eligible: false,
    code: 'multiple_statements',
  });
});

test('запрещённая SQL-конструкция запрещает автоподтверждение', async () => {
  const result = await decision({ analysis: { forbidden: ['FOR UPDATE'] } });

  assert.deepEqual({ eligible: result.eligible, code: result.reason?.code }, {
    eligible: false,
    code: 'forbidden_query',
  });
});

test('табличная функция ClickHouse запрещает автоподтверждение', async () => {
  const result = await decision({ analysis: { tableFunctions: ['s3'] } });

  assert.deepEqual({ eligible: result.eligible, code: result.reason?.code }, {
    eligible: false,
    code: 'table_function',
  });
});

test('превышение лимита строк запрещает автоподтверждение', async () => {
  const result = await decision({ limits: { rows: 1001 } });

  assert.deepEqual({ eligible: result.eligible, code: result.reason?.code }, {
    eligible: false,
    code: 'row_limit',
  });
});

test('превышение лимита байтов запрещает автоподтверждение', async () => {
  const result = await decision({ limits: { bytes: 256 * 1024 + 1 } });

  assert.deepEqual({ eligible: result.eligible, code: result.reason?.code }, {
    eligible: false,
    code: 'byte_limit',
  });
});

test('превышение лимита времени запрещает автоподтверждение', async () => {
  const result = await decision({ limits: { timeoutMs: 15_001 } });

  assert.deepEqual({ eligible: result.eligible, code: result.reason?.code }, {
    eligible: false,
    code: 'time_limit',
  });
});

test('потолок автозапросов в минуту запрещает автоподтверждение', async () => {
  const result = await decision({ rate: { used: 10 } });

  assert.deepEqual({ eligible: result.eligible, code: result.reason?.code }, {
    eligible: false,
    code: 'rate_limit',
  });
});

test('на проде глобальная настройка без отдельного допуска не действует', async () => {
  const result = await decision({
    profile: { prod: true },
    settings: { prodEnabled: false },
  });

  assert.deepEqual({ eligible: result.eligible, code: result.reason?.code }, {
    eligible: false,
    code: 'prod_auto_read_disabled',
  });
});

test('безопасное чтение проходит все ворота автоподтверждения', async () => {
  const result = await decision({ profile: { prod: true } });

  assert.deepEqual({ eligible: result.eligible, reason: result.reason ?? null }, {
    eligible: true,
    reason: null,
  });
});
