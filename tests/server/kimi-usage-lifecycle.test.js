import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';

import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import kimi from '../../server/src/lib/executors/kimi.ts';
import { requestKimiManagedUsage } from '../../server/src/lib/kimi/usage.ts';
import { createShutdownCoordinator } from '../../server/src/lib/shutdown.ts';
import providersModule from '../../server/src/modules/providers/index.ts';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = require('fastify');

/**
 * Проверяет живое исполнение, отличая уже завершившийся zombie от оставшегося worker.
 * PID берётся только из собственного spawn или записи тестовой программы.
 */
async function alive(pid) {
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');

  return Boolean(stat && !stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z'));
}

/**
 * Ожидает наблюдаемое событие без зависимости от скорости запуска Node на машине.
 * Общий срок ограничен, поэтому сломанный сценарий не оставляет тест вечным.
 */
async function waitFor(check) {
  const deadline = performance.now() + 5000;

  while (!await check()) {
    assert.ok(performance.now() < deadline, 'Не наступило ожидаемое событие теста');
    await pause(10);
  }
}

/**
 * Настоящий локальный брокер не читает аккаунт и отмечает каждый свой запуск.
 * Cleanup сверяет точный argv перед сигналом и касается только программы фикстуры.
 */
async function fixture(t, mode = '--fixture-startup-wait') {
  const base = path.join(artifactsPath({ env: process.env, home: os.homedir() }), 'kimi-usage/lifecycle');

  await fs.mkdir(base, { recursive: true });

  const root = await fs.mkdtemp(path.join(base, 'case-'));
  const bin = path.join(root, 'kimi.mjs');
  const marker = path.join(root, 'pids');
  const source = new URL('../fixtures/kimi-server/fake-usage.mjs', import.meta.url).href;

  await fs.writeFile(bin, `#!${process.execPath}\n`
    + `import { appendFile } from 'node:fs/promises';\n`
    + `await appendFile(${JSON.stringify(marker)}, process.pid + '\\n');\n`
    + `process.argv.push(${JSON.stringify(mode)});\n`
    + `await import(${JSON.stringify(source)});\n`, { mode: 0o700 });

  const pids = async () => (await fs.readFile(marker, 'utf8').catch(() => ''))
    .trim().split('\n').filter(Boolean).map(Number);

  t.after(async () => {
    for (const pid of await pids()) {
      const argv = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');

      if (argv.split('\0').includes(bin)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Свой процесс уже вышел.
        }
      }
    }

    await fs.rm(root, { recursive: true, force: true });
  });

  return {
    root,
    pids,
    config: {
      kimiBin: bin,
      kimiHome: path.join(root, 'home'),
      kimiRuntimeHome: path.join(root, 'runtime'),
      modelsPath: path.join(root, 'models.json'),
      providerUsageSeenPath: path.join(root, 'usage.json'),
      envPath: path.join(root, 'fixture.env'),
    },
  };
}

test('отменённая проверка Kimi не создаёт workspace и не запускает CLI', async (t) => {
  const { config } = await fixture(t);
  const controller = new AbortController();

  controller.abort();

  const outcome = await requestKimiManagedUsage(config, {
    signal: controller.signal,
    spawnProcess: () => assert.fail('Отменённая проверка не должна запускать CLI'),
  });

  assert.equal(outcome.reason, 'cancelled');
  await assert.rejects(fs.stat(config.kimiRuntimeHome), { code: 'ENOENT' });
});

test('отмена Kimi закрывает брокер во время запуска и HTTP-чтения', async (t) => {
  for (const mode of ['--fixture-startup-wait', '--fixture-request-wait']) {
    await t.test(mode, { timeout: 10000 }, async (scenario) => {
      const { config, pids } = await fixture(scenario, mode);
      const controller = new AbortController();
      let requesting = false;
      const pending = requestKimiManagedUsage(config, {
        signal: controller.signal,
        fetchImpl: (url, options) => {
          requesting = true;

          return fetch(url, options);
        },
      });

      await waitFor(async () => (await pids()).length > 0);

      if (mode === '--fixture-request-wait') {
        await waitFor(() => requesting);
      }

      controller.abort();

      assert.equal((await pending).reason, 'cancelled');
      assert.equal(await alive((await pids())[0]), false);
    });
  }
});

