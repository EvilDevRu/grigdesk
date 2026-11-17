import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

import { shellQuote } from '../../shared/lib/shellQuote.ts';
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
    maintenanceSource: async (signer: { publicKeyPem: string }) => {
      const module = await loadInstalledModule(t, 'tools/maintenance.mts', signer.publicKeyPem);
      const entry = `import { runMaintenance } from ${JSON.stringify(module.fixtureModuleUrl)};
        process.execPath = process.argv[1];
        process.exitCode = await runMaintenance(process.argv.slice(2));`;

      return `#!/bin/sh\nexec ${shellQuote(process.execPath)} --input-type=module -e `
        + `${shellQuote(entry)} "$0" "$@"\n`;
    },
    builderSource: async (name: string, _input: unknown, metadata: FixtureBinaryMetadata) => {
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
  await buildDeb({ root: built.root, artifacts: built.directory });

  const baseline = process.env.VERIFY_RELEASE_BASELINE === '1' ? {
    'tools/verifyRelease.mts': execFileSync('git', ['show', 'HEAD:tools/verifyRelease.mts'],
      { cwd: root, encoding: 'utf8' }),
  } : {};
  const { verifyBuiltRelease } = await loadInstalledModule(t, 'tools/verifyRelease.mts',
    built.signer.publicKeyPem, baseline);
  const proof = await verifyBuiltRelease(built.directory, built.index.latest.payload.commit);

  assert.equal(proof.runtime.installation.length, 3);

  for (const mode of proof.runtime.installation) {
    assert.equal(mode.completed, true);
    assert.equal(mode.guiAcceptance, 'not-performed');
    assert.equal(mode.digest, acceptance.manifestDigest);
  }
});
