import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';

import { canonicalJson } from '../shared/lib/canonicalJson.ts';
import { collectBuildProcesses, terminateBuildProcesses, type BuildProcess }
  from '../cli/buildProcesses.ts';

export interface RecipeStage {
  id: string;
  group: string;
  needs?: string[];
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  required?: boolean;
  memory?: {
    rssMb: number;
    heapMb: number;
    concurrency: number
  };
}

export interface ReleaseRecipe {
  format: 1;
  stages: RecipeStage[];
}

export type StageStatus = 'success' | 'failed' | 'blocked' | 'cancelled' | 'skipped';

export interface StageOutcome {
  id: string;
  group: string;
  status: StageStatus;
  exitCode: number | null;
  signal: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface PipelineResult {
  runId: string;
  code: number;
  reason: null | 130 | 143 | 124;
  cleanupConfirmed: boolean;
  outcomes: Record<string, StageOutcome>;
}

export interface PipelineObserver {
  start(stage: RecipeStage): void;
  finish(outcome: StageOutcome): void;
  output?(text: string, stream: 'stdout' | 'stderr'): void;
}

/**
 * Рецепт проверяется до первого child: команды, зависимости и ограничения закрыты схемой.
 * Неизвестная зависимость не превращается в успешно пройденную пустую группу.
 */
export function decodeRecipe(value: unknown): ReleaseRecipe {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (value as { format?: unknown }).format !== 1
    || !Array.isArray((value as { stages?: unknown }).stages)) {
    throw new Error('pipeline_recipe_invalid');
  }

  const recipe = value as ReleaseRecipe;
  const seen = new Set<string>();

  for (const stage of recipe.stages) {
    if (!stage || typeof stage.id !== 'string' || typeof stage.group !== 'string'
      || !Array.isArray(stage.argv) || stage.argv.length === 0
      || stage.argv.some((part) => typeof part !== 'string')
      || stage.timeoutMs !== undefined && (!Number.isSafeInteger(stage.timeoutMs) || stage.timeoutMs <= 0)
      || stage.needs !== undefined && (!Array.isArray(stage.needs)
        || stage.needs.some((need) => typeof need !== 'string'))
      || stage.cwd !== undefined && (path.isAbsolute(stage.cwd) || stage.cwd.split('/').includes('..'))
      || seen.has(stage.id)) {
      throw new Error('pipeline_recipe_invalid');
    }

    seen.add(stage.id);
  }

  for (const stage of recipe.stages) {
    if (stage.needs?.some((need) => !recipe.stages.some((other) =>
      other.group === need || other.id === need))) {
      throw new Error('pipeline_recipe_dependency_missing');
    }
  }

  return recipe;
}

/**
 * Отпечаток связывает canonical recipe с байтами реализации общего прогона.
 * Изменение команды или runner делает прежний receipt непригодным.
 */
export function recipeDigest(recipe: ReleaseRecipe, runnerBytes: Buffer): string {
  return createHash('sha256').update(canonicalJson(recipe)).update(runnerBytes)
    .digest('hex');
}

/**
 * Отпечаток рецепта покрывает также окружение, provisioning и управление процессами.
 * CI и локальный ctl читают ровно тот же набор файлов из собственного снимка.
 */
export async function recipeImplementationBytes(root: string): Promise<Buffer> {
  const files = ['tools/releasePipeline.mts', 'tools/releaseEnvironment.mts',
    'tools/ci/provision-ubuntu.sh', 'tools/ci/run-release-server-tests.sh',
    'tools/ci/prepare-release-desktop.sh', 'cli/buildProcesses.ts'];
  const chunks: Buffer[] = [];

  for (const file of files) {
    chunks.push(Buffer.from(file + '\0'), await fs.readFile(path.join(root, file)));
  }

  return Buffer.concat(chunks);
}

function blockedStage(stage: RecipeStage, status: StageStatus): StageOutcome {
  return {
    id: stage.id,
    group: stage.group,
    status,
    exitCode: null,
    signal: null,
    startedAt: null,
    finishedAt: null
  };
}

