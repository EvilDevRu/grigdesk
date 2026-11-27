import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { testDeepSeekBinarySelection } from '../helpers/deepseekBinary.mts';
import { writeDeepSeekLoopbackOverlay } from '../helpers/deepseekLoopback.mts';
import { startDeepSeekMessagesLoopback } from '../helpers/deepseekMessagesLoopback.mjs';
import { createAcpClient, initializeAcp } from '../../server/src/lib/acp/client.ts';
import { applyDeepSeekNativeSettings } from '../../server/src/lib/executorSettings/deepseek.ts';
import {
  acpDeepSeekSettingsRpc,
  startDeepSeekAcpSettings,
} from '../../server/src/lib/deepseek/nativeSettingsRpc.ts';
import { resolveDeepSeekRuntimeAsync } from '../../server/src/lib/deepseek/runtimeProcess.ts';
import { runDeepSeekServerTurn } from '../../server/src/lib/deepseek/serverTurn.ts';
import { startDeepSeekServer } from '../../server/src/lib/deepseek/serverRuntime.ts';

/**
 * Создаёт запуск с отдельным документом и посторонними файлами под DSH_HOME.
 * Ключи отсутствуют, рабочая сессия и модель в проверке не открываются.
 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-alpha-settings-'));
  const { config, generation } = await testDeepSeekBinarySelection();
  const runtime = await resolveDeepSeekRuntimeAsync(config);
  const overlayPath = path.join(root, 'launch.yml');
  const document = path.join(root, 'native-settings.yaml');
  const homePatch = path.join(root, 'cordis.patch.yml');
  const commonSettings = path.join(root, 'settings.yaml');
  const outOfScope = 'llm-deepseek:\n  maxTokens: 999\n';
  const userPatch = '- id: settings\n  disabled: true\n';

  await fs.writeFile(document, 'llm-deepseek:\n  maxTokens: 64\n', { mode: 0o600 });
  await fs.writeFile(commonSettings, outOfScope, { mode: 0o600 });
  await fs.writeFile(homePatch, userPatch, { mode: 0o600 });
  await fs.writeFile(overlayPath, [
    '- id: settings',
    '  config:',
    `    path: ${JSON.stringify(document)}`,
    '- id: sandbox-policy',
    '  config:',
    '    mode: read-only',
    `    workspaceRoot: ${JSON.stringify(root)}`,
    '',
  ].join('\n'), { mode: 0o600 });

  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  return {
    runtime,
    generation,
    document,
    commonSettings,
    outOfScope,
    homePatch,
    userPatch,
    launch: {
      runtime,
      bin: runtime.command,
      overlayPath,
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        DSH_HOME: root,
        DSH_TELEMETRY_DISABLED: '1',
      },
    },
  };
}

/**
 * Читает схему и значение через тот же RPC, что вызывает GrigDesk.
 * Управляемые launcher-ом права не появляются среди форм.
 */
async function maxTokens(client) {
  const description = await client.rpc('settings/describe', {});

  assert.equal(description.writable, true);
  assert.equal(description.hasDocument, true);

  const forbidden = ['sandbox-policy', 'permission', 'approval'];

  assert.ok(!description.namespaces.some(({ ns }) => forbidden.includes(ns)));

  const section = description.namespaces.find(({ ns }) => ns === 'llm-deepseek');

  assert.ok(section);

  return section;
}

for (const [transport, start] of [
  ['web', startDeepSeekServer],
  ['ACP', startDeepSeekAcpSettings],
]) {
  test(`alpha.2 ${transport} проверяет CAS и сохраняет приватные настройки после перезапуска`, async (t) => {
    const state = await fixture(t);
    const first = await start(state.launch);

    try {
      const section = await maxTokens(first.client);

      assert.equal(section.value.maxTokens, 64);

      const request = {
        ns: section.ns,
        expectedRevision: section.revision,
        ops: [{
          op: 'set',
          path: ['maxTokens'],
          value: 128,
        }],
      };
      const changed = await first.client.rpc('settings/mutate', request);

      assert.equal(changed.value.maxTokens, 128);
      assert.ok(changed.revision > section.revision);
      await assert.rejects(first.client.rpc('settings/mutate', request));
      assert.equal((await maxTokens(first.client)).value.maxTokens, 128);
    } finally {
      await first.stop();
    }

    const restarted = await start(state.launch);

    try {
      assert.equal((await maxTokens(restarted.client)).value.maxTokens, 128);
      assert.equal(await fs.readFile(state.document, 'utf8'), 'llm-deepseek:\n  maxTokens: 64\n');
      assert.equal(await fs.readFile(state.commonSettings, 'utf8'), state.outOfScope);
      assert.equal(await fs.readFile(state.homePatch, 'utf8'), state.userPatch);
    } finally {
      await restarted.stop();
    }
  });
}

