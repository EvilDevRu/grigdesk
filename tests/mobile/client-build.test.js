import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildClient } from '../../tools/mobile-client.mts';

/**
 * Подменяются только внешние компиляторы; staging, sealing и копирование выполняются всерьёз.
 * Старый app и рабочий web/dist остаются отдельными от нового полного приложения.
 */
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-client-build-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'web/dist'), { recursive: true });
  await mkdir(path.join(root, 'mobile/android/app'), { recursive: true });
  await writeFile(path.join(root, 'web/dist/index.html'), 'старый web');
  await writeFile(path.join(root, 'mobile/android/app/sentinel'), 'прежнее приложение');

  const commands = [];
  const run = async (command, args) => {
    commands.push([command, ...args]);

    if (command === 'npm') {
      const output = args[args.indexOf('--outDir') + 1];

      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, 'index.html'), '<div>полный UI</div>');
    } else {
      assert.equal(args.at(-1), ':client:assembleDebug');
      await mkdir(path.join(root, 'mobile/android/client/build/outputs/apk/debug'), { recursive: true });
      await writeFile(path.join(root, 'mobile/android/client/build/outputs/apk/debug/client-debug.apk'),
        'fixture');
    }

    return { stdout: '', stderr: '' };
  };

  return {
    root,
    commands,
    run,
    destination: path.join(root, 'apk'),
  };
}

test('новый build кладёт запечатанный UI в client/assets и собирает только :client', async (t) => {
  const env = await fixture(t);

  await buildClient(env);

  const assets = path.join(env.root, 'mobile/android/client/src/main/assets/ui');

  assert.match(await readFile(path.join(assets, 'index.html'), 'utf8'), /полный UI/);

  const api = JSON.parse(await readFile(path.join(assets, 'api-version.json'), 'utf8'));

  assert.deepEqual(api, { major: 0, minor: 1 });
  assert.ok(JSON.parse(await readFile(path.join(assets, 'release.json'), 'utf8')).id);
  assert.equal(await readFile(path.join(env.destination, 'grigdesk-mobile-debug.apk'), 'utf8'), 'fixture');
  assert.equal(await readFile(path.join(env.root, 'web/dist/index.html'), 'utf8'), 'старый web');
  assert.equal(await readFile(path.join(env.root, 'mobile/android/app/sentinel'), 'utf8'),
    'прежнее приложение');
  assert.equal(env.commands.some((command) => command.some((arg) => /cap|:app:/.test(arg))), false);
});

test('ошибка web сохраняет прежние assets и не вызывает Gradle', async (t) => {
  const env = await fixture(t);
  const assets = path.join(env.root, 'mobile/android/client/src/main/assets/ui');

  await mkdir(assets, { recursive: true });
  await writeFile(path.join(assets, 'index.html'), 'прежний пакет');
  await assert.rejects(buildClient({ ...env, run: async () => {
    throw new Error('fixture compiler failed');
  } }), /fixture compiler failed/);
  assert.equal(await readFile(path.join(assets, 'index.html'), 'utf8'), 'прежний пакет');
  await assert.rejects(access(path.join(env.destination, 'grigdesk-mobile-debug.apk')));
});

test('release без прежнего ключа не начинает сборку и не создаёт подпись', async (t) => {
  const env = await fixture(t);

  await assert.rejects(buildClient({
    ...env,
    release: true,
    env: {},
  }), /прежний ключ/);
  assert.deepEqual(env.commands, []);
  await assert.rejects(access(env.destination));
});
