import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

import { shellQuote } from '../../shared/lib/shellQuote.ts';
import { sha256File } from '../../shared/node/hash.ts';
import { buildStableLinuxZip } from '../../tools/linuxOfflinePackage.mts';
import { buildDeb } from '../../tools/buildDeb.mts';
import { resolveReleaseChecks } from '../../tools/releaseChecks.mts';
import { installedBuild, loadInstalledModule } from '../helpers/installedBuildFixture.mjs';
import { runtimeInfoFixture } from '../helpers/deepseekMetadataFixture.mts';

interface FixtureBinaryMetadata {
  version: string;
  packageId?: string;
  releaseId?: string;
}

const root = path.resolve(import.meta.dirname, '../..');

/**
 * Компиляторы дают исполняемые программы с настоящими публичными протоколами проб.
 * Подписи, tar, deb, внешний verifier и три установки остаются production-кодом.
 */
test('VERIFY-BUILT-INSTALLATION: официальный verifier доказывает три завершённые установки', async (t) => {
  const built = await installedBuild(t, 'release', {
    realGoUtilities: true,
    builderSource: async (name: string, _input: unknown, metadata: FixtureBinaryMetadata) => {
      if (['tracker', 'pipeline', 'routes', 'voice', 'relay'].includes(name)) {
        const info = {
          schema: 1,
          kind: name === 'relay' ? 'grigdesk-relay' : name,
          version: metadata.version,
          runtime: 'go',
          go: 'go1.27.4',
          os: 'linux',
          arch: 'amd64',
        };

        return `#!/bin/sh\nprintf '%s\\n' ${shellQuote(JSON.stringify(info))}\n`;
      }

      const server = {
        format: 1,
        hostContract: 1,
        version: metadata.version,
        packagingVersion: 2,
        packageId: metadata.packageId,
        runtime: {
          node: '24.21.0',
          abi: '137',
          platform: 'linux',
          arch: 'x64'
        },
        capabilities: ['api', 'ipc', 'helpers', 'engine'],
        engine: { protocol: 'route-v2', sha256: 'a'.repeat(64) },
        payload: {
          sha256: 'c'.repeat(64),
          size: 1,
          entryCount: 1
        },
      };
      const info = name === 'server' ? server : name === 'deepseek' ? runtimeInfoFixture() : metadata;
      const proof = {
        verified: true,
        version: metadata.version,
        packageId: name === 'server' ? metadata.packageId : runtimeInfoFixture().packageId,
        nativeBindingsVerified: 2,
        filesVerified: 1,
        glmPlugin: true,
      };

      return '#!/bin/sh\ncase "$1" in\n'
        + `--runtime-info) printf '%s\\n' ${shellQuote(JSON.stringify(info))} ;;\n`
        + `--verify) printf '%s\\n' ${shellQuote(JSON.stringify(proof))} ;;\n`
        + `*) printf '%s\\n' ${shellQuote(JSON.stringify(metadata))} ;;\nesac\n`;
    },
  });
  const checks = resolveReleaseChecks({
    testMode: 'full',
    reason: '',
    validationRun: '',
    version: built.index.latest.payload.version,
    commit: built.index.latest.payload.commit,
    ref: 'refs/heads/main',
  });
  const acceptanceFile = path.join(built.directory, 'release-acceptance.json');
  const acceptance = JSON.parse(await fs.readFile(acceptanceFile, 'utf8'));

  acceptance.testValidation = checks;
  await fs.writeFile(acceptanceFile, JSON.stringify(acceptance));
  await fs.writeFile(path.join(built.directory, 'release-checks.json'), JSON.stringify(checks));
  await buildDeb({
    root: built.root,
    artifacts: built.directory,
    offline: true,
  });

  const zip = await buildStableLinuxZip(built.directory, built.index.latest.payload.version);

  const baseline = process.env.VERIFY_RELEASE_BASELINE === '1' ? {
    'tools/verifyRelease.mts': execFileSync('git', ['show', 'HEAD:tools/verifyRelease.mts'],
      { cwd: root, encoding: 'utf8' }),
  } : {};
  const { verifyBuiltRelease } = await loadInstalledModule(t, 'tools/verifyRelease.mts',
    built.signer.publicKeyPem, baseline);

  // Fixture собран в канале release; verifier сверяет канал с env CI, поэтому
  // тест фиксирует канал под свой fixture и восстанавливает окружение после.
  const channelBefore = process.env.GRIGDESK_RELEASE_CHANNEL;

  process.env.GRIGDESK_RELEASE_CHANNEL = 'release';
  t.after(() => {
    if (channelBefore === undefined) {
      delete process.env.GRIGDESK_RELEASE_CHANNEL;
    } else {
      process.env.GRIGDESK_RELEASE_CHANNEL = channelBefore;
    }
  });

  const proof = await verifyBuiltRelease(built.directory, built.index.latest.payload.commit);

  assert.equal(proof.runtime.installation.length, 3);

  for (const mode of proof.runtime.installation) {
    assert.equal(mode.completed, true);
    assert.equal(mode.guiAcceptance, 'not-performed');
    assert.equal(mode.digest, acceptance.manifestDigest);
  }

  assert.ok(Array.isArray(proof.publicAssets));

  const expected = [
    'grigdesk-install', path.basename(zip),
    `grigdesk_${built.index.latest.payload.version}_amd64.deb`,
  ];

  assert.deepEqual(proof.publicAssets.map((asset: { name: string }) => asset.name), expected);

  for (const asset of proof.publicAssets) {
    const file = path.join(built.directory, asset.name);

    assert.equal(asset.sha256, await sha256File(file));
    assert.equal(asset.size, (await fs.stat(file)).size);
  }

  const resultFile = path.join(built.directory, 'verified-proof.json');

  await fs.stat(resultFile);
  await fs.writeFile(path.join(built.directory, 'unexpected.json'), '[]');
  execFileSync('7z', ['a', '-tzip', zip, 'unexpected.json'], { cwd: built.directory });
  await assert.rejects(verifyBuiltRelease(built.directory, built.index.latest.payload.commit),
    /offline_zip_inventory_invalid/u);
  await assert.rejects(fs.stat(resultFile), { code: 'ENOENT' });

  await buildStableLinuxZip(built.directory, built.index.latest.payload.version);
  await verifyBuiltRelease(built.directory, built.index.latest.payload.commit);
  await fs.stat(resultFile);

  const deb = path.join(built.directory, expected[2]!);
  const tree = path.join(built.root, 'wrong-deb');
  const changed = path.join(built.root, 'different.deb');

  await fs.mkdir(tree);
  execFileSync('dpkg-deb', ['--raw-extract', deb, tree]);
  await fs.chmod(path.join(tree, 'usr/bin/grigdesk'), 0o644);
  execFileSync('dpkg-deb', ['--build', '--root-owner-group', '-Znone', tree, changed]);
  await fs.copyFile(changed, deb);

  await assert.rejects(verifyBuiltRelease(built.directory, built.index.latest.payload.commit),
    /offline_deb_entry_invalid/u);
  await assert.rejects(fs.stat(resultFile), { code: 'ENOENT' });

  await fs.chmod(path.join(tree, 'usr/bin/grigdesk'), 0o755);

  const maintainerScript = path.join(tree, 'DEBIAN/postinst');

  await fs.writeFile(maintainerScript, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.rm(changed);
  execFileSync('dpkg-deb', ['--build', '--root-owner-group', '-Znone', tree, changed]);
  await fs.copyFile(changed, deb);
  await assert.rejects(verifyBuiltRelease(built.directory, built.index.latest.payload.commit),
    /offline_deb_inventory_invalid/u);
  await fs.rm(maintainerScript);

  const serverArchive = path.join(tree, 'usr/lib/grigdesk/server.tar.gz');
  const originalServer = await fs.readFile(serverArchive);

  await fs.writeFile(serverArchive, 'other content');
  await fs.rm(changed);
  execFileSync('dpkg-deb', ['--build', '--root-owner-group', '-Znone', tree, changed]);
  await fs.copyFile(changed, deb);
  await assert.rejects(verifyBuiltRelease(built.directory, built.index.latest.payload.commit),
    /offline_package_bytes_mismatch/u);

  await fs.writeFile(serverArchive, originalServer);
  await fs.chmod(path.join(tree, 'usr/lib/grigdesk/grigdesk-maintenance.gz'), 0o600);
  await fs.rm(changed);
  execFileSync('dpkg-deb', ['--build', '--root-owner-group', '-Znone', tree, changed]);
  await fs.copyFile(changed, deb);
  await assert.rejects(verifyBuiltRelease(built.directory, built.index.latest.payload.commit),
    /offline_deb_inventory_invalid/u);
  await assert.rejects(fs.stat(resultFile), { code: 'ENOENT' });
});
