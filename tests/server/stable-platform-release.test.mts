import assert from 'node:assert/strict';
import test from 'node:test';

import { assertStablePromotionProof } from '../../tools/promoteArtifact.mts';

import {
  collectStableAssetProof, stableAssetNames, stablePlatforms,
} from '../../tools/stablePlatformRelease.mts';

test('STABLE-ASSETS-ALL: все семь частей относятся к одному run и plan', () => {
  const identity = {
    version: '0.3.1',
    commit: 'c'.repeat(40),
    runId: '100',
    planDigest: 'b'.repeat(64),
  };
  const parts = stablePlatforms.map((platform) => ({
    ...identity,
    platform,
    channel: 'release' as const,
    assets: stableAssetNames(platform, identity.version).map((name) => ({
      name,
      size: 60,
      sha256: 'd'.repeat(64),
    })),
  }));

  assert.deepEqual(collectStableAssetProof(identity, parts).assets.map(({ name }) => name),
    [
      'grigdesk-install',
      'grigdesk-0.3.1-linux-x64-offline.zip',
      'grigdesk_0.3.1_amd64.deb',
      'grigdesk-0.3.1-macos-arm64-offline.zip',
      'grigdesk-0.3.1-linux-arm64-offline.zip',
      'grigdesk-0.3.1-windows-x64-offline.zip',
      'grigdesk-0.3.1-windows-arm64-offline.zip',
      'grigdesk-0.3.1-android-arm64.apk',
      'grigdesk-0.3.1-android-x86_64.apk',
    ]);

  const previous = parts.slice(0, -1);
  const final = parts.at(-1)!;

  assert.throws(() => collectStableAssetProof(identity, previous), /stable_asset_matrix_invalid/u);

  for (const wrong of [
    { ...final, platform: 'android-arm64' as const },
    { ...final, version: '0.3.2' },
    { ...final, commit: 'e'.repeat(40) },
    { ...final, runId: '101' },
    { ...final, planDigest: 'f'.repeat(64) },
    { ...final, assets: [{ ...final.assets[0]!, size: 2 * 1024 ** 3 }] },
  ]) {
    assert.throws(() => collectStableAssetProof(identity, [...previous, wrong]),
      /stable_asset_part_invalid/u);
  }
});

test('STABLE-PROMOTE: один Linux artifact без общего proof не допускается', () => {
  const expected = {
    runId: '100',
    commit: 'c'.repeat(40),
    version: '0.3.1',
    digest: '6'.repeat(64),
    artifactId: '1002',
  };
  const source = {
    ...expected,
    channel: 'release',
    signatureValid: true,
    planDigest: '4'.repeat(64),
    linuxManifestDigest: expected.digest,
    linuxBuildArtifactId: expected.artifactId,
    assets: stablePlatforms.flatMap((target) => stableAssetNames(target, expected.version))
      .map((name) => ({
        name,
        size: 16,
        sha256: 'e'.repeat(64),
      })),
  };

  assert.doesNotThrow(() => assertStablePromotionProof(source, expected));
  assert.throws(() => assertStablePromotionProof(null, expected), /stable_promotion_proof_invalid/u);
  assert.throws(() => assertStablePromotionProof({ ...source, linuxBuildArtifactId: '1003' },
    expected), /stable_promotion_proof_invalid/u);
  assert.throws(() => assertStablePromotionProof({ ...source, runId: '101' },
    expected), /stable_promotion_proof_invalid/u);
  assert.throws(() => assertStablePromotionProof({ ...source, assets: source.assets.slice(0, 3) },
    expected), /stable_promotion_proof_invalid/u);
});

