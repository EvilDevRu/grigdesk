import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
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
