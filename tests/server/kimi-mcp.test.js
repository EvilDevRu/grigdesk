import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import kimi, { composeKimiMcpServers } from '../../server/src/lib/executors/kimi.js';

test('Kimi объединяет user/project MCP, проект перекрывает имя и секреты не выходят', () => {
  const servers = composeKimiMcpServers({
    userConfig: {
      mcpServers: {
        figma: {
          url: 'https://user:password@user.test/mcp?token=query-secret',
          headers: { Authorization: 'header-secret' },
        },
        local: {
          command: 'npx',
          args: ['local-mcp', '--api-key', 'arg-secret'],
          env: { API_KEY: 'env-secret' },
        },
      },
    },
    projectConfigs: [{
      mcpServers: {
        figma: { url: 'https://project.test/mcp' },
        docs: { command: 'node', args: ['docs.js'], enabled: false },
      },
    }],
  });

  assert.deepEqual(servers.map((server) => [server.name, server.scope, server.state]), [
    ['local', 'user', 'configured'],
    ['docs', 'project', 'disabled'],
    ['figma', 'project', 'configured'],
  ]);
  assert.equal(servers.find((server) => server.name === 'figma').target,
    'https://project.test/mcp');
  assert.equal(servers.find((server) => server.name === 'local').target,
    'npx local-mcp --api-key •••');

  const publicJson = JSON.stringify(servers);
  for (const secret of [
    'password', 'query-secret', 'header-secret', 'arg-secret', 'env-secret',
  ]) {
    assert.equal(publicJson.includes(secret), false, `утёк секрет: ${secret}`);
  }
});

test('Kimi malformed entry остаётся видимой как unknown, внутренний MCP скрыт', () => {
  const servers = composeKimiMcpServers({
    userConfig: {
      mcpServers: {
        broken: 'not-an-object',
        targetless: { enabled: true },
        'cockpit-work': { command: 'node', args: ['internal.js'] },
      },
    },
  });

  assert.deepEqual(servers.map((server) => server.name), ['broken', 'targetless']);
  assert.ok(servers.every((server) => server.state === 'unknown'));
  assert.deepEqual(composeKimiMcpServers(), []);
});

test('Kimi mcpStatus читает штатные слои mcp.json и применяет их приоритет', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-kimi-mcp-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, '.kimi-code'));
  await fs.mkdir(home);

  await fs.writeFile(path.join(home, 'mcp.json'), JSON.stringify({
    mcpServers: {
      shared: { url: 'https://user.test/mcp' },
      userOnly: { command: 'node', args: ['user.js'] },
    },
  }));
  await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({
    mcpServers: {
      shared: { url: 'https://legacy-project.test/mcp' },
      legacyOnly: { command: 'node', args: ['legacy.js'] },
    },
  }));
  await fs.writeFile(path.join(root, '.kimi-code', 'mcp.json'), JSON.stringify({
    mcpServers: {
      shared: { url: 'https://local-project.test/mcp' },
      localOnly: { url: 'https://local-only.test/mcp', enabled: false },
    },
  }));

  const result = await kimi.mcpStatus({
    kimiLaunchMode: 'host',
    kimiHome: home,
    rootDir: root,
  });

  assert.equal(result.state, 'ok');
  assert.match(result.note, /живость Kimi проверяет/);
  assert.deepEqual(result.servers.map((server) => server.name), [
    'userOnly', 'legacyOnly', 'localOnly', 'shared',
  ]);
  const shared = result.servers.find((server) => server.name === 'shared');
  assert.equal(shared.scope, 'project');
  assert.equal(shared.target, 'https://local-project.test/mcp');
  assert.equal(result.servers.find((server) => server.name === 'localOnly').state, 'disabled');
});

test('Kimi contained не обещает host MCP, битый JSON host-профиля виден ошибкой', async (t) => {
  const contained = await kimi.mcpStatus({
    kimiLaunchMode: 'contained',
    kimiHome: '/host/kimi',
    rootDir: '/workspace',
  }, {
    readFile: async () => { throw new Error('contained не должен читать host config'); },
  });
  assert.equal(contained.state, 'ok');
  assert.deepEqual(contained.servers, []);
  assert.match(contained.note, /изолирует/);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-kimi-mcp-bad-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, 'mcp.json'), '{broken');
  const broken = await kimi.mcpStatus({
    kimiLaunchMode: 'host',
    kimiHome: home,
    rootDir: root,
  });
  assert.equal(broken.state, 'error');
  assert.match(broken.error, /некорректный JSON или схему/);
});
