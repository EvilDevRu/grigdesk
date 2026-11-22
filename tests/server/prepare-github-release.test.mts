import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sha256File } from '../../shared/node/hash.ts';
import { prepareGithubRelease } from '../../tools/prepareGithubRelease.mts';

test('GH-STABLE-ASSETS: оператор получает девять конкретных загрузок и проверяет байты', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-assets-'));

  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const commit = 'c'.repeat(40);
  const repository = 'example/grigdesk';
  const version = '1.2.3';
  const runId = '100';
  const planDigest = 'e'.repeat(64);
  const names = [
    'grigdesk-install',
    'grigdesk-1.2.3-linux-x64-offline.zip',
    'grigdesk_1.2.3_amd64.deb',
    'grigdesk-1.2.3-macos-arm64-offline.zip',
    'grigdesk-1.2.3-linux-arm64-offline.zip',
    'grigdesk-1.2.3-windows-x64-offline.zip',
    'grigdesk-1.2.3-windows-arm64-offline.zip',
    'grigdesk-1.2.3-android-arm64.apk',
    'grigdesk-1.2.3-android-x86_64.apk',
  ];

  for (const file of [...names, 'release-acceptance.json', 'server.tar.gz']) {
    await fs.writeFile(path.join(directory, file), file);
  }

  const assets = await Promise.all(names.map(async (name) => ({
    name,
    size: Buffer.byteLength(name),
    sha256: await sha256File(path.join(directory, name)),
  })));
  const proof = {
    version,
    commit,
    runId,
    planDigest,
    channel: 'release',
    assets,
    signatureValid: true,
  };

  const expected = {
    commit,
    version,
    repository,
    runId,
    planDigest,
  };
  const prepared = await prepareGithubRelease(directory, proof, expected);

  assert.deepEqual(prepared.assets.map((item) => item.name), names);
  assert.ok(prepared.notes.en.startsWith('## Download\n'));
  assert.ok(prepared.notes.ru.startsWith('## Скачать\n'));

  for (const name of names) {
    const url = `https://github.com/example/grigdesk/releases/download/v1.2.3/${name}`;

    assert.ok(prepared.notes.en.includes(url));
    assert.ok(prepared.notes.ru.includes(url));
  }

  assert.ok(prepared.notes.en.indexOf('linux-arm64-offline.zip')
    < prepared.notes.en.indexOf('macos-arm64-offline.zip'));
  assert.ok(prepared.assets[2]?.label.includes('Офлайн'));
  assert.ok(!prepared.notes.en.includes('release-acceptance.json'));

  await assert.rejects(prepareGithubRelease(directory, { ...proof, channel: 'dev' },
    expected), /github_asset_proof_invalid/u);
  await assert.rejects(prepareGithubRelease(directory, { ...proof, commit: 'b'.repeat(40) },
    expected), /github_asset_proof_invalid/u);
  await assert.rejects(prepareGithubRelease(directory, {
    ...proof,
    assets: [...assets, { ...assets[0]!, name: 'server.tar.gz' }],
  }, expected), /github_asset_proof_invalid/u);

  await assert.rejects(prepareGithubRelease(directory, { ...proof, runId: '101' },
    expected), /github_asset_proof_invalid/u);
  await fs.writeFile(path.join(directory, names[0]!), 'different bytes');

  await assert.rejects(prepareGithubRelease(directory, proof, expected),
    /github_asset_bytes_mismatch/u);
});
