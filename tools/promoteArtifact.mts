import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export interface PromotionRun {
  id?: number;
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
export function pickPromotionArtifact(list: { artifacts: { id: number; name: string }[] },
  artifactId: string): { id: number; name: string } {
  if (!/^[1-9][0-9]*$/u.test(artifactId) || !Array.isArray(list.artifacts)) {
    throw new Error('promotion_artifact_invalid');
  }

  const match = list.artifacts.filter((artifact) => String(artifact.id) === artifactId);

  if (match.length !== 1 || !match[0]!.name.startsWith('grigdesk-')) {
    throw new Error('promotion_artifact_invalid');
  }

  return match[0]!;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const run = JSON.parse(await fs.readFile(
    process.argv[process.argv.indexOf('--run') + 1]!, 'utf8')) as PromotionRun;
  const artifactId = process.argv[process.argv.indexOf('--artifact-id') + 1]!;
  const output = path.resolve(process.argv[process.argv.indexOf('--output') + 1]!);
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const expectedCommit = process.env.GRIGDESK_RELEASE_COMMIT ?? '';

  assertPromotionSource(run, repository, expectedCommit);

  const list = await fetch(`https://api.github.com/repos/${repository}`
    + `/actions/runs/${run.id}/artifacts?per_page=100`,
  {
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN ?? ''}`,
    Accept: 'application/vnd.github+json' }
  }).then((response) => {
    if (!response.ok) {
      throw new Error('promotion_api_failed');
    }

    return response.json();
  });
  const artifact = pickPromotionArtifact(list, artifactId);
  const archive = path.join(output, 'artifact.zip');

  await fs.mkdir(output, { recursive: true, mode: 0o700 });

  const outputFile = await fs.open(archive, 'wx', 0o600);

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('gh', ['api', `/repos/${repository}/actions/artifacts/${artifact.id}/zip`],
        { stdio: ['ignore', outputFile.fd, 'inherit'] });

      child.once('error', reject);
      child.once('close', (code) => code === 0 ? resolve() : reject(new Error('promotion_download_failed')));
    });
  } finally {
    await outputFile.close();
  }

  const entries = (await execute('unzip', ['-Z', '-1', archive])).stdout.trim().split('\n');

  if (new Set(entries).size !== entries.length || entries.some((name) =>
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) || name === 'artifact.zip')) {
    throw new Error('promotion_archive_invalid');
  }

  await execute('unzip', ['-q', archive, '-d', output]);
  await fs.rm(archive, { force: true });

  for (const name of entries) {
    if (!(await fs.lstat(path.join(output, name))).isFile()) {
      throw new Error('promotion_archive_invalid');
    }
  }
}