test('STABLE-ASSETS-COLLECT: девять файлов появляются целиком после сверки всех источников', async (t) => {
  const { createPublicKey } = await import('node:crypto');
  const fs = await import('node:fs/promises');
  const { default: path } = await import('node:path');
  const { canonicalJson } = await import('../../shared/lib/canonicalJson.ts');
  const { sha256, sha256File } = await import('../../shared/node/hash.ts');
  const { verifyReleaseEnvelope } = await import('../../shared/node/releaseTrust.ts');
  const { offlinePackageFiles, buildStableLinuxZip } = await import('../../tools/linuxOfflinePackage.mts');
  const { buildDeb } = await import('../../tools/buildDeb.mts');
  const { resolveStablePlatformRelease } = await import('../../tools/stablePlatformRelease.mts');
  const { readStableReleasePlan } = await import('../../tools/stableReleasePlan.mts');
  const { collectStableAssets } = await import('../../tools/collectStableAssets.mts');
  const { installedBuild } = await import('../helpers/installedBuildFixture.mjs');
  const built = await installedBuild(t, 'release');
  const key = createPublicKey(built.signer.publicKeyPem);
  const fingerprint = sha256(key.export({ type: 'spki', format: 'der' }));
  const { version, commit } = built.index.latest.payload;
  const runId = '42';
  const planFile = path.join(built.temporary, 'stable-plan.json');
  const planBytes = canonicalJson({
    format: 1,
    runId,
    runNumber: '42',
    ...resolveStablePlatformRelease({
      platforms: [...stablePlatforms],
      publish: false,
      testMode: 'full',
      reason: '',
      validationRun: '',
      attempt: '1',
      runNumber: '42',
      version,
      commit,
    }),
  }) + '\n';
  const planDigest = sha256(planBytes);

  await fs.writeFile(planFile, planBytes);

  const plan = await readStableReleasePlan(planFile, {
    commit,
    runId,
    digest: planDigest,
  });

  await assert.rejects(readStableReleasePlan(planFile, {
    commit,
    runId: '43',
    digest: planDigest,
  }), /stable_release_plan_invalid/u);
  await buildStableLinuxZip(built.directory, version);
  await buildDeb({
    root: built.root,
    artifacts: built.directory,
    offline: true,
  });

  // Сами bytes тестовых нативных файлов синтетические. Здесь проверяется передача между jobs,
  // а подписанный Linux-индекс и проверка его артефактов остаются настоящими.
  const fileRecords = async (directory: string, names: string[]) => Promise.all(names.map(async (name) => {
    const file = path.join(directory, name);

    return {
      name,
      size: (await fs.stat(file)).size,
      sha256: await sha256File(file),
    };
  }));
  const linuxProof = path.join(built.temporary, 'linux-proof');
  const nativeRoot = path.join(built.temporary, 'native');
  const output = path.join(built.temporary, 'downloads');

  await fs.mkdir(linuxProof);
  await fs.writeFile(path.join(linuxProof, 'verified-proof.json'), JSON.stringify({
    version,
    commit,
    channel: 'release',
    signatureValid: true,
    installerSignatureValid: true,
    archiveHashesValid: true,
    inventoriesValid: true,
    digest: verifyReleaseEnvelope(built.index.latest, built.signer.publicKeyPem),
    publicAssets: await fileRecords(built.directory, stableAssetNames('linux-x64', version)),
  }));

  const windowsFiles = [
    'grigdesk-install.ps1', 'grigdesk-install.ps1.sha256', 'grigdesk-install.ps1.sig',
    'grigdesk-maintenance.exe', 'release.json', 'desktop.exe', 'server.zip',
  ];
  const groups = {
    'darwin-arm64': ['darwin-arm64'],
    'linux-arm64': ['linux-arm64'],
    'windows-x64': ['windows-x64'],
    'windows-arm64': ['windows-arm64'],
    android: ['android-arm64', 'android-x86_64'],
  } as const;
  const artifacts = [];

  for (const [index, [group, targets]] of Object.entries(groups).entries()) {
    const parts = [];

    for (const platform of targets) {
      const directory = path.join(nativeRoot, group, platform);
      const names = group === 'android' ? ['grigdesk.apk']
        : group.startsWith('windows-') ? windowsFiles : offlinePackageFiles('release');

      await fs.mkdir(directory, { recursive: true });

      for (const name of names) {
        await fs.writeFile(path.join(directory, name), `${platform}/${name}\n`);
      }

      parts.push({
        platform,
        runId,
        planDigest,
        ...plan.current,
        manifestDigest: 'e'.repeat(64),
        signerFingerprint: fingerprint,
        files: await fileRecords(directory, names),
      });
    }

    const proof = path.join(nativeRoot, group, 'stable-native-proof.json');

    await fs.writeFile(proof, JSON.stringify({
      format: 1,
      parts,
    }));

    artifacts.push([group, {
      id: String(10 + index),
      digest: await sha256File(proof),
    }]);
  }

  const input = {
    plan,
    planDigest,
    linuxBuild: built.directory,
    linuxProof,
    linuxBuildId: '8',
    linuxProofId: '9',
    nativeRoot,
    nativeArtifacts: Object.fromEntries(artifacts),
    output,
    publicKeyPem: built.signer.publicKeyPem,
  };
  const windowsServer = path.join(nativeRoot, 'windows-x64/windows-x64/server.zip');
  const oldServer = await fs.readFile(windowsServer);

  await fs.writeFile(windowsServer, Buffer.from(oldServer).reverse());
  await assert.rejects(collectStableAssets(input), /stable_asset_bytes_mismatch: server.zip/u);
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
  await fs.writeFile(windowsServer, oldServer);

  const armApk = path.join(nativeRoot, 'android/android-arm64/grigdesk.apk');
  const x86Apk = path.join(nativeRoot, 'android/android-x86_64/grigdesk.apk');
  const oldX86 = await fs.readFile(x86Apk);

  await fs.copyFile(armApk, x86Apk);
  await assert.rejects(collectStableAssets(input), /stable_asset_bytes_mismatch: grigdesk.apk/u);
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
  await fs.writeFile(x86Apk, oldX86);

  const proof = await collectStableAssets(input);
  const expected = [
    'grigdesk-install',
    `grigdesk-${version}-linux-x64-offline.zip`,
    `grigdesk_${version}_amd64.deb`,
    `grigdesk-${version}-macos-arm64-offline.zip`,
    `grigdesk-${version}-linux-arm64-offline.zip`,
    `grigdesk-${version}-windows-x64-offline.zip`,
    `grigdesk-${version}-windows-arm64-offline.zip`,
    `grigdesk-${version}-android-arm64.apk`,
    `grigdesk-${version}-android-x86_64.apk`,
  ];

  assert.deepEqual(proof.assets.map((file) => file.name), expected);
  assert.deepEqual((await fs.readdir(output)).sort(), [...expected, 'stable-assets-proof.json'].sort());
  assert.equal(proof.linuxBuildArtifactId, '8');
  assert.equal(proof.linuxVerifyProofArtifactId, '9');
  assert.deepEqual(await fs.readFile(path.join(output, expected[8]!)), oldX86);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'stable-assets-proof.json'), 'utf8')),
    proof);
});
