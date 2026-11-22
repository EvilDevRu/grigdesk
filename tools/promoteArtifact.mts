import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { withWorkDirectory } from '../shared/node/files.ts';
import { stablePlatforms, stableAssetNames } from './stablePlatformRelease.mts';
import { publicReleaseFile, type PublicReleaseFile } from './verifyLinuxPackages.mts';

const execute = promisify(execFile);
const stableProofName = 'stable-assets-proof.json';
const stableJobName = 'Подготовка всех стабильных загрузок';
const numericId = /^[1-9][0-9]*$/u;
const sha256 = /^[a-f0-9]{64}$/u;

export interface PromotionRun {
  id?: number;
  run_attempt?: number;
  repository?: { full_name?: string };
  path?: string;
  conclusion?: string;
  head_sha?: string;
}

/**
 * Источник продвижения обязан быть успешным запуском release-workflow того же
 * репозитория и того же commit-а; артефакт выбирается по id, а не по имени.
 */
export function assertPromotionSource(run: PromotionRun, repository: string,
  expectedCommit: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
    || !/^[a-f0-9]{40}$/u.test(expectedCommit)
    || !Number.isSafeInteger(run.id) || (run.id ?? 0) <= 0
    || run.repository?.full_name !== repository
    || run.path !== '.github/workflows/grigdesk-release.yml'
    || run.conclusion !== 'success' || run.head_sha !== expectedCommit) {
    throw new Error('promotion_source_invalid');
  }
}

/**
 * Выбор принимает единственный числовой id из списка артефактов заданного run-а.
 * Имя подтверждает класс выпуска, но не заменяет проверку принадлежности по id.
 */
export function pickPromotionArtifact(list: { artifacts: RunArtifact[] },
  artifactId: string): { id: number; name: string } {
  if (!/^[1-9][0-9]*$/u.test(artifactId) || !Array.isArray(list.artifacts)) {
    throw new Error('promotion_artifact_invalid');
  }

  const match = list.artifacts.filter((artifact) => String(artifact.id) === artifactId);

  if (match.length !== 1 || match[0]?.expired || !match[0]?.name.startsWith('grigdesk-')) {
    throw new Error('promotion_artifact_invalid');
  }

  return match[0]!;
}


interface StablePromotionInput {
  runId: string;
  commit: string;
  version: string;
  digest: string;
  artifactId: string;
}

interface StablePromotionProof {
  runId: string;
  commit: string;
  version: string;
  channel: 'release';
  signatureValid: true;
  planDigest: string;
  linuxManifestDigest: string;
  linuxBuildArtifactId: string;
  assets: PublicReleaseFile[];
}

interface RunArtifact {
  id: number;
  name: string;
  expired?: boolean;
}

/**
 * Допуск к сайту относится к полному доказательству и точному ID сборки Linux.
 * Формат и порядок файлов проверяются до доступа к секрету SSH.
 */
export function assertStablePromotionProof(raw: unknown, expected: StablePromotionInput):
  asserts raw is StablePromotionProof {
  const proof = raw as Partial<StablePromotionProof> | null;
  const names = stablePlatforms.flatMap((target) => stableAssetNames(target, expected.version));

  if (!numericId.test(expected.runId) || !numericId.test(expected.artifactId)
    || !/^[a-f0-9]{40}$/u.test(expected.commit) || !sha256.test(expected.digest)
    || !/^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){2}$/u.test(expected.version)
    || proof?.channel !== 'release' || proof.signatureValid !== true
    || proof.runId !== expected.runId || proof.commit !== expected.commit
    || proof.version !== expected.version || proof.linuxManifestDigest !== expected.digest
    || proof.linuxBuildArtifactId !== expected.artifactId
    || typeof proof.planDigest !== 'string' || !sha256.test(proof.planDigest)
    || !Array.isArray(proof.assets) || proof.assets.length !== names.length
    || names.some((name, index) => {
      const file = proof.assets?.[index];

      return file?.name !== name || typeof file.sha256 !== 'string' || !sha256.test(file.sha256)
        || !Number.isSafeInteger(file.size) || file.size < 1 || file.size >= 2 * 1024 ** 3;
    })) {
    throw new Error('stable_promotion_proof_invalid');
  }
}

