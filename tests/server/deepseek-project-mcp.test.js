import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';

import {
  mergeMcpServers,
  parseProjectMcpServers,
  readProjectMcpServers,
} from '../../server/src/lib/deepseek/projectMcp.ts';
import deepseek from '../../server/src/lib/executors/deepseek.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE_ACP = path.join(REPO_ROOT, 'tests/fixtures/deepseek-harness/fakeAcp.mts');

async function tempProject(t, { git = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-deepseek-mcp-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  if (git) await fs.mkdir(path.join(root, '.git'));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'motion-mcp'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'on-path'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { root, bin };
}

test('parseProjectMcpServers: stdio-записи с абсолютной и PATH-командой, env в форме ACP', async (t) => {
  const { root, bin } = await tempProject(t);
  const { servers, warnings } = await parseProjectMcpServers({
    mcpServers: {
      motion: { command: path.join(bin, 'motion-mcp'), args: ['--stdio'], env: { KIMODO_URL: 'http://127.0.0.1:1' } },
      viaPath: { command: 'on-path' },
    },
  }, { searchPath: bin });
  assert.deepEqual(warnings, []);
  assert.deepEqual(servers, [
    {
      name: 'motion',
      command: path.join(bin, 'motion-mcp'),
      args: ['--stdio'],
      env: [{ name: 'KIMODO_URL', value: 'http://127.0.0.1:1' }],
    },
    { name: 'viaPath', command: path.join(bin, 'on-path'), args: [], env: [] },
  ]);
  assert.equal(path.isAbsolute(root), true);
});

test('parseProjectMcpServers: плохие записи пропускаются с предупреждением, хорошие остаются', async (t) => {
  const { bin } = await tempProject(t);
  const { servers, warnings } = await parseProjectMcpServers({
    mcpServers: {
      good: { command: path.join(bin, 'motion-mcp') },
      http: { type: 'http', url: 'http://127.0.0.1:9/mcp' },
      missing: { command: 'no-such-binary-anywhere' },
      off: { command: path.join(bin, 'motion-mcp'), disabled: true },
      'cockpit-work': { command: path.join(bin, 'motion-mcp') },
      badArgs: { command: path.join(bin, 'motion-mcp'), args: [1] },
      badEnv: { command: path.join(bin, 'motion-mcp'), env: { 'A=B': 'x' } },
      noCommand: { args: [] },
    },
  }, { searchPath: bin });
  assert.deepEqual(servers.map((server) => server.name), ['good']);
  assert.equal(warnings.length, 6);
  assert.match(warnings.join('\n'), /http: DeepSeek V1 получает только stdio/);
  assert.match(warnings.join('\n'), /missing: исполняемый файл/);
  assert.match(warnings.join('\n'), /cockpit-work: имя пустое или зарезервировано/);
  assert.match(warnings.join('\n'), /badArgs: args/);
  assert.match(warnings.join('\n'), /badEnv: переменная A=B/);
  assert.match(warnings.join('\n'), /noCommand: нет command/);
});

test('readProjectMcpServers: файл ищется у корня репозитория, без .git — в самом cwd', async (t) => {
  const { root, bin } = await tempProject(t, { git: true });
  const nested = path.join(root, 'sub', 'dir');
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({
    mcpServers: { motion: { command: path.join(bin, 'motion-mcp') } },
  }));
  const read = await readProjectMcpServers(nested, { searchPath: bin });
  assert.equal(read.file, path.join(root, '.mcp.json'));
  assert.deepEqual(read.servers.map((server) => server.name), ['motion']);

  const { root: plain } = await tempProject(t);
  assert.deepEqual(await readProjectMcpServers(plain), { file: null, servers: [], warnings: [] });

  // Проект без .git внутри чужого репозитория: свой .mcp.json в cwd перекрывает корневой.
  await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({
    mcpServers: {
      motion: { command: path.join(bin, 'motion-mcp'), args: ['root'] },
      shared: { command: path.join(bin, 'on-path') },
    },
  }));
  await fs.writeFile(path.join(nested, '.mcp.json'), JSON.stringify({
    mcpServers: { motion: { command: path.join(bin, 'motion-mcp'), args: ['nested'] } },
  }));
  const layered = await readProjectMcpServers(nested, { searchPath: bin });
  assert.equal(layered.file, path.join(nested, '.mcp.json'));
  assert.deepEqual(layered.servers.map((server) => [server.name, server.args]), [['motion', ['nested']], ['shared', []]]);

  await fs.writeFile(path.join(plain, '.mcp.json'), '{ broken');
  const broken = await readProjectMcpServers(plain);
  assert.equal(broken.servers.length, 0);
  assert.match(broken.warnings[0], /некорректный JSON/);
});

