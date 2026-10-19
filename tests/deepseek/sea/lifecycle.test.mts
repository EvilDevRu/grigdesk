import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { promisify } from 'node:util';

import { createAcpClient } from '../../../server/src/lib/acp/client.ts';

import {
  deepSeekLifecyclePidAlive,
  cleanupDeepSeekLifecycleCase,
  launchDeepSeekLifecycleCase,
  prepareDeepSeekLifecycle,
  stopDeepSeekLifecycleCase,
} from '../../helpers/deepseekLifecycle.mts';

/**
 * Внешняя смерть launcher даёт worker собственный бюджет на IPC disconnect и disposal.
 * Обычный stop ниже проверяется без такого eventual ожидания после возврата.
 */
async function waitForGone(pids: number[], timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;

  while (performance.now() < deadline) {
    if ((await Promise.all(pids.map(deepSeekLifecyclePidAlive))).every((alive) => !alive)) {
      return;
    }

    await pause(25);
  }

  assert.fail('После внешнего SIGKILL процессы не исчезли за 6 с');
}

test('S10a: настоящие worker и управляемый shell проходят таблицу остановки', {
  timeout: 600000,
}, async () => {
  const fixture = await prepareDeepSeekLifecycle();
  const report: Record<string, unknown>[] = [];
  const labels = ['stop', 'eof', 'sigterm', 'sigint', 'kill', 'disposal-timeout', 'escalation',
    'boot-kill', 'boot-restart'];

  try {
    for (const label of labels) {
      const run = await launchDeepSeekLifecycleCase(fixture, label);
      const start = performance.now();

      try {
        if (label === 'escalation') {
          process.kill(-run.launcher.pid!, 'SIGSTOP');
          await assert.rejects(stopDeepSeekLifecycleCase(run), /cleanup/u);
          await access(run.directory);
        } else if (label === 'disposal-timeout') {
          await assert.rejects(stopDeepSeekLifecycleCase(run), /cleanup/u);
          await access(run.directory);
        } else if (label === 'kill' || label === 'boot-kill') {
          run.launcher.kill('SIGKILL');
          await waitForGone([run.workerPid, ...(run.shellPid ? [run.shellPid] : [])], 6000);
        } else if (label === 'stop' || label === 'boot-restart') {
          await stopDeepSeekLifecycleCase(run);
        } else {
          if (label === 'eof') {
            run.launcher.stdin!.end();
          } else {
            run.launcher.kill(label === 'sigint' ? 'SIGINT' : 'SIGTERM');
          }

          const controller = new AbortController();
          let result;

          try {
            result = await Promise.race([
              run.exit,
              pause(6000, undefined, { signal: controller.signal }).then(() => {
                throw new Error('Остановка launcher превысила 6 с');
              }),
            ]);
          } finally {
            controller.abort();
          }

          assert.ok(result.code === 0 || label === 'sigint' && result.code === 130);
        }

        if (!['escalation', 'disposal-timeout'].includes(label)) {
          assert.equal(await deepSeekLifecyclePidAlive(run.launcher.pid!), false, `${label}: launcher жив`);
          assert.equal(await deepSeekLifecyclePidAlive(run.workerPid), false, `${label}: worker жив`);

          if (run.shellPid) {
            assert.equal(await deepSeekLifecyclePidAlive(run.shellPid), false, `${label}: shell жив`);
          }

          const marker = await readFile(run.marker, 'utf8').catch(() => '');

          await pause(200);
          assert.equal(await readFile(run.marker, 'utf8').catch(() => ''), marker,
            `${label}: marker продолжает меняться`);
        }

        report.push({
          label,
          outcome: 'passed',
          elapsedMs: performance.now() - start,
          workerPid: run.workerPid,
          shellPid: run.shellPid,
          containment: run.containment,
        });
        await writeFile(path.join(fixture.directory, 'stop-report.json'), JSON.stringify(report, null, 2));
      } catch (error) {
        report.push({
          label,
          outcome: 'failed',
          message: (error as Error).message,
          workerAlive: await deepSeekLifecyclePidAlive(run.workerPid),
          shellAlive: run.shellPid ? await deepSeekLifecyclePidAlive(run.shellPid) : false,
        });
        await writeFile(path.join(fixture.directory, 'stop-report.json'), JSON.stringify(report, null, 2));

        throw error;
      } finally {
        await cleanupDeepSeekLifecycleCase(fixture, run, label);
      }
    }
  } finally {
    await writeFile(path.join(fixture.directory, 'stop-report.json'), JSON.stringify(report, null, 2));
  }
});

test('production worker сохраняет cwd, env, patch с пробелами и чистые ACP frames', {
  timeout: 180000,
}, async () => {
  const fixture = await prepareDeepSeekLifecycle();
  const run = await launchDeepSeekLifecycleCase(fixture, 'protocol с пробелами');
  const client = createAcpClient(run.launcher, { requestTimeoutMs: 30000 });

  try {
    const initialized = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    }) as { protocolVersion: number };
    const facts = JSON.parse(await readFile(path.join(run.directory, 'facts.json'), 'utf8'));

    assert.equal(initialized.protocolVersion, 1);
    assert.equal(facts.cwd, run.directory);
    assert.equal(facts.value, 'значение с пробелами');
    assert.deepEqual(facts.argv, ['--profile', 'acp', '--patch', path.join(run.directory, 'overlay.yml')]);
    assert.equal(facts.execPath, path.join(fixture.cache, 'packages', fixture.packageId, 'node'));
    assert.match(run.output().stderr, /grigdesk-lifecycle-stderr/u);
    assert.ok(run.output().stdout.trim().split('\n').map((line) => JSON.parse(line))
      .every((frame) => frame.jsonrpc === '2.0'));
    client.close();
    assert.equal((await run.exit).code, 0);
    assert.equal(await deepSeekLifecyclePidAlive(run.workerPid), false);
    assert.equal(await deepSeekLifecyclePidAlive(run.shellPid!), false);
  } finally {
    client.close();
    await cleanupDeepSeekLifecycleCase(fixture, run, 'protocol');
  }
});

test('launcher сохраняет ненулевой exit code настоящего worker', { timeout: 180000 }, async () => {
  const fixture = await prepareDeepSeekLifecycle();
  const run = await launchDeepSeekLifecycleCase(fixture, 'worker-exit');

  try {
    assert.equal((await run.exit).code, 37);
    assert.equal(await deepSeekLifecyclePidAlive(run.workerPid), false);
  } finally {
    await cleanupDeepSeekLifecycleCase(fixture, run, 'worker-exit');
  }
});

test('чужой expect-package-id отказывает до старта worker и session', { timeout: 180000 }, async (t) => {
  const fixture = await prepareDeepSeekLifecycle();
  const directory = await mkdtemp(path.join(fixture.directory, 'mismatch-'));
  const home = path.join(directory, 'home');
  const overlay = path.join(directory, 'overlay.yml');
  const exec = promisify(execFile);

  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(home);
  await writeFile(overlay, '- insert:\n    - id: mismatch-probe\n      name: '
    + `${JSON.stringify(new URL(`file://${fixture.plugin}`).href)}\n`);
  await assert.rejects(exec(fixture.binary, [
    '--cache-dir', fixture.cache,
    '--expect-package-id', '0'.repeat(64),
    '--profile', 'acp', '--patch', overlay,
  ], {
    cwd: directory,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      DSH_HOME: home,
      GRIGDESK_TEST_STOP_DIR: directory,
    },
    timeout: 10000,
  }), (error: any) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');

    return true;
  });
  await assert.rejects(access(path.join(directory, 'worker.pid')), { code: 'ENOENT' });
});
