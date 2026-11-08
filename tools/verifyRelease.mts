import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { publishInstalledRelease } from './installedPublication.mts';
import { decodeReleaseChecks } from './releaseChecks.mts';
import { decodeReleaseChannelIndex }
  from '../shared/runtime/installedUpdateContracts.ts';
import { extractReleaseArtifact }
  from '../shared/node/releaseArchive.ts';
import { verifyReleaseEnvelope }
  from '../shared/node/releaseTrust.ts';
import { decodeServerBinaryInfo }
  from '../shared/runtime/serverBinary.ts';
import { decodeDeepSeekRuntimeInfo }
  from '../shared/chat/deepSeekBinary.ts';
import { removePrivateTree }
  from '../shared/node/files.ts';

const execute = promisify(execFile);

/**
 * Проверяет скачанные байты выпуска тем же путём, что публикация и установщик.
 * Реальные бинарники запускаются в отдельном HOME; GUI-приёмка сюда не входит.
 */
export async function verifyBuiltRelease(directory: string, expectedCommit: string) {
  assert.match(expectedCommit, /^[a-f0-9]{40}$/u);

  const names = (await fs.readdir(directory))
    .filter((name) => name === 'release.json' || name === 'dev.json');

  assert.equal(names.length, 1);

  const index = decodeReleaseChannelIndex(JSON.parse(
    await fs.readFile(path.join(directory, names[0]!), 'utf8'),
  ));

  assert.ok(index.latest);
  assert.equal(index.latest.payload.commit, expectedCommit);

  const checks = decodeReleaseChecks(JSON.parse(
    await fs.readFile(path.join(directory, 'release-checks.json'), 'utf8'),
  ));
  const acceptance = JSON.parse(await fs.readFile(path.join(directory, 'release-acceptance.json'), 'utf8'));

  assert.equal(checks.commit, expectedCommit);
  assert.equal(checks.version, index.latest.payload.version);
  assert.deepEqual(acceptance.testValidation, checks);
  assert.equal(acceptance.identity.commit, expectedCommit);
  assert.equal(acceptance.identity.version, index.latest.payload.version);
  assert.equal(acceptance.manifestDigest, verifyReleaseEnvelope(index.latest));

  const origin = new URL(index.latest.payload.artifacts.server.url).origin;

  // Настоящий preflight проверяет обе подписи и SHA архивов; dryRun запрещает SSH.
  // Заглушки адреса не используются: функция возвращает управление до подключения.
  await publishInstalledRelease(directory, [{
    origin,
    host: 'not-used.invalid',
    user: 'not-used',
    port: '22',
    key: '/not-used',
    dir: '/not-used',
  }], true);

  const counts: Record<string, number> = {};
  const runtime: Record<string, unknown> = {};
  const deb = path.join(directory, `grigdesk_${index.latest.payload.version}_amd64.deb`);
  const debFields: Record<string, string> = {};

  for (const [field, expected] of Object.entries({
    Package: 'grigdesk',
    Version: index.latest.payload.version,
    Architecture: 'amd64',
  })) {
    const result = await execute('dpkg-deb', ['--field', deb, field],
      { timeout: 15000, maxBuffer: 65536 });

    assert.equal(result.stderr, '');
    assert.equal(result.stdout.trim(), expected);
    debFields[field] = expected;
  }

  const work = await fs.mkdtemp(path.join(directory, 'inventory-check-'));

  try {
    for (const component of ['server', 'desktop'] as const) {
      const artifact = index.latest.payload.artifacts[component];

      await extractReleaseArtifact(path.join(directory, `${component}.tar.gz`),
        path.join(work, component), artifact);
      counts[component] = artifact.files.length;
    }

    const home = path.join(work, 'probe-home');
    const env = {
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      HOME: home,
      GRIGDESK_HOME: path.join(home, 'data'),
      XDG_CONFIG_HOME: path.join(home, 'config'),
      XDG_DATA_HOME: path.join(home, 'share'),
      XDG_CACHE_HOME: path.join(home, 'cache'),
      TMPDIR: path.join(home, 'tmp'),
    };

    for (const folder of Object.values(env).filter((value) => value.startsWith(home))) {
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    }

    const options = {
      cwd: '/',
      env,
      timeout: 180000,
      maxBuffer: 1024 * 1024,
    };
    const server = path.join(work, 'server/bin/grigdesk-server');
    const metadata = await execute(server, ['--runtime-info', '--json'], options);

    assert.equal(metadata.stderr, '');

    const info = decodeServerBinaryInfo(JSON.parse(metadata.stdout));

    assert.equal(info.version, index.latest.payload.version);
    assert.equal(info.packageId, index.latest.payload.artifacts.server.packageId);

    const verified = await execute(server, ['--verify', '--json'], options);
    const serverProof = JSON.parse(verified.stdout);

    assert.equal(verified.stderr, '');
    assert.equal(serverProof.verified, true);
    assert.equal(serverProof.packageId, info.packageId);
    assert.equal(serverProof.nativeBindingsVerified, 2);
    runtime.server = {
      packageId: info.packageId,
      version: info.version,
      verified: true,
      nativeBindingsVerified: 2,
      filesVerified: serverProof.filesVerified,
    };

    const deepseek = path.join(work, 'server/bin/deepseek');
    const deepseekMetadata = await execute(deepseek, ['--runtime-info', '--json'], options);

    assert.equal(deepseekMetadata.stderr, '');

    const deepseekInfo = decodeDeepSeekRuntimeInfo(JSON.parse(deepseekMetadata.stdout));
    const deepseekResult = await execute(deepseek, ['--verify', '--json'], options);
    const deepseekProof = JSON.parse(deepseekResult.stdout);

    assert.equal(deepseekResult.stderr, '');
    assert.equal(deepseekProof.verified, true);
    assert.equal(deepseekProof.packageId, deepseekInfo.packageId);
    assert.equal(deepseekProof.glmPlugin, true);
    runtime.deepseek = {
      packageId: deepseekInfo.packageId,
      verified: true,
      glmPlugin: true,
    };
  } finally {
    await removePrivateTree(work);
  }

  const proof = {
    channel: index.channel,
    version: index.latest.payload.version,
    commit: index.latest.payload.commit,
    digest: verifyReleaseEnvelope(index.latest),
    signatureValid: true,
    installerSignatureValid: true,
    archiveHashesValid: true,
    inventoriesValid: true,
    files: counts,
    runtime,
    deb: debFields,
    testValidation: checks,
  };

  await fs.writeFile(path.join(directory, 'verified-proof.json'), JSON.stringify(proof, null, 2));

  return proof;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const directory = path.resolve(process.argv[2] ?? 'release-artifacts');
  const proof = await verifyBuiltRelease(directory, process.env.GRIGDESK_RELEASE_COMMIT ?? '');

  assert.equal(proof.version, process.env.GRIGDESK_RELEASE_VERSION);
  process.stdout.write(`${JSON.stringify(proof)}\n`);
}
