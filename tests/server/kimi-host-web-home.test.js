import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildKimiHostWebHome } from '../../server/src/lib/kimi/hostWebHome.ts';

test('Kimi host web сохраняет сессии и конфигурацию, служебный MCP изолирован на запуск', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-kimi-web-home-'));
  const kimiHome = path.join(root, 'user-home');
  const runtimeHome = path.join(root, 'runtime');
  const sessions = path.join(kimiHome, 'sessions');

  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(kimiHome, 'config.toml'), 'default_model = "k3"\n');
  await writeFile(path.join(kimiHome, 'mcp.json'), JSON.stringify({
    mcpServers: { 'user-tool': { command: '/bin/true' } },
  }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const overlay = await buildKimiHostWebHome({
    kimiHome,
    runtimeHome,
    mcpServers: [{
      name: 'grigdesk-work',
      command: '/bin/node',
      args: ['work.mjs'],
    }],
  });
  const merged = JSON.parse(await readFile(path.join(overlay.home, 'mcp.json'), 'utf8'));

  assert.equal(await readlink(path.join(overlay.home, 'sessions')), sessions);
  assert.equal(await readlink(path.join(overlay.home, 'config.toml')), path.join(kimiHome, 'config.toml'));
  assert.deepEqual(Object.keys(merged.mcpServers).sort(), ['grigdesk-work', 'user-tool']);
  assert.deepEqual(JSON.parse(await readFile(path.join(kimiHome, 'mcp.json'), 'utf8')), {
    mcpServers: { 'user-tool': { command: '/bin/true' } },
  });

  await overlay.cleanup();
  assert.equal(await readFile(path.join(kimiHome, 'config.toml'), 'utf8'), 'default_model = "k3"\n');
});

for (const scenario of [
  {
    name: 'пустой ACP env исключается из записи',
    env: [],
    expected: {},
  },
  {
    name: 'ACP env преобразуется в объект',
    env: [{ name: 'A', value: '1' }],
    expected: { env: { A: '1' } },
  },
  {
    name: 'env объектом сохраняется',
    env: { A: '1' },
    expected: { env: { A: '1' } },
  },
  {
    name: 'пустой env объектом сохраняется',
    env: {},
    expected: { env: {} },
  },
]) {
  test(`Kimi host web: ${scenario.name}`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kimi-web-mcp-env-'));
    const kimiHome = path.join(root, 'user');
    const userServers = { 'user-tool': { command: '/bin/true', env: { USER_VALUE: 'saved' } } };

    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(kimiHome);
    await writeFile(path.join(kimiHome, 'mcp.json'), JSON.stringify({ mcpServers: userServers }));

    const overlay = await buildKimiHostWebHome({
      kimiHome,
      runtimeHome: path.join(root, 'runtime'),
      mcpServers: [{
        name: 'grigdesk-work',
        command: '/bin/true',
        env: scenario.env,
      }],
    });
    const merged = JSON.parse(await readFile(path.join(overlay.home, 'mcp.json'), 'utf8'));

    assert.deepEqual(merged.mcpServers['grigdesk-work'], {
      command: '/bin/true',
      args: [],
      ...scenario.expected,
    });
    assert.deepEqual(merged.mcpServers['user-tool'], userServers['user-tool']);
    assert.deepEqual(JSON.parse(await readFile(path.join(kimiHome, 'mcp.json'), 'utf8')), {
      mcpServers: userServers,
    });
  });
}

test('контролируемый host получает собственный config и сохраняет пользовательские сессии', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kimi-command-overlay-'));
  const kimiHome = path.join(root, 'user');
  const source = 'telemetry = false\n';

  await mkdir(path.join(kimiHome, 'sessions'), { recursive: true });
  await writeFile(path.join(kimiHome, 'config.toml'), source);
  t.after(() => rm(root, { recursive: true, force: true }));

  const overlay = await buildKimiHostWebHome({
    kimiHome,
    runtimeHome: path.join(root, 'runtime'),
    mcpServers: [],
    controlledCommands: true,
  });

  t.after(() => overlay.cleanup());
  assert.equal((await lstat(path.join(overlay.home, 'config.toml'))).isSymbolicLink(), false);
  assert.equal(overlay.commandProfile.commandsAllowed, true);
  assert.match(await readFile(path.join(overlay.home, 'config.toml'), 'utf8'), /Bash/);
  assert.equal(await readFile(path.join(kimiHome, 'config.toml'), 'utf8'), source);
  assert.equal(await readlink(path.join(overlay.home, 'sessions')), path.join(kimiHome, 'sessions'));
});

test('первый home сохраняет новую сессию после удаления overlay', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kimi-first-sessions-'));
  const kimiHome = path.join(root, 'user');

  await mkdir(kimiHome);
  t.after(() => rm(root, { recursive: true, force: true }));

  const overlay = await buildKimiHostWebHome({
    kimiHome,
    runtimeHome: path.join(root, 'runtime'),
    mcpServers: [],
    controlledCommands: true,
  });

  await writeFile(path.join(overlay.home, 'sessions', 'synthetic-session'), 'saved');
  await overlay.cleanup();
  assert.equal(await readFile(path.join(kimiHome, 'sessions', 'synthetic-session'), 'utf8'), 'saved');
});
