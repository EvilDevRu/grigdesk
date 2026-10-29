import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { build } from '../../deepseek/node_modules/esbuild/lib/main.js';

import {
  assertDeepSeekHostCompatibility,
  decodeDeepSeekRuntimeInfo,
} from '../../shared/chat/deepSeekBinary.ts';
import { createDeepSeekMetadata, manifestBytes, packageIdFor } from '../../deepseek/src/runtime/metadata.ts';
import { sha256 } from '../../shared/node/hash.ts';
import { runtimeInfoFixture } from '../helpers/deepseekMetadataFixture.mts';
import {
  GLM_ALLOWED_MODES,
  GLM_POLICY_REVISION,
  GLM_PROFILE_REVISION,
} from '../../server/src/lib/glm/contract.ts';

test('runtime-info принимает совместимый manifest без ограничения upstream и ABI сервера', () => {
  const value = runtimeInfoFixture();

  assert.deepEqual(decodeDeepSeekRuntimeInfo(value), value);
});

test('capability подтверждения сохраняется без изменения формы старого metadata', () => {
  const legacy = runtimeInfoFixture();

  assert.deepEqual(decodeDeepSeekRuntimeInfo(legacy), legacy);

  for (const toolPermissions of [true, false]) {
    const value = { ...legacy, capabilities: { ...legacy.capabilities, toolPermissions } };

    assert.deepEqual(decodeDeepSeekRuntimeInfo(value), value);
  }

  for (const toolPermissions of [null, 'true', 1, {}]) {
    assert.throws(() => decodeDeepSeekRuntimeInfo({
      ...legacy, capabilities: { ...legacy.capabilities, toolPermissions },
    }), { code: 'deepseek_metadata_invalid' });
  }
});

test('runtime-info отвергает отсутствующие поля, неверные hashes и неизвестные contracts', () => {
  for (const field of Object.keys(runtimeInfoFixture())) {
    const value = runtimeInfoFixture();

    Reflect.deleteProperty(value, field);
    assert.throws(() => decodeDeepSeekRuntimeInfo(value), { code: 'deepseek_metadata_invalid' }, field);
  }

  for (const field of ['packageId', 'buildId']) {
    for (const invalid of ['', 'a'.repeat(63), 'g'.repeat(64), 'A'.repeat(64), 12]) {
      const value = runtimeInfoFixture();

      Reflect.set(value, field, invalid);
      assert.throws(() => decodeDeepSeekRuntimeInfo(value), { code: 'deepseek_metadata_invalid' });
    }
  }

  const invalidValues = [
    { ...runtimeInfoFixture(), format: 2 },
    { ...runtimeInfoFixture(), hostContract: 2 },
    { ...runtimeInfoFixture(), capabilities: { ...runtimeInfoFixture().capabilities, acp: 'true' } },
    { ...runtimeInfoFixture(), workerNode: { ...runtimeInfoFixture().workerNode, sha256: 'broken' } },
  ];

  for (const value of invalidValues) {
    assert.throws(() => decodeDeepSeekRuntimeInfo(value), { code: 'deepseek_metadata_invalid' });
  }
});

test('дополнительные поля совместимого format не меняют известные сведения', () => {
  const value = runtimeInfoFixture();

  assert.deepEqual(decodeDeepSeekRuntimeInfo({
    ...value,
    futureField: { extra: true },
    capabilities: { ...value.capabilities, futureCapability: true },
  }), value);
});

test('journal требует неотрицательный write в непустом списке read', () => {
  for (const journal of [
    null,
    { write: 1, read: [] },
    { write: 2, read: [1] },
    { write: -1, read: [-1] },
    { write: 1, read: [-1, 1] },
    { write: 1.5, read: [1.5] },
  ]) {
    assert.throws(() => decodeDeepSeekRuntimeInfo({
      ...runtimeInfoFixture(),
      journal,
    }), { code: 'deepseek_metadata_invalid' });
  }
});

test('journal сохраняет исторический codec v0, подтверждённый настоящим upstream catalog', () => {
  for (const journal of [{ write: 0, read: [0] }, { write: 3, read: [0, 1, 2, 3] }]) {
    assert.deepEqual(decodeDeepSeekRuntimeInfo({ ...runtimeInfoFixture(), journal }).journal, journal);
  }
});