test('Kimi не начинает повтор после отмены во время паузы', { timeout: 10000 }, async (t) => {
  const { config, pids } = await fixture(t, '--fixture-request-error');
  const controller = new AbortController();
  let sleeps = 0;

  await kimi.usage(config, {
    signal: controller.signal,
    sleep: async () => {
      sleeps += 1;
      controller.abort();
    },
  });

  assert.equal(sleeps, 1);
  assert.equal((await pids()).length, 1);
  assert.equal(await alive((await pids())[0]), false);
});

test('таймаут Kimi завершает потомка и при уже вышедшем launcher', async (t) => {
  for (const earlyExit of [false, true]) {
    await t.test(String(earlyExit), { timeout: 10000 }, async (scenario) => {
      const { config } = await fixture(scenario);
      let child;
      let descendant;
      const source = `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
        child.once('spawn', () => {
          console.error(JSON.stringify({ pid: child.pid }));
          if (${earlyExit}) process.exit(17);
        });
        process.on('SIGTERM', () => process.exit(0));
        setInterval(() => {}, 1000);
      `;

      scenario.after(() => {
        child?.kill('SIGKILL');

        if (descendant) {
          try {
            process.kill(descendant, 'SIGKILL');
          } catch {
            // Свой потомок уже вышел.
          }
        }
      });

      const outcome = await requestKimiManagedUsage(config, {
        startupTimeoutMs: 300,
        spawnProcess: (_bin, _args, options) => {
          child = spawn(process.execPath, ['-e', source], options);
          child.stderr.on('data', (chunk) => {
            const match = chunk.toString().match(/"pid":(\d+)/u);

            if (match) {
              descendant = Number(match[1]);
            }
          });

          return child;
        },
      });

      assert.equal(outcome.reason, 'startup_timeout');
      assert.ok(descendant);
      await waitFor(async () => !await alive(descendant));
    });
  }
});

test('закрытие Fastify и drain сервера ждут завершения опроса Kimi', async (t) => {
  for (const drain of [false, true]) {
    await t.test(drain ? 'shutdown' : 'preClose', { timeout: 10000 }, async (scenario) => {
      const { config, pids } = await fixture(scenario);
      const app = Fastify({ logger: false });
      let completed = false;
      const events = [];
      const shutdown = createShutdownCoordinator({
        close: () => app.close(),
        timeoutMs: 8000,
        exit: () => {},
      });

      app.decorate('shutdown', shutdown);
      app.decorate('sse', {
        clientCount: () => 0,
        broadcast: (event) => events.push(event),
      });
      await app.register(providersModule, {
        prefs: { read: () => ({ providerUsageAutoRefresh: true }) },
        config,
        env: {},
        getProviderAdapters: async () => new Map([['fixture', {
          id: 'fixture',
          name: 'Fixture',
          kind: 'api',
          usage: (_config, deps) => kimi.usage(config, deps),
        }]]),
        getModelsRegistry: async () => ({}),
      });
      scenario.after(() => app.close());

      const polling = app.refreshProvidersUsage().finally(() => {
        completed = true;
      });

      await waitFor(async () => (await pids()).length > 0);
      await (drain ? shutdown.begin('проверка остановки') : app.close());

      assert.equal(await alive((await pids())[0]), false);
      await polling;
      assert.equal(completed, true);
      assert.deepEqual(events, [], 'Отменённый опрос не публикует SSE после остановки');
      await app.refreshProvidersUsage();
      assert.equal((await pids()).length, 1, 'Остановленный модуль не запускает новый опрос');
    });
  }
});