test('mergeMcpServers: cockpit-work первый, одноимённые проектные записи не дублируются', () => {
  const work = { name: 'cockpit-work', command: '/usr/bin/node', args: [], env: [] };
  const merged = mergeMcpServers([work], [
    { name: 'cockpit-work', command: '/tmp/fake', args: [], env: [] },
    { name: 'motion', command: '/tmp/motion', args: [], env: [] },
    { name: 'motion', command: '/tmp/motion-2', args: [], env: [] },
  ]);
  assert.deepEqual(merged.map((server) => `${server.name}:${server.command}`), [
    'cockpit-work:/usr/bin/node',
    'motion:/tmp/motion',
  ]);
});

test('адаптер DeepSeek добавляет проектные MCP к служебным в session/new', async (t) => {
  const { root, bin } = await tempProject(t, { git: true });
  const cwd = path.join(root, 'workspace');
  const launchDir = path.join(root, 'launch');
  const dshHome = path.join(root, 'home');
  const scenarioFile = path.join(root, 'scenario.json');
  const logFile = path.join(root, 'fake.ndjson');
  await Promise.all([cwd, launchDir, dshHome].map((dir) => fs.mkdir(dir, { recursive: true })));
  await fs.writeFile(path.join(launchDir, 'overlay.yml'), '[]\n');
  await fs.writeFile(scenarioFile, JSON.stringify({ configOptions: [], updates: [] }));
  await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({
    mcpServers: {
      motion: { command: path.join(bin, 'motion-mcp'), args: ['--stdio'], env: { KIMODO_URL: 'http://127.0.0.1:1' } },
      broken: { command: 'definitely-missing-binary-xyz' },
    },
  }));
  const warnings = [];
  const work = { name: 'cockpit-work', command: process.execPath, args: ['work.js'], env: [] };
  const result = await deepseek.run({
    config: { deepseekRuntimeHome: path.join(root, 'runtime'), deepseekBin: path.join(root, 'fake-dsh') },
    env: { ...process.env, DEEPSEEK_API_KEY: 'synthetic-runtime-key' },
    cwd,
    chatKey: 'chat-project-mcp',
    model: '["deepseek-official","deepseek-v4-flash"]',
    effort: 'high',
    message: 'hello',
    permissionMode: 'default',
    mcpServers: [work],
    log: { warn: (fields, message) => warnings.push({ fields, message }) },
    deps: {
      prepareLaunch: async () => ({ launchDir, dshHome, overlayPath: path.join(launchDir, 'overlay.yml') }),
      spawn: () => spawn(process.execPath, [FAKE_ACP, '--scenario', scenarioFile, '--log', logFile], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
      closeTimeoutMs: 80,
      termTimeoutMs: 80,
    },
  });
  assert.equal(result.stopReason, 'end_turn');

  const entries = (await fs.readFile(logFile, 'utf8')).trim().split('\n').map(JSON.parse);
  const created = entries.find((entry) => entry.kind === 'request' && entry.message?.method === 'session/new');
  assert.deepEqual(created.message.params.mcpServers, [
    work,
    {
      name: 'motion',
      command: path.join(bin, 'motion-mcp'),
      args: ['--stdio'],
      env: [{ name: 'KIMODO_URL', value: 'http://127.0.0.1:1' }],
    },
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].fields.warning, /broken: исполняемый файл/);
  assert.equal(warnings[0].message, 'DeepSeek: запись .mcp.json пропущена');
});
