import { randomUUID } from 'node:crypto';
import { routePathArgs, runRouteEngine } from './factoryRouteCli.ts';
import type { RouteConfig } from './factoryRouteCli.ts';
import {
  decodeStageRunnerApply, decodeStageRunnerIdentity, decodeStageRunnerOptions, stageRunnerSelectionError,
} from '../../../shared/pipeline/stageRunnerSettings.ts';
import type {
  StageRunnerApply, StageRunnerIdentity, StageRunnerOptions,
} from '../../../shared/pipeline/stageRunnerSettings.ts';

const PROVIDER_RE = /^[a-z][a-z0-9_-]*$/;

export class RunnerControlInputError extends Error {}

export class StageRunnerCommandError extends Error {
  readonly code: number;

  readonly timedOut: boolean;

  constructor(code: number, message: string, timedOut = false) {
    super(message);
    this.code = code;
    this.timedOut = timedOut;
  }
}

export interface RunnerControlResult {
  ok: boolean;
  output: string;
}

export class FactoryRunnerControl {
  readonly routeConfig: RouteConfig;

  constructor(routeConfig: RouteConfig) {
    this.routeConfig = routeConfig;
  }

  /**
   * Настройки запускаются с полным контекстом попытки и проверкой выбранного поколения.
   * Журнал изменяет только Go-движок.
   */
  async settingsCommand(
    operation: 'options' | 'apply' | 'show', identity: StageRunnerIdentity, extra: string[] = [],
  ): Promise<StageRunnerOptions> {
    identity = decodeStageRunnerIdentity(identity);

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

  /**
   * Действие без полей модели переносится в exact контракт движка.
   * Пара сохранённой модели остаётся только у того провайдера, которому принадлежит.
   */
  async changeStageProvider(
    identity: StageRunnerIdentity, primary: string | null, mode: StageRunnerApply['mode'],
  ): Promise<RunnerControlResult> {
    const selected = await this.settingsOptions({ identity, provider: primary ?? undefined });
    const provider = primary ?? selected.inherited?.primary ?? selected.effective.primary;
    const options = provider === (primary ?? selected.selection.parametersFor)
      ? selected : await this.settingsOptions({ identity, provider });
    const own = options.selection.parametersFor === provider;

    if (mode === 'restart' && !options.actual) {
      throw new StageRunnerCommandError(75, 'identity_conflict: этап уже завершил запуск');
    }

    const result = await this.applySettings({
      identity,
      mode,
      expectedRevision: options.revision,
      expectedRun: options.actual?.run ?? null,
      catalogRevision: options.catalogRevision,
      requestId: randomUUID(),
      selection: {
        primary,
        parametersFor: provider,
        model: own ? options.selection.model : null,
        effort: own ? options.selection.effort : null,
      },
    });

    return { ok: true, output: JSON.stringify(result) };
  }
}
