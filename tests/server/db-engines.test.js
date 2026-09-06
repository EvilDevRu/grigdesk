import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

async function engine(name) {
  try {
    return (await import(`../../server/src/lib/db/engines/${name}.js`)).default;
  } catch (error) {
    assert.fail(`движок ${name} ещё не реализован: ${error.message}`);
  }
}

test('MySQL определяет фактическое право записи по SHOW GRANTS', async () => {
  const mysql = await engine('mysql');
  const calls = [];
  const rights = await mysql.inspectRights({
    async query(text) {
      calls.push(text);
      return [[{ Grants: 'GRANT SELECT, UPDATE ON orders.* TO reader' }]];
    },
  });

  assert.deepEqual({ calls, rights }, {
    calls: ['SHOW GRANTS'],
    rights: { confirmedReadOnly: false, writable: true },
  });
});

test('MySQL отмечает опасные читающие конструкции до автоподтверждения', async () => {
  const mysql = await engine('mysql');
  const analysis = await mysql.analyze(
    "SELECT LOAD_FILE('/etc/passwd') FROM orders FOR UPDATE",
  );

  assert.deepEqual({
    queryClass: analysis.queryClass,
    tables: analysis.tables,
    forbidden: analysis.forbidden,
  }, {
    queryClass: 'read',
    tables: ['orders'],
    forbidden: ['LOAD_FILE', 'FOR UPDATE'],
  });
});

test('ClickHouse объявляет табличные функции внешнего доступа', async () => {
  const clickhouse = await engine('clickhouse');
  const analysis = await clickhouse.analyze(
    "SELECT * FROM s3('https://bucket.example/data.csv')",
  );

  assert.deepEqual({
    queryClass: analysis.queryClass,
    tableFunctions: analysis.tableFunctions,
  }, {
    queryClass: 'read',
    tableFunctions: ['s3'],
  });
});

test('ClickHouse проводит HTTP только через выданный SSH-канал', async (t) => {
  const clickhouse = await engine('clickhouse');
  const stream = new PassThrough();
  let config;
  const handle = await clickhouse.open({
    profile: { host: 'db.internal', port: 8123, user: 'reader', role: 'read' },
    password: Buffer.from('secret'),
    stream,
    clientFactory(input) {
      config = input;
      return { close: async () => {} };
    },
  });
  t.after(() => stream.destroy());
  let connected;
  const returned = config.http_agent.createConnection({}, (error, socket) => {
    connected = { error, socket };
  });
  let secondError;
  config.http_agent.createConnection({}, (error) => {
    secondError = error;
  });

  assert.deepEqual({
    maxConnections: config.max_open_connections,
    sameReturnedStream: returned === stream,
    sameCallbackStream: connected.socket === stream,
    firstError: connected.error,
    secondError: secondError?.code,
  }, {
    maxConnections: 1,
    sameReturnedStream: true,
    sameCallbackStream: true,
    firstError: null,
    secondError: 'ssh_channel_exhausted',
  });
  await handle.close();
});

test('MySQL берёт оценку строк и байтов из EXPLAIN, а не из лимитов', async () => {
  const mysql = await engine('mysql');
  const analysis = await mysql.analyze('UPDATE orders SET status = ? WHERE account_id = ?');
  const estimate = await mysql.estimate({
    async execute(text, params) {
      assert.match(text, /^EXPLAIN FORMAT=JSON UPDATE/u);
      assert.deepEqual(params, ['paid', 7]);
      return [[{
        EXPLAIN: JSON.stringify({
          query_block: {
            table: {
              rows_examined_per_scan: 37,
              cost_info: { data_read_per_join: '12K' },
            },
          },
        }),
      }]];
    },
  }, { ...analysis, params: ['paid', 7] }, {
    maxRows: 1000,
    maxBytes: 256 * 1024,
    timeoutMs: 15_000,
  });

  assert.deepEqual(estimate, { rows: 37, bytes: 12 * 1024, timeoutMs: 15_000 });
});

test('ClickHouse суммирует оценки EXPLAIN ESTIMATE', async () => {
  const clickhouse = await engine('clickhouse');
  const analysis = await clickhouse.analyze('SELECT id FROM orders');
  const estimate = await clickhouse.estimate({
    async query(input) {
      assert.equal(input.query, 'EXPLAIN ESTIMATE SELECT id FROM orders');
      return { json: async () => [{ rows: 20, bytes: 1100 }, { rows: 17, bytes: 900 }] };
    },
  }, analysis, { maxBytes: 256 * 1024, timeoutMs: 15_000 });

  assert.deepEqual(estimate, { rows: 37, bytes: 2000, timeoutMs: 15_000 });
});

test('Redis получает класс команды из COMMAND INFO а не локального списка', async () => {
  const redis = await engine('redis');
  const calls = [];
  const analysis = await redis.analyze('SET order:1 paid', {
    async commandInfo(command) {
      calls.push(command);
      return { name: 'set', flags: ['write'] };
    },
  });

  assert.deepEqual({ calls, queryClass: analysis.queryClass }, {
    calls: ['SET'],
    queryClass: 'write',
  });
});

test('Redis отклоняет неизвестную серверу команду', async () => {
  const redis = await engine('redis');
  const analysis = await redis.analyze('UNKNOWN-COMMAND value', {
    async call() {
      return [null];
    },
  });

  assert.equal(analysis.queryClass, 'unknown');
});

