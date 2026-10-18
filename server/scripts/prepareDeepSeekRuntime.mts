import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { sha256 } from '../../shared/node/hash.ts';

import { buildDeepSeekRuntime, deepSeekBuildInputs } from '../../tools/buildDeepSeekRuntime.mts';
import { materializeDeepSeekSnapshot } from '../../tools/deepseekVendorManifest.ts';
import { acquireDeepSeekLock, publishDeepSeekGeneration } from '../../tools/deepseekRuntimePublication.ts';
import { resolveDeepSeekRuntime } from '../src/lib/deepseek/runtimeProcess.ts';
import { readDeepSeekArtifact } from '../src/lib/deepseek/runtimeArtifact.ts';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const runtimeRoot = path.join(root, 'server/runtime/deepseek');
const vendor = path.join(root, 'third_party/deepseek-harness');
const pendingFile = path.join(runtimeRoot, 'publish-pending.json');

/**
 * Recovery принадлежит только job из маркера и только чистому исходному или целевому checkout.
 * Живой worker запрещает recovery; брошенный lock публикации снимет сама публикация.
 */
async function recoverPendingJob(jobId: string): Promise<void> {
  const pending = JSON.parse(await fs.readFile(pendingFile, 'utf8'));
  const { stdout: sha } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
  const { stdout: dirty } = await exec('git', ['status', '--porcelain=v1'], { cwd: root });

  if (pending.jobId !== jobId || dirty
      || ![pending.targetSha, pending.previousSha].includes(sha.trim())) {
    throw new Error('Recovery требует исходный или целевой чистый checkout этого job');
  }

  if (Number.isInteger(pending.workerPid)) {
    let alive = true;

    try {
      process.kill(pending.workerPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        alive = false;
      }
    }

    if (alive) {
      throw new Error('Worker ещё работает; recovery не разрешён');
    }
  }

  for (const directory of ['server', 'web']) {
    await exec('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], {
      cwd: path.join(root, directory),
      timeout: 15 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  }

  await exec('npm', ['run', 'build'], {
    cwd: path.join(root, 'web'),
    env: { ...process.env, VITE_GRIGDESK_SHA: sha.trim() },
    timeout: 15 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

/**
 * Готовое поколение подходит, только если записанные входы совпадают с текущими целиком.
 * Повреждённая, чужая или неполная сборка не считается готовой и пересобирается.
 */
function currentGeneration(
  generationRoot: string,
  inputs: Record<string, unknown>,
  { recovering = false } = {},
): { buildId: string; generationDir: string } | null {
  try {
    const runtime = resolveDeepSeekRuntime({
      deepseekRuntimeMode: 'embedded',
      deepseekGenerationRoot: generationRoot,
      ...(recovering ? { deepseekArtifactDir: path.join(generationRoot, 'current') } : {}),
    });
    const { artifact } = readDeepSeekArtifact(runtime.generationDir || '');

    // generationDir канонический; корень сравнивается тоже по realpath, иначе путь через
    // символическую ссылку (например, $PWD) выглядел бы как выход из builds.
    if (runtime.generationDir !== path.join(realpathSync(generationRoot), 'builds', artifact.buildId)) {
      throw Object.assign(new Error('Recovery current находится вне immutable builds'), {
        code: 'deepseek_runtime_recovery_invalid',
      });
    }

    const saved = sha256(JSON.stringify(artifact.inputIdentity.toolInputs));

    if (saved !== sha256(JSON.stringify(inputs))) {
      return null;
    }

    return { buildId: artifact.buildId, generationDir: runtime.generationDir };
  } catch (error) {
    if (['deepseek_runtime_publish_pending', 'deepseek_runtime_recovery_invalid']
      .includes((error as { code?: string }).code || '')) {
      throw error;
    }

    return null;
  }
}

/**
 * Update worker предлагает runtime установленного GrigDesk: при тех же входах целевой релиз
 * берёт его как есть, без npm ci, компиляции и нового поколения. Ошибка значит «собрать».
 */
function reusableGeneration(
  inputs: Record<string, unknown>,
): { buildId: string; generationDir: string } | null {
  const offered = process.env.GRIGDESK_DEEPSEEK_REUSE_RUNTIME;

  if (!offered || !path.isAbsolute(offered)) {
    return null;
  }

  try {
    return currentGeneration(offered, inputs);
  } catch {
    return null;
  }
}

/**
 * Сборка идёт под lock: исходники подкачиваются по manifest (сначала из проверенной копии
 * установленного GrigDesk, иначе по сети), compiler dependencies ставятся по exact lock.
 */
async function buildAndPublish(): Promise<Record<string, unknown>> {
  await fs.mkdir(runtimeRoot, { recursive: true });

  const lock = path.join(runtimeRoot, '.prepare-lock');

  await acquireDeepSeekLock(lock, {
    code: 'deepseek_runtime_prepare_locked',
    message: 'Подготовка DeepSeek уже идёт',
  });

  let staging: string | null = null;

  try {
    const seed = process.env.GRIGDESK_DEEPSEEK_UPSTREAM_SEED;

    await materializeDeepSeekSnapshot(vendor, {
      ...(seed && path.isAbsolute(seed) ? { seedDir: seed } : {}),
    });
    staging = await fs.mkdtemp(path.join(runtimeRoot, '.prepare-'));

    const dependencyDir = path.join(root, 'tools/deepseek-build');
    const lockHash = sha256(await fs.readFile(path.join(dependencyDir, 'package-lock.json')));
    const stamp = path.join(dependencyDir, 'node_modules/.grigdesk-lock');
    let prepared = false;

    try {
      prepared = (await fs.readFile(stamp, 'utf8')) === lockHash;
    } catch { /* Первый checkout ещё не установил compiler dependencies. */ }

    if (!prepared) {
      await exec('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], {
        cwd: dependencyDir,
        timeout: 15 * 60_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      await fs.writeFile(stamp, lockHash);
    }

    const generation = await buildDeepSeekRuntime({ vendorDir: vendor,
      outputDir: path.join(staging, 'generation') });

    return await publishDeepSeekGeneration(generation, runtimeRoot);
  } finally {
    if (staging) {
      await fs.rm(staging, { recursive: true, force: true });
    }

    await fs.rm(lock, { recursive: true, force: true });
  }
}

/**
 * Обычная подготовка проверяет входы готовой сборки и не устанавливает npm повторно.
 * Отсутствующий или устаревший runtime собирается из exact lock вне provider requests.
 */
async function prepare() {
  const args = process.argv.slice(2);
  const recovering = args.length === 2 && args[0] === '--recover-job'
    && /^[0-9a-f-]{36}$/u.test(args[1] || '');

  if (!recovering && (args.length > 1 || args.length === 1 && args[0] !== '--check')) {
    throw new Error('Допустим --check или --recover-job <UUID>');
  }

  if (recovering) {
    await recoverPendingJob(args[1]!);
  }

  const inputs = await deepSeekBuildInputs(vendor);
  const ready = currentGeneration(runtimeRoot, inputs, { recovering });

  if (ready) {
    if (recovering) {
      await fs.rm(pendingFile);
    }

    console.log(JSON.stringify(ready));

    return;
  }

  const reused = recovering ? null : reusableGeneration(inputs);

  if (reused) {
    console.log(JSON.stringify({ reused: true, ...reused }));

    return;
  }

  if (args[0] === '--check') {
    throw new Error('Embedded DeepSeek требует общей подготовки GrigDesk');
  }

  const published = await buildAndPublish();

  if (recovering) {
    await fs.rm(pendingFile);
  }

  console.log(JSON.stringify(published));
}

await prepare();
