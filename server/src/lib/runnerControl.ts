import { config as runtimeConfig } from '../config.ts';

import { execFile } from 'node:child_process';
import type { ExecFileOptions } from 'node:child_process';
import { routePathArgs, runRouteEngine } from './factoryRouteCli.ts';
import type { RouteConfig } from './factoryRouteCli.ts';
import {
  decodeStageRunnerApply, decodeStageRunnerIdentity, decodeStageRunnerOptions, stageRunnerSelectionError,
} from '../../../shared/pipeline/stageRunnerSettings.ts';
import type {
  StageRunnerApply, StageRunnerIdentity, StageRunnerOptions,
} from '../../../shared/pipeline/stageRunnerSettings.ts';

const TASK_RE = /^\d+$/;
const STAGE_RE = /^[A-Z][A-Z0-9_]*$/;
const PROVIDER_RE = /^[a-z][a-z0-9_-]*$/;

export class RunnerControlInputError extends Error {}
export class RunnerControlCommandError extends Error {}

export class StageRunnerCommandError extends Error {
  readonly code: number;

  readonly timedOut: boolean;

  constructor(code: number, message: string, timedOut = false) {
    super(message);
    this.code = code;
    this.timedOut = timedOut;
  }
}

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

  readonly routeConfig?: RouteConfig;

  constructor({
    factoryBin,
    stateDir,
    configRoot,
    profilesDir = '',
    run = defaultRun,
    routeConfig,
  }: {
    factoryBin: string;
    stateDir: string;
    configRoot: string;
    profilesDir?: string;
    run?: RunnerRunner;
    routeConfig?: RouteConfig;
  }) {
    if (!factoryBin || !stateDir || !configRoot) {
      throw new Error('FactoryRunnerControl: factoryBin/stateDir/configRoot are required');
    }
    this.factoryBin = factoryBin;
    this.stateDir = stateDir;
    this.configRoot = configRoot;
    this.profilesDir = profilesDir;
    this.run = run;
    this.routeConfig = routeConfig;
  }

  /**
   * Новые команды используют полный маршрутный контекст и закреплённый runtime.
   * Старые set/clear/switch сохраняют прежний публичный контракт.
   */
  async settingsCommand(
    operation: 'options' | 'apply' | 'show', identity: StageRunnerIdentity, extra: string[] = [],
  ): Promise<StageRunnerOptions> {
    identity = decodeStageRunnerIdentity(identity);

    if (!this.routeConfig) {
      throw new RunnerControlInputError('Нет контекста закреплённого движка.');
    }

    const args = [identity.task, 'runner', 'settings', operation,
      '--profile', identity.profile, '--attempt', identity.attempt,
      '--node', identity.node, '--stage', identity.stage, ...extra, ...routePathArgs(this.routeConfig)];
    const result = await runRouteEngine(this.routeConfig, args);

    if (!result.ok) {
      throw new StageRunnerCommandError(result.code, result.stderr || result.message, result.timedOut);
    }

    return decodeStageRunnerOptions(JSON.parse(result.stdout));
  }

  /**
   * Без provider читается сохранённый выбор точного узла, независимо от graph primary.
   * Явный provider открывает его каталог без нормализации недопустимых символов.
   */
  async settingsOptions({ identity, provider }: {
    identity: StageRunnerIdentity; provider?: string;
  }): Promise<StageRunnerOptions> {
    if (provider === undefined) {
      return this.settingsCommand('show', identity);
    }

    if (!PROVIDER_RE.test(provider)) {
      throw new RunnerControlInputError('Некорректный исполнитель.');
    }

    return this.settingsCommand('options', identity, ['--provider', provider]);
  }

  /**
   * Передаёт целый apply без per-field мутаций; CAS повторно проверяет сам движок.
   * Неопределённый исход команды восстанавливается чтением receipt того же запроса.
   */
  async applySettings(input: StageRunnerApply): Promise<StageRunnerOptions> {
    const payload = decodeStageRunnerApply(input);
    let options;

    try {
      options = await this.settingsOptions({
        identity: payload.identity,
        provider: payload.selection.parametersFor,
      });
    } catch (error) {
      const current = await this.settingsCommand('show', payload.identity);

      if (current.receipt?.requestId !== payload.requestId) {
        throw error;
      }

      options = current;
    }

    if (options.receipt?.requestId !== payload.requestId) {
      const invalid = stageRunnerSelectionError(payload.selection, options);

      if (invalid) {
        throw new StageRunnerCommandError(75, invalid);
      }
    }

    try {
      return await this.settingsCommand('apply', payload.identity, ['--payload', JSON.stringify(payload)]);
    } catch (error) {
      if (error instanceof StageRunnerCommandError && error.timedOut) {
        const current = await this.settingsCommand('show', payload.identity);

        if (current.receipt?.requestId === payload.requestId) {
          return current;
        }
      }

      throw error;
    }
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
