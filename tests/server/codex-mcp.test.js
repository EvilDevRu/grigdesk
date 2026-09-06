import assert from 'node:assert/strict';
import test from 'node:test';

import codex, {
  composeCodexMcpServers,
  parseCodexMcpInventory,
} from '../../server/src/lib/executors/codex.js';

test('Codex inventory не выдаёт конфигурацию за живое подключение и скрывает секреты', () => {
  const servers = parseCodexMcpInventory([
    {
      name: 'stdio-tools',
      enabled: true,
      auth_status: 'unknown',
      transport: {
        type: 'stdio',
        command: 'npx',
        args: ['server', '--api-key', 'secret-in-args'],
        env: { API_KEY: 'secret-in-env' },
      },
    },
    {
      name: 'remote-tools',
      enabled: true,
      auth_status: 'notLoggedIn',
      transport: {
        type: 'streamable_http',
        url: 'https://user:password@example.test/mcp?token=secret-in-query#private',
        http_headers: { Authorization: 'secret-in-header' },
      },
    },
    {
      name: 'off',
      enabled: false,
      disabled_reason: 'выключен профилем',
      transport: { type: 'stdio', command: 'node', args: ['off.js'] },
    },
  ]);

  assert.deepEqual(servers.map((server) => server.state), [
    'configured', 'needs-auth', 'disabled',
  ]);
  assert.equal(servers[0].target, 'npx server --api-key •••');
  assert.equal(servers[1].target, 'https://example.test/mcp');
  assert.match(servers[1].hint, /codex mcp login remote-tools/);
  assert.match(servers[2].detail, /профилем/);

  const publicJson = JSON.stringify(servers);
  for (const secret of [
    'secret-in-args', 'secret-in-env', 'password', 'secret-in-query', 'secret-in-header',
  ]) {
    assert.equal(publicJson.includes(secret), false, `утёк секрет: ${secret}`);
  }
});

test('Codex live MCP-состояния маппятся без таблиц tools/resources', () => {
  const runtimeStatuses = [
    ['connected', 'unknown', 'ok'],
    ['authenticationRequired', 'unknown', 'needs-auth'],
    ['failed', 'unknown', 'failed'],
    ['cancelled', 'unknown', 'failed'],
    ['disabled', 'unknown', 'disabled'],
    ['starting', 'unknown', 'unknown'],
    ['notStarted', 'unknown', 'configured'],
    [null, 'notLoggedIn', 'needs-auth'],
    ['futureState', 'unknown', 'unknown'],
  ];
  const data = runtimeStatuses.map(([runtimeStatus, authStatus], index) => ({
    name: `server-${index}`,
    runtimeStatus,
    authStatus,
    tools: { secretTool: { description: 'не отдавать наружу' } },
    resources: [{ uri: 'private://resource' }],
  }));
  const servers = composeCodexMcpServers({ data });

  assert.deepEqual(
    servers.map((server) => server.state),
    runtimeStatuses.map(([, , state]) => state),
  );
  assert.ok(servers.every((server) => server.scope === 'user'));
  assert.equal(JSON.stringify(servers).includes('secretTool'), false);
  assert.equal(JSON.stringify(servers).includes('private://resource'), false);
  assert.deepEqual(composeCodexMcpServers(null), []);
  assert.deepEqual(composeCodexMcpServers({ data: {} }), []);
});

// Форма ответа снята с живого codex-cli 0.150.1: у разового `app-server` runtimeStatus
// приходит null ВСЕГДА (сервер он в этом процессе ещё не вёл) — судить по нему значит
// пересказывать конфиг. Рукопожатие видно по serverInfo и таблице инструментов: у
// заведомо битой команды они пустые, у поднявшегося заполнены.
test('разовый опрос без runtimeStatus: статус берётся из рукопожатия', () => {
  const servers = composeCodexMcpServers({
    data: [
      {
        name: 'figma',
        runtimeStatus: null,
        authStatus: 'oAuth',
        serverInfo: { name: 'Figma MCP Server', version: '0.6.0' },
        tools: { get_code: {}, get_image: {} },
      },
      { name: 'broken', runtimeStatus: null, authStatus: 'unsupported', serverInfo: null, tools: {} },
      { name: 'off', runtimeStatus: null, authStatus: 'unsupported', serverInfo: null, tools: {} },
      {
        name: 'codex_apps',
        runtimeStatus: null,
        authStatus: 'bearerToken',
        serverInfo: { name: 'plugin-runtime', version: '0.1.0' },
        tools: { some_tool: {} },
      },
    ],
  }, [
    { name: 'figma', target: '', scope: 'user', state: 'configured', detail: '' },
    { name: 'broken', target: '', scope: 'user', state: 'configured', detail: '' },
    { name: 'off', target: '', scope: 'user', state: 'disabled', detail: 'Выключен.' },
  ]);

  assert.deepEqual(
    servers.map((server) => [server.name, server.state]),
    [['figma', 'ok'], ['broken', 'failed'], ['off', 'disabled']],
    'внутренний runtime плагинов Codex в список настроенных серверов не попадает',
  );
  assert.equal(servers[0].detail, '', 'у подключённого сервера чинить нечего');
  assert.match(servers[1].detail, /ни имени, ни инструментов/);
  assert.equal(JSON.stringify(servers).includes('get_code'), false);
});

test('Codex mcpStatus объединяет app-server с inventory и имеет честный fallback', async () => {
  const calls = [];
  const inventoryServer = {
    name: 'figma', target: 'https://mcp.figma.test/mcp', scope: 'user',
    state: 'configured', detail: '',
  };
  const live = await codex.mcpStatus({ codexBin: '/opt/codex', rootDir: '/workspace' }, {
    request: async (...args) => {
      calls.push(args);
      return {
        result: {
          data: [{ name: 'figma', runtimeStatus: 'connected', authStatus: 'oAuth' }],
          nextCursor: null,
        },
      };
    },
    inventory: async () => ({ ok: true, servers: [inventoryServer] }),
  });

  assert.equal(live.state, 'ok');
  assert.equal(live.servers[0].state, 'ok');
  assert.equal(live.servers[0].target, inventoryServer.target);
  assert.deepEqual(calls[0][1], {
    method: 'mcpServerStatus/list',
    params: { detail: 'toolsAndAuthOnly', limit: 100 },
  });
  assert.deepEqual(calls[0][2], { timeoutMs: 60_000 });

  const fallback = await codex.mcpStatus({ codexBin: 'codex', rootDir: '/workspace' }, {
    request: async () => ({ error: { message: 'method not found' } }),
    inventory: async () => ({ ok: true, servers: [inventoryServer] }),
  });
  assert.equal(fallback.state, 'ok');
  assert.equal(fallback.servers[0].state, 'configured');
  assert.match(fallback.note, /Живая проверка Codex недоступна/);

  const failed = await codex.mcpStatus({ codexBin: 'codex', rootDir: '/workspace' }, {
    request: async () => ({ error: { message: 'app-server failed' } }),
    inventory: async () => ({ ok: false, error: 'inventory failed', servers: [] }),
  });
  assert.equal(failed.state, 'error');
  assert.match(failed.error, /app-server failed/);
});
