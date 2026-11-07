import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  glmMcpLossError,
  glmMcpServerNameAllowed,
  glmMcpStartupError,
  glmMcpStatus,
  selectGlmMcpServers,
} from '../../server/src/lib/glm/mcp.ts';
import { glmMcpToolName } from '../../server/src/lib/glm/policy.ts';

function server(name) {
  return {
    name,
    command: '/usr/bin/fixture-mcp',
    args: ['--token', 'synthetic-arg-secret'],
    env: [{ name: 'SECRET_TOKEN', value: 'synthetic-env-secret' }],
  };
}

test('сервер с __ в имени, с _ на краю или длиннее 32 символов исключается с предупреждением', () => {
  for (const name of ['a__b', '_edge', 'edge_', 'x'.repeat(33), 'a', '', 'a b', 'a+b']) {
    assert.equal(glmMcpServerNameAllowed(name), false, name);
  }

  for (const name of ['ab', 'grigdesk-work', 'a_b', 'a-b-c', 'x'.repeat(32)]) {
    assert.equal(glmMcpServerNameAllowed(name), true, name);
  }

  const selected = selectGlmMcpServers({
    chat: [server('grigdesk-work'), server('a__b')],
    project: [server('valid'), server('edge_')],
  });

  assert.deepEqual(selected.mounted.map((item) => item.name), ['grigdesk-work']);
  assert.deepEqual(selected.excluded, [
    { name: 'a__b', reason: 'name_invalid' },
    { name: 'valid', reason: 'project_unsupported' },
    { name: 'edge_', reason: 'name_invalid' },
  ]);
  assert.equal(selected.warnings.length, 3);
});

test('проектный сервер с именем grigdesk-work исключается', () => {
  const selected = selectGlmMcpServers({
    chat: [server('grigdesk-work')],
    project: [server('grigdesk-work')],
  });

  assert.equal(selected.mounted.length, 1);
  assert.equal(selected.mounted[0], selected.mounted.find((item) => item.name === 'grigdesk-work'));
  assert.deepEqual(selected.excluded, [{ name: 'grigdesk-work', reason: 'reserved' }]);
});

test('имя инструмента считается формулой DSH: нормализация, 64 символа, хвост sha256[:12]', () => {
  assert.equal(glmMcpToolName('grigdesk-work', 'repo_history'), 'mcp__grigdesk-work__repo_history');
  assert.equal(glmMcpToolName('a__b', 'c'), 'mcp__a__b__c');
  assert.equal(glmMcpToolName('long', 'x'.repeat(70)),
    `mcp__long__${'x'.repeat(40)}_3a94a9b9fe67`);

  const normalized = glmMcpToolName('srv', 'a.b');

  assert.match(normalized, /^mcp__srv__a_b_[a-f0-9]{12}$/u);
});

test('публичный статус MCP — configured и rootDir, без env, args и ключей', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-mcp-status-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: {
    secretive: {
      command: process.execPath,
      args: ['--token', 'synthetic-arg-secret'],
      env: { SECRET_TOKEN: 'synthetic-env-secret' },
    },
  } }));

  const status = await glmMcpStatus({ rootDir: root });
  const text = JSON.stringify(status);

  // Факт G2 (F13): проектные MCP не подключаются; статус называет их число, но не их данные.
  assert.equal(status.state, 'ok');
  assert.deepEqual(status.servers, []);
  assert.match(status.note, /1 проектн/u);
  assert.match(status.note, /grigdesk-work/u);

  for (const secret of ['synthetic-arg-secret', 'synthetic-env-secret', 'SECRET_TOKEN', 'secretive']) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test('отказ запуска и потеря grigdesk-work распознаются как glm_mcp_not_ready', () => {
  const startup = 'dsh: plugin tree failed to load: failed to apply loader entry grigdesk-mcp-grigdesk-work '
    + '(@deepseek-ai/dsh-mcp-client): mcp-client(grigdesk-work): '
    + 'initial connection or tool synchronization failed';

  assert.equal(glmMcpStartupError(startup)?.code, 'glm_mcp_not_ready');
  assert.equal(glmMcpStartupError('Таймаут запуска'), null);
  assert.equal(glmMcpLossError('mcp__grigdesk-work__echo', [{ type: 'text', text: 'Error: Not connected' }],
    true)?.code, 'glm_mcp_not_ready');
  assert.equal(
    glmMcpLossError('mcp__grigdesk-work__echo', [{ type: 'text', text: 'Error: bad input' }], true),
    null,
  );
  assert.equal(glmMcpLossError('read', [{ type: 'text', text: 'Error: Not connected' }], true), null);
});
