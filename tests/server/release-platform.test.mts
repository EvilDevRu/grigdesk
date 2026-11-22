import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readNodeRuntime, serverNodeRuntimeManifest, serverSeaHostTarget } from '../../shared/node/nodeRuntime.ts';
import { serverExecutableGuard } from '../../server/scripts/binary/installFiles.mts';
import { nodeArchive } from '../../shared/node/seaBuild.ts';
import { assertReleasePlatform } from '../../shared/node/releaseChannel.ts';
import { verifyReleaseEnvelope } from '../../shared/node/releaseTrust.ts';
import { decodeReleaseChannelIndex } from '../../shared/runtime/installedUpdateContracts.ts';
import { signedIndex, signedMacIndex } from '../helpers/releaseV2Fixture.mjs';

test('RELEASE-LINUX-ARM64-PIN: сборщик сверяет закреплённую платформу архива и ELF', async () => {
  const target = serverSeaHostTarget('linux', 'arm64');
  const manifest = serverNodeRuntimeManifest(target);
  const source = new URL(`../../${manifest}`, import.meta.url);
  const pin = readNodeRuntime(JSON.parse(await readFile(source, 'utf8')), manifest);

  assert.equal(target, 'linux-arm64');
  assert.equal(pin.platform, target);
  assert.equal(nodeArchive(pin).name, 'node-v24.21.0-linux-arm64.tar.xz');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-elf-arm64-'));
  const file = path.join(dir, 'candidate');
  const header = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(header);
  header.writeUInt16LE(3, 16);
  header.writeUInt16LE(183, 18);

  try {
    await writeFile(file, header);
    const input = await open(file, 'r+');

    try {
      await serverExecutableGuard(target)(input);
      header.writeUInt16LE(62, 18);
      await input.write(header, 0, header.length, 0);
      await assert.rejects(serverExecutableGuard(target)(input), /ELF ARM64/u);
    } finally {
      await input.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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
