import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';

import { resolveDeepSeekRuntimeAsync } from '../../server/src/lib/deepseek/runtimeProcess.ts';
import { writeDeepSeekBinaryStub } from '../helpers/deepseekBinaryStub.mts';
import { runtimeInfoFixture } from '../helpers/deepseekMetadataFixture.mts';
import deepseek from '../../server/src/lib/executors/deepseek.ts';
import { deepSeekCatalogCacheKey } from '../../server/src/lib/deepseek/catalog.ts';
import { deepSeekNativeSettings } from '../../server/src/lib/executorSettings/deepseek.ts';

test('одновременный async descriptor запускает одну metadata пробу', async (t) => {
  const { config, counter, info } = await fixture(t, 100);
  const values = await Promise.all(Array.from({ length: 12 }, () => resolveDeepSeekRuntimeAsync(config)));
  const probes = (await fs.readFile(counter, 'utf8')).trim().split('\n');

  assert.equal(probes.length, 1);
  assert.ok(values.every((value) => value.identity === `deepseek-package:${info.packageId}`));
});

/**
 * Счётчик пишет сам metadata процесс; это наблюдаемая граница запуска, а не sleep.
 * Все варианты продолжают отвечать только публичной metadata, без Harness/parity fake.
 */
async function fixture(t, delay = 0) {
  const { root, binary } = await writeDeepSeekBinaryStub(t, '');
  const counter = path.join(root, 'counter');
  const info = runtimeInfoFixture();

  await fs.writeFile(counter, '');

  async function write(output, milliseconds = delay, target = binary) {
    await fs.writeFile(target, `#!${process.execPath}\n`
      + `require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'probe\\n');\n`
      + `setTimeout(() => process.stdout.write(${JSON.stringify(output)}), ${milliseconds});\n`,
    { mode: 0o755 });
  }

  await write(JSON.stringify(info));

  return {
    root,
    binary,
    info,
    counter,
    write,
    config: {
      deepseekRuntimeMode: 'binary',
      deepseekBin: binary,
      deepseekCacheDir: path.join(root, 'cache'),
    },
  };
}

/**
 * Собственный counter подтверждает, что shared probe уже выполняется.
 * Истечение срока даёт явный отказ fixture без сохранённого фонового ожидания.
 */
async function waitForProbe(counter) {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    if ((await fs.readFile(counter, 'utf8')).length > 0) {
      return;
    }

    await pause(10);
  }

  assert.fail('Metadata процесс не записал counter');
}

test('замена ELF при прежнем пути пересчитывает SHA и metadata', async (t) => {
  const f = await fixture(t);
  const a = await resolveDeepSeekRuntimeAsync(f.config);
  const next = path.join(f.root, 'replacement');
  const info = {
    ...f.info,
    packageId: 'c'.repeat(64),
    binaryVersion: '0.2.0',
  };

  await f.write(JSON.stringify(info), 0, next);
  await fs.rename(next, f.binary);

  const b = await resolveDeepSeekRuntimeAsync(f.config);

  assert.equal(b.metadata.packageId, info.packageId);
  assert.notEqual(a.identity, b.identity);
  assert.notEqual(a.binaryFile.sha256, b.binaryFile.sha256);
  assert.equal((await fs.readFile(f.counter, 'utf8')).trim().split('\n').length, 2);
});

test('смена symlink при прежнем выбранном пути инвалидирует metadata', async (t) => {
  const f = await fixture(t);
  const selected = path.join(f.root, 'selected');
  const other = path.join(f.root, 'other');
  const temporary = path.join(f.root, 'next-link');
  const config = { ...f.config, deepseekBin: selected };

  await fs.symlink(f.binary, selected);

  const a = await resolveDeepSeekRuntimeAsync(config);

  await f.write(JSON.stringify({ ...f.info, packageId: 'd'.repeat(64) }), 0, other);
  await fs.symlink(other, temporary);
  await fs.rename(temporary, selected);

  const b = await resolveDeepSeekRuntimeAsync(config);

  assert.equal(b.command, selected);
  assert.notEqual(a.identity, b.identity);
  assert.equal(b.metadata.packageId, 'd'.repeat(64));
});

