import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { spawnDeepSeekBinary } from '../../server/src/lib/deepseek/binaryProcess.ts';
import { resolveDeepSeekRuntimeAsync } from '../../server/src/lib/deepseek/runtimeProcess.ts';
import { startGlmProcess } from '../../server/src/lib/glm/launch.ts';
import { startDeepSeekServer } from '../../server/src/lib/deepseek/serverRuntime.ts';
import { prepareDeepSeekLifecycle } from '../helpers/deepseekLifecycle.mts';
import { startDeepSeekAcpSettings } from '../../server/src/lib/deepseek/nativeSettingsRpc.ts';
import { readDeepSeekCatalog } from '../../server/src/lib/deepseek/catalog.ts';
import { deepSeekTestArtifactsRoot } from '../helpers/deepseekBinary.mts';
import { startDeepSeekLoopback, writeDeepSeekLoopbackOverlay } from '../helpers/deepseekLoopback.mts';
import { runDeepSeekServerTurn } from '../../server/src/lib/deepseek/serverTurn.ts';

const fixture = fileURLToPath(new URL('../fixtures/deepseek-harness/binaryGroup.mjs', import.meta.url));

/**
 * PID берётся только из файла собственной fixture, а группа — из собственного spawn.
 * Cleanup теста не меняет проверяемый результат production stop.
 */
async function launch(t, mode = 'graceful') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owned-binary-'));
  let owned;
  let pid;

  t.after(async () => {
    if (pid) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') {
          throw error;
        }
      }

      await owned.closed;
    }

    await fs.rm(root, { recursive: true, force: true });
  });
  owned = spawnDeepSeekBinary(process.execPath, [fixture, root, 'launcher', mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pid = owned.child.pid;

  const deadline = Date.now() + 10000;
  let worker = 0;

  while (!worker && Date.now() < deadline) {
    worker = Number(await fs.readFile(path.join(root, 'worker.pid'), 'utf8').catch(() => ''));

    if (!worker) {
      await pause(20);
    }
  }

  assert.ok(worker > 1, 'Fixture worker подтвердил свой PID');

  return {
    owned,
    root,
    worker,
    pid,
  };
}

/**
 * Проверка касается только PID собственной fixture; EPERM не означает отсутствие.
 * После успешного stop процесс обязан уже отсутствовать, без eventual ожидания.
 */
function alive(pid) {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }

    throw error;
  }
}

test('stop своей process group ждёт worker и стабилизацию marker', async (t) => {
  const { owned, root, worker, pid } = await launch(t);
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');

  assert.equal(Number(fields[2]), pid, 'Отдельная собственная process group');
  await owned.stop();
  assert.equal(alive(pid), false);
  assert.equal(alive(worker), false);

  const marker = await fs.readFile(path.join(root, 'worker.marker'), 'utf8').catch(() => '');

  await pause(100);
  assert.equal(await fs.readFile(path.join(root, 'worker.marker'), 'utf8').catch(() => ''), marker);
  await owned.stop();
});

test('зависшая группа получает 6+2 с и честный отказ после эскалации', { timeout: 15000 }, async (t) => {
  const { owned, worker, pid } = await launch(t, 'blocked');
  const started = performance.now();
  const first = owned.stop();
  const second = owned.stop();

  assert.equal(first, second, 'Повторный stop не создаёт новый deadline');
  await assert.rejects(first, { code: 'deepseek_binary_cleanup' });
  assert.ok(performance.now() - started >= 5900);
  assert.ok(performance.now() - started < 8500);
  assert.equal(alive(pid), false);
  assert.equal(alive(worker), false);
  await assert.rejects(owned.stop(), { code: 'deepseek_binary_cleanup' });
});

test('смерть launcher запускает cleanup собственной группы без явного stop', {
  timeout: 15000,
}, async (t) => {
  const { owned, worker } = await launch(t, 'blocked');

  owned.child.kill('SIGKILL');

  const deadline = performance.now() + 8500;

  while (alive(worker) && performance.now() < deadline) {
    await pause(25);
  }

  assert.equal(alive(worker), false, 'Автоматический cleanup завершает worker после смерти launcher');
  await assert.rejects(owned.stop(), { code: 'deepseek_binary_cleanup' });
});

