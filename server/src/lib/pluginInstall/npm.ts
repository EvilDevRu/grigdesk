import type { PluginCommandResult, PluginCommandRunner, PluginWorkspaceBudget } from './runCommand.ts';
import { runCommand } from './runCommand.ts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installError } from './errors.ts';
import { workspaceWithinBudget } from './workspaceBudget.ts';
import { validateNpmDirectory } from './validatePackage.ts';
import { capturePackageSnapshot, validatePreparedPayload } from './payloadDigest.ts';

export type NpmRunner = (
  cwd: string,
  signal?: AbortSignal,
  workspaceBudget?: PluginWorkspaceBudget,
) => Promise<PluginCommandResult>;

export interface NpmRunnerOptions {
  cacheRoot?: string;
  baseEnv?: NodeJS.ProcessEnv;
  offline?: boolean;
}

/**
 * Runner отделяет подготовку зависимостей от планирования installer job.
 * Первый тест фиксирует доверенный executable и изоляцию npm config.
 */
export function createNpmRunner(
  run: PluginCommandRunner = runCommand,
  options: NpmRunnerOptions = {},
): NpmRunner {
  return async (cwd, signal, workspaceBudget) => {
    await validateNpmDirectory(cwd);

    const cache = options.cacheRoot ?? (workspaceBudget ? path.join(workspaceBudget.root, 'npm') : null);
    const root = cache ?? await mkdtemp(path.join(os.tmpdir(), 'cockpit-npm-policy-'));

    await mkdir(root, { recursive: true, mode: 0o700 });

    const scope = await mkdtemp(path.join(root, 'policy-'));
    const user = path.join(scope, 'user.npmrc');
    const global = path.join(scope, 'global.npmrc');
    const nodeBin = path.dirname(process.execPath);

    await writeFile(user, '', { mode: 0o600 });
    await writeFile(global, '', { mode: 0o600 });

    try {
      const result = await run(path.join(nodeBin, 'npm'), [
        'ci',
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        `--userconfig=${user}`,
        `--globalconfig=${global}`,
        '--registry=https://registry.npmjs.org/',
        `--cache=${root}`,
        `--prefix=${cwd}`,
        '--update-notifier=false',
        ...(options.offline ? ['--offline'] : []),
      ], {
        cwd,
        signal,
        workspaceBudget,
        timeoutMs: 600_000,
        env: {
          PATH: `${nodeBin}:/usr/bin:/bin`,
          HOME: scope,
          TMPDIR: scope,
          LC_ALL: 'C',
          LANGUAGE: 'C',
        },
      });

      if (result.workspaceLimitExceeded) {
        throw installError('workspace_limit');
      }

      return result;
    } finally {
      if (!cache) {
        await rm(root, { recursive: true, force: true });
      }
    }
  };
}

/**
 * Общая подготовка выполняет npmDirs последовательно с одним budget root.
 * Результат должен пройти повторную проверку до статуса ready.
 */
export async function prepareNpmDependencies(
  directory: string,
  npmDirs: string[],
  webDir: string | null,
  npm: NpmRunner = createNpmRunner(),
  signal?: AbortSignal,
  budget?: PluginWorkspaceBudget,
): Promise<string> {
  const snapshot = await capturePackageSnapshot(directory, npmDirs);

  for (const relative of npmDirs) {
    if (signal?.aborted) {
      throw installError('cancelled');
    }

    if (budget && !await workspaceWithinBudget(budget)) {
      throw installError('workspace_limit');
    }

    const result = await npm(path.join(directory, relative), signal, budget);

    if (result.workspaceLimitExceeded) {
      throw installError('workspace_limit');
    }

    if (result.aborted || signal?.aborted) {
      throw installError('cancelled');
    }

    if (result.code !== 0 || result.timedOut) {
      throw installError('dependencies_failed');
    }
  }

  if (signal?.aborted) {
    throw installError('cancelled');
  }

  if (budget && !await workspaceWithinBudget(budget)) {
    throw installError('workspace_limit');
  }

  return validatePreparedPayload(directory, snapshot, webDir);
}
