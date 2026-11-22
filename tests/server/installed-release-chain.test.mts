import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { installedBuild } from '../helpers/installedBuildFixture.mjs';
import { ReleaseChannelService } from '../../shared/node/releaseChannel.ts';
import { extractReleaseArtifact } from '../../shared/node/releaseArchive.ts';
import { verifyReleaseEnvelope } from '../../shared/node/releaseTrust.ts';
import type { ReleaseArtifact } from '../../shared/runtime/installedUpdateContracts.ts';

for (const channel of ['release', 'dev'] as const) {
  test(`CHAIN-${channel.toUpperCase()}: bundle → подписанный канал → распаковка комплекта v3`, async (t) => {
    const built = await installedBuild(t, channel);
    const reader = new ReleaseChannelService({
      channel,
      publicKeyPem: built.signer.publicKeyPem,
      urls: [`https://grigdesk.test/${channel}.json`],
      fetch: async () => new Response(JSON.stringify(built.index)),
    });
    const envelope = await reader.latest(true);

    assert.ok(envelope);
    assert.equal(envelope.format, 3);

    const manifestDigest = verifyReleaseEnvelope(envelope, built.signer.publicKeyPem);
    const acceptanceFile = path.join(built.directory, 'release-acceptance.json');
    const acceptance = JSON.parse(await fs.readFile(acceptanceFile, 'utf8'));

    assert.equal(manifestDigest, acceptance.manifestDigest);

    for (const component of ['desktop', 'server', 'control'] as const) {
      const artifact = envelope.payload.artifacts[component];

      assert.ok(artifact);
      await extractReleaseArtifact(path.join(built.directory, `${component}.tar.gz`),
        path.join(built.temporary, component), artifact);
    }

    assert.deepEqual(envelope, built.index.latest);
    assert.deepEqual(built.admission, ['verify', 'compatibility']);
    assert.equal(await fs.stat(path.join(built.directory, 'grigdesk-install')).then(() => true), true);
  });
}

test('PIPE-BUNDLE: подписанная server-поставка содержит pipeline с SHA и правами', async (t) => {
    const built = await installedBuild(t, 'release');
    const server: ReleaseArtifact = built.index.latest.payload.artifacts.server;
    const entry = server.files.find((item) => item.path === 'bin/pipeline');

    assert.ok(entry, 'новый CLI отсутствует в подписанной server-описи');
    assert.equal(entry.mode, 0o555);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(entry.size > 0);
    assert.ok(built.captured.some((item) => item.name === 'pipeline'));
});

test('PIPE-BUNDLE-MISSING: официальный выпуск не принимает пропущенный pipeline', async (t) => {
    await assert.rejects(installedBuild(t, 'release', {
        omitBuilder: 'pipeline'
    }), /release_builder_missing:pipeline/u);
});

test('ONLINE-BUNDLE: установщик мал и отделён от helper и архивов', async (t) => {
  const box = await installedBuild(t, 'release');
  const script = await fs.readFile(path.join(box.directory, 'grigdesk-install'));

  assert.equal(script.subarray(0, 10).toString(), '#!/bin/sh\n');
  assert.ok(script.length <= 64 * 1024);
  assert.ok((await fs.stat(path.join(box.directory, 'grigdesk-maintenance.gz'))).size > 0);
  assert.deepEqual(Object.keys(box.index.latest.payload.artifacts).sort(), ['control', 'desktop', 'server']);
  assert.equal(box.index.format, 3);
});
