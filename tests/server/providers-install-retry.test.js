import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { isProviderInstallJob } from '../../shared/chat/providerInstallContracts.ts';
import { runCommand } from '../../server/src/lib/pluginInstall/runCommand.ts';
import { isTransientInstallFailure } from '../../server/src/lib/providerInstall/networkFailure.ts';
import { installFixture, current, start, completed, until } from './helpers/providerInstallFixture.js';

const TLS_ERROR = 'curl: (35) error:0A000126:SSL routines::unexpected eof while reading\n';

/**
 * Каждая попытка возвращает полный контракт runner и свой независимый вывод.
 * Последовательность результатов имитирует сеть без запуска внешних установщиков.
 */
function commandResult(overrides = {}) {
  return {
    code: 1,
    signal: null,
    timedOut: false,
    aborted: false,
    stdout: '',
    stderr: TLS_ERROR,
    stdoutTruncated: false,
    stderrTruncated: false,
    workspaceLimitExceeded: false,
    ...overrides,
  };
}

/**
 * Настоящий сервис и HTTP работают с временным состоянием и управляемой сетью.
 * Подменяется только процесс; probe начинает видеть новую версию после его успеха.
 */
async function retryFixture(t, { id = 'claude', operation = 'update', results, retrySleep } = {}) {
  const runs = [];
  const pauses = [];
  let fixture;

  fixture = await installFixture(t, {
    installed: operation !== 'install',
    runner: async (bin, args, options) => {
      const result = commandResult(results?.[runs.length]);

      runs.push({
        bin,
        args,
        options,
      });
      options.onStdout?.(result.stdout);
      options.onStderr?.(result.stderr);

      if (result.code === 0) {
        fixture.setInstalled(true);
        fixture.setVersion('2.0.0');
      }

      return result;
    },
    providerInstall: {
      retrySleep: async (ms, signal) => {
        pauses.push(ms);
        await retrySleep?.(ms, signal, fixture);
      },
    },
  });
  fixture.adapters.clear();
  fixture.provider.id = id;
  fixture.adapters.set(id, fixture.provider);

  return {
    ...fixture,
    runs,
    pauses,
  };
}

test('временные сетевые ошибки распознаются по выводу curl, npm и native CLI', () => {
  const transient = [
    TLS_ERROR,
    'curl: (6) Could not resolve host: example.invalid',
    'curl: (7) Failed to connect',
    'curl: (18) end of response with 100 bytes missing',
    'curl: (28) Operation timed out',
    'curl: (56) Recv failure: Connection reset by peer',
    'curl: (22) The requested URL returned error: 503',
    'npm error code ECONNRESET',
    'npm error code EAI_AGAIN',
    'npm error code E503',
    'HTTP/2 429',
    'Request failed with status code 502',
    'Failed to download: connection reset by peer',
    'TypeError: fetch failed',
  ];

  for (const stderr of transient) {
    assert.equal(isTransientInstallFailure(commandResult({ stderr })), true, stderr);
    assert.equal(isTransientInstallFailure(commandResult({ stdout: stderr, stderr: '' })), true, stderr);
  }

  for (const stderr of [
    'npm error code EACCES',
    'ENOENT npm',
    'HTTP 401 Unauthorized',
    'HTTP 403 Forbidden',
    'curl: (22) The requested URL returned error: 404',
    'curl: (60) SSL certificate problem',
    'Unsupported platform',
    'SHA256 checksum mismatch',
    `${TLS_ERROR}ENOSPC: no space left on device`,
    `${TLS_ERROR}certificate verify failed`,
  ]) {
    assert.equal(isTransientInstallFailure(commandResult({ stderr })), false, stderr);
  }

  for (const overrides of [
    { code: 0 },
    { aborted: true },
    { timedOut: true },
    { signal: 'SIGTERM' },
    { workspaceLimitExceeded: true },
  ]) {
    assert.equal(isTransientInstallFailure(commandResult(overrides)), false, JSON.stringify(overrides));
  }
});