/**
 * Читает только отдельный результат общего verify.
 * Путь остаётся параметром job, содержимое proof его не задаёт.
 */
export async function readStablePromotionProof(directory: string, expected: StablePromotionInput) {
  const file = directory && path.join(directory, stableProofName);
  const stat = file && await fs.lstat(file).catch(() => null);

  if (!stat || !stat.isFile() || stat.size < 1 || stat.size > 1024 ** 2) {
    throw new Error('stable_promotion_proof_invalid');
  }

  const proof: unknown = JSON.parse(await fs.readFile(file, 'utf8'));

  assertStablePromotionProof(proof, expected);

  return proof;
}

/**
 * Сверяет фактические три файла Linux x64 из build ID с общим доказательством.
 * Совпадение версии, подписи канала и имён само по себе не подтверждает байты .deb.
 */
export async function assertStableLinuxFiles(directory: string, proof: StablePromotionProof) {
  for (const expected of proof.assets.slice(0, stableAssetNames('linux-x64', proof.version).length)) {
    const actual = await publicReleaseFile(directory, expected.name);

    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
      throw new Error('stable_promotion_linux_bytes_mismatch: ' + expected.name);
    }
  }
}

/**
 * Читает все страницы фиксированного API своего репозитория.
 * Следующая страница вычисляется локально, URL из тела ответа не используется.
 */
