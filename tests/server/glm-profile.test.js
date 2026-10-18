import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildLaunchFiles } from '../../server/src/lib/deepseek/profile.ts';
import { GLM_PROFILE_REVISION, buildGlmRoute } from '../../server/src/lib/glm/contract.ts';
import { glmChatHome, prepareGlmLaunch } from '../../server/src/lib/glm/launch.ts';
import { buildGlmLaunchFiles, glmLaunchFingerprint } from '../../server/src/lib/glm/profile.ts';
import { runtimeYaml } from '../../tools/runtimeComposition.ts';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const GOLDEN = path.join(REPO_ROOT, 'tests/fixtures/glm/deepseek-launch-golden.json');
const IDENTITY = 'f'.repeat(64);

/**
 * Временные каталоги профиля: проект с вложенным cwd и корень private homes.
 * Удаляются после теста; процессы здесь не запускаются.
 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-profile-'));
  const project = path.join(root, 'project');
  const cwd = path.join(project, 'nested');

  await fs.mkdir(path.join(project, '.git'), { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  return {
    root,
    project,
    cwd,
    launchDir: path.join(root, 'launch'),
    runtimeHome: path.join(root, 'glm-home'),
  };
}

function launchOptions(f, overrides = {}) {
  return {
    launchDir: f.launchDir,
    cwd: f.cwd,
    workspaceRoot: f.cwd,
    projectRoot: f.project,
    accessMode: 'api',
    model: 'glm-5.3',
    transport: 'web',
    settingsDocument: path.join(f.root, 'settings.yaml'),
    hooks: {
      ssh: true,
      db: false,
      strictDb: false,
    },
    ...overrides,
  };
}

/**
 * Опции подготовки запуска: каталог запуска выбирает сама подготовка, на каждый запуск свой.
 * Остальные поля совпадают с опциями сборки файлов профиля.
 */
function prepareOptions(f, overrides = {}) {
  const { launchDir: _launchDir, settingsDocument: _settings, ...rest } = launchOptions(f);

  return {
    runtimeHome: f.runtimeHome,
    identity: IDENTITY,
    chatKey: 'chat-a',
    ...rest,
    ...overrides,
  };
}

async function overlayRows(files) {
  return runtimeYaml().load(await fs.readFile(files.overlayPath, 'utf8'));
}

function insertRows(rows) {
  return rows.find((row) => Array.isArray(row.insert))?.insert ?? [];
}

test('overlay выключает llm-deepseek и session-title-llm и назначает модель zai для web и acp', async (t) => {
  const f = await fixture(t);

  for (const transport of ['web', 'acp']) {
    const rows = await overlayRows(await buildGlmLaunchFiles(launchOptions(f, { transport })));
    const byId = new Map(rows.filter((row) => row.id).map((row) => [row.id, row]));
    const modelRow = transport === 'web' ? 'agent-default-model' : 'acp';

    assert.equal(byId.get('llm-deepseek')?.disabled, true);
    assert.equal(byId.get('session-title-llm')?.disabled, true);
    assert.deepEqual(byId.get(modelRow)?.config, { provider: 'zai', model: 'glm-5.3' });
    assert.equal(byId.has(transport === 'web' ? 'acp' : 'agent-default-model'), false);

    // Факт G2 (F8): без строки web штатный preset не монтируется, поэтому она не выключается.
    assert.equal(byId.has('web'), false);
  }
});

test('overlay вставляет llm-pi-ai с маршрутом режима, а overlay DeepSeek — нет', async (t) => {
  const f = await fixture(t);

  for (const accessMode of ['api', 'coding-plan']) {
    const rows = await overlayRows(await buildGlmLaunchFiles(launchOptions(f, { accessMode })));
    const plugin = insertRows(rows).find((row) => row.id === 'llm-pi-ai');

    assert.equal(plugin?.name, '@deepseek-ai/dsh-llm-pi-ai');
    assert.deepEqual(plugin?.config, { providers: { zai: buildGlmRoute(accessMode) } });
  }

  const golden = JSON.parse(await fs.readFile(GOLDEN, 'utf8'));

  for (const variant of Object.values(golden)) {
    assert.equal(variant.overlay.includes('llm-pi-ai'), false);
  }
});

