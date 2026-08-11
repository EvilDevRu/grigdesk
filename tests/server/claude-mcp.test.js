import assert from 'node:assert/strict';
import test from 'node:test';

import {
  claudeAiConnectors,
  classifyMcpScope,
  composeMcpServers,
  parseClaudeMcpList,
} from '../../server/src/lib/executors/claude.js';

// Синтетический, но форматно точный вывод `claude mcp list`.
const SYNTHETIC_OUTPUT = [
  'Checking MCP server health…',
  '',
  'claude.ai Example Drive: https://example.invalid/mcp - ✔ Connected',
  'issue-tracker: docker run -i --rm --env-file /home/u/app/.env -v data:/data example-mcp'
    + ' - ✘ Failed to connect — -32000: MCP error -32000: Connection closed',
  'browser: node /home/u/mcp/cli.js --isolated --output-dir /tmp/browser-mcp-output - ✔ Connected',
].join('\n');

test('разбор `claude mcp list`: имя, цель и состояние каждого сервера', () => {
  const servers = parseClaudeMcpList(SYNTHETIC_OUTPUT);

  assert.equal(servers.length, 3);
  assert.deepEqual(servers.map((s) => s.name), ['claude.ai Example Drive', 'issue-tracker', 'browser']);
  assert.deepEqual(servers.map((s) => s.state), ['ok', 'failed', 'ok']);
  assert.equal(servers[0].target, 'https://example.invalid/mcp');
  // Причина отказа доезжает до человека целиком: по ней сервер и чинят.
  assert.match(servers[1].detail, /Connection closed/);
  // Иконку в текст не тащим — состояние уже разобрано в state.
  assert.doesNotMatch(servers[1].detail, /[✔✘]/u);
});

test('команда запуска с дефисами не принимается за статус', () => {
  const [server] = parseClaudeMcpList(
    'issue-tracker: docker run -i --rm --env-file /x/.env -v data:/data example-mcp - ✘ Failed to connect',
  );

  // Разрежь строку по последнему « - » — и половина команды уехала бы в статус.
  assert.equal(server.target, 'docker run -i --rm --env-file /x/.env -v data:/data example-mcp');
  assert.equal(server.state, 'failed');
});

test('незнакомый статус не выдаётся за рабочий сервер', () => {
  const [server] = parseClaudeMcpList('foo: node cli.js - ⚠ Reconnecting in 5s');
  assert.equal(server.state, 'unknown');
  assert.equal(server.detail, 'Reconnecting in 5s');

  // Строки без маркера статуса — не серверы: посторонний вывод CLI в список не попадает.
  assert.deepEqual(parseClaudeMcpList(''), []);
  assert.deepEqual(parseClaudeMcpList('Checking MCP server health…'), []);
  assert.deepEqual(parseClaudeMcpList('какой-то посторонний вывод без двоеточия'), []);
  assert.deepEqual(parseClaudeMcpList('bar: node cli.js - перезапускается'), []);
});

test('нужна авторизация — отдельное состояние, а не отказ', () => {
  const [server] = parseClaudeMcpList('gdrive: https://example/mcp - ⚠ Needs authentication');
  assert.equal(server.state, 'needs-auth');
});

test('коннектор без авторизации печатается как Connected — верить этому нельзя', () => {
  // `mcp list` может показать «✔ Connected», хотя тот же CLI держит коннектор
  // в mcp-needs-auth-cache и агенту инструменты не отдаёт.
  const [server] = parseClaudeMcpList('claude.ai Example Drive: https://x/mcp - ✔ Connected');
  assert.equal(server.state, 'ok');
  assert.equal(server.detail, 'Connected');
});

test('коннекторы claude.ai берутся из конфига: в `mcp list` их нет вовсе', () => {
  // Команда печатает только локальные MCP, а аккаунтные коннекторы берутся из конфига.
  // Без этого списка секция «claude.ai» в панели была бы пустой всегда.
  const config = {
    claudeAiMcpEverConnected: ['claude.ai Example Design', 'claude.ai Example Drive', 'claude.ai Example Design', '  '],
  };
  const connectors = claudeAiConnectors(config, ['claude.ai Example Drive']);

  assert.deepEqual(connectors.map((s) => s.name), ['claude.ai Example Design', 'claude.ai Example Drive']);
  assert.deepEqual(connectors.map((s) => s.scope), ['account', 'account']);
  // Живость аккаунтного коннектора локально не проверить — «подключён» тут было бы враньём,
  // а «состояние неизвестно» жёлтым — ложной тревогой над рабочим коннектором.
  assert.deepEqual(connectors.map((s) => s.state), ['remote', 'needs-auth']);
  assert.deepEqual(claudeAiConnectors(null), []);
  assert.deepEqual(claudeAiConnectors({ claudeAiMcpEverConnected: 'не массив' }), []);
});

test('итоговый список: кэш авторизации перебивает Connected, дублей нет', () => {
  const servers = composeMcpServers({
    servers: parseClaudeMcpList(SYNTHETIC_OUTPUT),
    userServers: ['issue-tracker', 'browser'],
    needsAuthNames: ['claude.ai Example Drive'],
    userConfig: {
      claudeAiMcpEverConnected: ['claude.ai Example Drive', 'claude.ai Example Design'],
    },
  });

  // Один коннектор пришёл и из списка CLI, и из конфига — в панели он один раз.
  assert.deepEqual(servers.map((s) => s.name),
    ['claude.ai Example Drive', 'issue-tracker', 'browser', 'claude.ai Example Design']);
  assert.deepEqual(servers.map((s) => s.state), ['needs-auth', 'failed', 'ok', 'remote']);
  // «Connected» под подписью «Нужна авторизация» — противоречие на экране.
  assert.equal(servers[0].detail, 'Needs authentication');
  assert.deepEqual(servers.map((s) => s.scope), ['account', 'user', 'user', 'account']);
});

test('упавший сервер не подменяется «нужна авторизация»', () => {
  const [server] = composeMcpServers({
    servers: parseClaudeMcpList('issue-tracker: docker run - ✘ Failed to connect — Connection closed'),
    userServers: ['issue-tracker'],
    needsAuthNames: ['issue-tracker'],
  });

  // Вход тут ничего не чинит: процесс не поднялся, и починка совсем другая.
  assert.equal(server.state, 'failed');
  assert.match(server.detail, /Connection closed/);
});

test('scope: аккаунтный коннектор — тот, определения которого нет в файлах', () => {
  const known = { userServers: ['issue-tracker', 'browser'], projectServers: ['docs'] };

  assert.equal(classifyMcpScope('issue-tracker', known), 'user');
  assert.equal(classifyMcpScope('docs', known), 'project');
  // Определения коннекторов claude.ai локально нет — только имя в списке «когда-то подключался».
  assert.equal(classifyMcpScope('claude.ai Example Drive', known), 'account');
  assert.equal(classifyMcpScope('что угодно'), 'account');
});