test('PGID захвачен своим spawn; подмена child.pid не затрагивает чужой sentinel', async (t) => {
  const { owned, worker } = await launch(t);
  const sentinelRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foreign-sentinel-'));
  const sentinel = spawn(process.execPath, [fixture, sentinelRoot, 'sentinel', 'graceful'], {
    detached: true,
    stdio: 'ignore',
  });
  const sentinelClosed = new Promise((resolve) => sentinel.once('close', resolve));

  t.after(async () => {
    sentinel.kill('SIGTERM');
    await sentinelClosed;
    await fs.rm(sentinelRoot, { recursive: true, force: true });
  });

  const deadline = Date.now() + 10000;

  while (!await fs.access(path.join(sentinelRoot, 'sentinel.pid')).then(() => true, () => false)
    && Date.now() < deadline) {
    await pause(20);
  }

  owned.child.pid = sentinel.pid;

  const first = owned.stop();

  assert.equal(first, owned.stop());
  await first;
  assert.equal(alive(worker), false);
  assert.equal(alive(sentinel.pid), true);
  assert.equal(sentinel.exitCode, null);
});

/**
 * Настоящий ELF получает test plugin с управляемой upstream shell, без model API.
 * Cleanup знает только PID своего launcher и PID, записанные собственным plugin.
 */
async function webFixture(t, { hang = false, boot = false, prepared } = {}) {
  const candidate = prepared ?? await prepareDeepSeekLifecycle();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owned-web-'));
  const launchDir = path.join(root, 'launch');
  const home = path.join(root, 'home');
  const overlayPath = path.join(launchDir, 'overlay.yml');
  let child;
  let childClosed;

  t.after(async () => {
    const pids = [
      child?.pid,
      Number(await fs.readFile(path.join(root, 'worker.pid'), 'utf8').catch(() => '')),
      Number(await fs.readFile(path.join(root, 'shell.pid'), 'utf8').catch(() => '')),
      Number(await fs.readFile(path.join(root, 'boot-gate.ready'), 'utf8').catch(() => '')),
    ].filter((pid) => Number.isSafeInteger(pid) && pid > 1);

    for (const pid of pids) {
      try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');

        process.kill(Number(fields[2]) === pid ? -pid : pid, 'SIGKILL');
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes(error.code)) {
          throw error;
        }
      }
    }

    await childClosed;
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(launchDir);
  await fs.mkdir(home);
  await fs.writeFile(overlayPath, '- insert:\n    - id: managed-stop-fixture\n      name: '
    + `${JSON.stringify(pathToFileURL(candidate.plugin).href)}\n`);

  const config = {
    deepseekRuntimeMode: 'binary',
    deepseekBin: candidate.binary,
    deepseekCacheDir: candidate.cache,
    deepseekRuntimeHome: path.join(root, 'runtime'),
  };
  const runtime = await resolveDeepSeekRuntimeAsync(config);
  const options = {
    runtime,
    bin: candidate.binary,
    launch: { overlayPath, launchDir },
    overlayPath,
    cwd: root,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      DSH_HOME: home,
      TMPDIR: root,
      DSH_TELEMETRY_DISABLED: '1',
      GRIGDESK_TEST_STOP_DIR: root,
      ...(hang ? { GRIGDESK_TEST_HANG_DISPOSAL: '1' } : {}),
      ...(boot ? { GRIGDESK_TEST_BOOT_GATE: path.join(root, 'boot-gate') } : {}),
    },
    spawnProcess: (...args) => {
      child = spawn(...args);
      childClosed = new Promise((resolve) => child.once('close', resolve));

      return child;
    },
  };

  /**
   * Web URL может появиться раньше остальных plugins: это ещё не готовность команды.
   * Отказ disposal проверяется только после собственного shell marker и containment.
   */
  async function ready() {
    const deadline = Date.now() + 30000;

    while (Date.now() < deadline) {
      const worker = Number(await fs.readFile(path.join(root, 'worker.pid'), 'utf8').catch(() => ''));
      const shell = Number(await fs.readFile(path.join(root, 'shell.pid'), 'utf8').catch(() => ''));
      const marker = await fs.readFile(path.join(root, 'marker'), 'utf8').catch(() => '');
      const containment = await fs.readFile(path.join(root, 'containment'), 'utf8').catch(() => '');

      if (worker > 1 && shell > 1 && marker.length > 0 && containment) {
        return {
          worker,
          shell,
          containment,
        };
      }

      await pause(25);
    }

    assert.fail('Настоящая managed shell не достигла собственного marker');
  }

  return {
    options,
    config,
    root,
    ready,
    launcher: () => child,
  };
}

