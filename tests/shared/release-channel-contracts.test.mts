import assert from 'node:assert/strict';
import test from 'node:test';

import { signedIndex } from '../helpers/releaseV2Fixture.mjs';

import { decodeChannelEntry } from '../../shared/runtime/releaseChannelContracts.ts';
import { decodeReleaseChannelIndex } from '../../shared/runtime/installedUpdateContracts.ts';

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

test('RCC-1: историческая запись переносного комплекта декодируется', () => {
  assert.equal(decodeChannelEntry(entry).compat.arch, 'x64');
  assert.equal(decodeChannelEntry({
    ...entry,
    archiveUrl: null
  }).archiveUrl, null);
});

test('RCC-2: посторонние поля и битые значения записи отвергаются', () => {
  assert.throws(() => {
    return decodeChannelEntry({
      ...entry,
      extra: 1
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

for (const channel of ['release', 'dev']) {
  test(`RCC-V1: подписанный ${channel} сохраняет состав, API, identity и описания`, () => {
    const fixture = signedIndex({ channel });
    const decoded = decodeReleaseChannelIndex(fixture.index);

    assert.deepEqual(decoded, fixture.index);
  });
}

for (const field of ['version', 'notes', 'serverApi', 'files', 'size', 'url']) {
  test(`RCC-V1 validation: недопустимый ${field} отвергается`, () => {
    const fixture = signedIndex();
    const payload = fixture.index.latest.payload;

    if (field === 'version') {
      payload.version = '0.3.0-dev.1';
    } else if (field === 'notes') {
      payload.notes = { ru: 'x'.repeat(16001), en: 'x' };
    } else if (field === 'serverApi') {
      payload.serverApi = { major: -1, minor: 1 };
    } else if (field === 'files') {
      payload.artifacts.desktop.files[0].path = '../escape';
    } else if (field === 'size') {
      payload.artifacts.desktop.size = -1;
    } else {
      payload.artifacts.desktop.url = 'http://grigdesk.test/archive';
    }

    assert.throws(() => decodeReleaseChannelIndex(fixture.index));
  });
}
