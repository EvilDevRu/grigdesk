import os from 'node:os';
import { dataHome } from '../../shared/runtime/dataHome.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEEPSEEK_DIALECT } from '../src/lib/deepseek/contract.ts';
import { runDeepSeekTurn } from '../src/lib/deepseek/runtime.ts';
import type { DeepSeekUpdate } from '../src/lib/deepseek/steps.ts';
import deepseek from '../src/lib/executors/deepseek.ts';
import type { ExecutorAdapter } from '../src/lib/executors/index.ts';
import { prepareFactoryNativeSettings } from '../src/lib/executorSettings/factorySettings.ts';
import { prepareDeepSeekRuntime, preparedDeepSeekRuntime } from '../src/lib/deepseek/preparedRuntime.ts';
import { deepSeekDistributionMode } from '../src/lib/deepseek/distribution.ts';
import { isDirectRun } from '../src/lib/helperEntry.ts';
import { helperCommand, runtimeKind } from '../src/lib/runtimePaths.ts';
import {
  emitRunnerEvent as emit,
  factoryRunIdentity,
  factoryStatusEnvironment,
  parseRunnerArguments,
  readRunnerPrompt,
  redactRunnerError,
  validateRunnerPaths,
  writeRunnerLast,
} from '../src/lib/factoryProviderRunner.ts';

interface Arguments {
  bin: string;
  cwd: string;
  runDir: string;
  runtimeHome: string;
  promptFile: string;
  model: string;
  effort: string;
  mode: 'read-only' | 'workspace-write';
  artifactDir?: string;
  runtimeIdentity?: string;
  runtimeVersion?: string;
  cacheDir?: string;
}

const LABEL = 'DeepSeek Factory';
const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const MODEL_IDS = new Set([
  '["deepseek-official","deepseek-flash"]',
  '["deepseek-official","deepseek-v4-flash"]',
  '["deepseek-official","deepseek-v4-pro"]',
  '["deepseek-official","deepseek-v4-flash-vision-exp"]',
]);
const EFFORTS = new Set(['', 'off', 'low', 'high', 'max']);

/**
 * Общий разбор пар argv, затем DeepSeek-специфичные режим, модель и effort узла.
 * Сообщения отказов сохраняют прежнюю подпись DeepSeek Factory.
 */
function parseArguments(argv: readonly string[]): Arguments {
  const { values, required } = parseRunnerArguments(argv, LABEL, [
    '--bin', '--cwd', '--run-dir', '--runtime-home', '--prompt-file',
    '--model', '--effort', '--mode', '--artifact-dir', '--runtime-identity', '--runtime-version',
    '--cache-dir',
  ]);
  const mode = required('--mode');
  if (mode !== 'read-only' && mode !== 'workspace-write') {
    throw new Error(`DeepSeek Factory: режим не поддерживается: ${mode}`);
  }
  const model = required('--model');
  const effort = values.get('--effort') || '';
  if (!MODEL_IDS.has(model)) throw new Error(`DeepSeek Factory: неизвестная модель: ${model}`);
  if (!EFFORTS.has(effort)) throw new Error(`DeepSeek Factory: effort не поддерживается: ${effort}`);
  return {
    bin: required('--bin'),
    cwd: required('--cwd'),
    runDir: required('--run-dir'),
    runtimeHome: required('--runtime-home'),
    promptFile: required('--prompt-file'),
    model,
    effort,
    mode,
    artifactDir: values.get('--artifact-dir'),
    runtimeIdentity: values.get('--runtime-identity'),
    runtimeVersion: values.get('--runtime-version'),
    cacheDir: values.get('--cache-dir'),
  };
}

function textContent(value: unknown): string {
  const content = value as { type?: unknown; text?: unknown } | null;
  if (content?.type === 'text') return String(content.text || '');
  if (!Array.isArray(value)) return '';
  return value.map((entry) => textContent((entry as { content?: unknown })?.content))
    .filter(Boolean).join('\n');
}

/**
 * Публикует только retained diagnostic события без private ACP payload.
 * Host status остаётся отдельным MCP-контрактом и не выводится из текста ответа.
 */
function emitUpdate(update: DeepSeekUpdate, publish = emit): void {
  const event = String(update.sessionUpdate || '');

  if (event === 'agent_message_chunk') {
    publish({ event, text: textContent(update.content) });
  } else if (event === 'agent_thought_chunk') {
    publish({ event });
  } else if (event === 'tool_call') {
    publish({ event, name: String(update.title || ''), toolCallId: String(update.toolCallId || '') });
  } else if (event === 'tool_call_update') {
    publish({
      event,
      toolCallId: String(update.toolCallId || ''),
      status: String(update.status || ''),
    });
  } else if (event === 'usage_update') {
    publish({ event, used: update.used, size: update.size });
  }
}

function safeError(error: unknown): string {
  return redactRunnerError(error, [process.env.DEEPSEEK_API_KEY]);
}

function errorCode(error: unknown, message: string): string {
  const code = String((error as { code?: unknown } | null)?.code || '');
  if (code) return code;
  return /sandbox.{0,40}unavailable|SANDBOX_UNAVAILABLE/iu.test(message)
    ? 'sandbox_unavailable'
    : 'deepseek_wrapper_error';
}

/**
 * Wrapper закрепляет runtime и перечитывает host prefs для этого узла до model call.
 * Тестовая зависимость использует тот же runtime с loopback endpoint и private overlay.
 */
