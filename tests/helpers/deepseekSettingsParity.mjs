import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureTestDeepSeekArtifact } from './deepseekRuntimeArtifact.mts';
import { startDeepSeekLoopback, writeDeepSeekLoopbackOverlay } from './deepseekLoopback.mts';
import { resolveDeepSeekRuntimeAsync } from '../../server/src/lib/deepseek/runtimeProcess.ts';
import { startDeepSeekServer } from '../../server/src/lib/deepseek/serverRuntime.ts';
import { runDeepSeekServerTurn } from '../../server/src/lib/deepseek/serverTurn.ts';
import { runDeepSeekTurn } from '../../server/src/lib/deepseek/runtime.ts';
import { createAcpClient, initializeAcp } from '../../server/src/lib/acp/client.ts';
import {
  acpDeepSeekSettingsRpc,
  startDeepSeekAcpSettings,
} from '../../server/src/lib/deepseek/nativeSettingsRpc.ts';
import {
  applyDeepSeekNativeSettings,
  verifyDeepSeekNativeSettings,
} from '../../server/src/lib/executorSettings/deepseek.ts';

function plan(entries) {
  return {
    providerId: 'deepseek',
    fingerprint: 'loopback-proof',
    accepted: entries.map(([namespace, leaf, value]) => ({
      fieldId: JSON.stringify([namespace, leaf]),
      path: [namespace, leaf],
      value,
      channelId: 'isolated-settings-document',
    })),
  };
}

import { ensureTestDeepSeekBinary } from './deepseekBinary.mts';

/**
 * Стенд имеет отдельные homes/documents и запрет внешнего fetch в каждом процессе.
 * Выбранная generation остаётся неизменной между mutation и рабочим запуском.
 */
