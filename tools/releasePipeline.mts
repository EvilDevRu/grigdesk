import fs from 'node:fs/promises';
import { renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';

import { canonicalJson } from '../shared/lib/canonicalJson.ts';
import { collectBuildProcesses, terminateBuildProcesses, type BuildProcess }
  from '../cli/buildProcesses.ts';
import { runDarwinBuildProcess } from '../cli/darwinBuildProcesses.ts';
import { configureDarwinBuildProcessHelper } from '../shared/node/processIdentity.ts';
import { readTargetNodeRuntime, serverNodeRuntimeManifest } from '../shared/node/nodeRuntime.ts';
import { readDarwinBuildSetsid } from './darwinBuildTools.mts';
import { assertRuntimePinDirectory, checkRuntimePinOutcomes, readRuntimePinJson }
  from './ci/runtimePinEvidence.mts';

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

/**
 * A successful aggregate cannot stand in for an omitted mandatory build stage.
 * Uses the selected groups from the pinned recipe.
 */
export function requireBuildOutcomes(
  recipe: ReleaseRecipe, groups: readonly string[], result: PipelineResult,
) {
  if (result.code !== 0 || !result.cleanupConfirmed || recipe.stages.some(({ id, group, required }) =>
    groups.includes(group) && required !== false
    && (result.outcomes[id]?.status !== 'success' || result.outcomes[id]?.exitCode !== 0))) {
    throw new Error('release_pipeline_receipt_missing');
  }
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
export async function recipeImplementationBytes(root: string, darwin = false): Promise<Buffer> {
  const files = ['tools/releasePipeline.mts', 'tools/releaseEnvironment.mts',
    'tools/ci/provision-ubuntu.sh', 'tools/ci/run-release-server-tests.sh',
    'tools/install-qwen-preview.sh',
    'tools/ci/prepare-release-desktop.sh', 'cli/buildProcesses.ts',
    'go.mod', 'go.sum', 'tools/build-go-utilities.sh', 'tests/run-go-utilities.sh',
    'tools/goReleaseUtility.mts',
    'tools/installedBundle.mts', 'tools/verifyGoReleaseSize.mts', 'tools/verifyGoReleaseEvidence.mts'];
  const chunks: Buffer[] = [];

  if (darwin) {
    files.push('cli/darwinBuildProcesses.ts', 'shared/node/processIdentity.ts',
      'tools/darwinBuildTools.mts', 'tools/macos/process-identity.c', 'tools/macos/runner-fds.h',
      'tools/macos/setsid.c', 'tools/ci/runtimePinEvidence.mts',
      'tools/ci/runtime-pin-reporter.mjs', 'tools/ci/run-macos-runtime-pin-tests.mts',
      'tools/ci/Brewfile.macos', 'server/build/node-runtime-darwin-arm64.json',
      'tools/ci/stage-platform-candidate.mts', 'tools/ci/mac-candidate-bootstrap.mts',
      'tools/buildDesktopRelease.mts', 'tools/verifyInstallation.mts');
  }

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
  signal?: AbortSignal;
  darwinToolchain?: { nodeVersion: string; npmVersion: string };
  candidateRecipe?: boolean;
  sourceReceiptIdentity?: {
    commit: string;
    sourceDigest: string;
    recipeDigest: string;
  };
}): Promise<PipelineResult> {
  const recipe = decodeRecipe(input.recipe);
  const project = path.resolve(import.meta.dirname, '..');
  const darwin = process.platform === 'darwin';

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
  let setsid: string | undefined;
  let runtimePinDirectory: string | undefined;
  const sourceStage = darwin ? recipe.stages.find((stage) => stage.id === 'mac-runtime-pin-source'
    && (input.groups === undefined || input.groups.includes(stage.group))) : undefined;
  const controller = new AbortController();

  if (sourceStage && (!/^[a-f0-9]{40}$/u.test(input.sourceReceiptIdentity?.commit ?? '')
    || !/^[a-f0-9]{64}$/u.test(input.sourceReceiptIdentity?.sourceDigest ?? '')
    || !/^[a-f0-9]{64}$/u.test(input.sourceReceiptIdentity?.recipeDigest ?? '')
    || input.sourceReceiptIdentity?.sourceDigest !== input.sourceDigest)) {
    throw new Error('mac_runtime_pin_source_identity_invalid');
  }

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

    if (darwin) {
      controller.abort(reason);
    } else {
      terminate = terminateStageTree();
    }
  };

  const onAbort = () => {
    const value = input.signal?.reason;

    onSignal(value === 130 || value?.code === 130 ? 'SIGINT' : 'SIGTERM');
  };

  if (darwin && input.signal) {
    input.signal.addEventListener('abort', onAbort, { once: true });

    if (input.signal.aborted) {
      onAbort();
    }
  } else {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }

  /**
   * Журнал получает исходные байты в обоих режимах вывода.
   * В Darwin вывод ограничивается deadline даже при зависшем downstream.
   */
  const capture = async (stream: AsyncIterable<Buffer>, channel: 'stdout' | 'stderr',
    signal?: AbortSignal) => {
    const output = input.observer?.output;
    const decoder = output ? new StringDecoder('utf8') : undefined;

    for await (const chunk of stream) {
      signal?.throwIfAborted();

      if (output && decoder) {
        output(decoder.write(chunk), channel);
      } else if (!process[channel].write(chunk) && signal) {
        await once(process[channel], 'drain', { signal });
      }

      await log.write(chunk);
    }

    if (output && decoder) {
      output(decoder.end(), channel);
    }
  };

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

    const cwd = stage.cwd ? path.resolve(input.cwd, stage.cwd) : input.cwd;
    const env: NodeJS.ProcessEnv = {
      ...input.env,
      ...stage.env,
      ...stage.memory ? {
        NODE_TEST_MAX_RSS_MB: String(stage.memory.rssMb),
        NODE_TEST_HEAP_MB: String(stage.memory.heapMb),
      } : {},
    };

    if (stage === sourceStage) {
      const receiptRoot = await fs.realpath(input.receiptDir);

      runtimePinDirectory = await fs.mkdtemp(path.join(receiptRoot, 'runtime-pin-'));
      await assertRuntimePinDirectory(runtimePinDirectory);
      env.GRIGDESK_RUNTIME_PIN_REPORT_DIR = runtimePinDirectory;
    }

    if (reason !== null) {
      return blockedStage(stage, 'cancelled');
    }

    if (setsid) {
      env.GRIGDESK_BUILD_PROCESS_HELPER = input.env.GRIGDESK_BUILD_PROCESS_HELPER;
      env.GRIGDESK_BUILD_PROCESS_HELPER_SHA256 = input.env.GRIGDESK_BUILD_PROCESS_HELPER_SHA256;
      env.GRIGDESK_TEST_SETSID_BIN = setsid;
      env.GRIGDESK_BUILD_SETSID_SHA256 = input.env.GRIGDESK_BUILD_SETSID_SHA256;

      const result = await runDarwinBuildProcess({
        file: stage.argv[0]!,
        args: stage.argv.slice(1),
        cwd,
        env,
        setsid,
        output: 'pipe',
        timeoutMs: stage.timeoutMs,
        signal: controller.signal,
        onStopReason: (value) => {
          reason ??= value;
        },
        capture: async (child, signal) => {
          await Promise.all([
            capture(child.stdout!, 'stdout', signal), capture(child.stderr!, 'stderr', signal),
          ]);
        },
      });

      reason ??= result.reason;
      cleanupConfirmed = result.cleanupConfirmed;

      if (!cleanupConfirmed || result.error) {
        const detail = !cleanupConfirmed ? 'не подтверждено завершение процессов'
          : (result.error as Error).message;

        await log.write(`\n[${stage.id}] ${detail}\n`);
      }

      const status = reason === 124 ? 'failed' : reason !== null ? 'cancelled'
        : result.code === 0 && result.cleanupConfirmed ? 'success' : 'failed';

      return {
        id: stage.id,
        group: stage.group,
        status,
        exitCode: result.code,
        signal: result.signal,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }

    const child = spawn(stage.argv[0]!, stage.argv.slice(1), {
      cwd,
      env,
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
    if (sourceStage) {
      await fs.mkdir(input.receiptDir, { recursive: true, mode: 0o700 });
    }

    if (darwin && reason === null) {
      const pin = await readTargetNodeRuntime(path.join(input.cwd, serverNodeRuntimeManifest('darwin-arm64')),
        'darwin-arm64');

      if (process.arch !== 'arm64' || input.darwinToolchain?.nodeVersion !== `v${pin.version}`
        || !/^\d+\.\d+\.\d+$/u.test(input.darwinToolchain.npmVersion)) {
        throw new Error('release_toolchain_invalid');
      }

      await configureDarwinBuildProcessHelper(input.env);
      setsid = await readDarwinBuildSetsid(input.env);
    }

    for (const stage of recipe.stages) {
      if (!darwin && stage.group.startsWith('mac-')
        || stage.group === 'candidate-build' && !input.candidateRecipe
        || input.groups !== undefined && !input.groups.includes(stage.group)) {
        outcomes[stage.id] = blockedStage(stage, 'skipped');

        continue;
      }

      if (reason !== null) {
        outcomes[stage.id] = blockedStage(stage, 'cancelled');

        continue;
      }

      if (darwin && !cleanupConfirmed) {
        outcomes[stage.id] = blockedStage(stage, 'blocked');

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

      if (stage === sourceStage && outcomes[stage.id]!.status === 'success' && reason === null) {
        try {
          const file = path.join(runtimePinDirectory ?? '', 'runtime-pin-outcomes.json');
          const outcomes = checkRuntimePinOutcomes('source', await readRuntimePinJson(file, true));

          await fs.writeFile(path.join(input.receiptDir, 'mac-runtime-pin-source.json'), canonicalJson({
            format: 1,
            ...input.sourceReceiptIdentity,
            stage: stage.id,
            code: 0,
            outcomes,
          }) + '\n', { flag: 'wx', mode: 0o600 });
        } catch (error) {
          outcomes[stage.id]!.status = 'failed';
          await log.write(String(error) + '\n');
        }
      }

      input.observer?.finish(outcomes[stage.id]!);
    }

    if (terminate !== null) {
      await terminate;
    }

    if (darwin) {
      const digest = input.sourceReceiptIdentity?.recipeDigest
        ?? recipeDigest(recipe, await recipeImplementationBytes(project, true));

      await fs.mkdir(input.receiptDir, { recursive: true, mode: 0o700 });

      const failed = recipe.stages.some((stage) => stage.required !== false
        && outcomes[stage.id]?.status !== 'success' && outcomes[stage.id]?.status !== 'skipped');
      const result: PipelineResult = {
        runId,
        code: reason ?? (failed || !cleanupConfirmed ? 1 : 0),
        reason,
        cleanupConfirmed,
        outcomes,
      };
      const receipt = path.join(input.receiptDir, `pipeline-${runId}.json`);
      const temporary = `${receipt}.tmp`;

      writeFileSync(temporary, canonicalJson({
        format: 1,
        recipeDigest: digest,
        sourceDigest: input.sourceDigest ?? null,
        environment: {
          ...input.darwinToolchain,
          os: os.platform(),
          arch: os.arch(),
          kernel: os.release(),
          ...setsid ? {
            processIdentitySha256: input.env.GRIGDESK_BUILD_PROCESS_HELPER_SHA256,
            setsidSha256: input.env.GRIGDESK_BUILD_SETSID_SHA256,
          } : {},
        },
        ...result,
      }) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temporary, receipt);

      return result;
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    input.signal?.removeEventListener('abort', onAbort);
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
    await recipeImplementationBytes(path.resolve(import.meta.dirname, '..'), input.candidateRecipe));

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
    candidateRecipe: process.env.GRIGDESK_RELEASE_DUAL === '1',
    sourceReceiptIdentity: process.env.GRIGDESK_RELEASE_RECIPE_DIGEST ? {
      commit: process.env.GRIGDESK_RELEASE_COMMIT ?? '',
      sourceDigest: process.env.GRIGDESK_RELEASE_SOURCE_DIGEST ?? '',
      recipeDigest: process.env.GRIGDESK_RELEASE_RECIPE_DIGEST,
    } : undefined,
    darwinToolchain: process.platform === 'darwin' ? {
      nodeVersion: process.env.GRIGDESK_RELEASE_NODE_VERSION ?? '',
      npmVersion: process.env.GRIGDESK_RELEASE_NPM_VERSION ?? '',
    } : undefined,
    sourceDigest: process.env.GRIGDESK_RELEASE_SOURCE_DIGEST,
    logFile: process.env.GRIGDESK_PIPELINE_LOG ?? 'pipeline.log',
    receiptDir: process.env.GRIGDESK_PIPELINE_RECEIPTS ?? '.'
  })).code);
}