test('ошибка probe не возвращает старую identity; исправление видно без рестарта', async (t) => {
  const f = await fixture(t);

  await resolveDeepSeekRuntimeAsync(f.config);
  await f.write('invalid-json');
  await assert.rejects(resolveDeepSeekRuntimeAsync(f.config), { code: 'deepseek_binary_metadata_invalid' });
  await fs.unlink(f.binary);
  await assert.rejects(resolveDeepSeekRuntimeAsync(f.config), { code: 'deepseek_binary_missing' });
  await f.write(JSON.stringify({ ...f.info, packageId: 'e'.repeat(64) }));

  const repaired = await resolveDeepSeekRuntimeAsync(f.config);

  assert.equal(repaired.metadata.packageId, 'e'.repeat(64));
});

test('heartbeat работает во время медленной async проверки', async (t) => {
  const f = await fixture(t, 200);
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 5);

  try {
    await resolveDeepSeekRuntimeAsync(f.config);
    assert.ok(ticks >= 5, `Heartbeat сработал ${ticks} раз`);
  } finally {
    clearInterval(timer);
  }
});

test('отмена одного waiter не отменяет shared probe другого', async (t) => {
  const f = await fixture(t, 300);
  const controller = new AbortController();
  const cancelled = resolveDeepSeekRuntimeAsync(f.config, { signal: controller.signal })
    .then((value) => ({ value }), (error) => ({ error }));
  const retained = resolveDeepSeekRuntimeAsync(f.config);

  await waitForProbe(f.counter);
  controller.abort();

  const result = await cancelled;

  assert.equal(result.error, controller.signal.reason);
  assert.equal((await retained).metadata.packageId, f.info.packageId);
  assert.equal((await fs.readFile(f.counter, 'utf8')).trim().split('\n').length, 1);
});

test('поздний отказ старого probe не удаляет успешный cache новой поставки', async (t) => {
  const f = await fixture(t, 300);
  const original = resolveDeepSeekRuntimeAsync(f.config).then((value) => ({ value }), (error) => ({ error }));

  await waitForProbe(f.counter);

  const replacement = path.join(f.root, 'replacement');
  const next = { ...f.info, packageId: 'f'.repeat(64) };

  await f.write(JSON.stringify(next), 0, replacement);
  await fs.rename(replacement, f.binary);

  const changed = await resolveDeepSeekRuntimeAsync(f.config);
  const old = await original;

  assert.equal(old.error.code, 'deepseek_binary_changed');
  assert.equal(changed.metadata.packageId, next.packageId);
  assert.equal((await resolveDeepSeekRuntimeAsync(f.config)).identity, changed.identity);
  assert.equal((await fs.readFile(f.counter, 'utf8')).trim().split('\n').length, 2);
});

test('security profile, catalog key и native context разделяют async descriptor', async (t) => {
  const f = await fixture(t, 100);
  const profile = deepseek.sessionBinding.securityProfile(f.config);
  const key = deepSeekCatalogCacheKey(f.config, { DEEPSEEK_API_KEY: 'synthetic-key' });
  const context = deepSeekNativeSettings.context(f.config, f.root, 'chat');
  const [profileValue, keyValue, contextValue] = await Promise.all([profile, key, context]);

  assert.equal((await fs.readFile(f.counter, 'utf8')).trim().split('\n').length, 1);
  assert.equal(typeof profile.then, 'function');
  assert.equal(typeof key.then, 'function');
  assert.match(profileValue, /^deepseek-host-sandbox-v5:/u);
  assert.ok(keyValue.includes(f.info.upstreamVersion));
  assert.equal(contextValue.runtimeIdentity, `deepseek-package:${f.info.packageId}`);
});