export async function runDeepSeekFactory(
  argv = process.argv.slice(2),
  env = process.env,
  deps: { runTurn?: typeof runDeepSeekTurn; emit?: typeof emit } = {},
): Promise<void> {
  const args = await validateRunnerPaths(parseArguments(argv), LABEL);
  const identity = factoryRunIdentity(env, LABEL);
  const runtimeMode = env.GRIGDESK_DEEPSEEK_RUNTIME_MODE
    || (runtimeKind() === 'packaged'
      ? 'binary'
      : deepSeekDistributionMode(path.join(ROOT, 'server/deepseek-runtime-contract.json')));

  if (runtimeMode !== 'installed' && runtimeMode !== 'embedded' && runtimeMode !== 'binary') {
    throw new Error('DeepSeek Factory: неизвестный режим runtime');
  }

  const config = {
    deepseekRuntimeHome: args.runtimeHome,
    deepseekBin: args.bin,
    deepseekBinOverride: env.GRIGDESK_DEEPSEEK_BIN || undefined,
    deepseekRuntimeMode: runtimeMode as 'installed' | 'embedded' | 'binary',
    deepseekCacheDir: args.cacheDir || env.GRIGDESK_DEEPSEEK_CACHE_DIR || undefined,
    deepseekGenerationRoot: env.GRIGDESK_DEEPSEEK_GENERATION_ROOT
      || path.join(ROOT, 'server/runtime/deepseek'),
    deepseekArtifactDir: args.artifactDir || env.GRIGDESK_DEEPSEEK_ARTIFACT_DIR || undefined,
    rootDir: ROOT,
  };
  const preparedRuntime = await prepareDeepSeekRuntime(config, { signal: AbortSignal.timeout(15000) });
  const runtime = await preparedDeepSeekRuntime(config, preparedRuntime);

  if ((args.runtimeIdentity && args.runtimeIdentity !== runtime.identity)
      || (args.runtimeVersion && args.runtimeVersion !== runtime.runtimeVersion)) {
    throw Object.assign(new Error('DeepSeek Factory: runtime изменился после preflight'), {
      code: 'deepseek_runtime_changed',
    });
  }

  const { nativeSettings } = await prepareFactoryNativeSettings({
    adapter: deepseek as ExecutorAdapter,
    config,
    cwd: args.cwd,
    mode: args.mode,
    preparedRuntime,
    prefsPath: env.GRIGDESK_PROVIDER_PREFS_PATH || env.GRIGDESK_PREFS_PATH
      || path.join(dataHome({ env, home: env.HOME || os.homedir() }), 'state/prefs.json'),
  });
  const publish = deps.emit || emit;
  const prompt = await readRunnerPrompt(args.promptFile, LABEL);
  const controller = new AbortController();
  let interruptedBySignal = false;
  const cancel = () => {
    interruptedBySignal = true;
    controller.abort();
  };
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);

  publish({ event: 'deepseek_start', dialect: DEEPSEEK_DIALECT, mode: args.mode, model: args.model });

  try {
    const status = helperCommand('factory-status-mcp', []);
    const result = await (deps.runTurn || runDeepSeekTurn)({
      config,
      env,
      nativeSettings,
      preparedRuntime,
      // Чатовые тумблеры прямого SSH/БД сюда не идут: дефолт адаптера блокирует SSH.
      message: prompt,
      model: args.model,
      effort: args.effort,
      cwd: args.cwd,
      permissionMode: args.mode,
      signal: controller.signal,
      chatKey: `factory:${identity.task}:${identity.stage}:${identity.runId}:${identity.epoch}`,
      factory: true,
      mcpServers: [{
        name: 'factory-status',
        command: status.command,
        args: status.args,
        env: factoryStatusEnvironment(env),
      }],
      onRawUpdate: (update) => emitUpdate(update, publish),
      onSessionCreated: () => publish({ event: 'session_created' }),
      onPermissionResolved: ({ context, outcome }) => publish({
        event: 'permission',
        tool: String(context.title || ''),
        outcome: outcome.outcome.outcome,
        ...(outcome.outcome.outcome === 'selected'
          ? { optionId: outcome.outcome.optionId }
          : {}),
      }),
    });

    await writeRunnerLast(args.runDir, result.reply || (result.stopReason === 'cancelled'
      ? '⏹ Ход остановлен.\n'
      : ''));
    // Внешний timeout/stop уже выбрал терминальный исход. ACP может успеть
    // корректно ответить `cancelled` до SIGKILL, но это не превращает прерванный
    // запуск в успех. Не публикуем terminal result после host-сигнала.
    if (interruptedBySignal) {
      return;
    }

    publish({
      event: 'result',
      stopReason: result.stopReason || 'unknown',
      contextMetric: result.contextMetric,
      ...(result.contextTokens !== undefined ? { contextTokens: result.contextTokens } : {}),
      ...(result.contextWindow !== undefined ? { contextWindow: result.contextWindow } : {}),
    });
  } finally {
    process.removeListener('SIGTERM', cancel);
    process.removeListener('SIGINT', cancel);
  }
}

/**
 * Явный helper entry вызывает тот же wrapper и сохраняет его catch/emit протокол.
 * Библиотечный import runDeepSeekFactory сам не начинает ход и не читает argv запуска.
 */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    await runDeepSeekFactory(argv);
  } catch (error) {
    const message = safeError(error);

    emit({ event: 'wrapper_error', code: errorCode(error, message), message });
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url)) {
  void main();
}
