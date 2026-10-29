import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ensureTestDeepSeekBinary } from '../helpers/deepseekBinary.mts';
import { resolveDeepSeekRuntimeAsync } from '../../server/src/lib/deepseek/runtimeProcess.ts';
import { startDeepSeekServer } from '../../server/src/lib/deepseek/serverRuntime.ts';
import { startDeepSeekAcpSettings } from '../../server/src/lib/deepseek/nativeSettingsRpc.ts';
import { readDeepSeekCatalog } from '../../server/src/lib/deepseek/catalog.ts';
import { runDeepSeekTurn } from '../../server/src/lib/deepseek/runtime.ts';

/**
 * Настоящий ELF получает только локальный барьер boot либо аварийный выход plugin.
 * Все каталоги принадлежат тесту; модель, пользовательский home и сеть не используются.
 */
async function fixture(t, boot = false) {
  const candidate = await ensureTestDeepSeekBinary();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-startup-cleanup-'));
  const launchDir = path.join(root, 'launch');
  const home = path.join(root, 'home');
  const overlayPath = path.join(launchDir, 'overlay.yml');
  const toolPolicyPath = path.join(root, 'tool-policy.json');
  const plugin = path.join(root, 'startup.mjs');
  const barrier = path.join(root, 'boot.ready');
  let child;
  let closed;

  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }

    await closed;
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(launchDir);
  await fs.mkdir(home);
  await fs.writeFile(toolPolicyPath, JSON.stringify({
    format: 1,
    consumer: 'deepseek-chat',
    revision: 'grigdesk-tool-permissions-v1',
    mode: 'default',
    workspaceRoot: root,
    workActions: {},
  }));
  await fs.writeFile(plugin, boot
    ? `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(barrier)}, String(process.pid));
await new Promise(() => {});
`
    : 'process.exit(74);\n');
  await fs.writeFile(overlayPath, '- insert:\n    - id: startup-cleanup\n      name: '
    + `${JSON.stringify(pathToFileURL(plugin).href)}\n`);

  const config = {
    deepseekRuntimeMode: 'binary',
    deepseekBin: candidate.binary,
    deepseekCacheDir: candidate.cacheDir,
    deepseekRuntimeHome: path.join(root, 'runtime'),
  };
  const runtime = await resolveDeepSeekRuntimeAsync(config);
  const options = {
    runtime,
    bin: candidate.binary,
    overlayPath,
    cwd: root,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      DSH_HOME: home,
      TMPDIR: root,
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: 'synthetic-startup-key',
    },
    spawnProcess: (...args) => {
      child = spawn(...args);
      closed = new Promise((resolve) => child.once('close', resolve));

      return child;
    },
  };

  return {
    root,
    home,
    toolPolicyPath,
    config,
    options,
    barrier,
    launcher: () => child,
  };
}

/**
 * Барьер подтверждает запуск bootstrap до намеренной смерти собственного launcher.
 * Таймаут ожидания не считается ошибкой продукта и не подменяет проверку причины.
 */
async function waitForBoot(barrier) {
  const deadline = Date.now() + 30000;

  while (!await fs.access(barrier).then(() => true, () => false)) {
    assert.ok(Date.now() < deadline, 'Собственный worker достиг boot-барьера');
    await pause(20);
  }
}

/**
 * Проверяются обе независимые причины и внешний код, удерживающий диагностику.
 * Любой произвольный cleanup без первичного отказа эту проверку не проходит.
 */
function checkFailure(error, primary) {
  assert.equal(error.code, 'deepseek_binary_cleanup');
  assert.match(error.message, primary);
  assert.match(error.cause.message, primary);
  assert.equal(error.stopFailure.code, 'deepseek_binary_cleanup');
  assert.match(error.stopFailure.message, /Не подтверждено штатное завершение DeepSeek/u);
  assert.ok(error.stopDetails);
  assert.equal(error.stopDetails.groupGone, true);

  return true;
}