async function settingsFixture(t, mode) {
  const candidate = mode === 'binary' ? await ensureTestDeepSeekBinary() : null;
  const artifact = candidate
    ? path.join(candidate.cacheDir, 'packages', candidate.info.packageId, 'generation')
    : await ensureTestDeepSeekArtifact();
  const config = candidate ? {
    deepseekRuntimeMode: 'binary',
    deepseekBin: candidate.binary,
    deepseekCacheDir: candidate.cacheDir,
  } : { deepseekArtifactDir: artifact, deepseekBin: process.execPath };
  const runtime = await resolveDeepSeekRuntimeAsync(config);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-wire-settings-'));
  const mock = await startDeepSeekLoopback();

  t.after(async () => {
    await mock.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  return {
    artifact,
    config,
    runtime,
    root,
    mock,
  };
}

/**
 * Web/ACP настройки проверяются одинаковыми сценариями на двух способах поставки.
 * Меняется только fixture descriptor; mutation, CAS/readback и модельный HTTP настоящие.
 */
export function registerDeepSeekSettingsParity(mode = 'binary') {
  const fixture = (t) => settingsFixture(t, mode);

  test('настоящий web maxTokens 64/128 меняет max_tokens HTTP без внешнего API', async (t) => {
    const { artifact, runtime, root, mock } = await fixture(t);

    for (const maxTokens of [64, 128]) {
      const home = path.join(root, String(maxTokens));
      const document = path.join(home, 'native-settings.yaml');

      await fs.mkdir(home);
      await fs.writeFile(document, '{}\n');

      const overlayPath = await writeDeepSeekLoopbackOverlay({
        artifact,
        root: home,
        document,
        endpoint: mock.endpoint,
      });
      const result = await runDeepSeekServerTurn({
        runtime,
        bin: process.execPath,
        overlayPath,
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          DSH_HOME: home,
          DEEPSEEK_API_KEY: 'grigdesk-loopback-only',
          DSH_TELEMETRY_DISABLED: '1',
        },
        nativeSettings: plan([['llm-deepseek', 'maxTokens', maxTokens]]),
        message: 'Ответь fixture',
        model: '["deepseek-official","deepseek-v4-flash"]',
        effort: 'off',
        signal: AbortSignal.timeout(30_000),
      });

      assert.equal(result.reply, 'loopback-ok');
      assert.equal(mock.payloads.at(-1).max_tokens, maxTokens);
    }

    assert.equal(mock.payloads.length, 2);
  });

  test('настоящий ACP maxTokens и restart owner переживают двухфазный запуск', async (t) => {
    const { artifact, runtime, root, mock } = await fixture(t);

    for (const maxTokens of [64, 128]) {
      const home = path.join(root, String(maxTokens));
      const document = path.join(home, 'native-settings.yaml');
      const owner = path.join(home, 'owner.txt');

      await fs.mkdir(home);
      await fs.writeFile(document, '{}\n');

      const overlayPath = await writeDeepSeekLoopbackOverlay({
        artifact,
        root: home,
        document,
        endpoint: mock.endpoint,
        restartOwner: owner,
      });
      const options = {
        runtime,
        overlayPath,
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          DSH_HOME: home,
          DEEPSEEK_API_KEY: 'grigdesk-loopback-only',
          DSH_TELEMETRY_DISABLED: '1',
        },
      };
      const selected = plan([
        ['llm-deepseek', 'maxTokens', maxTokens], ['grigdesk-restart-test', 'enabled', false],
      ]);
      const preparatory = await startDeepSeekAcpSettings(options);

      try {
        assert.equal(await fs.readFile(owner, 'utf8'), 'true');
        await applyDeepSeekNativeSettings(preparatory.client, selected);
        await verifyDeepSeekNativeSettings(preparatory.client, selected);
        assert.equal(await fs.readFile(owner, 'utf8'), 'true', 'Readback не означает смену restart owner');
        assert.equal(mock.payloads.length, maxTokens === 64 ? 0 : 1);
      } finally {
        await preparatory.stop();
      }

      const args = [...runtime.prefixArgs, '--profile', 'acp', '--patch', overlayPath];
      const child = spawn(runtime.command, args, {
        cwd: home,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const client = createAcpClient(child, { requestTimeoutMs: 30_000 });

      child.stderr.resume();

      try {
        const initialized = await initializeAcp(client);
        const rpc = acpDeepSeekSettingsRpc(client, initialized);

        await verifyDeepSeekNativeSettings(rpc, selected);
        assert.equal(await fs.readFile(owner, 'utf8'), 'false');

        const session = await client.request('session/new', { cwd: home, mcpServers: [] });

        await client.request('session/set_config_option', {
          sessionId: session.sessionId,
          configId: 'reasoning_effort',
          value: 'off',
        });
        await verifyDeepSeekNativeSettings(rpc, selected);
        await client.request('session/prompt', {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Ответь fixture' }],
        });
        assert.equal(mock.payloads.at(-1).max_tokens, maxTokens);
        await client.request('session/close', { sessionId: session.sessionId });
      } finally {
        client.close();
        child.kill('SIGTERM');

        if (child.exitCode === null && child.signalCode === null) {
          await new Promise((resolve) => child.once('exit', resolve));
        }
      }
    }

    assert.equal(mock.payloads.length, 2);
  });

  test('настоящий web boolean сохраняет false отдельно от значения base', async (t) => {
    const { artifact, runtime, root, mock } = await fixture(t);
    const document = path.join(root, 'native-settings.yaml');

    await fs.writeFile(document, '{}\n');

    const overlayPath = await writeDeepSeekLoopbackOverlay({
      artifact,
      root,
      document,
      endpoint: mock.endpoint,
    });

    await fs.appendFile(overlayPath, [
      '- id: subagent-model-selection-settings',
      '  config:',
      '    enabled: true',
      '    allowedModels:',
      '      - provider: deepseek-official',
      '        model: deepseek-v4-flash',
    ].join('\n') + '\n');

    const server = await startDeepSeekServer({
      runtime,
      bin: process.execPath,
      overlayPath,
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        DSH_HOME: root,
        DSH_TELEMETRY_DISABLED: '1',
      },
    });

    try {
      const before = await server.client.rpc('settings/describe');
      const namespace = before.namespaces.find((item) => item.ns === 'subagent-model-selection');
      const selected = plan([['subagent-model-selection', 'enabled', false]]);

      assert.equal(namespace.value.enabled, true);
      await applyDeepSeekNativeSettings(server.client, selected);
      await verifyDeepSeekNativeSettings(server.client, selected);
      assert.match(await fs.readFile(document, 'utf8'), /enabled: false/u);
      assert.equal(mock.payloads.length, 0);
    } finally {
      await server.stop();
    }
  });

  test('настоящий web restart запускает owner из изменённого документа до prompt', async (t) => {
    const { artifact, runtime, root, mock } = await fixture(t);
    const document = path.join(root, 'native-settings.yaml');
    const owner = path.join(root, 'owner.txt');

    await fs.writeFile(document, '{}\n');

    const overlayPath = await writeDeepSeekLoopbackOverlay({
      artifact,
      root,
      document,
      endpoint: mock.endpoint,
      restartOwner: owner,
    });
    const observations = [];
    const result = await runDeepSeekServerTurn({
      runtime,
      bin: process.execPath,
      overlayPath,
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        DSH_HOME: root,
        DSH_TELEMETRY_DISABLED: '1',
        DEEPSEEK_API_KEY: 'grigdesk-loopback-only',
      },
      nativeSettings: plan([['grigdesk-restart-test', 'enabled', false]]),
      message: 'fixture',
      signal: AbortSignal.timeout(30_000),
      startServer: async (options) => {
        const server = await startDeepSeekServer(options);

        observations.push(await fs.readFile(owner, 'utf8'));

        return server;
      },
    });

    assert.equal(result.reply, 'loopback-ok');
    assert.deepEqual(observations, ['true', 'false']);
    assert.equal(mock.payloads.length, 1);
  });

  test('настоящий ACP отклоняет override до worker, session и model HTTP', async (t) => {
    const { artifact, config, root, mock } = await fixture(t);
    const home = path.join(root, 'turn');
    const document = path.join(home, 'native-settings.yaml');

    await fs.mkdir(home);
    await fs.writeFile(document, '{}\n');

    const overlayPath = await writeDeepSeekLoopbackOverlay({
      artifact,
      root: home,
      document,
      endpoint: mock.endpoint,
    });
    let spawnedWorkers = 0;

    await assert.rejects(runDeepSeekTurn({
      config: {
        ...config,
        deepseekRuntimeHome: root,
      },
      cwd: root,
      chatKey: 'loopback-negative',
      env: {
        PATH: process.env.PATH,
        HOME: root,
        DEEPSEEK_API_KEY: 'grigdesk-loopback-only',
      },
      nativeSettings: plan([['llm-deepseek', 'maxTokens', -1]]),
      deps: {
        prepareLaunch: async () => ({
          launchDir: home,
          dshHome: home,
          overlayPath,
          toolPolicyPath: path.join(home, 'tool-policy.json'),
        }),
        spawn: () => {
          spawnedWorkers += 1;

          throw new Error('Worker запрещён после отказа override');
        },
      },
    }));
    assert.equal(spawnedWorkers, 0);
    assert.equal(mock.payloads.length, 0);
    await assert.rejects(fs.access(home));
  });
}