test('PreToolUse с matcher * ведёт на GLM policy hook; UserPromptSubmit — на hook инструкций', async (t) => {
  const f = await fixture(t);
  const files = await buildGlmLaunchFiles(launchOptions(f));
  const hooks = JSON.parse(await fs.readFile(files.hooksPath, 'utf8')).hooks;
  const rows = await overlayRows(files);
  const bridge = insertRows(rows).find((row) => row.id === 'hooks-claude-code');

  assert.deepEqual(Object.keys(hooks).sort(), ['PreToolUse', 'UserPromptSubmit']);
  assert.equal(hooks.PreToolUse.length, 1);
  assert.equal(hooks.PreToolUse[0].matcher, '*');
  assert.equal(hooks.PreToolUse[0].hooks.length, 1);
  assert.match(hooks.PreToolUse[0].hooks[0].command, /glmToolPolicyHook\.mts/u);
  assert.equal(hooks.PreToolUse[0].hooks[0].timeout, 30);
  assert.match(hooks.UserPromptSubmit[0].hooks[0].command, /deepseekInstructionsHook\.mts/u);
  assert.equal(bridge?.config.configPath, files.hooksPath);
  assert.equal(bridge?.config.projectDir, f.cwd);
});

test('homes GLM вне homes DeepSeek, разделены по identity и хэшу chatKey; chatKey с ../ не выходит из корня',
  async (t) => {
    const f = await fixture(t);
    const first = glmChatHome(f.runtimeHome, IDENTITY, 'chat-a');
    const homes = [
      first,
      glmChatHome(f.runtimeHome, IDENTITY, 'chat-b'),
      glmChatHome(f.runtimeHome, 'e'.repeat(64), 'chat-a'),
      glmChatHome(f.runtimeHome, IDENTITY, '../../escape'),
    ];

    assert.equal(new Set(homes).size, homes.length);
    assert.equal(path.dirname(path.dirname(first)), f.runtimeHome);
    assert.equal(path.basename(path.dirname(first)), IDENTITY.slice(0, 16));

    for (const home of homes) {
      const relative = path.relative(f.runtimeHome, home);

      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), home);
      assert.equal(home.includes('grigdesk-deepseek'), false);
    }
  });

test('каталоги 0700, файлы 0600', async (t) => {
  const f = await fixture(t);
  const launch = await prepareGlmLaunch(prepareOptions(f));

  for (const directory of [launch.dshHome, launch.launchDir]) {
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700, directory);
  }

  for (const file of [launch.overlayPath, launch.hooksPath, launch.settingsDocument]) {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600, file);
  }
});

test('settings-документ пересоздаётся на каждый запуск без секции llm-pi-ai', async (t) => {
  const f = await fixture(t);
  const options = prepareOptions(f);
  const first = await prepareGlmLaunch(options);

  await fs.writeFile(first.settingsDocument, JSON.stringify({
    'llm-pi-ai': { providers: { zai: { baseURL: 'http://127.0.0.1:9/hijack' } } },
  }));

  const second = await prepareGlmLaunch(options);
  const rows = await overlayRows(second);

  assert.equal(second.settingsDocument, first.settingsDocument);
  assert.equal(path.dirname(second.settingsDocument), second.dshHome);
  assert.equal(await fs.readFile(second.settingsDocument, 'utf8'), '{}\n');
  assert.deepEqual(rows.find((row) => row.id === 'settings')?.config, { path: second.settingsDocument });
  assert.notEqual(first.launchDir, second.launchDir);
});

test('отпечаток запуска меняется от GLM_PROFILE_REVISION', async (t) => {
  const f = await fixture(t);
  const files = await buildGlmLaunchFiles(launchOptions(f));
  const overlay = await fs.readFile(files.overlayPath, 'utf8');
  const hooks = await fs.readFile(files.hooksPath, 'utf8');

  const current = glmLaunchFingerprint({
    revision: GLM_PROFILE_REVISION,
    overlay,
    hooks,
  });
  const next = glmLaunchFingerprint({
    revision: `${GLM_PROFILE_REVISION}-next`,
    overlay,
    hooks,
  });

  assert.equal(files.fingerprint, current);
  assert.notEqual(files.fingerprint, next);
});

