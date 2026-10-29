// Host-wrapper GLM для отвязанного этапа Factory: проверяет argv и identity этапа,
// закрепляет DSH ELF и запускает настоящий web-ход GLM со статусным MCP хоста.
// Ключ модели и текст prompt не попадают ни в argv статуса, ни в события wrapper-а.

import type { ChatStep } from '../src/lib/chat/streamSteps.ts';
import { glmAccessError } from '../src/lib/glm/env.ts';
import { GLM_FACTORY_MODELS, glmFactoryModel } from '../src/lib/glm/factoryCatalog.ts';
import type { GlmFactoryFilesystem } from '../src/lib/glm/factoryPolicy.ts';
import { prepareGlmRuntime, preparedGlmRuntime } from '../src/lib/glm/preparedRuntime.ts';
import { runGlmTurn } from '../src/lib/glm/runtime.ts';
import type { GlmTurnOptions } from '../src/lib/glm/runtime.ts';
import {
  emitRunnerEvent,
  factoryRunIdentity,
  factoryStatusEnvironment,
  parseRunnerArguments,
  readRunnerPrompt,
  redactRunnerError,
  validateRunnerPaths,
  writeRunnerLast,
} from '../src/lib/factoryProviderRunner.ts';
import { isDirectRun } from '../src/lib/helperEntry.ts';
import { helperCommand } from '../src/lib/runtimePaths.ts';

interface Arguments {
  bin: string;
  cwd: string;
  runDir: string;
  runtimeHome: string;
  promptFile: string;
  model: string;
  effort: string;
  filesystem: GlmFactoryFilesystem;
  runtimeIdentity?: string;
  runtimeVersion?: string;
  cacheDir?: string;
}

type GlmFactoryTurn = (options: GlmTurnOptions) => ReturnType<typeof runGlmTurn>;

const LABEL = 'GLM Factory';

/**
 * Общий разбор пар argv, затем режим ФС узла и модель из каталога этапа GLM.
 * Пара другого маршрута и уровень вне списка модели отвергаются до эффектов.
 */
function parseArguments(argv: readonly string[]): Arguments {
  const { values, required } = parseRunnerArguments(argv, LABEL, [
    '--bin', '--cwd', '--run-dir', '--runtime-home', '--prompt-file',
    '--model', '--effort', '--mode', '--runtime-identity', '--runtime-version', '--cache-dir',
  ]);
  const mode = required('--mode');

  if (mode !== 'read-only' && mode !== 'workspace-write') {
    throw new Error(`${LABEL}: режим не поддерживается: ${mode}`);
  }

  const model = required('--model');
  const effort = values.get('--effort') || '';

  if (!glmFactoryModel(model, effort)) {
    throw new Error(`${LABEL}: модель или уровень не из каталога этапа: ${model} ${effort}`);
  }

  return {
    bin: required('--bin'),
    cwd: required('--cwd'),
    runDir: required('--run-dir'),
    runtimeHome: required('--runtime-home'),
    promptFile: required('--prompt-file'),
    model,
    effort,
    filesystem: mode === 'read-only' ? 'state-only' : 'workspace-write',
    runtimeIdentity: values.get('--runtime-identity'),
    runtimeVersion: values.get('--runtime-version'),
    cacheDir: values.get('--cache-dir'),
  };
}

/**
 * Retained событие шага — только тип и имя инструмента: аргументы и текст модели
 * остаются в private журнале DSH, а не в потоке wrapper-а.
 */
function stepEvent(step: ChatStep): Record<string, unknown> | null {
  if (step.k === 'tool') {
    return { event: 'tool_call', name: String(step.name || '') };
  }

  return step.k === 'res' ? { event: 'tool_result' } : null;
}

function errorCode(error: unknown): string {
  return String((error as { code?: unknown } | null)?.code || '') || 'glm_wrapper_error';
}

/**
 * Wrapper закрепляет DSH ELF до model call и сверяет его с descriptor preflight движка.
 * Тестовая зависимость runTurn вызывает тот же упакованный runGlmTurn с DI модели.
 */
