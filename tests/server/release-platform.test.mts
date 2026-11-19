import assert from 'node:assert/strict';
import test from 'node:test';

import { readNodeRuntime } from '../../shared/node/nodeRuntime.ts';
import { nodeArchive } from '../../shared/node/seaBuild.ts';
import { assertReleasePlatform } from '../../shared/node/releaseChannel.ts';
import { verifyReleaseEnvelope } from '../../shared/node/releaseTrust.ts';
import { decodeReleaseChannelIndex } from '../../shared/runtime/installedUpdateContracts.ts';
import { signedIndex, signedMacIndex } from '../helpers/releaseV2Fixture.mjs';

test('RELEASE-MAC-PIN: архив Node соответствует Mac ARM64', () => {
  const pin = {
    version: '24.21.0',
    platform: 'darwin-arm64',
    sha256: '6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe',
  };

  assert.deepEqual(readNodeRuntime(pin, 'macOS'), pin);
  assert.equal(nodeArchive(pin).name, 'node-v24.21.0-darwin-arm64.tar.xz');
  assert.throws(() => readNodeRuntime({ ...pin, platform: 'darwin-x64' }, 'macOS'));
});

test('RELEASE-MAC-MANIFEST: отдельная подписанная платформа и порог ОС', async () => {
  const fixture = signedMacIndex();
  const index = decodeReleaseChannelIndex(fixture.index);
  const platform = index.latest!.payload.platform;
  const host = {
    platform: 'darwin' as const,
    arch: 'arm64' as const,
    macVersion: async () => '15.0.1',
    glibcVersion: () => undefined,
  };

  assert.equal(verifyReleaseEnvelope(index.latest!, fixture.publicKeyPem), fixture.manifestDigest);
  assert.deepEqual(platform, {
    os: 'darwin',
    arch: 'arm64',
    minMacOS: '15.0',
  });
  await assertReleasePlatform(platform, host);
  await assert.rejects(assertReleasePlatform(platform, { ...host, macVersion: async () => '14.99.0' }),
    /release_platform_incompatible/u);
  await assert.rejects(assertReleasePlatform(platform, {
    ...host,
    platform: 'linux',
    arch: 'x64',
  }), /release_platform_incompatible/u);

  const wrong = structuredClone(index) as typeof fixture.index;

  wrong.latest.payload.platform = { ...wrong.latest.payload.platform, glibc: '2.28' };
  assert.throws(() => decodeReleaseChannelIndex(wrong), /release_manifest_invalid/u);

  const incomplete = structuredClone(fixture.index);

  delete incomplete.latest.payload.artifacts.desktop.unpackedBundleBytes;
  assert.throws(() => decodeReleaseChannelIndex(incomplete), /release_manifest_invalid/u);
  assert.deepEqual(decodeReleaseChannelIndex(signedIndex().index).latest!.payload.platform, {
    os: 'linux',
    arch: 'x64',
    glibc: '2.28',
  });
});
