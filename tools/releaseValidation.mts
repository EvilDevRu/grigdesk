import fs from 'node:fs/promises';
import path from 'node:path';

import { decodeRecipe, recipeDigest, recipeImplementationBytes } from './releasePipeline.mts';
import { isRecord } from '../shared/lib/objects.ts';
import { sha256 } from '../shared/node/hash.ts';
import { parseProductVersion } from '../shared/runtime/productReleaseVersion.ts';

const WORKFLOW = '.github/workflows/grigdesk-release.yml';
const PREVIOUS_FULL_WORKFLOW = '327853e9c7720731964077c47570ca1e0be46f6b';
const CLASSIC_WORKFLOWS = new Set([
  '48a9468743794c93e8450336b400725e4b4d5079',
  '72167dafed76d675529dbdb1f162ac524cb48398',
]);
const CLASSIC_JOBS = new Map<string, readonly string[]>([
  ['План и допуск выпуска', []],
  ['Сервер, shared и руководство', ['Общий прогон серверных проверок']],
  ['Web-проверки', ['Общий прогон web-проверок']],
  ['Сборка и подпись', ['Общая сборка web', 'Ключ подписи', 'Сборка комплекта', 'Deb-пакет',
    'Свидетельство проверок']],
  ['Проверка готовых пакетов', ['Проверка готовых пакетов']],
  ['Публикация на сайт', []],
]);
const CANDIDATE_JOBS = new Set([
  'Сборка кандидата Linux x64', 'Проверка кандидата Linux x64',
  'Сборка кандидата macOS ARM64', 'Проверка кандидата macOS ARM64', 'Выдача пары кандидатов',
]);
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
  'Общий прогон серверных проверок', 'Общий прогон web-проверок', 'Общая сборка web',
  'Ключ подписи', 'Сборка комплекта', 'Deb-пакет', 'Свидетельство проверок',
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
 * Допустим только целый классический граф выбранного workflow attempt.
 * Активный кандидат, неожиданный job или пропущенный test step дисквалифицируют reuse.
 */
