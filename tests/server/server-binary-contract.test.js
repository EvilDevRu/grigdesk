import assert from 'node:assert/strict';
import test from 'node:test';

import { parseServerBinaryArgs } from '../../server/src/binary/args.ts';
import { packageIdFor, publicServerBinaryInfo } from '../../server/src/binary/metadata.ts';
import { decodeServerBinaryInfo } from '../../shared/runtime/serverBinary.ts';
import { decodePreparedRuntime, probeServerBinary } from '../../shared/node/serverBinaryRuntime.ts';

const hash = 'a'.repeat(64);
const info = {
  format: 1,
  hostContract: 1,
  version: '0.1.0',
  packagingVersion: 2,
  packageId: hash,
  runtime: {
    node: '24.21.0',
    abi: '137',
    platform: 'linux',
    arch: 'x64',
  },
  capabilities: ['api', 'ipc', 'helpers', 'engine'],
  engine: {
    protocol: 'route-v2',
    sha256: hash,
  },
  payload: {
    sha256: hash,
    size: 123,
    entryCount: 12,
  },
};

test('SB01: identity включает launcher/payload и не зависит от порядка ключей', () => {
  const first = {
    version: '0.1.0',
    payload: { sha256: 'a' },
    launcher: 'b',
  };
  const second = {
    launcher: 'b',
    payload: { sha256: 'a' },
    version: '0.1.0',
  };

  assert.equal(packageIdFor(first), packageIdFor(second));
  assert.notEqual(packageIdFor(first), packageIdFor({ ...first, launcher: 'c' }));
  assert.notEqual(packageIdFor(first), packageIdFor({ ...first, payload: { sha256: 'd' } }));
  assert.equal(packageIdFor(first), packageIdFor({ ...first, packageId: hash }));
});

test('SB02: CLI разбирается без D и отвергает несовместимые режимы', () => {
  for (const argv of [['--version'], ['--runtime-info', '--json'], ['--verify'], ['--verify', '--json']]) {
    assert.notEqual(parseServerBinaryArgs(argv).mode, 'error');
  }

  for (const argv of [['--eval', 'x'], ['--verify', '--verify'], ['--prepare'], ['--help', '--verify']]) {
    assert.equal(parseServerBinaryArgs(argv).mode, 'error');
  }
});

test('SB02: полная таблица CLI закрывает повторы и передачу preparation', () => {
  const token = '12345678-1234-4234-8234-123456789abc';

  for (const argv of [
    [], ['--help'], ['--license'], ['--version', '--json'], ['--check-runtime'], ['--check-startup'],
    ['--prepare', '--json'], ['--cache-prune', '--json'], ['--expect-package-id', hash],
    ['--expect-package-id', hash, '--preparation-token', token],
    ['--release-preparation', token, '--package-id', hash, '--json'],
  ]) {
    assert.notEqual(parseServerBinaryArgs(argv).mode, 'error', JSON.stringify(argv));
  }

  for (const argv of [
    ['--json'], ['-p', '1'], ['run'], ['--runtime-info'], ['--cache-prune'],
    ['--version', '--expect-package-id', hash], ['--expect-package-id', 'A'.repeat(64)],
    ['--preparation-token', token], ['--release-preparation', token, '--json'],
    ['--prepare', '--json', '--preparation-token', token, '--expect-package-id', hash],
    ['--verify', '--json', '--json'], ['--expect-package-id', hash, '--expect-package-id', hash],
    ['--release-preparation', 'invalid', '--package-id', hash, '--json'],
    ['--release-preparation', token, '--package-id', hash, '--json', '--preparation-token', token],
  ]) {
    assert.equal(parseServerBinaryArgs(argv).mode, 'error', JSON.stringify(argv));
  }
});

test('SB01: публичная проекция проверяет pin и исключает private index', () => {
  const source = structuredClone(info);

  source.payload.entries = [{ path: '/private/source', sha256: hash }];
  source.sourceRoot = '/private/source';
  assert.deepEqual(publicServerBinaryInfo(source), info);
  assert.deepEqual(decodeServerBinaryInfo(info), info);

  for (const [key, value] of [
    ['format', 2], ['hostContract', 2], ['packagingVersion', 1], ['version', '1.0.0'],
    ['packageId', 'bad'], ['capabilities', ['api', 'eval']],
  ]) {
    assert.throws(() => decodeServerBinaryInfo({ ...info, [key]: value }), {
      code: 'server_metadata_invalid',
    });
  }

  for (const [key, value] of [
    ['platform', 'darwin'], ['arch', 'arm64'], ['abi', '127'], ['node', '22.0.0'],
  ]) {
    assert.throws(() => decodeServerBinaryInfo({ ...info, runtime: { ...info.runtime, [key]: value } }), {
      code: 'server_metadata_invalid',
    });
  }

  for (const payload of [
    { ...info.payload, sha256: 'bad' }, { ...info.payload, size: -1 }, { ...info.payload, entryCount: 1.5 },
  ]) {
    assert.throws(() => decodeServerBinaryInfo({ ...info, payload }), { code: 'server_metadata_invalid' });
  }
});

test('SB19b-probe: внешняя metadata ограничена, prepare связывает id и physical paths', async () => {
  const calls = [];
  const result = await probeServerBinary('/fixture/server', {
    run: async (file, args, options) => {
      calls.push({
        file,
        args,
        options,
      });

      return { stdout: JSON.stringify(info) };
    },
  });

  assert.deepEqual(result, info);
  assert.equal(calls[0].options.env.PATH, '');
  assert.equal(calls[0].options.maxBuffer, 65536);
  assert.deepEqual(calls[0].args, ['--runtime-info', '--json']);

  const root = `/fixture/runtimes/server/packages/${hash}`;
  const prepared = {
    packageId: hash,
    root,
    node: `${root}/runtime/node/bin/node`,
    engine: `${root}/engine/bin/factory`,
    installationBin: '/fixture/bin',
    preparationToken: '11111111-2222-4333-8444-555555555555',
  };

  assert.deepEqual(decodePreparedRuntime(prepared, hash), prepared);

  for (const invalid of [
    { ...prepared, extra: true }, { ...prepared, packageId: 'b'.repeat(64) },
    { ...prepared, node: '/usr/bin/node' }, { ...prepared, engine: `${root}/../factory` },
    { ...prepared, root: 'relative' }, { ...prepared, preparationToken: 'bad' },
  ]) {
    assert.throws(() => decodePreparedRuntime(invalid, hash));
  }

  await assert.rejects(probeServerBinary('/fixture/server', {
    run: async () => ({ stdout: JSON.stringify(info) + ' '.repeat(65536) }),
  }));
});
