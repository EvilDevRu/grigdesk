import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { seaConfig } from '../../shared/node/seaBuild.ts';

test('SEA config принимает assets пакета и сохраняет независимый NODE-LICENSE Б24', () => {
  const assets = {
    'manifest.json': 'manifest.json',
    'payload.zip': 'payload.zip',
  };
  const config = seaConfig(assets);

  assert.deepEqual(config.assets, {
    'NODE-LICENSE': 'LICENSE',
    ...assets,
  });
  assert.deepEqual(seaConfig().assets, { 'NODE-LICENSE': 'LICENSE' });
  assert.deepEqual(assets, {
    'manifest.json': 'manifest.json',
    'payload.zip': 'payload.zip',
  });
});

test('пакет DeepSeek закрепляет свои build deps и тот же Node pin без runtime npm dependencies', async () => {
  const manifest = JSON.parse(await readFile(
    new URL('../../deepseek/package.json', import.meta.url), 'utf8',
  ));
  const lock = JSON.parse(await readFile(
    new URL('../../deepseek/package-lock.json', import.meta.url), 'utf8',
  ));
  const pin = await readFile(new URL('../../deepseek/build/node-runtime.json', import.meta.url), 'utf8');
  const b24Pin = await readFile(new URL('../../b24/build/node-runtime.json', import.meta.url), 'utf8');

  assert.equal(manifest.name, 'grigdesk-deepseek');
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(manifest.devDependencies, {
    '@types/node': '22.20.1',
    esbuild: '0.25.12',
    fflate: '0.8.3',
    postject: '1.0.0-alpha.6',
    typescript: '5.9.3',
  });
  assert.equal(lock.packages[''].name, 'grigdesk-deepseek');
  assert.equal(pin, b24Pin);
  assert.equal(manifest.scripts.build, 'node scripts/buildBinary.mts');
  assert.equal(manifest.scripts.test, 'node scripts/test.mts');
  assert.equal(manifest.scripts['test:sea'], 'node scripts/test.mts --sea');
  assert.equal(manifest.scripts.verify, 'node scripts/verify.mts');
});

test('package runner отвергает неизвестные параметры до запуска набора тестов', async () => {
  const script = fileURLToPath(new URL('../../deepseek/scripts/test.mts', import.meta.url));

  await assert.rejects(promisify(execFile)(process.execPath, [script, '--unexpected']), (error: any) => {
    assert.equal(error.code, 2);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /Использование/u);

    return true;
  });
});