function verifyClassicJobs(
  jobs: unknown[], pairedWorkflow: boolean, runId: number, headSha: string,
): void {
  const expected = new Set([...CLASSIC_JOBS.keys(), ...(pairedWorkflow ? CANDIDATE_JOBS : [])]);

  for (const job of jobs) {
    if (!isRecord(job) || typeof job.name !== 'string' || !expected.delete(job.name)
      || job.status !== 'completed' || !Array.isArray(job.steps)
      || pairedWorkflow && (job.run_id !== runId || job.head_sha !== headSha)) {
      throw new Error('release_validation_jobs_incomplete');
    }

    const skippedWithEmptySteps = job.conclusion === 'skipped' && job.steps.length === 0;

    if (CANDIDATE_JOBS.has(job.name)) {
      if (!skippedWithEmptySteps) {
        throw new Error('release_validation_candidate_run');
      }

      continue;
    }

    if (job.name === 'Публикация на сайт' && skippedWithEmptySteps) {
      continue;
    }

    if (job.conclusion !== 'success' || job.steps.some((step) => !isRecord(step))) {
      throw new Error('release_validation_job_not_successful');
    }

    for (const name of CLASSIC_JOBS.get(job.name) ?? []) {
      const steps = job.steps.filter((step) => step.name === name);

      if (steps.length !== 1 || steps[0]?.status !== 'completed' || steps[0]?.conclusion !== 'success') {
        throw new Error('release_validation_required_check_missing');
      }
    }
  }

  if (expected.size) {
    throw new Error('release_validation_jobs_incomplete');
  }
}

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
    || !['refs/heads/main', `refs/tags/v${input.version}`].includes(input.ref)) {
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

  const [current, prior] = await Promise.all([
    commitFiles(input.currentCommit, read),
    commitFiles(run.head_sha, read),
  ]);
  const currentWorkflow = current.find((entry) => entry.path === WORKFLOW)?.sha;
  const priorWorkflow = prior.find((entry) => entry.path === WORKFLOW)?.sha;

  if (!currentWorkflow || !priorWorkflow
    || priorWorkflow !== currentWorkflow && priorWorkflow !== PREVIOUS_FULL_WORKFLOW
      && !CLASSIC_WORKFLOWS.has(priorWorkflow)) {
    throw new Error('release_validation_workflow_untrusted');
  }

  const legacy = priorWorkflow === PREVIOUS_FULL_WORKFLOW;
  const pairedWorkflow = !legacy && !CLASSIC_WORKFLOWS.has(priorWorkflow);
  const attempt = run.run_attempt;

  if (pairedWorkflow && (!Number.isSafeInteger(attempt) || Number(attempt) <= 0)) {
    throw new Error('release_validation_attempt_invalid');
  }

  const jobsRoute = `/actions/runs/${input.runId}`
    + (pairedWorkflow ? `/attempts/${attempt}` : '') + '/jobs?per_page=100';
  const jobs = await read(jobsRoute);

  if (!Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length || !jobs.jobs.length) {
    throw new Error('release_validation_jobs_incomplete');
  }

  const checks = legacy ? CHECKS : [...CHECKS, 'Проверка готовых пакетов'];

  if (legacy) {
    const steps: Record<string, unknown>[] = [];

    for (const job of jobs.jobs) {
      if (!isRecord(job) || job.status !== 'completed' || job.conclusion !== 'success'
        || !Array.isArray(job.steps) || job.steps.some((step) => !isRecord(step))) {
        throw new Error('release_validation_job_not_successful');
      }

      steps.push(...job.steps as Record<string, unknown>[]);
    }

    for (const name of checks) {
      const matches = steps.filter((step) => step.name === name);

      if (matches.length !== 1 || matches[0]?.status !== 'completed' || matches[0]?.conclusion !== 'success') {
        throw new Error('release_validation_required_check_missing');
      }
    }
  } else {
    verifyClassicJobs(jobs.jobs, pairedWorkflow, Number(input.runId), run.head_sha);
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
    checks: [...checks],
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


const RECEIPT_LIMIT = 1024 * 1024;

export interface PipelineReceipt {
  format: 1;
  recipeDigest: string;
  code: number;
}

/**
 * Digest вычисляется от явно выбранного checkout, независимо от cwd тестового пакета.
 * Runner, окружение и provisioning входят в ту же границу воспроизводимости.
 */
export async function computeRecipeDigest(recipeText: string,
  root = process.cwd()): Promise<string> {
  return recipeDigest(decodeRecipe(JSON.parse(recipeText)),
    await recipeImplementationBytes(root));
}

// root передаётся явно: серверные тесты идут с cwd=server, а digest обязан
// считаться от файлов репозитория, а не от текущего каталога запуска.

/**
 * Reuse допускает только receipt новой схемы: точный формат, текущий digest
 * рецепта и нулевой код прогона. Прежние прогоны без receipt не покрывают схему.
 */
export async function decodePipelineReceipt(value: unknown, recipeText: string,
  root = process.cwd()): Promise<PipelineReceipt> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (value as { format?: unknown }).format !== 1
    || typeof (value as { recipeDigest?: unknown }).recipeDigest !== 'string'
    || typeof (value as { code?: unknown }).code !== 'number') {
    throw new Error('pipeline_receipt_invalid');
  }

  const receipt = value as PipelineReceipt;
  const expected = await computeRecipeDigest(recipeText, root);

  if (receipt.recipeDigest !== expected || receipt.code !== 0
    || receipt.recipeDigest.length !== 64) {
    throw new Error('pipeline_receipt_invalid');
  }

  return receipt;
}

/**
 * Полный кандидат требует успешных исходов всех обязательных server/web стадий.
 * Один build-only receipt с правильным digest не доказывает выполнение тестов.
 */
export async function verifyPipelineReceipts(directory: string, root: string): Promise<void> {
  const recipeText = await fs.readFile(path.join(root, 'tools/releaseRecipe.json'), 'utf8');
  const recipe = decodeRecipe(JSON.parse(recipeText));
  const outcomes: Record<string, { status?: string; exitCode?: number }> = {};
  const files = (await fs.readdir(directory)).filter((name) =>
    /^pipeline-[a-f0-9-]+[.]json$/u.test(name));

  for (const name of files) {
    const file = path.join(directory, name);
    const stat = await fs.lstat(file);

    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > RECEIPT_LIMIT) {
      throw new Error('pipeline_receipt_invalid');
    }

    const value = JSON.parse(await fs.readFile(file, 'utf8'));

    await decodePipelineReceipt(value, recipeText, root);

    if (value.cleanupConfirmed !== true || !isRecord(value.outcomes)
      || process.env.GRIGDESK_RELEASE_SOURCE_DIGEST
        && value.sourceDigest !== process.env.GRIGDESK_RELEASE_SOURCE_DIGEST) {
      throw new Error('pipeline_receipt_invalid');
    }

    for (const [id, outcome] of Object.entries(value.outcomes)) {
      if (isRecord(outcome) && outcome.status !== 'skipped') {
        outcomes[id] = outcome;
      }
    }
  }

  for (const stage of recipe.stages.filter((entry) =>
    ['server', 'web'].includes(entry.group) && entry.required !== false)) {
    if (outcomes[stage.id]?.status !== 'success' || outcomes[stage.id]?.exitCode !== 0) {
      throw new Error('release_pipeline_receipt_missing');
    }
  }
}
