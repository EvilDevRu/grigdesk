import fs from 'node:fs/promises';
import path from 'node:path';
import { constants, renameSync } from 'node:fs';
import { generateKeyPairSync, randomUUID } from 'node:crypto';

import { assertInstallationPath } from '../shared/node/installedLayout.ts';
import { sha256File } from '../shared/node/hash.ts';
import { syncDirectory } from '../shared/node/files.ts';
import { canonicalJson } from '../shared/lib/canonicalJson.ts';

export interface DistributionRunArtifact {
  name: string;
  size: number;
  sha256: string;
}

export interface DistributionRunRecord {
  format: 1;
  runId: string;
  uid: number;
  realArtifactsRoot: string;
  sourceCommit: string;
  sourceDigest: string;
  recipeDigest: string;
  publicKeyPem: string;
  manifestDigest: string;
  stage: 'building' | 'failed' | 'verified';
  artifacts: DistributionRunArtifact[];
  verificationTools?: { processIdentity: string; setsid: string };
}

const RECORD_LIMIT = 1024 * 1024;

/**
 * Приватная запись доверия живёт вне каталога артефактов: 0700/0600, uid владельца,
 * точная схема. Публичный ключ run-а закрепляется здесь и нигде больше не читается
 * как доверенный.
 */
export async function createRunRecord(runDir: string, meta: {
  realArtifactsRoot: string;
  sourceCommit: string;
  sourceDigest: string;
  recipeDigest: string;
  manifestDigest: string;
}, keys?: { publicKeyPem: string; privateKeyPem: string }):
Promise<{
  runId: string;
  privateKeyPem: string;
  record: DistributionRunRecord
}> {
  const runId = randomUUID();
  const directory = path.join(runDir, runId);
  const generated = keys ?? (() => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');

    return {
      privateKeyPem: String(privateKey.export({ type: 'pkcs8', format: 'pem' })),
      publicKeyPem: String(publicKey.export({ type: 'spki', format: 'pem' })),
    };
  })();
  const { privateKeyPem, publicKeyPem } = generated;
  const record: DistributionRunRecord = {
    format: 1,
    runId,
    uid: process.getuid!(),
    realArtifactsRoot: meta.realArtifactsRoot,
    sourceCommit: meta.sourceCommit,
    sourceDigest: meta.sourceDigest,
    recipeDigest: meta.recipeDigest,
    publicKeyPem,
    manifestDigest: meta.manifestDigest,
    stage: 'building',
    artifacts: [],
  };

  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  await assertInstallationPath(runDir);
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(path.join(directory, 'run.json'),
    canonicalJson(record) + '\n', { mode: 0o600 });
  await fs.writeFile(path.join(directory, 'private.pem'), privateKeyPem, { mode: 0o600 });

  return {
    runId,
    privateKeyPem,
    record
  };
}

/**
 * Итог заменяет собственную запись атомарным rename в приватной папке запуска.
 * Один writer переводит building в терминальное состояние после проверки отмены.
 */
