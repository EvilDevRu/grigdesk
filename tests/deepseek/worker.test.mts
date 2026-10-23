import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { runLauncherWorker } from '../../deepseek/src/launcher/worker.ts';

/**
 * Только entry подменён локальной программой; forwarding, IPC и итог берутся из launcher.
 * Worker держится живым после подтверждения, поэтому успех требует настоящего SIGKILL.
 */
async function workerCase(t: test.TestContext, body: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'launcher-disposal-'));

  t.after(() => rm(directory, { recursive: true, force: true }));
  await symlink(process.execPath, path.join(directory, 'node'));
  await writeFile(path.join(directory, 'worker-bootstrap.mjs'), body);

  return runLauncherWorker({
    directory,
    entry: 'fixture',
    args: [],
    capture: true,
  });
}

for (const code of [0, 130]) {
  test(`launcher сохраняет подтверждённый ${code} после добивания worker`, async (t) => {
    const result = await workerCase(t, `
setInterval(() => {}, 1000);
process.send({ type: 'worker-disposed', code: ${code} });
`);

    assert.equal(result.code, code);
  });
}

test('launcher не принимает повреждённое подтверждение и выход без кода', async (t) => {
  const result = await workerCase(t, `
process.send({ type: 'worker-disposed', code: 1 });
setTimeout(() => process.kill(process.pid, 'SIGKILL'), 30);
`);

  assert.equal(result.code, 75);
});

test('внешний SIGKILL после подтверждения не становится добиванием launcher', async (t) => {
  const result = await workerCase(t, `
process.send({ type: 'worker-disposed', code: 0 }, () => process.kill(process.pid, 'SIGKILL'));
`);

  assert.equal(result.code, 75);
});

test('переполнение capture остаётся отказом даже после подтверждения', async (t) => {
  const result = await workerCase(t, `
setInterval(() => {}, 1000);
process.on('SIGTERM', () => {});
process.stdout.write('x'.repeat(70000), () => process.send({ type: 'worker-disposed', code: 0 }));
`);

  assert.equal(result.code, 75);
});

test('реальный код отказа worker не заменяется подтверждённым кодом', async (t) => {
  const result = await workerCase(t, `
process.send({ type: 'worker-disposed', code: 0 }, () => process.exit(75));
`);

  assert.equal(result.code, 75);
});

/**
 * Изолируем саму production stop-функцию без загрузки всего host и внешних сервисов.
 * Управляемые dispose, IPC и таймер проверяют порядок эффектов; весь host покрывает ELF-тест.
 */
async function hostStop(dispose: () => Promise<void>, connected = true) {
  const source = await readFile(new URL('../../deepseek/src/host/entry.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function stop(code)');
  const end = source.indexOf("process.once('SIGTERM'", start);
  const messages: unknown[] = [];
  const exits: number[] = [];
  const timers: { callback: () => void; milliseconds: number }[] = [];
  const stop = runInNewContext(`let stopping = false;\n${source.slice(start, end)}\nstop`, {
    context: { fiber: { dispose } },
    process: {
      connected,
      send(message: unknown, callback: () => void) {
        messages.push(JSON.parse(JSON.stringify(message)));
        callback();
      },
      exit: (code: number) => exits.push(code),
    },
    setTimeout(callback: () => void, milliseconds: number) {
      timers.push({ callback, milliseconds });
    },
  }) as (code: number) => Promise<void>;

  return {
    stop,
    messages,
    exits,
    timers,
  };
}

test('host подтверждает уборку строго после разрешения dispose', async () => {
  let finish!: () => void;
  const fixture = await hostStop(() => new Promise<void>((resolve) => {
    finish = resolve;
  }));
  const stopped = fixture.stop(130);

  assert.deepEqual(fixture.messages, []);
  assert.deepEqual(fixture.exits, []);
  finish();
  await stopped;
  assert.deepEqual(fixture.messages, [{ type: 'worker-disposed', code: 130 }]);
  assert.deepEqual(fixture.exits, [130]);
});

test('ошибка dispose не даёт подтверждения', async () => {
  const fixture = await hostStop(async () => {
    throw new Error('disposer failed');
  });

  await assert.rejects(fixture.stop(0), /disposer failed/u);
  assert.deepEqual(fixture.messages, []);
});

test('зависший dispose сохраняет deadline 3 с и код 75 без IPC', async () => {
  const fixture = await hostStop(() => new Promise(() => {}));

  void fixture.stop(0);
  assert.equal(fixture.timers[0]!.milliseconds, 3000);
  fixture.timers[0]!.callback();
  assert.deepEqual(fixture.messages, []);
  assert.deepEqual(fixture.exits, [75]);
});

test('без IPC и при нештатном коде host не подтверждает уборку', async () => {
  for (const [connected, code] of [[false, 0], [true, 1]] as const) {
    const fixture = await hostStop(async () => {}, connected);

    await fixture.stop(code);
    assert.deepEqual(fixture.messages, []);
    assert.deepEqual(fixture.exits, [code]);
  }
});