test('Redis оценивает GET по фактической длине значения', async () => {
  const redis = await engine('redis');
  const analysis = await redis.analyze('GET order:1', {
    async commandInfo() {
      return { flags: ['readonly'], firstKey: 1, lastKey: 1, step: 1 };
    },
  });
  const calls = [];
  const estimate = await redis.estimate({
    async call(...args) {
      calls.push(args);
      return 42;
    },
  }, analysis, { timeoutMs: 1000, maxRows: 1000, maxBytes: 4096 });

  assert.deepEqual({ calls, estimate }, {
    calls: [['STRLEN', 'order:1']],
    estimate: { rows: 1, bytes: 58, timeoutMs: 1000 },
  });
});

test('Redis получает фактические права пользователя из ACL GETUSER', async () => {
  const redis = await engine('redis');
  const calls = [];
  const rights = await redis.inspectRights({
    async call(...args) {
      calls.push(args);
      return ['flags', ['on'], 'commands', '+@read +set'];
    },
  }, { user: 'reader' });

  assert.deepEqual({ calls, rights }, {
    calls: [['ACL', 'GETUSER', 'reader']],
    rights: { confirmedReadOnly: false, writable: true },
  });
});

test('MySQL снимает запрос настоящим KILL QUERY и не трогает рабочее соединение', async () => {
  const mysql = await engine('mysql');
  const control = [];
  let destroyed = false;
  const outcome = await mysql.cancel({
    threadId: 77,
    connection: {
      threadId: 77,
      destroy() {
        destroyed = true;
      },
    },
    control: {
      async query(text) {
        control.push(text);
        return [[]];
      },
    },
  }, { id: 'run-a' });

  assert.deepEqual({ control, destroyed, outcome }, {
    control: ['KILL QUERY 77'],
    destroyed: false,
    outcome: { ok: true, method: 'query' },
  });
});

test('MySQL без служебного соединения объявляет разрыв, а не тихую отмену', async () => {
  const mysql = await engine('mysql');
  let destroyed = false;
  const outcome = await mysql.cancel({
    threadId: 9,
    connection: {
      threadId: 9,
      destroy() {
        destroyed = true;
      },
    },
  }, { id: 'run-a' });

  assert.deepEqual({ destroyed, outcome }, {
    destroyed: true,
    outcome: { ok: true, method: 'connection' },
  });
});

test('MySQL открывает служебное соединение вторым каналом туннеля', async () => {
  const mysql = await engine('mysql');
  const worker = new PassThrough();
  const service = new PassThrough();
  const streams = [];
  const driver = {
    async createConnection(options) {
      streams.push(options.stream);
      return {
        threadId: 5,
        async query() {
          return [[]];
        },
        async end() {},
        destroy() {},
      };
    },
  };
  const handle = await mysql.open({
    profile: { host: 'db.internal', port: 3306, user: 'reader', role: 'read' },
    password: Buffer.from('secret'),
    stream: worker,
    openStream: async () => service,
    driver,
  });

  assert.deepEqual({
    channels: streams.map((value) => (value === worker ? 'рабочий' : 'служебный')),
    hasControl: Boolean(handle.control),
    readOnlyActive: handle.readOnlyActive,
  }, {
    channels: ['рабочий', 'служебный'],
    hasControl: true,
    readOnlyActive: true,
  });
});

test('MySQL снимает затянувшийся пишущий запрос сторожем: MAX_EXECUTION_TIME его не держит', async () => {
  const mysql = await engine('mysql');
  const control = [];
  const failure = await mysql.execute({
    threadId: 21,
    connection: {
      threadId: 21,
      execute() {
        return new Promise(() => {});
      },
      destroy() {},
    },
    control: {
      async query(text) {
        control.push(text);
        return [[]];
      },
    },
  }, {
    text: 'UPDATE orders SET status = 1',
    limits: { timeoutMs: 20 },
  }).then(() => null, (error) => error);
  await new Promise((resolve) => {
    setTimeout(resolve, 10);
  });

  assert.deepEqual({ code: failure?.code, control }, {
    code: 'query_timeout',
    control: ['KILL QUERY 21'],
  });
});

test('ClickHouse шлёт KILL QUERY служебным клиентом, а не каналом занятого запроса', async () => {
  const clickhouse = await engine('clickhouse');
  const worker = [];
  const service = [];
  const outcome = await clickhouse.cancel({
    client: {
      async command(request) {
        worker.push(request.query);
      },
    },
    control: {
      async command(request) {
        service.push(String(request.query_params?.query_id || ''));
      },
    },
  }, { queryId: 'query-77' });

  assert.deepEqual({ worker, service, outcome }, {
    worker: [],
    service: ['query-77'],
    outcome: { ok: true, method: 'query' },
  });
});

test('Redis не рвёт соединение ради отмены атомарной команды', async () => {
  const redis = await engine('redis');
  let disconnected = false;
  const outcome = await redis.cancel({
    client: {
      disconnect() {
        disconnected = true;
      },
    },
  }, { text: 'GET order:1' });

  assert.deepEqual({ disconnected, outcome }, {
    disconnected: false,
    outcome: { ok: false, method: 'wait' },
  });
});

test('Redis снимает затянувшийся скрипт через SCRIPT KILL служебным соединением', async () => {
  const redis = await engine('redis');
  const calls = [];
  let disconnected = false;
  const outcome = await redis.cancel({
    client: {
      disconnect() {
        disconnected = true;
      },
    },
    control: {
      async call(...args) {
        calls.push(args);
      },
    },
  }, { text: 'EVAL "return 1" 0' });

  assert.deepEqual({ calls, disconnected, outcome }, {
    calls: [['SCRIPT', 'KILL']],
    disconnected: false,
    outcome: { ok: true, method: 'query' },
  });
});
