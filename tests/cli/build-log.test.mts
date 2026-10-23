import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { requiredApi } from './helpers/menuFixture.mts';
import { terminalBuildFixture, launchBuild } from './helpers/buildFixture.mts';

for (const override of [false, true]) {
  test(`BL-ROTATE: 12 → 10 + latest, D override=${override}, чужое сохранено`, async (t) => {
    const open = await requiredApi('cli/buildLog.ts', 'openBuildLog');
    const home = await mkdtemp(path.join(os.tmpdir(), 'ctl-build-log-'));
    const data = path.join(home, override ? 'override-data' : '.grigdesk');
    const directory = path.join(data, 'artifacts/ctl-build');
    const history = path.join(data, 'state/ctl-build-timings.json');
    const env = { HOME: home, ...(override ? { GRIGDESK_HOME: data } : {}) };

    t.after(() => rm(home, { recursive: true, force: true }));

    const first = await open({ env, home });

    await first.write('журнал 0\n');
    await first.close();
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    await mkdir(path.dirname(history), { recursive: true });
    await writeFile(history, 'история не является журналом');
    await writeFile(path.join(directory, 'owner.log'), 'посторонний файл');

    const paths: string[] = [first.path];

    for (let index = 1; index < 12; index++) {
      const log = await open({ env, home });

      paths.push(log.path);
      assert.equal(path.dirname(log.path), directory);
      await log.write(`журнал ${index}\n`);
      await log.close();
      assert.equal((await lstat(log.path)).mode & 0o777, 0o600);
    }

    const files = await readdir(directory);
    const own = files.filter((file) => /^build-.*\.log$/u.test(file));
    const latest = path.join(directory, 'latest.log');

    assert.equal(own.length, 10);
    assert.equal(new Set(paths).size, 12);
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    assert.ok((await lstat(latest)).isSymbolicLink());
    assert.equal(path.isAbsolute(await readlink(latest)), false);
    assert.equal(await readFile(latest, 'utf8'), 'журнал 11\n');
    assert.equal(await readFile(path.join(directory, 'owner.log'), 'utf8'), 'посторонний файл');
    assert.equal(await readFile(history, 'utf8'), 'история не является журналом');
  });
}

test('BL-WRITE-FAIL: отказ открытия журнала понятен и происходит до сборочных команд', async (t) => {
  const box = await terminalBuildFixture(t);

  await mkdir(box.env.GRIGDESK_HOME, { recursive: true });
  await writeFile(path.join(box.env.GRIGDESK_HOME, 'artifacts'), 'не каталог');

  const session = launchBuild(t, box, 'web');
  const result = await session.done;

  assert.notEqual(result.code, 0, 'Сборка прошла, хотя журнал создать невозможно');
  assert.match(session.output(), /журнал|log/iu);
  assert.deepEqual(await box.calls(), [], 'До открытия журнала нельзя вызывать сборщик');
});