test('GLM сохраняет launchDir при честном cleanup отказе настоящего binary worker', {
  timeout: 900000,
}, async (t) => {
  const { options, ready, root, launcher } = await webFixture(t, { hang: true });
  const server = await startGlmProcess(options);

  const pids = await ready();
  const started = performance.now();
  const result = await server.stop().then(() => ({ ok: true }), (error) => ({
    ok: false,
    code: error.code,
  }));
  const report = path.join(deepSeekTestArtifactsRoot(), 's10c/web-stop-result.json');

  await fs.mkdir(path.dirname(report), { recursive: true });

  await fs.writeFile(report, JSON.stringify({
    result,
    kind: options.runtime.kind,
    elapsedMs: performance.now() - started,
    exitCode: launcher().exitCode,
    signal: launcher().signalCode,
    workerAlive: alive(pids.worker),
    shellAlive: alive(pids.shell),
    facts: JSON.parse(await fs.readFile(path.join(root, 'facts.json'), 'utf8')),
    disposerStarted: await fs.access(path.join(root, 'disposal-start')).then(() => true, () => false),
  }, null, 2));
  assert.deepEqual(result, { ok: false, code: 'deepseek_binary_cleanup' });
  await fs.access(options.launch.launchDir);
});

test('ACP settings владеет отдельной группой настоящего launcher и ждёт stop', {
  timeout: 900000,
}, async (t) => {
  const { options, ready } = await webFixture(t);
  const acp = await startDeepSeekAcpSettings(options);
  let worker;
  let shell;

  try {
    ({ worker, shell } = await ready());

    const workerStat = await fs.readFile(`/proc/${worker}/stat`, 'utf8');
    const workerFields = workerStat.slice(workerStat.lastIndexOf(')') + 2).split(' ');
    const launcherPid = Number(workerFields[1]);
    const launcherStat = await fs.readFile(`/proc/${launcherPid}/stat`, 'utf8');
    const launcherFields = launcherStat.slice(launcherStat.lastIndexOf(')') + 2).split(' ');

    assert.equal(Number(launcherFields[2]), launcherPid);
  } finally {
    await acp.stop();
  }

  assert.equal(alive(worker), false);
  assert.equal(alive(shell), false);
});

test('catalog создаёт собственную process group для настоящего binary', {
  timeout: 900000,
}, async (t) => {
  const { config, options } = await webFixture(t);
  let pgid;
  let closed;
  let launcherPid;

  const result = await readDeepSeekCatalog({
    config,
    env: { ...options.env, DEEPSEEK_API_KEY: 'synthetic-catalog-key' },
  }, {
    spawnProcess: (...args) => {
      const child = spawn(...args);

      launcherPid = child.pid;
      pgid = fs.readFile(`/proc/${child.pid}/stat`, 'utf8').then((stat) => (
        Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2])
      ));
      closed = new Promise((resolve) => child.once('close', resolve));

      return child;
    },
  });

  await closed;
  assert.ok(result.models.length > 0);
  assert.equal(await pgid, launcherPid);
  assert.equal(alive(launcherPid), false);
});

/**
 * Внешняя смерть launcher допускает только отдельный bounded бюджет для IPC disposal.
 * Штатный stop ниже проверяется сразу после возврата, без такого ожидания.
 */
async function waitForGone(pids, milliseconds = 6000) {
  const deadline = performance.now() + milliseconds;

  while (pids.some(alive) && performance.now() < deadline) {
    await pause(25);
  }

  assert.ok(pids.every((pid) => !alive(pid)), 'Worker и managed command исчезли за 6 с');
}

