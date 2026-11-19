import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sha256File } from '../../shared/node/hash.ts';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';

import { createRunRecord, completeRunRecord, readRunRecord }
  from '../../tools/distributionRuns.mts';
import { verifyDistributionArtifacts } from '../../tools/releaseArtifactVerification.mts';
import { acceptanceBox } from './verify-installation.test.mts';

test('RUN-RECORD: приватная запись читается только владельцем и по точной схеме', async (t) => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dist-runs-'));

  t.after(() => fs.rm(runDir, { recursive: true, force: true }));

  const created = await createRunRecord(runDir, {
    realArtifactsRoot: path.join(runDir, 'release-artifacts'),
    sourceCommit: 'c'.repeat(40),
    sourceDigest: 'd'.repeat(64),
    recipeDigest: 'e'.repeat(64),
    manifestDigest: 'f'.repeat(64),
  });

  assert.equal((await readRunRecord(runDir, created.runId)).runId, created.runId);
  await assert.rejects(readRunRecord(runDir, 'not-a-uuid'), /distribution_run_id_invalid/u);

  await completeRunRecord(runDir, created.runId, 'verified', []);

  const recordDirectory = path.join(runDir, created.runId);

  assert.equal((await fs.stat(recordDirectory)).mode & 0o077, 0);
  assert.equal((await fs.stat(path.join(recordDirectory, 'run.json'))).mode & 0o177, 0);
  assert.equal((await readRunRecord(runDir, created.runId)).stage, 'verified');
});

test('RUN-RECORD: отмена оставляет building; терминальный writer единственный', async (t) => {
  const runDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'dist-terminal-'));

  t.after(() => fs.rm(runDir, { recursive: true, force: true }));

  const { runId } = await createRunRecord(runDir, {
    realArtifactsRoot: path.join(runDir, 'release-artifacts'),
    sourceCommit: 'c'.repeat(40),
    sourceDigest: 'd'.repeat(64),
    recipeDigest: 'e'.repeat(64),
    manifestDigest: '',
  });
  const signal = AbortSignal.abort(143);

  await assert.rejects(completeRunRecord(runDir, runId, 'verified', [], { signal }),
    (error) => error === 143);
  assert.equal((await readRunRecord(runDir, runId)).stage, 'building');

  const attempts = await Promise.allSettled([
    completeRunRecord(runDir, runId, 'failed', []),
    completeRunRecord(runDir, runId, 'failed', []),
  ]);

  assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
  await assert.rejects(completeRunRecord(runDir, runId, 'verified', []),
    /distribution_run_already_terminal/u);
  assert.equal((await readRunRecord(runDir, runId)).stage, 'failed');
  assert.deepEqual((await readRunRecord(runDir, runId)).artifacts, []);
});

test('LOCAL-RUN-TRUST: запись доверяет ключ run-а, --from тот же каталог отвергает', async (t) => {
  const box = await acceptanceBox(t);
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dist-trust-'));

  t.after(() => fs.rm(runDir, { recursive: true, force: true }));

  const record = await createRunRecord(runDir, {
    realArtifactsRoot: box.directory,
    sourceCommit: box.release.envelope.payload.commit,
    sourceDigest: '0'.repeat(64),
    recipeDigest: '1'.repeat(64),
    manifestDigest: box.release.manifestDigest,
  }, {
    publicKeyPem: box.release.publicKeyPem,
    privateKeyPem: String(box.release.privateKey.export({ type: 'pkcs8', format: 'pem' })),
  });

  await fs.writeFile(path.join(box.directory, 'local-build.json'), '{}\n');
  await completeRunRecord(runDir, record.runId, 'verified', []);

  const local = await verifyDistributionArtifacts(box.directory, {
    purpose: 'local',
    publicKeyPem: record.record.publicKeyPem,
    expectedCommit: box.release.envelope.payload.commit,
    expectedManifestDigest: box.release.manifestDigest,
  });

  assert.equal(local.bootstrap.manifestDigest, box.release.manifestDigest);

  await assert.rejects(verifyDistributionArtifacts(box.directory, {
    purpose: 'official',
    publicKeyPem: box.release.publicKeyPem,
    expectedCommit: box.release.envelope.payload.commit,
  }), /release_distribution_local_marker_present/u);

  await assert.rejects(verifyDistributionArtifacts(box.directory, {
    purpose: 'local',
    publicKeyPem: record.record.publicKeyPem,
    expectedCommit: box.release.envelope.payload.commit,
    expectedManifestDigest: 'f'.repeat(64),
  }), /release_distribution_digest_mismatch/u);
});

