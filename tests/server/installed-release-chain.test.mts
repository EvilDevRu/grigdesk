import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { installedBuild } from '../helpers/installedBuildFixture.mjs';
import { installedFixture } from '../helpers/installedUpdateFixture.mjs';
import { ReleaseChannelService } from '../../shared/node/releaseChannel.ts';
import { verifyReleaseEnvelope } from '../../shared/node/releaseTrust.ts';
import type { ReleaseArtifact } from '../../shared/runtime/installedUpdateContracts.ts';

for (const channel of ['release', 'dev'] as const) {
  test(`CHAIN-${channel.toUpperCase()}: bundle → подписанный канал → настоящая подготовка`, async (t) => {
    const built = await installedBuild(t, channel);
    const reader = new ReleaseChannelService({
      channel,
      publicKeyPem: built.signer.publicKeyPem,
      urls: [`https://grigdesk.test/${channel}.json`],
      fetch: async () => new Response(JSON.stringify(built.index)),
    });
    const envelope = (await reader.latest(true))!;
    const manifestDigest = verifyReleaseEnvelope(envelope, built.signer.publicKeyPem);
    const archives = new Map<string, Buffer>();

    for (const component of ['desktop', 'server'] as const) {
      archives.set(envelope.payload.artifacts[component].url,
        await fs.readFile(path.join(built.directory, `${component}.tar.gz`)));
    }

    const box = await installedFixture(t, {
      release: {
        envelope,
        manifestDigest,
        archives,
        identity: envelope.payload,
        publicKeyPem: built.signer.publicKeyPem,
      },
    });
    const job = await box.create();
    const ready = await box.manager.prepare(job.id);

    assert.equal(ready.stage, 'ready');
    assert.equal(ready.manifestDigest, manifestDigest);
    assert.deepEqual(ready.envelope, built.index.latest);
    assert.deepEqual(await box.pointer(), box.previous);
    assert.deepEqual(built.admission, ['verify', 'compatibility']);
    assert.equal(await fs.stat(path.join(built.directory, 'grigdesk-install')).then(() => true), true);
    await box.preserved();
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