test('packageId канонизирует весь manifest без самого packageId и включает binaryVersion', () => {
  assert.equal(packageIdFor({
    b: 2,
    a: 1,
    packageId: 'ignored',
  }), sha256('{"a":1,"b":2}'));
  assert.equal(packageIdFor({ a: 1, b: 2 }), packageIdFor({ b: 2, a: 1 }));
  assert.equal(packageIdFor({ a: { c: 3, b: 2 } }), packageIdFor({ a: { b: 2, c: 3 } }));

  const { packageId: _ignored, ...manifest } = runtimeInfoFixture();
  const first = createDeepSeekMetadata(manifest);
  const next = createDeepSeekMetadata({ ...manifest, binaryVersion: '0.1.1' });

  assert.equal(decodeDeepSeekRuntimeInfo(first).packageId, first.packageId);
  assert.equal(first.buildId, next.buildId);
  assert.equal(first.upstreamVersion, next.upstreamVersion);
  assert.deepEqual(first.glm, next.glm);
  assert.notEqual(first.packageId, next.packageId);
  assert.notEqual(first.packageId, packageIdFor({ ...manifest, launcher: 'changed' }));
  assert.throws(() => packageIdFor({ unsupported: undefined }), TypeError);
});

test('требования host соответствуют адаптерам и отвергают несовместимость', async () => {
  const host = JSON.parse(await readFile(new URL('../../server/deepseek-host-contract.json', import.meta.url),
    'utf8'));
  const info = runtimeInfoFixture();

  assert.equal(host.glm.profileRevision, GLM_PROFILE_REVISION);
  assert.equal(host.glm.policyRevision, GLM_POLICY_REVISION);
  assert.ok(GLM_ALLOWED_MODES.includes(host.glm.mode));
  assert.deepEqual(GLM_ALLOWED_MODES, ['api', 'coding-plan']);
  assert.deepEqual(host.requiredCapabilities, ['web', 'acp', 'settingsWeb', 'settingsAcp']);
  assert.doesNotThrow(() => assertDeepSeekHostCompatibility(info, host));

  const consumers = [
    { ...host, runtimeInfoFormat: 2 },
    { ...host, hostContract: 2 },
    { ...host, glm: { ...host.glm, profileRevision: 'incompatible' } },
    { ...host, glm: { ...host.glm, policyRevision: 'incompatible' } },
  ];

  for (const consumer of consumers) {
    assert.throws(() => assertDeepSeekHostCompatibility(info, consumer), {
      code: 'deepseek_host_incompatible',
    });
  }

  assert.throws(() => assertDeepSeekHostCompatibility({
    ...info,
    capabilities: { ...info.capabilities, settingsAcp: false },
  }, host), { code: 'deepseek_host_incompatible' });
});

test('загрузка metadata не читает env или файлы и не запускает процессы', async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../../deepseek/src/runtime/metadata.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  });
  const exported = { exports: {} as Record<string, unknown> };
  const forbidden = () => {
    throw new Error('Побочный эффект при загрузке metadata');
  };
  const sandbox = {
    module: exported,
    require: (name: string) => name === 'node:crypto' ? crypto : new Proxy({}, { get: () => forbidden }),
    setTimeout: forbidden,
    setInterval: forbidden,
  };

  Object.defineProperty(sandbox, 'process', { get: forbidden });
  runInNewContext(bundle.outputFiles[0]!.text, sandbox);
  assert.equal(typeof exported.exports.createDeepSeekMetadata, 'function');
});

test('launcher проверяет bytes SEA manifest до metadata и любых файловых эффектов', async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../../deepseek/src/launcher/main.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  });
  const info = createDeepSeekMetadata(runtimeInfoFixture());
  const bytes = manifestBytes(info);
  const require = createRequire(import.meta.url);
  const forbidden = () => {
    throw new Error('Metadata обращается к окружению или файловой системе');
  };

  for (const [body, identity, expectedCode] of [
    [bytes, info.packageId, 0],
    [bytes.replace('9.2.0-compatible', '9.3.0-compatible'), info.packageId, 1],
    [bytes, '0'.repeat(64), 1],
  ] as const) {
    let stdout = '';
    let stderr = '';
    const processFixture = {
      argv: ['deepseek', 'deepseek', '--runtime-info', '--json'],
      exitCode: 0,
      stdout: { write: (value: string) => {
        stdout += value;
      } },
      stderr: { write: (value: string) => {
        stderr += value;
      } },
    };

    Object.defineProperty(processFixture, 'env', { get: forbidden });
    runInNewContext(bundle.outputFiles[0]!.text, {
      Buffer,
      process: processFixture,
      require: (name: string) => {
        if (name === 'node:sea') {
          return { getRawAsset: (key: string) => Buffer.from(key === 'manifest.json' ? body : identity) };
        }

        if (['node:fs', 'node:fs/promises', 'node:child_process'].includes(name)) {
          return new Proxy({}, { get: () => forbidden });
        }

        return require(name);
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(processFixture.exitCode, expectedCode, stderr);

    if (expectedCode === 0) {
      assert.deepEqual(JSON.parse(stdout), info);
      assert.equal(stderr, '');
    } else {
      assert.equal(stdout, '');
      assert.equal(JSON.parse(stderr).code, 'deepseek_launcher_failed');
    }
  }
});