test('RUN-RECORD-MOVED: перемещение каталога не обновляет доверенную запись', async (t) => {
  const box = await acceptanceBox(t);
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dist-trust-move-'));

  t.after(() => fs.rm(runDir, { recursive: true, force: true }));

  const record = await createRunRecord(runDir, {
    realArtifactsRoot: box.directory,
    sourceCommit: box.release.envelope.payload.commit,
    sourceDigest: '0'.repeat(64),
    recipeDigest: '1'.repeat(64),
    manifestDigest: box.release.manifestDigest,
  }, {
    publicKeyPem: box.release.publicKeyPem,
    privateKeyPem: String(box.release.privateKey.export({ type: 'pkcs8', format: 'pem' })),
  });

  await completeRunRecord(runDir, record.runId, 'verified', []);

  const moved = path.join(runDir, 'moved');

  await fs.rename(box.directory, moved);

  const stored = await readRunRecord(runDir, record.runId);

  // Запись по-прежнему указывает на прежний физический путь и не обновилась сама.
  assert.equal(stored.realArtifactsRoot, box.directory);
  await assert.rejects(verifyDistributionArtifacts(stored.realArtifactsRoot, {
    purpose: 'local',
    publicKeyPem: stored.publicKeyPem,
    expectedCommit: stored.sourceCommit,
    expectedManifestDigest: stored.manifestDigest,
  }), /ENOENT/u);
});

test('OFFICIAL-FROM-TRUST: commit берётся из release-checks.json и сверяется', async (t) => {
  const box = await acceptanceBox(t);
  const { resolveTrust } = await import('../../tools/distribution.mts');
  const commit = box.release.envelope.payload.commit;

  await fs.writeFile(path.join(box.directory, 'release-checks.json'),
    `${JSON.stringify({ commit, version: box.release.envelope.payload.version })}\n`);

  const resolved = await resolveTrust(['check', '--from', box.directory]);

  assert.equal(resolved.trust.purpose, 'official');
  assert.equal(resolved.trust.expectedCommit, commit);
  assert.equal(resolved.directory, box.directory);

  const explicit = await resolveTrust(['check', '--from', box.directory,
    '--commit', commit]);

  assert.equal(explicit.trust.expectedCommit, commit);
  await assert.rejects(resolveTrust(['check', '--from', box.directory,
    '--commit', 'd'.repeat(40)]), /dist_commit_mismatch/u);

  await fs.rm(path.join(box.directory, 'release-checks.json'));
  await assert.rejects(resolveTrust(['check', '--from', box.directory]),
    /dist_commit_source_missing/u);
});

test('LOCAL-RUN-TRUST-KEYS: запись с ключами фикстуры доверяет тот же конверт', async (t) => {
  const box = await acceptanceBox(t);
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dist-trust-keys-'));

  t.after(() => fs.rm(runDir, { recursive: true, force: true }));

  const record = await createRunRecord(runDir, {
    realArtifactsRoot: box.directory,
    sourceCommit: box.release.envelope.payload.commit,
    sourceDigest: '0'.repeat(64),
    recipeDigest: '1'.repeat(64),
    manifestDigest: box.release.manifestDigest,
  }, {
    publicKeyPem: box.release.publicKeyPem,
    privateKeyPem: String(box.release.privateKey.export({ type: 'pkcs8', format: 'pem' })),
  });

  await fs.writeFile(path.join(box.directory, 'local-build.json'), '{}\n');
  await completeRunRecord(runDir, record.runId, 'verified', []);

  const local = await verifyDistributionArtifacts(box.directory, {
    purpose: 'local',
    publicKeyPem: record.record.publicKeyPem,
    expectedCommit: box.release.envelope.payload.commit,
    expectedManifestDigest: box.release.manifestDigest,
  });

  assert.equal(local.bootstrap.manifestDigest, box.release.manifestDigest);

  await assert.rejects(verifyDistributionArtifacts(box.directory, {
    purpose: 'official',
    publicKeyPem: box.release.publicKeyPem,
    expectedCommit: box.release.envelope.payload.commit,
  }), /release_distribution_local_marker_present/u);
});

