import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RELEASE_CHANNEL_URLS, decodeChannelEntry, decodeChannelIndex,
} from '../../shared/runtime/releaseChannelContracts.ts';

const entry = {
  version: '0.2.0',
  commit: 'a'.repeat(40),
  archiveSha256: 'b'.repeat(64),
  archiveSize: 123456,
  bundleSha256: 'c'.repeat(64),
  signature: Buffer.alloc(64, 1).toString('base64'),
  archiveUrl: 'https://grigdesk.com/releases/0.2.0/release.tar.gz',
  compat: {
    os: 'linux',
    arch: 'x64',
    glibc: '2.28'
  },
};

test('RCC-1: валидный индекс канала декодируется, поля проверяются', () => {
  const index = {
    format: 1,
    latest: entry,
    publishedAt: '2026-11-02T00:00:00.000Z'
  };

  assert.equal(decodeChannelIndex(index).latest?.version, '0.2.0');
  assert.equal(decodeChannelEntry(entry).compat.arch, 'x64');
  assert.equal(decodeChannelEntry({
    ...entry,
    archiveUrl: null
  }).archiveUrl, null);
});

test('RCC-2: посторонние поля, неверный формат и битые значения отвергаются', () => {
  assert.throws(() => {
    return decodeChannelIndex({
      format: 2,
      latest: entry,
    publishedAt: '2026-11-02T00:00:00.000Z'
    });
  });
  assert.throws(() => {
    return decodeChannelIndex({
      format: 1,
    latest: {
      ...entry,
      extra: 1
    },
      publishedAt: '2026-11-02T00:00:00.000Z'
    });
  });
  assert.throws(() => {
    return decodeChannelEntry({
      ...entry,
      archiveSha256: 'zz'
    });
  });
  assert.throws(() => {
    return decodeChannelEntry({
      ...entry,
      version: '0.2'
    });
  });
  assert.throws(() => {
    return decodeChannelEntry({
      ...entry,
      commit: 'xyz'
    });
  });
  assert.throws(() => {
    return decodeChannelEntry({
      ...entry,
      signature: 'short'
    });
  });
  assert.throws(() => {
    return decodeChannelEntry({
      ...entry,
      archiveUrl: 'http://insecure'
    });
  });
  assert.throws(() => {
    return decodeChannelEntry({
      ...entry,
    compat: {
      os: 'linux',
      arch: 'x64',
      glibc: '2.28',
      extra: 1
    }
    });
  });
});

test('RCC-3: адреса канала — HTTPS grigdesk.com и зеркало grigdesk.ru', () => {
  assert.deepEqual(RELEASE_CHANNEL_URLS, [
    'https://grigdesk.com/api/releases/v1/channel.json',
    'https://grigdesk.ru/api/releases/v1/channel.json',
  ]);
});
