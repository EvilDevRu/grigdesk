import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { decodeServerBinaryInfo } from '../../shared/runtime/serverBinary.ts';

const helper = fileURLToPath(new URL('../../deploy/lib/runtime-env.sh', import.meta.url));
const metadata = {
  format: 1,
  hostContract: 1,
  version: '0.1.0',
  packagingVersion: 2,
  packageId: 'a'.repeat(64),
  runtime: {
    node: '24.21.0',
    abi: '137',
    platform: 'linux',
    arch: 'x64',
  },
  capabilities: ['api', 'ipc', 'helpers', 'engine'],
  engine: { protocol: 'route-v2', sha256: 'b'.repeat(64) },
  payload: {
    sha256: 'c'.repeat(64),
    size: 12,
    entryCount: 1,
  },
};

/**
 * Настоящий shell-декодер получает JSON как данные argv и не готовит серверный runtime.
 * Только Python хоста нужен до выбора Node; данные живой установки не читаются.
 */
function decode(value: unknown) {
  return spawnSync('/bin/bash', ['-c', [
    'set -euo pipefail',
    'source "$1"',
    'grigdesk_decode_binary_json metadata "$2"',
  ].join('\n'), 'runtime-env-version-test', helper, JSON.stringify(value)], {
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
    timeout: 5000,
  });
}

test('RUNTIME-ENV-VERSION: stable/dev не требуют правки host-скрипта при каждом выпуске', async () => {
  const current = (await readFile(new URL('../../VERSION', import.meta.url), 'utf8')).trim();

  for (const version of [current, '0.1.0', '2.3.4', '2.3.4-dev.0', '2.3.4-dev.42',
    '9007199254740991.0.0', '2.3.4-dev.9007199254740991']) {
    const value = { ...metadata, version };
    const result = decode(value);

    assert.equal(decodeServerBinaryInfo(value).version, version);
    assert.equal(result.status, 0, `${version}: ${result.stderr}`);
    assert.equal(result.stdout, metadata.packageId + '\n');
    assert.equal(result.stderr, '');
  }
});

test('RUNTIME-ENV-VERSION: неверный формат и небезопасные номера отвергаются обоими декодерами', () => {
  for (const version of [undefined, null, true, 123, [], {}, '', 'v0.1.2', '0.1', '01.2.3',
    '1.02.3', '1.2.03', '1.2.3-dev', '1.2.3-dev.01', '1.2.3-rc.1', '1.2.3+build',
    '9007199254740992.0.0', '0.9007199254740992.0', '0.0.9007199254740992',
    '1.2.3-dev.9007199254740992']) {
    const value = { ...metadata, version };
    const result = decode(value);

    assert.throws(() => decodeServerBinaryInfo(value), { code: 'server_metadata_invalid' });
    assert.equal(result.status, 1, JSON.stringify(version));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});

test('RUNTIME-ENV-VERSION: новый номер продукта не разрешает несовместимый бинарный протокол', () => {
  for (const incompatible of [
    { format: 2 },
    { hostContract: 2 },
    { packagingVersion: 1 },
    { runtime: { ...metadata.runtime, node: '22.19.0' } },
    { runtime: { ...metadata.runtime, abi: '127' } },
    { capabilities: ['api', 'ipc', 'helpers'] },
    { engine: { ...metadata.engine, protocol: 'route-v3' } },
  ]) {
    const value = {
      ...metadata,
      version: '2.3.4',
      ...incompatible,
    };
    const result = decode(value);

    assert.throws(() => decodeServerBinaryInfo(value), { code: 'server_metadata_invalid' });
    assert.equal(result.status, 1, JSON.stringify(incompatible));
    assert.equal(result.stdout, '');
  }
});