export async function completeRunRecord(runDir: string, runId: string,
  stage: 'failed' | 'verified', artifacts: DistributionRunArtifact[],
  options: {
    manifestDigest?: string;
    verificationTools?: DistributionRunRecord['verificationTools'];
    signal?: AbortSignal;
  } = {}): Promise<void> {
  const { manifestDigest, verificationTools, signal } = options;

  await readRunRecord(runDir, runId);

  const directory = path.join(runDir, runId);
  const lock = path.join(directory, 'terminal.lock');

  await fs.mkdir(lock, { mode: 0o700 });

  const temporary = path.join(lock, 'run.json');

  try {
    const record = await readRunRecord(runDir, runId);

    if (record.stage !== 'building') {
      throw new Error('distribution_run_already_terminal');
    }

    signal?.throwIfAborted();

    const updated = {
      ...record,
      stage,
      artifacts,
      ...manifestDigest !== undefined ? { manifestDigest } : {},
      ...verificationTools !== undefined ? { verificationTools } : {},
    };
    const file = await fs.open(temporary, 'wx', 0o600);

    try {
      await file.writeFile(canonicalJson(updated) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }

    // Проверка сигнала и начало commit проходят в одном обороте цикла событий.
    signal?.throwIfAborted();
    renameSync(temporary, path.join(directory, 'run.json'));
    await syncDirectory(directory);
  } finally {
    await fs.rm(temporary, { force: true });
    await fs.rmdir(lock);
  }
}

/**
 * Чтение доверенной записи: O_NOFOLLOW, uid/режим/размер, точная схема ключей и
 * совпадение runId. Ключ из local-build.json каталога не читается никогда.
 */
export async function readRunRecord(runDir: string, runId: string): Promise<DistributionRunRecord> {
  if (!/^[a-f0-9-]{36}$/u.test(runId)) {
    throw new Error('distribution_run_id_invalid');
  }

  const directory = path.join(runDir, runId);
  const file = path.join(directory, 'run.json');

  await assertInstallationPath(runDir).catch(() => {
    throw new Error('distribution_run_record_invalid');
  });

  const stat = await fs.lstat(directory).catch(() => null);

  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!()
    || stat.mode & 0o077) {
    throw new Error('distribution_run_record_invalid');
  }

  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new Error('distribution_run_record_invalid');
  });

  try {
    const fileStat = await handle.stat();

    if (!fileStat.isFile() || fileStat.uid !== process.getuid!() || fileStat.mode & 0o177
      || fileStat.size > RECORD_LIMIT) {
      throw new Error('distribution_run_record_invalid');
    }

    const value = JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>;
    const fields = ['artifacts', 'format', 'manifestDigest', 'publicKeyPem', 'recipeDigest',
      'realArtifactsRoot', 'runId', 'sourceCommit', 'sourceDigest', 'stage', 'uid'];
    const tools = value.verificationTools;

    if (tools !== undefined) {
      fields.push('verificationTools');

      if (value.stage !== 'verified' || !tools || typeof tools !== 'object'
        || Object.keys(tools).sort().join(',') !== 'processIdentity,setsid'
        || !Object.values(tools).every((digest) => typeof digest === 'string'
          && /^[a-f0-9]{64}$/u.test(digest))) {
        throw new Error('distribution_run_record_invalid');
      }
    }

    if (Object.keys(value).sort().join(',') !== fields.sort().join(',') || value.format !== 1
      || value.runId !== runId || value.uid !== process.getuid!()
      || !['building', 'failed', 'verified'].includes(String(value.stage))) {
      throw new Error('distribution_run_record_invalid');
    }

    if (typeof value.realArtifactsRoot !== 'string' || !path.isAbsolute(value.realArtifactsRoot)
      || typeof value.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(value.sourceCommit)
      || typeof value.publicKeyPem !== 'string' || !value.publicKeyPem.includes('PUBLIC KEY')
      || !['sourceDigest', 'recipeDigest'].every((key) => typeof value[key] === 'string'
        && /^[a-f0-9]{64}$/u.test(value[key] as string))
      || typeof value.manifestDigest !== 'string'
      || value.manifestDigest !== '' && !/^[a-f0-9]{64}$/u.test(value.manifestDigest)
      || !Array.isArray(value.artifacts)) {
      throw new Error('distribution_run_record_invalid');
    }

    for (const artifact of value.artifacts as DistributionRunArtifact[]) {
      if (!artifact || Object.keys(artifact).sort().join(',') !== 'name,sha256,size'
        || typeof artifact.name !== 'string' || path.basename(artifact.name) !== artifact.name
        || ['.', '..'].includes(artifact.name) || !/^[a-f0-9]{64}$/u.test(artifact.sha256)
        || !Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
        throw new Error('distribution_run_record_invalid');
      }
    }

    return value as unknown as DistributionRunRecord;
  } finally {
    await handle.close();
  }
}

/**
 * Проверка локального доверия закрепляет физический путь и точные байты всей описи.
 * Ни ключ, ни дополнительные файлы из переданного каталога не расширяют доверие run-а.
 */
export async function verifyRunArtifacts(record: DistributionRunRecord, signal?: AbortSignal): Promise<void> {
  const root = record.realArtifactsRoot;

  await assertInstallationPath(root);

  if (await fs.realpath(root) !== root || record.artifacts.length === 0) {
    throw new Error('distribution_run_artifacts_invalid');
  }

  const names = record.artifacts.map((artifact) => artifact.name).sort();
  const actual = (await fs.readdir(root)).sort();

  if (new Set(names).size !== names.length || names.join('\0') !== actual.join('\0')) {
    throw new Error('distribution_run_artifacts_invalid');
  }

  for (const artifact of record.artifacts) {
    signal?.throwIfAborted();

    const file = path.join(root, artifact.name);
    const stat = await fs.lstat(file);

    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== record.uid
      || stat.size !== artifact.size || await sha256File(file, signal) !== artifact.sha256) {
      throw new Error('distribution_run_artifacts_invalid');
    }
  }
}
