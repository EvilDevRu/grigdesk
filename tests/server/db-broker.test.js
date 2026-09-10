import assert from 'node:assert/strict';
import test from 'node:test';

import { createPermissionQueue } from '../../server/src/lib/chat/permissionQueue.ts';

async function brokerFactory() {
  let module;
  try {
    module = await import('../../server/src/lib/db/broker.ts');
  } catch (error) {
    assert.fail(`единый broker надзорных DB-запросов ещё не реализован: ${error.message}`);
  }
  const create = module.createDbBroker || module.default;
  assert.equal(typeof create, 'function', 'db/broker.js обязан экспортировать фабрику');
  return create;
}

async function fixture(options = {}) {
  const queueEvents = [];
  const permissionQueue = createPermissionQueue({ timeoutMs: 24 * 60 * 60 * 1000 });
  permissionQueue.subscribe((event) => queueEvents.push(event));
  const audit = [];
  const queryEvents = [];
  let executions = 0;
  const analysis = options.analysis || {
    queryClass: 'read',
    single: true,
    tables: ['orders'],
    forbidden: [],
    tableFunctions: [],
  };
  let estimates = 0;
  let rightsChecks = 0;
  const engine = {
    id: 'mysql',
    label: 'MySQL',
    analyze: async () => {
      if (options.analyzeThrows === true) throw new Error('разбор запроса недоступен');
      return analysis;
    },
    inspectRights: async () => {
      rightsChecks += 1;
      return { confirmedReadOnly: true, writable: false };
    },
    estimate: async () => {
      estimates += 1;
      return options.estimate || ({ rows: 1, bytes: 64, timeoutMs: 100 });
    },
    execute: async () => {
      executions += 1;
      return [{ id: 1 }];
    },
  };
  const session = options.session === undefined ? {
    id: 'session-a',
    projectId: 'project-a',
    label: 'Прод-заказы',
    role: 'read',
    engine: 'mysql',
    prod: true,
    agentAllowed: true,
    generation: 1,
    readOnlyActive: true,
    handle: {},
  } : options.session;
  const sessions = {
    findForAgent: () => session,
    find: () => session,
    current: () => session,
  };
  const create = await brokerFactory();
  const broker = create({
    pluginEnabled: () => true,
    permissionQueue,
    sessions,
    engines: { get: () => engine },
    audit: { append: async (entry) => audit.push(entry) },
    settings: () => ({
      allowDdlAdmin: options.allowDdlAdmin === true,
      autoRead: options.autoRead === true,
      autoReadProd: options.autoReadProd === true,
      maxRows: 1000,
      maxBytes: 256 * 1024,
      timeoutMs: 15_000,
      autoReadPerMinute: 10,
    }),
    onQuery: (event) => queryEvents.push(event),
  });
  return {
    broker,
    permissionQueue,
    queueEvents,
    audit,
    queryEvents,
    executions: () => executions,
    estimates: () => estimates,
    rightsChecks: () => rightsChecks,
  };
}

function request(overrides = {}) {
  return {
    action: 'query',
    label: 'Прод-заказы',
    role: 'read',
    text: 'SELECT id FROM orders',
    params: [],
    ...overrides,
  };
}

function denialSnapshot(state, result) {
  return {
    denied: result?.ok === false,
    executions: state.executions(),
    humanWaiting: state.permissionQueue.waiting().length,
    waitingEvents: state.queueEvents.filter((event) => event.type === 'waiting').length,
    dbDecisions: state.queueEvents.filter((event) => (
      event.type === 'done' && event.origin === 'db'
    )).length,
    audit: state.audit.length,
  };
}

test('запрос без открытой DB-сессии получает внутренний отказ', async () => {
  const state = await fixture({ session: null });
  const result = await state.broker.invoke({ projectId: 'project-a' }, request());

  assert.deepEqual(denialSnapshot(state, result), {
    denied: true,
    executions: 0,
    humanWaiting: 0,
    waitingEvents: 0,
    dbDecisions: 1,
    audit: 1,
  });
});

test('запрос без выданного человеком допуска получает внутренний отказ', async () => {
  const state = await fixture({
    session: {
      id: 'session-a', projectId: 'project-a', label: 'Прод-заказы', role: 'read',
      engine: 'mysql', prod: true, agentAllowed: false, generation: 1, readOnlyActive: true,
    },
  });
  const result = await state.broker.invoke({ projectId: 'project-a' }, request());

  assert.deepEqual(denialSnapshot(state, result), {
    denied: true,
    executions: 0,
    humanWaiting: 0,
    waitingEvents: 0,
    dbDecisions: 1,
    audit: 1,
  });
});

for (const queryClass of ['ddl', 'admin']) {
  test(`${queryClass.toUpperCase()} отклоняется без обращения к человеку`, async () => {
    const state = await fixture({
      analysis: { queryClass, single: true, tables: [], forbidden: [], tableFunctions: [] },
    });
    const result = await state.broker.invoke({ projectId: 'project-a' }, request());

    assert.deepEqual(denialSnapshot(state, result), {
      denied: true,
      executions: 0,
      humanWaiting: 0,
      waitingEvents: 0,
      dbDecisions: 1,
      audit: 1,
    });
  });
}