/**
 * Один общий run scope: первый сигнал фиксирует 130/143, timeout — 124; после
 * причины новые стадии не запускаются, exit 0 ребёнка не возвращает успех.
 */
export async function runStages(input: {
  recipe: ReleaseRecipe;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logFile: string;
  receiptDir: string;
  groups?: string[];
  sourceDigest?: string;
  observer?: PipelineObserver;
}): Promise<PipelineResult> {
  const recipe = decodeRecipe(input.recipe);

  if (input.groups?.some((group) => !recipe.stages.some((stage) => stage.group === group))) {
    throw new Error('pipeline_group_unknown');
  }

  const runId = randomUUID();
  const outcomes: Record<string, StageOutcome> = {};
  let reason: null | 130 | 143 | 124 = null;
  let cleanupConfirmed = true;
  let known: BuildProcess[] = [];
  let trackingInFlight: Promise<void> | null = null;
  let currentChildPid: number | null = null;
  let terminate: Promise<void> | null = null;

  await fs.mkdir(path.dirname(input.logFile), { recursive: true, mode: 0o700 });

  const log = await fs.open(input.logFile, 'wx', 0o600);

  /**
   * Завершается только собранное дерево собственной текущей стадии по PID/starttime.
   * Ранний выход лидера не отменяет ожидание известных потомков.
   */
  const terminateStageTree = async (): Promise<void> => {
    if (currentChildPid === null) {
      return;
    }

    await trackingInFlight;

    const result = await terminateBuildProcesses(currentChildPid, known);

    known = result.processes;
    cleanupConfirmed = result.cleanupConfirmed;
  };

  /**
   * Первая причина отмены закрепляется на весь запуск и больше не заменяется.
   * Даже нулевой exit остановленного ребёнка не разрешает новые стадии.
   */
  const onSignal = (signal: NodeJS.Signals) => {
    if (reason !== null) {
      return;
    }

    reason = signal === 'SIGINT' ? 130 : 143;
    terminate = terminateStageTree();
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  /**
   * Стадия запускается в собственной группе, вывод читается в stream и журнал.
   * Receipt получает фактический exit только после закрытия потоков и завершения отмены.
   */
  const runStage = async (stage: RecipeStage): Promise<StageOutcome> => {
    const startedAt = new Date().toISOString();

    await log.write(`\n[${stage.id}] ${canonicalJson({
      argv: stage.argv,
      cwd: stage.cwd ?? '.',
      envKeys: Object.keys(stage.env ?? {})
    })}\n`);
    input.observer?.start(stage);

    const child = spawn(stage.argv[0]!, stage.argv.slice(1), {
      cwd: stage.cwd ? path.resolve(input.cwd, stage.cwd) : input.cwd,
      env: {
        ...input.env,
        ...stage.env,
        ...stage.memory ? {
          NODE_TEST_MAX_RSS_MB: String(stage.memory.rssMb),
          NODE_TEST_HEAP_MB: String(stage.memory.heapMb),
        } : {},
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const closed = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) => {
        child.on('error', () => resolve({ code: null, signal: null }));
        child.on('close', (code, signal) => resolve({ code, signal }));
      });


    let timedOut = false;

    currentChildPid = child.pid ?? null;
    known = child.pid ? await collectBuildProcesses(child.pid) : [];

    const tracking = setInterval(() => {
      if (!child.pid || reason !== null || trackingInFlight) {
        return;
      }

      trackingInFlight = collectBuildProcesses(child.pid, known).then((entries) => {
        known = entries;
      }).finally(() => {
        trackingInFlight = null;
      });
    }, 100);

    const timer = stage.timeoutMs === undefined ? null : setTimeout(() => {
      if (reason === null) {
        timedOut = true;
        reason = 124;
        terminate = terminateStageTree();
      }
    }, stage.timeoutMs);

    /**
     * Журнал получает исходные байты в обоих режимах вывода.
     * У наблюдателя отдельный декодер каждого потока сохраняет границы UTF-8.
     */
    const capture = async (stream: AsyncIterable<Buffer>, channel: 'stdout' | 'stderr') => {
      const output = input.observer?.output;
      const decoder = output ? new StringDecoder('utf8') : undefined;

      for await (const chunk of stream) {
        if (output && decoder) {
          output(decoder.write(chunk), channel);
        } else {
          process[channel].write(chunk);
        }

        await log.write(chunk);
      }

      if (output && decoder) {
        output(decoder.end(), channel);
      }
    };
    const streams = Promise.all([
      capture(child.stdout!, 'stdout'), capture(child.stderr!, 'stderr'),
    ]);

    const exit = await closed;

    if (timer !== null) {
      clearTimeout(timer);
    }

    clearInterval(tracking);
    await trackingInFlight;
    await streams;

    if (terminate !== null) {
      await terminate;
    }

    currentChildPid = null;

    const status: StageStatus = timedOut ? 'failed'
      : reason !== null ? 'cancelled' : exit.code === 0 ? 'success' : 'failed';

    return {
      id: stage.id,
      group: stage.group,
      status,
      exitCode: exit.code,
      signal: exit.signal,
      startedAt,
      finishedAt: new Date().toISOString()
    };
  };

  try {
    for (const stage of recipe.stages) {
      if (input.groups !== undefined && !input.groups.includes(stage.group)) {
        outcomes[stage.id] = blockedStage(stage, 'skipped');

        continue;
      }

      if (reason !== null) {
        outcomes[stage.id] = blockedStage(stage, 'cancelled');

        continue;
      }

      const needs = stage.needs ?? [];
      const blocked = needs.some((group) => recipe.stages
        .filter((other) => other.group === group || other.id === group)
        .some((other) => outcomes[other.id]?.status !== 'success'
          && outcomes[other.id]?.status !== 'skipped'));

      if (blocked) {
        outcomes[stage.id] = blockedStage(stage, 'blocked');

        continue;
      }

      outcomes[stage.id] = await runStage(stage);
      input.observer?.finish(outcomes[stage.id]!);
    }

    if (terminate !== null) {
      await terminate;
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await log.close();
  }

  const failed = recipe.stages.some((stage) => stage.required !== false
    && outcomes[stage.id]?.status !== 'success'
    && outcomes[stage.id]?.status !== 'skipped');
  const result: PipelineResult = {
    runId,
    code: reason ?? (failed || !cleanupConfirmed ? 1 : 0),
    reason,
    cleanupConfirmed,
    outcomes
  };
  const digest = recipeDigest(recipe,
    await recipeImplementationBytes(path.resolve(import.meta.dirname, '..')));

  const probe = async (command: string) => promisify(execFile)(command, ['--version'], {
    env: input.env,
    timeout: 5000,
  }).then((value) => value.stdout.trim(), () => 'unavailable');
  const environment = {
    nodeVersion: await probe('node'),
    npmVersion: await probe('npm'),
    os: os.platform(),
    arch: os.arch(),
    kernel: os.release(),
  };

  await fs.mkdir(input.receiptDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(input.receiptDir, `pipeline-${runId}.json`),
    canonicalJson({
      format: 1,
      recipeDigest: digest,
      sourceDigest: input.sourceDigest ?? null,
      environment,
      ...result
    }) + '\n',
    { mode: 0o600 });

  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const recipe = decodeRecipe(JSON.parse(await fs.readFile(process.argv[2]!, 'utf8')));
  const groupsIndex = process.argv.indexOf('--groups');
  const groups = groupsIndex >= 0 && process.argv[groupsIndex + 1]
    ? process.argv[groupsIndex + 1]!.split(',') : undefined;

  process.exit((await runStages({
    recipe,
    cwd: process.cwd(),
    env: process.env,
    groups,
    sourceDigest: process.env.GRIGDESK_RELEASE_SOURCE_DIGEST,
    logFile: process.env.GRIGDESK_PIPELINE_LOG ?? 'pipeline.log',
    receiptDir: process.env.GRIGDESK_PIPELINE_RECEIPTS ?? '.'
  })).code);
}
