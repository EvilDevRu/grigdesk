import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { installedFixture } from '../helpers/installedUpdateFixture.mjs';
import { loadInstalledModule } from '../helpers/installedBuildFixture.mjs';

/**
 * Настоящие receipt, подписанное задание и сервис снимков проходят обычную подготовку.
 * Только процессные порты worker удерживают drain, чтобы проверить порядок выхода main.
 */
async function applicationExit(t) {
  const box = await installedFixture(t, { mode: 'remote' });
  const calls = [];
  const draining = Promise.withResolvers();
  const drained = Promise.withResolvers();
  const executable = path.join(box.root, 'generations/0.2.0/desktop/GrigDesk');

  await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await box.manager.prepare((await box.create()).id);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(box.release.index)));
  globalThis.__installedExit = {
    calls,
    draining,
    drained,
  };

  const { createInstalledApplication } = await loadInstalledModule(t,
    'desktop/src/installedApplication.ts', box.release.publicKeyPem, {
      'shared/node/installedUpdateWorker.ts': `
        const f = globalThis.__installedExit;
        export async function createUpdateHandoff(root, id) {
          f.calls.push('handoff');

          return { jobId: id };
        }
        export async function launchUpdateWorker() {
          f.calls.push('worker');
        }
        export async function waitUpdateWorker(root, handoff, phase) {
          f.calls.push(phase);

          if (phase === 'drained') {
            f.draining.resolve();
            await f.drained.promise;
          }
        }
        export async function writeDesktopBootProof() {}
        export async function resumeDesktopHandoff() {
          throw new Error('Неожиданное восстановление');
        }
      `,
    });
  const app = await createInstalledApplication({
    executable,
    identity: { ...box.release.identity, version: '0.2.0' },
    localSelected: () => false,
    ownsLocal: () => false,
    remoteApi: () => ({ major: 0, minor: 1 }),
    confirm: async () => {
      calls.push('confirm');

      return true;
    },
    save: async () => {
      calls.push('save');
    },
    flushCookies: async () => {
      calls.push('cookies');
    },
    drainLogs: async () => {
      calls.push('logs');
    },
    exit: async () => {
      calls.push('exit');
    },
  });

  await app.port.action('check', {});
  box.onCleanup(() => {
    app.close();
    drained.resolve();
    delete globalThis.__installedExit;
  });
  assert.equal(app.port.state().job.stage, 'ready');
  assert.equal(app.canApplyReadyOnQuit(), true);

  return {
    app,
    calls,
    draining,
    drained,
  };
}

test('QUIT-READY: применение ждёт drain перед сохранением и выходом без второго вопроса', async (t) => {
  const f = await applicationExit(t);
  const applying = f.app.applyReadyOnQuit();

  await f.draining.promise;
  assert.deepEqual(f.calls, ['handoff', 'worker', 'accepted', 'drained']);

  const repeated = f.app.applyReadyOnQuit();

  assert.equal(repeated, applying);
  f.drained.resolve();
  assert.equal(await applying, 'applied');
  assert.equal(await repeated, 'applied');
  assert.deepEqual(f.calls, ['handoff', 'worker', 'accepted', 'drained',
    'save', 'cookies', 'logs', 'exit']);
});

for (const failed of [false, true]) {
  test(`QUIT-EXPLICIT: закрытие ждёт тот же handoff кнопки, отказ drain=${failed}`, async (t) => {
    const f = await applicationExit(t);
    const explicit = f.app.port.action('apply', { confirmed: true });
    const settled = explicit.then(() => null, (error) => error);

    await f.draining.promise;
    f.app.port.state().job.stage = 'stopping';
    assert.equal(f.app.canApplyReadyOnQuit(), true, 'Запущенное применение важнее ready-снимка');

    const quitting = f.app.applyReadyOnQuit();

    assert.equal(f.calls.includes('exit'), false);

    if (failed) {
      f.drained.reject(new Error('release_drain_not_proven'));
    } else {
      f.drained.resolve();
    }

    assert.equal(await quitting, failed ? 'idle' : 'applied');
    assert.equal((await settled)?.message ?? null, failed ? 'release_drain_not_proven' : null);
    assert.equal(f.calls.filter((call) => call === 'handoff').length, 1);
    assert.equal(f.calls.filter((call) => call === 'confirm').length, 1);
    assert.equal(f.calls.includes('exit'), !failed);
  });
}

test('QUIT-CLOSED: закрытый сервис не применяет сохранённое ready', async (t) => {
  const f = await applicationExit(t);

  f.app.close();
  assert.equal(f.app.canApplyReadyOnQuit(), false);
  assert.equal(await f.app.applyReadyOnQuit(), 'idle');
  assert.deepEqual(f.calls, []);
});
