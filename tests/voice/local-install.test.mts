import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { installLocalEngine } from '../../voice/src/local/install.ts';
import { acquireDirectoryLock, directoryLockOwnedBy } from '../../shared/node/directoryLock.ts';
import { beforeCompletion, eventually, localFixture } from './helpers.mts';

for (const engineId of ['piper', 'silero'] as const) {
  test(`voice-install-${engineId}-принимает-staging-и-публикует-готовый-runtime`, async (t) => {
    const f = await localFixture(t, engineId);
    const result = await installLocalEngine(f.spec);

    assert.equal(existsSync(result.manifestPath), true);

    const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
    const synthesis = JSON.parse(await fs.readFile(f.synthLog, 'utf8'));
    const model = synthesis.args[synthesis.args.indexOf('--model') + 1];

    assert.equal(result.engineId, engineId);
    assert.equal(manifest.id, f.pkg.id);
    assert.equal(synthesis.text, 'проверка связи');
    assert.ok(model.startsWith(path.join(f.voiceDir, 'cache')));
    assert.ok((await fs.lstat(path.join(f.voiceDir, 'engines', engineId, 'venv'))).isSymbolicLink());

    const before = await fs.readFile(f.pipLog, 'utf8');

    await installLocalEngine(f.spec);
    assert.equal(await fs.readFile(f.pipLog, 'utf8'), before);
  });

  test(`voice-install-${engineId}-отказ-приёмки-не-публикует-манифест`, async (t) => {
    const f = await localFixture(t, engineId);

    await fs.writeFile(f.silent, '1');
    await assert.rejects(installLocalEngine(f.spec), /тишин/iu);

    const group = engineId === 'piper' ? 'voices' : 'models';

    await assert.rejects(fs.access(path.join(f.voiceDir, 'engines', engineId,
      group, f.pkg.id, 'voice.json')), { code: 'ENOENT' });
    await fs.rm(f.silent);

    const retried = await installLocalEngine(f.spec);

    assert.equal(JSON.parse(await fs.readFile(retried.manifestPath, 'utf8')).id, f.pkg.id);
  });
}

test('voice-install-кэш-готов-первый-pip-падает-повтор-восстанавливает', async (t) => {
  const f = await localFixture(t, 'piper');
  const cache = path.join(f.voiceDir, 'cache', 'piper-irina.tar.gz');

  await fs.mkdir(path.dirname(cache), { recursive: true });
  await fs.writeFile(cache, f.bytes);
  await fs.writeFile(f.failPip, '1');
  await assert.rejects(installLocalEngine(f.spec));

  const result = await installLocalEngine(f.spec);

  assert.equal(JSON.parse(await fs.readFile(result.manifestPath, 'utf8')).id, 'irina');
  assert.equal((await fs.readFile(f.pipLog, 'utf8')).trim().split('\n').length, 2);
  assert.deepEqual(f.network.ranges, [], 'исправный кэш не скачивался снова');
});

test('voice-install-реальный-обрыв-сохраняет-prefix-и-повтор-запрашивает-Range', async (t) => {
  const f = await localFixture(t, 'silero');
  const cache = path.join(f.voiceDir, 'cache', 'silero-v5_5_ru.pt');

  f.network.breakNextBody();

  const controller = new AbortController();
  const first = installLocalEngine({ ...f.spec, signal: controller.signal })
    .then(() => null, (error: unknown) => error);

  try {
    await beforeCompletion(
      eventually(async () => (await fs.stat(cache).catch(() => null))?.size === 100), first,
    );
    f.network.disconnect();
    assert.ok(await first, 'обрыв не считается успехом');
  } finally {
    controller.abort();
    await first;
  }

  await installLocalEngine(f.spec);
  assert.ok(f.network.ranges.includes('bytes=100-'));
  assert.deepEqual(await fs.readFile(cache), f.bytes);
});

test('voice-install-200-вместо-206-заменяет-prefix', async (t) => {
  const f = await localFixture(t, 'silero');
  const cache = path.join(f.voiceDir, 'cache', 'silero-v5_5_ru.pt');

  await fs.mkdir(path.dirname(cache), { recursive: true });
  await fs.writeFile(cache, f.bytes.subarray(0, 100));
  f.network.ignoreRange();
  await installLocalEngine(f.spec);
  assert.deepEqual(await fs.readFile(cache), f.bytes);
});

test('voice-install-полный-битый-кэш-перекачивается', async (t) => {
  const f = await localFixture(t, 'silero');
  const cache = path.join(f.voiceDir, 'cache', 'silero-v5_5_ru.pt');

  await fs.mkdir(path.dirname(cache), { recursive: true });
  await fs.writeFile(cache, Buffer.alloc(f.bytes.length));
  await installLocalEngine(f.spec);
  assert.deepEqual(await fs.readFile(cache), f.bytes);
  assert.ok(f.network.ranges.includes(''), 'полный запрос после повреждения');
});

test('voice-install-неверный-sha-не-создаёт-engine', async (t) => {
  const f = await localFixture(t, 'silero');

  assert.ok(f.pkg.engineId === 'silero');

  await assert.rejects(installLocalEngine({
    ...f.spec,
    package: { ...f.pkg, fileSha256: '0'.repeat(64) },
  }), /sha|ожидалось|сумм/iu);
  await assert.rejects(fs.access(path.join(f.voiceDir, 'engines', 'silero')), { code: 'ENOENT' });
});