for (const mode of ['boot-kill', 'abort-startup']) {
  test(`web ELF сохраняет исходную причину ${mode} отдельно от cleanup`, {
    timeout: 60000,
  }, async (t) => {
    const input = await fixture(t, true);
    const controller = new AbortController();
    const spawnProcess = input.options.spawnProcess;

    input.options.signal = controller.signal;

    if (mode === 'abort-startup') {
      input.options.spawnProcess = (...args) => {
        const child = spawnProcess(...args);

        controller.abort(new Error('Тестовая отмена запуска'));

        return child;
      };
    }

    const pending = startDeepSeekServer(input.options).then(() => null, (error) => error);

    if (mode === 'boot-kill') {
      await waitForBoot(input.barrier);
      input.launcher().kill('SIGKILL');
    }

    const error = await pending;

    checkFailure(error, mode === 'boot-kill'
      ? /DeepSeek web завершился до запуска/u : /Probe DeepSeek остановлен/u);
    assert.equal(error.stopDetails.exit.signal, mode === 'boot-kill' ? 'SIGKILL' : 'SIGTERM');
    await fs.access(path.dirname(input.options.overlayPath));
  });
}

for (const owner of ['settings', 'catalog', 'acp']) {
  test(`${owner} ELF сохраняет отказ initialize при вторичном cleanup`, {
    timeout: 60000,
  }, async (t) => {
    const input = await fixture(t);
    const { options } = input;
    let pending;
    let launchDir = path.dirname(options.overlayPath);

    if (owner === 'settings') {
      pending = startDeepSeekAcpSettings(options);
    } else if (owner === 'catalog') {
      pending = readDeepSeekCatalog({ config: input.config, env: options.env }, {
        spawnProcess: (command, args, spawnOptions) => {
          const index = args.indexOf('--patch') + 1;

          launchDir = path.dirname(args[index]);
          args[index] = options.overlayPath;

          return options.spawnProcess(command, args, spawnOptions);
        },
      });
    } else {
      pending = runDeepSeekTurn({
        config: input.config,
        env: options.env,
        cwd: input.root,
        chatKey: 'startup-cleanup-test',
        message: 'Не должен попасть в модель.',
        deps: {
          spawn: options.spawnProcess,
          prepareLaunch: async () => ({
            launchDir,
            dshHome: input.home,
            overlayPath: options.overlayPath,
            toolPolicyPath: input.toolPolicyPath,
          }),
        },
      });
    }

    await assert.rejects(pending, (error) => checkFailure(error, /ACP (?:process|transport) завершился/u));
    await fs.access(launchDir);
  });
}

test('ACP сохраняет первичную ошибку prompt при отказе последующего shutdown', async (t) => {
  const input = await fixture(t);
  const scenario = path.join(input.root, 'scenario.json');
  const log = path.join(input.root, 'acp.jsonl');
  const fake = fileURLToPath(new URL('../fixtures/deepseek-harness/fakeAcp.mts', import.meta.url));

  await fs.writeFile(scenario, JSON.stringify({
    promptError: { code: -32603, message: 'Internal error: turn failed: Connection error.' },
    hangOnClose: true,
  }));
  await assert.rejects(runDeepSeekTurn({
    config: input.config,
    env: input.options.env,
    cwd: input.root,
    chatKey: 'prompt-cleanup-test',
    message: 'Один принятый prompt.',
    deps: {
      prepareLaunch: async () => ({
        launchDir: path.dirname(input.options.overlayPath),
        dshHome: input.home,
        overlayPath: input.options.overlayPath,
        toolPolicyPath: input.toolPolicyPath,
      }),
      spawn: (_command, _args, options) => {
        const child = input.options.spawnProcess(process.execPath,
          [fake, '--scenario', scenario, '--log', log], options);
        const kill = child.kill.bind(child);

        child.kill = () => kill('SIGKILL');

        return child;
      },
    },
  }), (error) => {
    checkFailure(error, /Internal error: turn failed: Connection error/u);
    assert.equal(error.retryState, 'post_prompt');

    return true;
  });
});