test('установка и обновление всех CLI повторяются внутри одной операции', async (t) => {
  for (const id of ['claude', 'codex', 'kimi']) {
    for (const operation of ['install', 'update']) {
      await t.test(`${id} ${operation}`, async (scenario) => {
        const fixture = await retryFixture(scenario, {
          id,
          operation,
          results: [{}, {
            code: 0,
            stderr: '',
            stdout: 'готово\n',
          }],
          retrySleep: async (_ms, _signal, service) => {
            const live = await current(service.app);
            const competing = await start(service.app, id, operation);

            assert.equal(live.active.status, 'running');
            assert.equal(live.active.stage, 'download-install');
            assert.deepEqual(live.active.retry, { attempt: 2, attempts: 3 });
            assert.equal(competing.statusCode, 409, competing.body);
          },
        });
        const response = await start(fixture.app, id, operation);

        assert.equal(response.statusCode, 202, response.body);

        const job = (await completed(fixture.app, id)).recent[id];

        assert.equal(job.id, response.json().active.id);
        assert.equal(job.status, 'succeeded');
        assert.equal(job.outcome, operation === 'install' ? 'installed' : 'updated');
        assert.equal(fixture.runs.length, 2);
        assert.deepEqual(fixture.pauses, [2000]);
        assert.equal(job.outputTail, `${TLS_ERROR}готово\n`);
        assert.equal(fixture.calls.models.filter((options) => options?.refresh).length, 1);
        assert.equal(isProviderInstallJob(job), true);
      });
    }
  }
});

test('бюджет кончается на третьей попытке с последней причиной отказа', async (t) => {
  const fixture = await retryFixture(t, {
    results: [{}, {}, { stderr: 'npm error code ETIMEDOUT\n' }],
  });

  await start(fixture.app);

  const job = (await completed(fixture.app)).recent.claude;

  assert.equal(job.status, 'failed');
  assert.match(job.error.message, /ETIMEDOUT/u);
  assert.equal(fixture.runs.length, 3);
  assert.deepEqual(fixture.pauses, [2000, 5000]);
  assert.deepEqual(job.retry, { attempt: 3, attempts: 3 });
  assert.equal(fixture.calls.models.filter((options) => options?.refresh).length, 0);

  for (const retry of [null, {}, { attempt: 1, attempts: 3 }, { attempt: 4, attempts: 3 }]) {
    assert.equal(isProviderInstallJob({ ...job, retry }), false);
  }
});

test('локальный отказ, отмена и timeout не запускают новую команду', async (t) => {
  for (const result of [
    { stderr: 'EACCES' },
    { stderr: 'curl: (22) The requested URL returned error: 403' },
    { aborted: true },
    { timedOut: true },
    { signal: 'SIGKILL' },
  ]) {
    await t.test(JSON.stringify(result), async (scenario) => {
      const fixture = await retryFixture(scenario, { results: [result] });

      await start(fixture.app);

      const job = (await completed(fixture.app)).recent.claude;

      assert.equal(job.status, 'failed');
      assert.equal(fixture.runs.length, 1);
      assert.deepEqual(fixture.pauses, []);
    });
  }
});

test('прежний update-маршрут получает итог после retry', async (t) => {
  const fixture = await retryFixture(t, {
    results: [{}, {
      code: 0,
      stdout: 'финальный вывод',
      stderr: '',
    }],
  });

  delete fixture.provider.installation;

  const response = await fixture.app.inject({ method: 'POST', url: '/api/providers/claude/update' });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().ok, true);
  assert.equal(response.json().output, 'финальный вывод');
  assert.equal(fixture.runs.length, 2);
  assert.deepEqual(fixture.pauses, [2000]);
});

test('реальные worker завершаются до повтора, пауза отменяется закрытием сервиса', async (t) => {
  const fixture = await installFixture(t, { runner: runCommand });
  const counter = path.join(fixture.root, 'attempts');

  fixture.descriptor.update.executable = process.execPath;
  fixture.descriptor.update.args = ['-e', `
    require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'x');
    process.stderr.write(${JSON.stringify(TLS_ERROR)});
    process.exit(35);
  `];

  await start(fixture.app);
  await until(() => current(fixture.app), (snapshot) => snapshot.active?.retry?.attempt === 2);

  const saved = JSON.parse(await fs.readFile(fixture.config.providerInstallStatePath, 'utf8'));

  assert.equal(saved.worker, null, 'Пауза началась до подтверждённой остановки worker');
  await fixture.app.close();

  const final = JSON.parse(await fs.readFile(fixture.config.providerInstallStatePath, 'utf8'));

  assert.equal(final.active, null);
  assert.equal(final.recent.claude.status, 'interrupted');
  assert.equal(await fs.readFile(counter, 'utf8'), 'x', 'Закрытие запустило ещё одну попытку');
});