test('overlay с подменой адреса отличается от production только baseURL и строкой guard', async (t) => {
  const f = await fixture(t);
  const production = await overlayRows(await buildGlmLaunchFiles(launchOptions(f, {
    launchDir: path.join(f.root, 'production'),
  })));
  const substituted = await overlayRows(await buildGlmLaunchFiles(launchOptions(f, {
    launchDir: path.join(f.root, 'substituted'),
    modelEndpoint: 'http://127.0.0.1:1/api/paas/v4',
    egressGuard: path.join(f.root, 'guard.mjs'),
  })));
  const normalize = (rows) => JSON.parse(JSON.stringify(rows).replaceAll(path.join(f.root, 'production'),
    '<LAUNCH>').replaceAll(path.join(f.root, 'substituted'), '<LAUNCH>'));
  const left = normalize(production);
  const right = normalize(substituted);
  const leftInsert = insertRows(left);
  const rightInsert = insertRows(right);
  const guard = rightInsert.filter((row) => !leftInsert.some((other) => other.id === row.id));

  assert.deepEqual(guard.map((row) => row.id), ['grigdesk-glm-egress-guard']);
  assert.equal(guard[0]?.name, `file://${path.join(f.root, 'guard.mjs')}`);
  assert.equal(rightInsert.find((row) => row.id === 'llm-pi-ai')?.config.providers.zai.baseURL,
    'http://127.0.0.1:1/api/paas/v4');

  rightInsert.splice(rightInsert.indexOf(guard[0]), 1);
  rightInsert.find((row) => row.id === 'llm-pi-ai').config.providers.zai.baseURL
    = leftInsert.find((row) => row.id === 'llm-pi-ai').config.providers.zai.baseURL;

  if (leftInsert.find((row) => row.id === 'llm-pi-ai').config.providers.zai.baseURL === undefined) {
    delete rightInsert.find((row) => row.id === 'llm-pi-ai').config.providers.zai.baseURL;
  }

  assert.deepEqual(right, left);
});

const PROJECT_MCP_TEST = 'проектные MCP-серверы исключаются с предупреждением, запуск не падает; '
  + 'grigdesk-work остаётся';

test(PROJECT_MCP_TEST, async (t) => {
  const f = await fixture(t);

  await fs.writeFile(path.join(f.project, '.mcp.json'), JSON.stringify({ mcpServers: {
    'a__b': { command: process.execPath, args: ['x'] },
    valid: { command: process.execPath, args: ['y'] },
  } }));

  const warnings = [];
  const launch = await prepareGlmLaunch(prepareOptions(f, {
    mcpServers: [{
      name: 'grigdesk-work',
      command: process.execPath,
      args: ['work-mcp.js'],
      env: [],
    }],
    warn: (message) => warnings.push(message),
  }));
  const rows = insertRows(await overlayRows(launch));
  const mcp = rows.filter((row) => row.name === '@deepseek-ai/dsh-mcp-client');

  assert.deepEqual(mcp.map((row) => row.config.serverName), ['grigdesk-work']);
  assert.equal(mcp[0]?.config.failOnStartupError, true);
  assert.deepEqual(mcp[0]?.config.reconnect, { enabled: false });
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((warning) => /не подключается к GLM/u.test(warning)));
});

test('buildLaunchFiles DeepSeek после параметризации даёт прежний overlay байт в байт', async (t) => {
  const golden = JSON.parse(await fs.readFile(GOLDEN, 'utf8'));

  for (const [name, options] of Object.entries({
    web: ['web', 'workspace-write', 'ask', true, true, true, true],
    acp: ['acp', 'read-only', 'never', false, false, false, false],
  })) {
    const [transport, mode, approval, ssh, db, mcp, settings] = options;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ds-golden-'));
    const launchDir = path.join(root, 'launch');

    t.after(() => fs.rm(root, { recursive: true, force: true }));

    const files = await buildLaunchFiles({
      launchDir,
      cwd: path.join(root, 'project', 'nested'),
      workspaceRoot: path.join(root, 'project'),
      mode,
      approval,
      transport,
      mcpServers: mcp ? [{
        name: 'fixture',
        command: '/usr/bin/fixture-mcp',
        args: ['--a', 'b'],
        env: [{ name: 'X', value: 'y' }],
      }] : [],
      nativeSettingsDocument: settings ? path.join(launchDir, 'native-settings.yaml') : undefined,
      hooks: {
        bashToolName: 'bash',
        ssh,
        db,
        strictDb: db,
        instructions: { projectRoot: path.join(root, 'project') },
      },
    });
    const normalize = (text) => text.replaceAll(root, '<ROOT>').replaceAll(process.execPath, '<NODE>')
      .replaceAll(REPO_ROOT, '<REPO>');

    assert.equal(normalize(await fs.readFile(files.overlayPath, 'utf8')), golden[name].overlay, name);
    assert.equal(normalize(await fs.readFile(files.hooksPath, 'utf8')), golden[name].hooks, name);
    assert.equal(files.version, golden[name].version);
  }
});
