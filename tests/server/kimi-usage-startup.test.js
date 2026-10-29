import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import {
  classifyKimiUsageResponse,
  requestKimiManagedUsage,
} from '../../server/src/lib/kimi/usage.ts';
import { withExternalCliProcess } from '../../server/src/lib/providerInstall/externalCliProcess.ts';

/**
 * Отдельные каталоги npm-entry и Node воспроизводят установку через nvm.
 * Фикстура не использует системный Node, аккаунт Kimi или рабочее состояние сервера.
 */
async function usageFixture(t) {
  const base = path.join(artifactsPath({ env: process.env, home: os.homedir() }), 'kimi-usage/tests');

  await fs.mkdir(base, { recursive: true });

  const root = await fs.mkdtemp(path.join(base, 'startup-'));
  const nodeBin = path.join(root, 'node-bin');
  const npmBin = path.join(root, 'npm-bin');
  const entry = path.join(root, 'main.mjs');
  const bin = path.join(npmBin, 'kimi');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(nodeBin);
  await fs.mkdir(npmBin);
  await fs.symlink(process.execPath, path.join(nodeBin, 'node'));
  await fs.copyFile(new URL('../fixtures/kimi-server/fake-usage.mjs', import.meta.url), entry);
  await fs.chmod(entry, 0o755);
  await fs.symlink(entry, bin);

  return {
    root,
    nodeBin,
    config: {
      kimiBin: bin,
      kimiHome: path.join(root, '.kimi-code'),
      kimiRuntimeHome: path.join(root, 'runtime'),
    },
  };
}

test('Kimi usage запускает npm-entry с отдельным Node в прямой и подготовленной среде', async (t) => {
  for (const prepared of [false, true]) {
    await t.test(prepared ? 'пользовательский shell' : 'родительский PATH', async (scenario) => {
      const { root, nodeBin, config } = await usageFixture(scenario);
      const previousPath = process.env.PATH;

      scenario.after(() => {
        process.env.PATH = previousPath;
      });
      process.env.PATH = prepared ? path.join(root, 'server-without-node') : nodeBin;

      const context = {
        providerId: 'kimi',
        executable: config.kimiBin,
        resourceKey: 'a'.repeat(64),
        leaseDirectory: path.join(root, 'leases'),
        env: { PATH: nodeBin },
      };
      const request = () => requestKimiManagedUsage(config, { startupTimeoutMs: 5000 });
      const outcome = await (prepared ? withExternalCliProcess(context, request) : request());

      assert.deepEqual(outcome, {
        result: {
          kind: 'ok',
          summary: {
            used: 1,
            limit: 10,
            fixturePath: nodeBin,
          },
        },
      });
      assert.equal(JSON.stringify(outcome).includes('usage-fixture-token'), false);
    });
  }
});

test('Kimi usage немедленно сообщает ошибку spawn и ранний выход вместо таймаута', async (t) => {
  const { root, config } = await usageFixture(t);
  const cases = [
    {
      name: 'файл отсутствует',
      bin: path.join(root, 'missing'),
      error: /ENOENT/u,
    },
    {
      name: 'процесс вышел',
      source: 'process.exit(17)',
      error: /код 17/u,
    },
    {
      name: 'вывод ошибки',
      source: 'console.error("fixture failure"); process.exit(18)',
      error: /fixture failure/u,
    },
    {
      name: 'выход сигналом',
      source: 'process.kill(process.pid, "SIGTERM")',
      error: /SIGTERM/u,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const selected = { ...config, kimiBin: entry.bin ?? process.execPath };
      const outcome = await requestKimiManagedUsage(selected, {
        startupTimeoutMs: 5000,
        spawnProcess: (bin, args, options) => spawn(bin, entry.source ? ['-e', entry.source] : args, options),
        fetchImpl: async () => {
          assert.fail('Запрос не должен уходить до готовности брокера');
        },
      });

      assert.equal(outcome.reason, 'spawn_failed');
      assert.match(outcome.error, entry.error);
      assert.match(classifyKimiUsageResponse(outcome).message, /не смог запустить/u);
    });
  }
});

test('Kimi usage сохраняет настоящий таймаут и останавливает только свой child', async (t) => {
  const { config } = await usageFixture(t);
  let child;

  t.after(() => child?.kill('SIGKILL'));

  const outcome = await requestKimiManagedUsage(config, {
    startupTimeoutMs: 50,
    spawnProcess: (_bin, _args, options) => {
      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);

      return child;
    },
    fetchImpl: async () => {
      assert.fail('Без готовности запросы запрещены');
    },
  });

  assert.equal(outcome.reason, 'startup_timeout');
  assert.match(classifyKimiUsageResponse(outcome).message, /не успел запуститься/u);
  assert.equal(child.signalCode, 'SIGTERM');
});