test('LOCAL-RUN-CHECK-CLI: сквозной dist check --local-run реальным CLI', async (t) => {
  const box = await acceptanceBox(t);
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dist-run-cli-'));
  const { completed } = await import('../cli/helpers/sandbox.mts');
  const { spawn } = await import('node:child_process');
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const record = await createRunRecord(runDir, {
    realArtifactsRoot: box.directory,
    sourceCommit: box.release.envelope.payload.commit,
    sourceDigest: '0'.repeat(64),
    recipeDigest: '1'.repeat(64),
    manifestDigest: box.release.manifestDigest,
  }, {
    publicKeyPem: box.release.publicKeyPem,
    privateKeyPem: String(box.release.privateKey.export({ type: 'pkcs8', format: 'pem' })),
  });

  const inventory = await Promise.all((await fs.readdir(box.directory)).map(async (name) => {
    const file = path.join(box.directory, name);

    return {
      name,
      size: (await fs.stat(file)).size,
      sha256: await sha256File(file)
    };
  }));

  await completeRunRecord(runDir, record.runId, 'verified', inventory);

  const child = spawn(process.execPath,
    [path.join(repository, 'tools/distribution.mts'), 'check',
      '--local-run', record.runId], {
        cwd: repository,
        env: { ...process.env, GRIGDESK_DIST_RUN_DIR: runDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
  const result = await completed(child);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /"verified":true/u);

  t.after(() => fs.rm(runDir, { recursive: true, force: true }));
});

test('DIST-NO-MARKERS: без исходников dist завершается кодом 2 до эффектов', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dist-no-markers-'));
  const { completed } = await import('../cli/helpers/sandbox.mts');
  const { spawn } = await import('node:child_process');
  const repository = fileURLToPath(new URL('../../', import.meta.url));

  t.after(() => fs.rm(temporary, { recursive: true, force: true }));

  const child = spawn(process.execPath,
    [path.join(repository, 'tools/distribution.mts'), 'build'], {
      cwd: temporary,
      env: { ...process.env, GRIGDESK_DIST_RUN_DIR: temporary },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const result = await completed(child);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /из исходников/u);
});

/**
 * Локальный CLI получает доверие только через приватную опись своего run-а.
 * Изменение дополнительных байтов ловится до helper, даже если подписи архива прежние.
 */
test('LOCAL-RUN-INVENTORY: изменение marker и symlink записи отвергаются', async (t) => {
  const box = await acceptanceBox(t);
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dist-inventory-'));
  const { resolveTrust } = await import('../../tools/distribution.mts');

  t.after(() => fs.rm(runDir, { recursive: true, force: true }));

  const created = await createRunRecord(runDir, {
    realArtifactsRoot: box.directory,
    sourceCommit: box.release.envelope.payload.commit,
    sourceDigest: '0'.repeat(64),
    recipeDigest: '1'.repeat(64),
    manifestDigest: box.release.manifestDigest,
  }, {
    publicKeyPem: box.release.publicKeyPem,
    privateKeyPem: String(box.release.privateKey.export({ type: 'pkcs8', format: 'pem' })),
  });
  const inventory = await Promise.all((await fs.readdir(box.directory)).map(async (name) => {
    const file = path.join(box.directory, name);

    return {
      name,
      size: (await fs.stat(file)).size,
      sha256: await sha256File(file)
    };
  }));

  await completeRunRecord(runDir, created.runId, 'verified', inventory);

  const previous = process.env.GRIGDESK_DIST_RUN_DIR;

  process.env.GRIGDESK_DIST_RUN_DIR = runDir;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.GRIGDESK_DIST_RUN_DIR;
    } else {
      process.env.GRIGDESK_DIST_RUN_DIR = previous;
    }
  });
  await resolveTrust(['check', '--local-run', created.runId]);
  await fs.writeFile(path.join(box.directory, 'unexpected'), 'лишние байты');
  await assert.rejects(resolveTrust(['check', '--local-run', created.runId]),
    /distribution_run_artifacts_invalid/u);

  const link = path.join(runDir, 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12));

  await fs.symlink(path.join(runDir, created.runId), link);
  await assert.rejects(readRunRecord(runDir, path.basename(link)),
    /distribution_run_record_invalid/u);
});