test('alpha.2 ACP отвергает Loader-патч в документе настроек до initialize', async (t) => {
  const state = await fixture(t);

  await fs.writeFile(`${state.document}.cordis.yml`, [
    '- id: llm-deepseek',
    "  name: '@deepseek-ai/dsh-llm-deepseek-api-key'",
    '  disabled: true',
    '  config: { maxTokens: 64 }',
    '',
  ].join('\n'), { mode: 0o600 });
  await assert.rejects(startDeepSeekAcpSettings(state.launch));
});

test('alpha.2 web сохраняет прежний id настройки подагента и явное false', async (t) => {
  const state = await fixture(t);

  await fs.appendFile(state.launch.overlayPath, [
    '- id: subagent-model-selection-settings',
    '  config: { enabled: true }',
    '',
  ].join('\n'));

  const server = await startDeepSeekServer(state.launch);

  try {
    const description = await server.client.rpc('settings/describe', {});
    const section = description.namespaces.find(({ ns }) => ns === 'subagent-model-selection');

    assert.equal(section.value.enabled, true);

    const changed = await server.client.rpc('settings/mutate', {
      ns: section.ns,
      expectedRevision: section.revision,
      ops: [{
        op: 'set',
        path: ['enabled'],
        value: false,
      }],
    });

    assert.equal(changed.value.enabled, false);
    assert.equal(changed.base.enabled, true);
    assert.equal(changed.user.enabled, false);
  } finally {
    await server.stop();
  }
});

const FLASH = 'deepseek-flash';
const SETTINGS_OVERRIDE = {
  providerId: 'deepseek',
  fingerprint: 'alpha-messages-loopback',
  accepted: [{
    fieldId: JSON.stringify(['llm-deepseek', 'maxTokens']),
    path: ['llm-deepseek', 'maxTokens'],
    value: 128,
    channelId: 'isolated-settings-document',
  }],
};

/**
 * Указывает тестовый endpoint через обычный overlay. Guard из существующего fixture
 * запрещает fetch вне loopback, даже если код по ошибке выберет production URL.
 */
async function messagesFixture(t, transport) {
  const { launch, generation, document } = await fixture(t);
  const mock = await startDeepSeekMessagesLoopback(FLASH);

  t.after(() => mock.stop());

  const overlayPath = await writeDeepSeekLoopbackOverlay({
    root: launch.cwd,
    artifact: generation,
    document,
    endpoint: mock.endpoint,
  });

  if (transport === 'acp') {
    await fs.appendFile(overlayPath, [
      '- id: acp',
      '  config:',
      '    provider: deepseek-official',
      `    model: ${FLASH}`,
      '',
    ].join('\n'));
  }

  return {
    mock,
    options: {
      ...launch,
      overlayPath,
      env: {
        ...launch.env,
        DEEPSEEK_API_KEY: 'grigdesk-loopback-only',
      },
    },
  };
}

test('alpha.2 web передаёт max_tokens из private settings в Messages API', async (t) => {
  const { mock, options } = await messagesFixture(t, 'web');
  const result = await runDeepSeekServerTurn({
    ...options,
    nativeSettings: SETTINGS_OVERRIDE,
    message: 'Ответь fixture',
    model: JSON.stringify(['deepseek-official', FLASH]),
    effort: 'off',
    signal: AbortSignal.timeout(30_000),
  });

  assert.equal(result.reply, 'loopback-ok');
  assert.deepEqual(mock.payloads.map((payload) => payload.max_tokens), [128]);
});

test('alpha.2 ACP передаёт max_tokens после закрытия процесса настройки', async (t) => {
  const { mock, options } = await messagesFixture(t, 'acp');
  const first = await startDeepSeekAcpSettings(options);

  try {
    await applyDeepSeekNativeSettings(first.client, SETTINGS_OVERRIDE);
    assert.deepEqual(mock.payloads, []);
  } finally {
    await first.stop();
  }

  const { runtime, cwd, env, overlayPath } = options;
  const args = [...runtime.prefixArgs, '--profile', 'acp', '--patch', overlayPath];
  const child = spawn(runtime.command, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = createAcpClient(child, { requestTimeoutMs: 30_000 });

  child.stderr.resume();

  try {
    const initialized = await initializeAcp(client);
    const settings = acpDeepSeekSettingsRpc(client, initialized);
    const section = await maxTokens(settings);

    assert.equal(section.value.maxTokens, 128);

    const session = await client.request('session/new', { cwd, mcpServers: [] });

    await client.request('session/set_config_option', {
      sessionId: session.sessionId,
      configId: 'reasoning_effort',
      value: 'off',
    });
    await client.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Ответь fixture' }],
    });
    assert.deepEqual(mock.payloads.map((payload) => payload.max_tokens), [128]);
    await client.request('session/close', { sessionId: session.sessionId });
  } finally {
    client.close();
    child.kill('SIGTERM');

    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
});
