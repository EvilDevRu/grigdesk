import fs from 'node:fs/promises';
import path from 'node:path';

import { isRecord } from '../shared/lib/objects.ts';
import { sha256 } from '../shared/node/hash.ts';
import { parseProductVersion } from '../shared/runtime/productReleaseVersion.ts';

const WORKFLOW = '.github/workflows/grigdesk-release.yml';
const PREVIOUS_FULL_WORKFLOW = '327853e9c7720731964077c47570ca1e0be46f6b';
const ORCHESTRATION = new Set([
  WORKFLOW,
  'tools/releaseValidation.mts',
  'tests/server/release-validation.test.js',
  'tests/server/release-workflow.test.js',
  'docs/grigdesk/server/release-workflow-validation.md',
  'docs/grigdesk/server/release-validation-reuse.md',
  'docs/grigdesk/server/README.md',
]);
const CHECKS = [
  'Тесты сервера', 'Тесты web', 'Тесты shared-контрактов', 'Руководство выпуска',
  'Подтверждение всех проверок', 'Production-сборка web', 'Сборка комплекта',
  'Deb-пакет', 'Артефакты проверочного выпуска',
];
const COMMIT = /^[a-f0-9]{40}$/u;

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

interface ValidationInput {
  repository: string;
  runId: string;
  currentCommit: string;
  channel: string;
  ref: string;
  version: string;
}

type Reader = (route: string) => Promise<Record<string, unknown>>;

/**
 * Полная Git-опись сравнивает bytes и modes каждого файла, включая тесты и guide.
 * Исключены только семь явных файлов самого механизма CI; ссылки в них запрещены.
 */
function treeFiles(value: Record<string, unknown>): TreeEntry[] {
  if (value.truncated !== false || !Array.isArray(value.tree)) {
    throw new Error('release_validation_tree_incomplete');
  }

  const files: TreeEntry[] = [];
  const paths = new Set<string>();

  for (const entry of value.tree) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || entry.path.startsWith('/')
      || entry.path.split('/').includes('..') || typeof entry.mode !== 'string'
      || typeof entry.sha !== 'string' || !COMMIT.test(entry.sha)
      || !['tree', 'blob', 'commit'].includes(String(entry.type)) || paths.has(entry.path)) {
      throw new Error('release_validation_tree_invalid');
    }

    paths.add(entry.path);

    if (entry.type !== 'tree') {
      if (ORCHESTRATION.has(entry.path) && entry.mode !== '100644') {
        throw new Error('release_validation_orchestration_link');
      }

      files.push({
        path: entry.path,
        mode: entry.mode,
        type: String(entry.type),
        sha: entry.sha,
      });
    }
  }

  return files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

/**
 * API commit сначала подтверждает SHA и корень дерева, затем требует полную опись.
 * Чужой или усечённый ответ не заменяется локальным предположением о совпадении.
 */
async function commitFiles(commit: string, read: Reader): Promise<TreeEntry[]> {
  const metadata = await read(`/git/commits/${commit}`);

  if (metadata.sha !== commit || !isRecord(metadata.tree)
    || typeof metadata.tree.sha !== 'string' || !COMMIT.test(metadata.tree.sha)) {
    throw new Error('release_validation_commit_invalid');
  }

  const tree = await read(`/git/trees/${metadata.tree.sha}?recursive=1`);

  if (tree.sha !== metadata.tree.sha) {
    throw new Error('release_validation_tree_mismatch');
  }

  return treeFiles(tree);
}

/**
 * Повторное использование допускается только для stable-тега и успешного полного прогона.
 * Все runtime-исходники, зависимости, тесты и справка должны совпадать побайтно.
 */