test('web и GLM на настоящем ELF проходят полную таблицу исходов остановки', {
  timeout: 900000,
}, async (t) => {
  const prepared = await prepareDeepSeekLifecycle();
  const report = [];
  const reportFile = path.join(deepSeekTestArtifactsRoot(), 's10c/outcomes.json');

  const scenarios = ['stop', 'sigterm', 'sigint', 'kill', 'disposal-timeout', 'escalation',
    'boot-kill', 'boot-restart', 'abort-startup'];

  await fs.mkdir(path.dirname(reportFile), { recursive: true });

  for (const [api, start] of [['web', startDeepSeekServer], ['glm', startGlmProcess]]) {
    for (const scenario of scenarios) {
      await t.test(`${api}: ${scenario}`, async (caseTest) => {
        const input = await webFixture(caseTest, {
          prepared,
          hang: scenario === 'disposal-timeout',
          boot: scenario === 'boot-kill',
        });
        const started = performance.now();

        try {
          if (scenario === 'abort-startup') {
            const controller = new AbortController();
            const spawnProcess = input.options.spawnProcess;

            input.options.signal = controller.signal;
            input.options.spawnProcess = (...args) => {
              const child = spawnProcess(...args);

              controller.abort(new Error('Fixture abort во время startup'));

              return child;
            };
            await assert.rejects(start(input.options));
            assert.equal(alive(input.launcher().pid), false);
          } else if (scenario === 'boot-kill') {
            const pending = start(input.options).then((server) => ({ server }), (error) => ({ error }));
            const barrier = path.join(input.root, 'boot-gate.ready');
            const deadline = Date.now() + 30000;
            let worker = 0;

            while (!worker && Date.now() < deadline) {
              worker = Number(await fs.readFile(barrier, 'utf8').catch(() => ''));

              if (!worker) {
                await pause(25);
              }
            }

            assert.ok(worker > 1, 'Loader достиг реального boot barrier');
            input.launcher().kill('SIGKILL');
            await waitForGone([worker]);

            const result = await pending;

            if (result.server) {
              await result.server.stop();
            }
          } else {
            const server = await start(input.options);
            const { worker, shell, containment } = await input.ready();

            assert.ok(['scope', 'fallback group'].includes(containment));

            if (scenario === 'escalation') {
              const pid = input.launcher().pid;
              const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');

              assert.equal(Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]), pid);
              process.kill(-pid, 'SIGSTOP');
              await assert.rejects(server.stop(), { code: 'deepseek_binary_cleanup' });
              await fs.access(input.options.launch.launchDir);
            } else if (scenario === 'disposal-timeout') {
              await assert.rejects(server.stop(), { code: 'deepseek_binary_cleanup' });
              await fs.access(input.options.launch.launchDir);
            } else {
              if (['kill', 'sigterm', 'sigint'].includes(scenario)) {
                const signals = {
                  kill: 'SIGKILL',
                  sigterm: 'SIGTERM',
                  sigint: 'SIGINT',
                };

                input.launcher().kill(signals[scenario]);
                await waitForGone([worker, shell]);
              }

              await server.stop();
              assert.equal(alive(worker), false);
              assert.equal(alive(shell), false);
              assert.equal(alive(input.launcher().pid), false);

              const marker = await fs.readFile(path.join(input.root, 'marker'), 'utf8');

              await pause(150);
              assert.equal(await fs.readFile(path.join(input.root, 'marker'), 'utf8'), marker);
            }

            report.push({
              api,
              scenario,
              containment,
              outcome: 'passed',
            });
          }

          if (['boot-kill', 'abort-startup'].includes(scenario)) {
            report.push({
              api,
              scenario,
              outcome: 'passed',
            });
          }
        } catch (error) {
          report.push({
            api,
            scenario,
            outcome: 'failed',
            message: error.message,
          });

          throw error;
        } finally {
          await fs.writeFile(reportFile, JSON.stringify({
            elapsedMs: performance.now() - started,
            cases: report,
          }, null, 2));
        }
      });
    }
  }
});

test('cleanup отказ после настоящего prompt сохраняет session и запрещает pre-prompt retry', {
  timeout: 900000,
}, async (t) => {
  const { options, root, ready } = await webFixture(t, { hang: true });
  const mock = await startDeepSeekLoopback();
  const cache = options.runtime.prefixArgs[options.runtime.prefixArgs.indexOf('--cache-dir') + 1];
  const artifact = path.join(cache, 'packages', options.runtime.metadata.packageId, 'generation');
  const document = path.join(root, 'settings.yaml');
  let sessionId;

  t.after(() => mock.stop());
  await fs.writeFile(document, '{}\n');

  const overlayPath = await writeDeepSeekLoopbackOverlay({
    root,
    artifact,
    endpoint: mock.endpoint,
    document,
  });

  await fs.appendFile(overlayPath, await fs.readFile(options.overlayPath, 'utf8'));
  await assert.rejects(runDeepSeekServerTurn({
    ...options,
    overlayPath,
    env: { ...options.env, DEEPSEEK_API_KEY: 'synthetic-loopback-key' },
    message: 'Проверь cleanup после единственного model request.',
    model: '["deepseek-official","deepseek-v4-flash"]',
    effort: 'off',
    signal: AbortSignal.timeout(60000),
    onSessionCreated: (id) => {
      sessionId = id;
    },
    startServer: async (input) => {
      const server = await startDeepSeekServer({ ...input, spawnProcess: options.spawnProcess });

      await ready();

      return server;
    },
  }), (error) => {
    assert.equal(error.code, 'deepseek_binary_cleanup');
    assert.equal(error.retryState, 'post_prompt');
    assert.equal(error.sessionId, sessionId);
    assert.ok(Array.isArray(error.steps));

    return true;
  });
  assert.ok(sessionId);
  assert.equal(mock.payloads.length, 1);
});