test('неразобранный запрос отклоняется без вопроса человеку', async () => {
  const state = await fixture({
    analysis: { queryClass: 'unknown', single: false, tables: [] },
  });
  const result = await state.broker.invoke({ projectId: 'project-a' }, request());

  assert.deepEqual(denialSnapshot(state, result), {
    denied: true,
    executions: 0,
    humanWaiting: 0,
    waitingEvents: 0,
    dbDecisions: 1,
    audit: 1,
  });
});

test('режим прав и provider auto-allow не обходят DB-очередь', async () => {
  const state = await fixture();
  const pendingResult = state.broker.invoke({
    projectId: 'project-a',
    chatKey: 'chat-a',
    permissionMode: 'bypassPermissions',
    autoDecision: true,
  }, request());
  let pending;
  for (let attempt = 0; attempt < 100 && !pending; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    pending = state.permissionQueue.waiting().find((entry) => entry.origin === 'db');
  }
  const snapshot = pending && {
    origin: pending.origin,
    canRemember: pending.canRemember,
    queryClass: pending.presentation?.queryClass,
    tables: pending.presentation?.tables,
  };
  if (pending) {
    await state.permissionQueue.answer(pending.pid, 'db', { allow: false, remember: true });
  }
  await pendingResult;

  assert.deepEqual(snapshot, {
    origin: 'db',
    canRemember: false,
    queryClass: 'read',
    tables: ['orders'],
  });
});

test('серверная карточка записи содержит весь безопасный DB-контекст', async () => {
  const state = await fixture({
    analysis: {
      queryClass: 'write',
      single: true,
      tables: ['orders'],
      forbidden: [],
      tableFunctions: [],
    },
    estimate: { rows: 37, bytes: 2048, timeoutMs: 300 },
    session: {
      id: 'session-write',
      projectId: 'project-a',
      label: 'Прод-заказы',
      role: 'write',
      engine: 'mysql',
      prod: true,
      agentAllowed: true,
      generation: 1,
      readOnlyActive: false,
      handle: {},
    },
  });
  const pendingResult = state.broker.invoke({ projectId: 'project-a' }, request({
    role: 'write',
    text: 'UPDATE orders SET status = ? WHERE id = ?',
    params: ['paid', 42],
  }));
  let pending;
  for (let attempt = 0; attempt < 100 && !pending; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    pending = state.permissionQueue.waiting().find((entry) => entry.origin === 'db');
  }
  const presentation = pending?.presentation;
  if (pending) {
    await state.permissionQueue.answer(pending.pid, 'db', { allow: false });
  }
  await pendingResult;

  assert.deepEqual({
    profile: presentation?.profile,
    engine: presentation?.engine,
    prod: presentation?.prod,
    query: presentation?.query,
    queryClass: presentation?.queryClass,
    tables: presentation?.tables,
    rowEstimate: presentation?.rowEstimate,
    hasAutoReadReason: Object.hasOwn(presentation || {}, 'autoReadReason'),
  }, {
    profile: { label: 'Прод-заказы', role: 'write' },
    engine: { id: 'mysql', label: 'MySQL' },
    prod: true,
    query: 'UPDATE orders SET status = ? WHERE id = ?',
    queryClass: 'write',
    tables: ['orders'],
    rowEstimate: 37,
    hasAutoReadReason: true,
  });
});

test('автоподтверждённое чтение проходит через внутреннее решение общей очереди', async () => {
  const state = await fixture({ autoRead: true, autoReadProd: true });
  const result = await state.broker.invoke({ projectId: 'project-a' }, request());

  assert.deepEqual({
    ok: result?.ok,
    executions: state.executions(),
    humanWaiting: state.permissionQueue.waiting().length,
    waitingEvents: state.queueEvents.filter((event) => event.type === 'waiting').length,
    dbDecisions: state.queueEvents.filter((event) => (
      event.type === 'done' && event.origin === 'db'
    )).length,
    audit: state.audit.length,
  }, {
    ok: true,
    executions: 1,
    humanWaiting: 0,
    waitingEvents: 0,
    dbDecisions: 1,
    audit: 1,
  });
});

test('агентский запрос публикуется в живую ленту от проверки до результата', async () => {
  const state = await fixture({ autoRead: true, autoReadProd: true });
  await state.broker.invoke({ projectId: 'project-a' }, request());
  const states = state.queryEvents.map((event) => event.state)
    .filter((value, index, all) => value !== all[index - 1]);
  const last = state.queryEvents.at(-1);

  assert.deepEqual({
    states,
    actor: last?.actor,
    text: last?.text,
    queryClass: last?.queryClass,
    resultOk: last?.result?.ok,
  }, {
    states: ['checking', 'running', 'done'],
    actor: 'agent',
    text: 'SELECT id FROM orders',
    queryClass: 'read',
    resultOk: true,
  });
});