export async function runGlmFactory(
  argv = process.argv.slice(2),
  env = process.env,
  deps: { runTurn?: GlmFactoryTurn; emit?: typeof emitRunnerEvent } = {},
): Promise<void> {
  const args = await validateRunnerPaths(parseArguments(argv), LABEL);
  const identity = factoryRunIdentity(env, LABEL);

  // Этап идёт в режиме службы (api или coding-plan — policy-v2, 29.10.2026): ключ
  // активного режима подставит runGlmTurn через buildGlmChildEnv, допуск по metadata DSH
  // сверяет resolveGlmAccess. Здесь только валидация значения до похода в runtime.
  if (env.GRIGDESK_GLM_API_MODE !== 'api' && env.GRIGDESK_GLM_API_MODE !== 'coding-plan') {
    throw glmAccessError('glm_factory_mode_unsupported', `${LABEL}: нужен режим доступа api или coding-plan`);
  }

  const config = {
    deepseekRuntimeMode: 'binary' as const,
    deepseekBin: args.bin,
    deepseekCacheDir: args.cacheDir || env.GRIGDESK_DEEPSEEK_CACHE_DIR || undefined,
    glmRuntimeHome: args.runtimeHome,
  };
  const preparedRuntime = await prepareGlmRuntime(config, { signal: AbortSignal.timeout(15000) });
  const runtime = await preparedGlmRuntime(config, preparedRuntime);

  if ((args.runtimeIdentity && args.runtimeIdentity !== runtime.identity)
      || (args.runtimeVersion && args.runtimeVersion !== runtime.runtimeVersion)) {
    throw glmAccessError('glm_runtime_changed', `${LABEL}: runtime изменился после preflight`);
  }

  const publish = deps.emit || emitRunnerEvent;
  const prompt = await readRunnerPrompt(args.promptFile, LABEL);
  const controller = new AbortController();
  let interruptedBySignal = false;
  const cancel = () => {
    interruptedBySignal = true;
    controller.abort();
  };

  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
  publish({
    event: 'glm_start',
    mode: args.filesystem,
    model: args.model,
  });

  try {
    const status = helperCommand('factory-status-mcp', []);
    const runTurn = deps.runTurn || ((options: GlmTurnOptions) => runGlmTurn(options, {
      env,
      catalog: GLM_FACTORY_MODELS,
    }));
    const result = await runTurn({
      config,
      preparedRuntime,
      message: prompt,
      model: args.model,
      effort: args.effort,
      cwd: args.cwd,
      signal: controller.signal,
      chatKey: `factory:${identity.task}:${identity.stage}:${identity.runId}:${identity.epoch}`,
      factory: true,
      factoryContext: {
        ...identity,
        filesystem: args.filesystem,
        statusServer: {
          name: 'factory-status',
          command: status.command,
          args: status.args,
          env: factoryStatusEnvironment(env),
        },
      },
      onSessionCreated: () => {
        publish({ event: 'session_created' });
      },
      onStep: (step) => {
        const event = stepEvent(step);

        if (event) {
          publish(event);
        }
      },
    });

    await writeRunnerLast(args.runDir, result.reply || '');

    // Внешний timeout/stop уже выбрал терминальный исход: ответ после сигнала не становится успехом.
    if (interruptedBySignal) {
      return;
    }

    publish({
      event: 'result',
      stopReason: (result as { emptyRun?: boolean }).emptyRun ? 'empty' : 'end_turn',
    });
  } finally {
    process.removeListener('SIGTERM', cancel);
    process.removeListener('SIGINT', cancel);
  }
}

/**
 * Явный helper entry вызывает тот же wrapper и сохраняет протокол отказа wrapper_error.
 * Библиотечный import runGlmFactory сам не начинает ход и не читает argv запуска.
 */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    await runGlmFactory(argv);
  } catch (error) {
    const message = redactRunnerError(error, [process.env.ZAI_API_KEY, process.env.ZAI_CODING_API_KEY]);

    emitRunnerEvent({
      event: 'wrapper_error',
      code: errorCode(error),
      message,
    });
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url)) {
  void main();
}