test('voice-install-piper-понимает-dot-members', async (t) => {
  const f = await localFixture(t, 'piper', 'dot');
  const result = await installLocalEngine(f.spec);

  assert.equal(JSON.parse(await fs.readFile(result.manifestPath, 'utf8')).id, 'irina');

  const accepted = JSON.parse(await fs.readFile(f.synthLog, 'utf8'));

  assert.match(accepted.text, /Проверка/iu);
});

test('voice-install-416-сбрасывает-префикс-ровно-один-раз', async (t) => {
  const f = await localFixture(t, 'silero');
  const cache = path.join(f.voiceDir, 'cache', 'silero-v5_5_ru.pt');

  await fs.mkdir(path.dirname(cache), { recursive: true });
  await fs.writeFile(cache, f.bytes.subarray(0, 100));
  f.network.rejectRequests(1);

  const result = await installLocalEngine(f.spec);

  assert.deepEqual(f.network.ranges, ['bytes=100-', '']);
  assert.deepEqual(await fs.readFile(cache), f.bytes);
  assert.equal(JSON.parse(await fs.readFile(result.manifestPath, 'utf8')).id, f.pkg.id);
});

test('voice-install-повторный-416-завершает-попытку', async (t) => {
  const f = await localFixture(t, 'silero');
  const cache = path.join(f.voiceDir, 'cache', 'silero-v5_5_ru.pt');

  await fs.mkdir(path.dirname(cache), { recursive: true });
  await fs.writeFile(cache, f.bytes.subarray(0, 100));
  f.network.rejectRequests(2);
  await assert.rejects(installLocalEngine(f.spec), /повторно.*416/iu);
  assert.deepEqual(f.network.ranges, ['bytes=100-', '']);
  await assert.rejects(fs.access(path.join(f.voiceDir, 'engines', 'silero')), { code: 'ENOENT' });
});

test('voice-install-неверный-Content-Range-сохраняет-префикс', async (t) => {
  const f = await localFixture(t, 'silero');
  const cache = path.join(f.voiceDir, 'cache', 'silero-v5_5_ru.pt');
  const prefix = f.bytes.subarray(0, 100);

  await fs.mkdir(path.dirname(cache), { recursive: true });
  await fs.writeFile(cache, prefix);
  f.network.invalidNextRange();
  await assert.rejects(installLocalEngine(f.spec), /Content-Range/u);
  assert.deepEqual(await fs.readFile(cache), prefix);
  await assert.rejects(fs.access(path.join(f.voiceDir, 'engines', 'silero')), { code: 'ENOENT' });
  await installLocalEngine(f.spec);
  assert.deepEqual(f.network.ranges, ['bytes=100-', 'bytes=100-']);
  assert.deepEqual(await fs.readFile(cache), f.bytes);
});

test('voice-install-занятый-lock-не-снимает-чужого-владельца', async (t) => {
  const f = await localFixture(t, 'silero');
  const lockPath = path.join(f.voiceDir, 'cache', 'install.lock');

  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  const owner = await acquireDirectoryLock(lockPath, { waitMs: 0 });

  t.after(() => owner.release());
  await assert.rejects(installLocalEngine(f.spec), /уже идёт/iu);
  assert.equal(await directoryLockOwnedBy(lockPath, owner.owner), true);
  await owner.release();
  await installLocalEngine(f.spec);
});

test('voice-install-конкурент-не-входит-в-pip-удержанного-владельца',
  { timeout: 15000 }, async (t) => {
    const f = await localFixture(t, 'silero');
    const controller = new AbortController();
    let entered!: () => void;
    let release!: () => void;

    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first: Promise<unknown> | undefined;
    const cleanup = async () => {
      release();
      controller.abort();
      await first?.catch(() => undefined);
    };

    t.after(cleanup);
    first = installLocalEngine({
      ...f.spec,
      signal: controller.signal,
      run: async (command, args, options) => {
        if (args[0] === '-m' && args[1] === 'pip') {
          entered();
          await barrier;
        }

        return f.run(command, args, options);
      },
    });

    try {
      await beforeCompletion(inside, first);
      await assert.rejects(installLocalEngine(f.spec), /уже идёт/iu);
      release();
      await first;
    } finally {
      await cleanup();
    }

    await installLocalEngine(f.spec);
    assert.equal((await fs.readFile(f.pipLog, 'utf8')).trim().split('\n').length, 1);
  });

test('voice-install-отмена-pip-закрывает-child-и-разрешает-повтор', async (t) => {
  const f = await localFixture(t, 'silero');
  const pidFile = path.join(f.root, 'held-pip.pid');
  const controller = new AbortController();
  const attempt = installLocalEngine({
    ...f.spec,
    signal: controller.signal,
    run: async (command, args, options) => {
      if (args[0] === '-m' && args[1] === 'pip') {
        return f.run(process.execPath, ['-e', [
          `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
          'setInterval(() => {}, 1000);',
        ].join('\n')], options);
      }

      return f.run(command, args, options);
    },
  }).then(() => null, (error: unknown) => error);

  try {
    await beforeCompletion(
      eventually(async () => (await fs.stat(pidFile).catch(() => null)) !== null), attempt,
    );
    controller.abort();
    assert.ok(await attempt);
  } finally {
    controller.abort();
    await attempt;
  }

  const pid = Number(await fs.readFile(pidFile, 'utf8'));

  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });

  const recovered = await installLocalEngine(f.spec);

  assert.equal(JSON.parse(await fs.readFile(recovered.manifestPath, 'utf8')).id, f.pkg.id);
});

