import { config as runtimeConfig } from '../config.ts';

import { execFile } from 'node:child_process';
import type { ExecFileOptions } from 'node:child_process';

const TASK_RE = /^\d+$/;
const STAGE_RE = /^[A-Z][A-Z0-9_]*$/;
const PROVIDER_RE = /^[a-z][a-z0-9_-]*$/;

export class RunnerControlInputError extends Error {}
export class RunnerControlCommandError extends Error {}

// Потоки завершённой команды. Ошибку запуска отдаёт reject, а не поле результата.
export interface RunnerRunResult {
  stdout: string;
  stderr: string;
}

// Запуск CLI движка. Подменяется в тестах, поэтому объявлен отдельным типом.
export type RunnerRunner = (
  file: string,
  args: string[],
  options: ExecFileOptions,
) => Promise<RunnerRunResult>;

// Ответ управляющей команды: сам факт успеха и обрезанный вывод движка.
export interface RunnerControlResult {
  ok: boolean;
  output: string;
}

const defaultRun: RunnerRunner = (file, args, options) => {
  return new Promise<RunnerRunResult>((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(new RunnerControlCommandError(
          String(stderr || error.message || 'factory runner command failed').trim().slice(-1000),
        ));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
};

export class FactoryRunnerControl {
  readonly factoryBin: string;

  readonly stateDir: string;

  readonly configRoot: string;

  readonly profilesDir: string;

  readonly run: RunnerRunner;

  constructor({
    factoryBin,
    stateDir,
    configRoot,
    profilesDir = '',
    run = defaultRun,
  }: {
    factoryBin: string;
    stateDir: string;
    configRoot: string;
    profilesDir?: string;
    run?: RunnerRunner;
  }) {
    if (!factoryBin || !stateDir || !configRoot) {
      throw new Error('FactoryRunnerControl: factoryBin/stateDir/configRoot are required');
    }
    this.factoryBin = factoryBin;
    this.stateDir = stateDir;
    this.configRoot = configRoot;
    this.profilesDir = profilesDir;
    this.run = run;
  }

  async exec(args: string[]): Promise<RunnerControlResult> {
    const { stdout } = await this.run(
      this.factoryBin,
      args,
      {
        shell: false,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        env: {
          GRIGDESK_HOME: runtimeConfig.dataHome,
          PATH: process.env.PATH || '/usr/bin:/bin',
          HOME: process.env.HOME || '',
          LANG: process.env.LANG || 'C',
          LC_ALL: process.env.LC_ALL || 'C',
          FACTORY_STATE: this.stateDir,
          STATE_DIR: this.stateDir,
          FACTORY_CONFIG_ROOT: this.configRoot,
          ...(this.profilesDir ? { FACTORY_PROFILES_DIR: this.profilesDir } : {}),
        },
      },
    );
    return { ok: true, output: stdout.trim() };
  }

  async switch({ task, stage, target }: {
    task: unknown;
    stage: unknown;
    target: unknown;
  }): Promise<RunnerControlResult> {
    if (!TASK_RE.test(String(task || ''))
        || !STAGE_RE.test(String(stage || ''))
        || !PROVIDER_RE.test(String(target || ''))) {
      throw new RunnerControlInputError('Некорректные параметры переключения исполнителя.');
    }
    return this.exec([String(task), 'runner', 'switch', String(stage), String(target)]);
  }

  /** Stage-level override: primary этапа пишется в реестр задачи через CLI движка. */
  async setStage({ task, stage, primary }: {
    task: unknown;
    stage: unknown;
    primary: unknown;
  }): Promise<RunnerControlResult> {
    if (!TASK_RE.test(String(task || ''))
        || !STAGE_RE.test(String(stage || ''))
        || !PROVIDER_RE.test(String(primary || ''))) {
      throw new RunnerControlInputError('Некорректные параметры назначения исполнителя этапа.');
    }
    return this.exec([String(task), 'runner', 'set', String(stage), String(primary)]);
  }

  /** Снять stage-level override. Идемпотентно: движок просто убирает ключ реестра. */
  async clearStage({ task, stage }: {
    task: unknown;
    stage: unknown;
  }): Promise<RunnerControlResult> {
    if (!TASK_RE.test(String(task || ''))
        || !STAGE_RE.test(String(stage || ''))) {
      throw new RunnerControlInputError('Некорректные параметры снятия исполнителя этапа.');
    }
    return this.exec([String(task), 'runner', 'clear', String(stage)]);
  }
}