export async function validatePriorReleaseRun(input: ValidationInput, read: Reader) {
  const version = parseProductVersion(input.version);

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository)
    || !/^[1-9][0-9]*$/u.test(input.runId) || !COMMIT.test(input.currentCommit)
    || input.channel !== 'release' || !version || version.dev !== null
    || input.ref !== `refs/tags/v${input.version}`) {
    throw new Error('release_validation_input_invalid');
  }

  const run = await read(`/actions/runs/${input.runId}`);

  if (run.id !== Number(input.runId) || run.status !== 'completed' || run.conclusion !== 'success'
    || run.event !== 'workflow_dispatch' || run.path !== WORKFLOW
    || !isRecord(run.repository) || run.repository.full_name !== input.repository
    || !isRecord(run.head_repository) || run.head_repository.full_name !== input.repository
    || typeof run.head_sha !== 'string' || !COMMIT.test(run.head_sha)) {
    throw new Error('release_validation_run_not_successful');
  }

  const [current, prior, jobs] = await Promise.all([
    commitFiles(input.currentCommit, read),
    commitFiles(run.head_sha, read),
    read(`/actions/runs/${input.runId}/jobs?per_page=100`),
  ]);
  const currentWorkflow = current.find((entry) => entry.path === WORKFLOW)?.sha;
  const priorWorkflow = prior.find((entry) => entry.path === WORKFLOW)?.sha;

  if (!currentWorkflow || !priorWorkflow
    || (priorWorkflow !== currentWorkflow && priorWorkflow !== PREVIOUS_FULL_WORKFLOW)) {
    throw new Error('release_validation_workflow_untrusted');
  }

  if (!Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length || !jobs.jobs.length) {
    throw new Error('release_validation_jobs_incomplete');
  }

  const steps: Record<string, unknown>[] = [];

  for (const job of jobs.jobs) {
    if (!isRecord(job) || job.status !== 'completed' || job.conclusion !== 'success'
      || !Array.isArray(job.steps) || job.steps.some((step) => !isRecord(step))) {
      throw new Error('release_validation_job_not_successful');
    }

    steps.push(...job.steps as Record<string, unknown>[]);
  }

  for (const name of CHECKS) {
    const matches = steps.filter((step) => step.name === name);
    const match = matches.length === 1 ? matches[0] : null;

    if (!match || match.status !== 'completed' || match.conclusion !== 'success') {
      throw new Error('release_validation_required_check_missing');
    }
  }

  const product = (files: TreeEntry[]) => JSON.stringify(
    files.filter((entry) => !ORCHESTRATION.has(entry.path)),
  );
  const currentProduct = product(current);

  if (currentProduct !== product(prior) || currentProduct === '[]') {
    throw new Error('release_validation_source_changed');
  }

  return {
    format: 1,
    runId: Number(input.runId),
    validatedCommit: run.head_sha,
    currentCommit: input.currentCommit,
    productDigest: sha256(currentProduct),
    checks: [...CHECKS],
    orchestrationPaths: [...ORCHESTRATION],
  };
}

// Обычный запуск сохраняет полный набор. Явный run требует доказательства до чтения ключей.
// GitHub token используется только для чтения metadata и никогда не попадает в receipt или журнал.
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const runId = (process.env.VALIDATION_RUN ?? '').trim();
  let reused = false;

  if (!process.env.GITHUB_OUTPUT) {
    throw new Error('release_validation_output_missing');
  }

  if (runId) {
    const repository = process.env.GITHUB_REPOSITORY ?? '';
    const token = process.env.GH_TOKEN ?? '';
    const receiptFile = process.env.VALIDATION_RECEIPT ?? '';

    if (!token || !path.isAbsolute(receiptFile)) {
      throw new Error('release_validation_environment_missing');
    }

    const receipt = await validatePriorReleaseRun({
      repository,
      runId,
      currentCommit: process.env.GRIGDESK_RELEASE_COMMIT ?? '',
      channel: process.env.GRIGDESK_RELEASE_CHANNEL ?? '',
      version: process.env.GRIGDESK_RELEASE_VERSION ?? '',
      ref: process.env.GITHUB_REF ?? '',
    }, async (route) => {
      const response = await fetch(`https://api.github.com/repos/${repository}${route}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
        },
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });

      if (!response.ok) {
        throw new Error(`release_validation_api_${response.status}`);
      }

      const body: unknown = await response.json();

      if (!isRecord(body)) {
        throw new Error('release_validation_api_invalid');
      }

      return body;
    });

    await fs.writeFile(receiptFile, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(`Полные проверки подтверждены запуском ${receipt.runId}.\n`);
    reused = true;
  }

  await fs.appendFile(process.env.GITHUB_OUTPUT, `reused=${reused}\n`);
}