test('реальный процесс после TLS-обрыва обновляется со второй попытки', async (t) => {
  const pauses = [];
  const fixture = await installFixture(t, {
    runner: runCommand,
    providerInstall: {
      retrySleep: async (ms) => {
        const saved = JSON.parse(await fs.readFile(fixture.config.providerInstallStatePath, 'utf8'));

        pauses.push(ms);
        assert.equal(saved.worker, null);
      },
    },
  });
  const counter = path.join(fixture.root, 'attempts');

  fixture.descriptor.update.executable = process.execPath;
  fixture.descriptor.update.args = ['-e', `
    const fs = require('node:fs');
    const first = !fs.existsSync(${JSON.stringify(counter)});
    fs.appendFileSync(${JSON.stringify(counter)}, 'x');
    if (first) {
      process.stderr.write(${JSON.stringify(TLS_ERROR)});
      process.exit(35);
    }
    process.stdout.write('готово');
  `];

  await start(fixture.app);
  fixture.setVersion('2.0.0');

  const job = (await completed(fixture.app)).recent.claude;

  assert.equal(job.status, 'succeeded');
  assert.equal(job.outputTail, `${TLS_ERROR}готово`);
  assert.deepEqual(pauses, [2000]);
  assert.equal(await fs.readFile(counter, 'utf8'), 'xx');
});

test('неподтверждённый worker и исключение runner запрещают retry', async (t) => {
  for (const mode of ['worker', 'exception']) {
    await t.test(mode, async (scenario) => {
      let runs = 0;
      const pauses = [];
      const fixture = await installFixture(scenario, {
        runner: async (_bin, _args, options) => {
          runs += 1;

          if (mode === 'exception') {
            throw new Error('ECONNRESET');
          }

          await options.ownership.started({
            commandId: 'unconfirmed-fixture-worker',
            supervisorPid: process.pid,
            supervisorStartTime: '0',
            pid: process.pid,
            pgid: process.pid,
            startTime: '0',
          });

          return commandResult();
        },
        providerInstall: { retrySleep: async (ms) => pauses.push(ms) },
      });

      await start(fixture.app);
      await completed(fixture.app);
      assert.equal(runs, 1);
      assert.deepEqual(pauses, []);
    });
  }
});

test('все попытки и паузы расходуют один срок команды', { timeout: 5000 }, async (t) => {
  let now = Date.now();
  const timeouts = [];
  const fixture = await installFixture(t, {
    runner: async (_bin, _args, options) => {
      timeouts.push(options.timeoutMs);
      now += timeouts.length < 3 ? 200_000 : 50_000;

      if (timeouts.length < 3) {
        return commandResult();
      }

      fixture.setVersion('2.0.0');

      return commandResult({ code: 0, stderr: '' });
    },
    providerInstall: {
      retrySleep: async (ms) => {
        now += ms;
      },
    },
  });

  t.mock.method(Date, 'now', () => now);
  await fixture.app.inject({ method: 'POST', url: '/api/providers/claude/update' });

  const job = (await current(fixture.app)).recent.claude;

  assert.equal(job.status, 'succeeded');
  assert.deepEqual(timeouts, [600_000, 398_000, 193_000]);
});

test('недостаток общего срока запрещает следующую попытку', { timeout: 5000 }, async (t) => {
  let now = Date.now();
  let runs = 0;
  const fixture = await installFixture(t, {
    runner: async () => {
      runs += 1;
      now += 599_000;

      return commandResult();
    },
    providerInstall: {
      retrySleep: async () => assert.fail('Пауза не помещается в общий срок'),
    },
  });

  t.mock.method(Date, 'now', () => now);
  await fixture.app.inject({ method: 'POST', url: '/api/providers/claude/update' });

  const job = (await current(fixture.app)).recent.claude;

  assert.equal(job.status, 'failed');
  assert.equal(runs, 1);
  assert.equal(job.retry, undefined);
});