test('отмена через разрыв соединения закрывает сессию, а не оставляет её мнимо живой', async () => {
  const { cancelDbQuery } = await import('../../server/src/lib/db/broker.ts');
  assert.equal(typeof cancelDbQuery, 'function', 'политика отмены запроса не вынесена в broker');
  const closed = [];
  const outcome = await cancelDbQuery({
    query: { id: 'query-a', state: 'running', text: 'UPDATE orders SET status = 1' },
    session: {
      id: 'session-a',
      handle: {},
      engine: {
        async cancel() {
          return { ok: true, method: 'connection' };
        },
      },
    },
    sessions: {
      async close(id, reason) {
        closed.push([id, reason]);
      },
    },
  });

  assert.deepEqual({ closed, outcome }, {
    closed: [['session-a', 'connection_reset']],
    outcome: { ok: true, method: 'connection' },
  });
});

test('неотменяемая команда остаётся выполняющейся и не выдаётся за отменённую', async () => {
  const { cancelDbQuery } = await import('../../server/src/lib/db/broker.ts');
  const closed = [];
  const outcome = await cancelDbQuery({
    query: { id: 'query-b', state: 'running', text: 'GET order:1' },
    session: {
      id: 'session-b',
      handle: {},
      engine: {
        async cancel() {
          return { ok: false, method: 'wait' };
        },
      },
    },
    sessions: {
      async close(id, reason) {
        closed.push([id, reason]);
      },
    },
  });

  assert.deepEqual({ closed, outcome }, {
    closed: [],
    outcome: { ok: false, error: 'cancel_not_supported' },
  });
});

test('движку отмены достаётся текст запроса: без него Redis не отличит скрипт от команды', async () => {
  const { cancelDbQuery } = await import('../../server/src/lib/db/broker.ts');
  const seen = [];
  await cancelDbQuery({
    query: { id: 'query-c', state: 'running', text: 'EVAL "return 1" 0' },
    session: {
      id: 'session-c',
      handle: {},
      engine: {
        async cancel(_handle, run) {
          seen.push(run);
          return { ok: true, method: 'query' };
        },
      },
    },
    sessions: { async close() {} },
  });

  assert.deepEqual(seen, [{
    id: 'query-c',
    queryId: 'query-c',
    text: 'EVAL "return 1" 0',
    command: '',
  }]);
});

test('запрос с табличной функцией не доводится до EXPLAIN раньше решения человека', async () => {
  const state = await fixture({
    autoRead: true,
    analysis: {
      queryClass: 'read', single: true, tables: [], forbidden: [], tableFunctions: ['url'],
    },
  });
  const running = state.broker.invoke({ projectId: 'project-a' }, request({
    text: "SELECT * FROM url('http://169.254.169.254/latest/meta-data', JSONEachRow)",
  }));
  let pending = null;
  while (!pending) {
    pending = state.permissionQueue.waiting().find((entry) => entry.origin === 'db');
    if (!pending) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const shown = pending.presentation || pending;
  await state.permissionQueue.answer(pending.pid, 'db', { allow: false });
  const result = await running;

  assert.deepEqual({
    estimates: state.estimates(),
    executions: state.executions(),
    denied: result.ok === false,
    tableFunctions: shown.tableFunctions,
  }, {
    estimates: 0,
    executions: 0,
    denied: true,
    tableFunctions: ['url'],
  });
});

test('при выключенном авто-чтении недоверенный текст не исполняется ради оценки', async () => {
  const state = await fixture({ autoRead: false });
  const running = state.broker.invoke({ projectId: 'project-a' }, request());
  let pending = null;
  while (!pending) {
    pending = state.permissionQueue.waiting().find((entry) => entry.origin === 'db');
    if (!pending) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await state.permissionQueue.answer(pending.pid, 'db', { allow: false });
  await running;

  assert.deepEqual({
    estimates: state.estimates(),
    rightsChecks: state.rightsChecks(),
  }, {
    estimates: 0,
    rightsChecks: 0,
  });
});

test('упавший разбор движка даёт отказ с журналом, а не исключение мимо рубежа', async () => {
  const state = await fixture({ analyzeThrows: true });
  const result = await state.broker.invoke({ projectId: 'project-a' }, request());

  assert.deepEqual(denialSnapshot(state, result), {
    denied: true,
    executions: 0,
    humanWaiting: 0,
    waitingEvents: 0,
    dbDecisions: 1,
    audit: 1,
  });
});

test('запрос сверх предела длины отклоняется до живой записи и журнала целиком', async () => {
  const state = await fixture();
  const result = await state.broker.invoke({ projectId: 'project-a' }, request({
    text: `SELECT '${'A'.repeat(21_000)}'`,
  }));

  assert.deepEqual({
    denied: result.ok === false,
    error: result.error,
    auditQueryLength: state.audit[0]?.query?.length,
    executions: state.executions(),
  }, {
    denied: true,
    error: 'query_too_long',
    auditQueryLength: 201,
    executions: 0,
  });
});