async function listRunEntries<T>(endpoint: string, key: 'jobs' | 'artifacts'): Promise<T[]> {
  const entries: T[] = [];

  for (let page = 1; ; page++) {
    const response = await fetch(`${endpoint}?per_page=100&page=${page}`, {
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN ?? ''}`,
        Accept: 'application/vnd.github+json',
      },
    });

    if (!response.ok) {
      throw new Error('promotion_api_failed');
    }

    const body = await response.json();
    const items = body?.[key];

    if (!Array.isArray(items) || items.length > 100) {
      throw new Error('promotion_api_invalid');
    }

    entries.push(...items);

    if (items.length < 100) {
      return entries;
    }
  }
}

/**
 * Скачивает один артефакт в выделенный каталог с проверкой плоской описи.
 * Для общего proof принимает только один файл с закреплённым именем.
 */
async function downloadPromotionArtifact(
  repository: string, id: number, output: string, onlyFile?: string,
) {
  const archive = path.join(output, 'artifact.zip');

  await fs.mkdir(output, { recursive: true, mode: 0o700 });

  const outputFile = await fs.open(archive, 'wx', 0o600);

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('gh', ['api', `/repos/${repository}/actions/artifacts/${id}/zip`], {
        stdio: ['ignore', outputFile.fd, 'inherit'],
      });

      child.once('error', reject);
      child.once('close', (code) => code === 0 ? resolve() : reject(new Error('promotion_download_failed')));
    });
  } finally {
    await outputFile.close();
  }

  try {
    const listing = await execute('unzip', ['-Z', '-1', archive], { maxBuffer: 1024 ** 2 });
    const entries = listing.stdout.trimEnd().split('\n');

    if (new Set(entries).size !== entries.length || entries.some((name) =>
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) || name === 'artifact.zip')
      || onlyFile && (entries.length !== 1 || entries[0] !== onlyFile)) {
      throw new Error('promotion_archive_invalid');
    }

    await execute('unzip', ['-q', archive, '-d', output]);

    for (const name of entries) {
      if (!(await fs.lstat(path.join(output, name))).isFile()) {
        throw new Error('promotion_archive_invalid');
      }
    }
  } finally {
    await fs.rm(archive, { force: true });
  }
}

/**
 * Требует отдельный артефакт, успешный job того же commit и первую попытку.
 * Проверки выполняются перед извлечением архива и переносом proof на следующий шаг.
 */
async function requireStableProofArtifact(endpoint: string, artifacts: RunArtifact[],
  run: PromotionRun, artifactId: string, proofId: string) {
  const matches = artifacts.filter((item) => String(item.id) === proofId);
  const proof = matches[0];

  if (run.run_attempt !== 1 || proofId === artifactId || !numericId.test(proofId)
    || matches.length !== 1 || !proof || proof.expired !== false
    || proof.name !== `grigdesk-stable-proof-${run.id}-1`) {
    throw new Error('stable_promotion_proof_invalid');
  }

  const jobs = await listRunEntries<{
    name: string;
    head_sha: string;
    status: string;
    conclusion: string;
  }>(`${endpoint}/attempts/1/jobs`, 'jobs');
  const stable = jobs.filter((job) => job.name === stableJobName);

  if (stable.length !== 1 || stable[0]?.status !== 'completed'
    || stable[0].conclusion !== 'success' || stable[0].head_sha !== run.head_sha) {
    throw new Error('stable_promotion_proof_invalid');
  }

  return proof.id;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const flags = new Map<string, string>();

  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index]!;
    const value = process.argv[index + 1];

    if (!value || flags.has(flag) || ![
      '--run', '--artifact-id', '--output', '--mode', '--stable-proof-id', '--proof-output',
    ].includes(flag)) {
      throw new Error('promotion_arguments_invalid');
    }

    flags.set(flag, value);
  }

  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const commit = process.env.GRIGDESK_RELEASE_COMMIT ?? '';
  const channel = process.env.GRIGDESK_RELEASE_CHANNEL ?? '';
  const mode = flags.get('--mode');
  const marker = /^[a-f0-9]{40}$/u.test(commit) && await execute(
    'git', ['cat-file', '-e', `${commit}:tools/stablePlatformRelease.mts`],
  ).then(() => true, () => false);

  if (marker && ((mode !== 'inspect' && mode !== 'publish') || !['release', 'dev'].includes(channel))
    || mode === 'publish' && channel === 'release' && !marker) {
    throw new Error('stable_promotion_mode_required');
  }

  const runPath = flags.get('--run');
  const artifactId = flags.get('--artifact-id') ?? '';
  const outputPath = flags.get('--output');

  if (!runPath || !numericId.test(artifactId) || !outputPath
    || mode !== undefined && mode !== 'inspect' && mode !== 'publish') {
    throw new Error('promotion_arguments_invalid');
  }

  const run = JSON.parse(await fs.readFile(runPath, 'utf8')) as PromotionRun;
  const output = path.resolve(outputPath);

  assertPromotionSource(run, repository, commit);

  const endpoint = `https://api.github.com/repos/${repository}/actions/runs/${run.id}`;
  const stable = mode === 'publish' && channel === 'release';
  const proofId = flags.get('--stable-proof-id') ?? '';
  const proofOutput = flags.get('--proof-output');

  if (stable && (!numericId.test(proofId) || artifactId === proofId || !proofOutput)) {
    throw new Error('stable_promotion_proof_invalid');
  }

  const artifacts = await listRunEntries<RunArtifact>(`${endpoint}/artifacts`, 'artifacts');
  const artifact = pickPromotionArtifact({ artifacts }, artifactId);

  if (stable) {
    const id = await requireStableProofArtifact(endpoint, artifacts, run, artifactId, proofId);
    const proofPath = path.resolve(proofOutput!);
    const expected = {
      runId: String(run.id),
      commit,
      version: process.env.GRIGDESK_RELEASE_VERSION ?? '',
      digest: process.env.GRIGDESK_RELEASE_EXPECTED_DIGEST ?? '',
      artifactId,
    };

    await withWorkDirectory(path.dirname(proofPath), async (work) => {
      const proofDirectory = path.join(work, 'proof');

      await downloadPromotionArtifact(repository, id, proofDirectory, stableProofName);

      const proof = await readStablePromotionProof(proofDirectory, expected);

      await downloadPromotionArtifact(repository, artifact.id, output);
      await assertStableLinuxFiles(output, proof);
      await fs.rename(proofDirectory, proofPath);
    });
  } else {
    await downloadPromotionArtifact(repository, artifact.id, output);
  }
}
