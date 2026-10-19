import os from 'node:os';
import { dataHome } from '../../shared/runtime/dataHome.ts';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEEPSEEK_DIALECT } from '../src/lib/deepseek/contract.ts';
import { runDeepSeekTurn } from '../src/lib/deepseek/runtime.ts';
import type { DeepSeekUpdate } from '../src/lib/deepseek/steps.ts';
import deepseek from '../src/lib/executors/deepseek.ts';
import type { ExecutorAdapter } from '../src/lib/executors/index.ts';
import { prepareFactoryNativeSettings } from '../src/lib/executorSettings/factorySettings.ts';
import { prepareDeepSeekRuntime, preparedDeepSeekRuntime } from '../src/lib/deepseek/preparedRuntime.ts';
import { deepSeekDistributionMode } from '../src/lib/deepseek/distribution.ts';

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

const STATUS_ENV_NAMES = Object.freeze([
  'FACTORY_RUN_TASK',
  'FACTORY_RUN_STAGE',
  'FACTORY_RUN_ID',
  'FACTORY_RUN_EPOCH',
  'FACTORY_STATUS_MODE',
  'FACTORY_STATUS_REQUEST_DIR',
  'FACTORY_STATE',
  'STATE_DIR',
  'FACTORY_STAGE_RESULT_CHECK',
]);

const STATUS_MCP = fileURLToPath(new URL('./deepseekStatusMcp.mts', import.meta.url));
const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const MODEL_IDS = new Set([
  '["deepseek-official","deepseek-flash"]',
  '["deepseek-official","deepseek-v4-flash"]',
  '["deepseek-official","deepseek-v4-pro"]',
  '["deepseek-official","deepseek-v4-flash-vision-exp"]',
]);
const EFFORTS = new Set(['', 'off', 'low', 'high', 'max']);

function parseArguments(argv: readonly string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined || value.includes('\0')) {
      throw new Error('DeepSeek Factory: повреждены аргументы wrapper-а');
    }
    if (values.has(name)) throw new Error(`DeepSeek Factory: повторён аргумент ${name}`);
    values.set(name, value);
  }
  const required = (name: string): string => {
    const value = values.get(name) || '';
    if (!value) throw new Error(`DeepSeek Factory: не задан ${name}`);
    return value;
  };
  const known = new Set([
    '--bin', '--cwd', '--run-dir', '--runtime-home', '--prompt-file',
    '--model', '--effort', '--mode', '--artifact-dir', '--runtime-identity', '--runtime-version',
    '--cache-dir',
  ]);
  for (const name of values.keys()) {
    if (!known.has(name)) throw new Error(`DeepSeek Factory: неизвестный аргумент ${name}`);
  }
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

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function validatePaths(args: Arguments): Promise<Arguments> {
  for (const [name, value] of Object.entries({
    bin: args.bin,
    cwd: args.cwd,
    runDir: args.runDir,
    runtimeHome: args.runtimeHome,
    promptFile: args.promptFile,
    ...(args.cacheDir ? { cacheDir: args.cacheDir } : {}),
  })) {
    if (!path.isAbsolute(value)) throw new Error(`DeepSeek Factory: ${name} не абсолютный`);
  }
  const [cwd, runDir, bin, promptFile] = await Promise.all([
    fs.realpath(args.cwd),
    fs.realpath(args.runDir),
    fs.realpath(args.bin),
    fs.realpath(args.promptFile),
  ]);
  const promptStat = await fs.lstat(args.promptFile);
  const binStat = await fs.stat(bin);
  if (promptStat.isSymbolicLink() || !promptStat.isFile() || (promptStat.mode & 0o077) !== 0) {
    throw new Error('DeepSeek Factory: prompt-file должен быть private regular file');
  }
  if (!binStat.isFile() || (binStat.mode & 0o111) === 0) {
    throw new Error('DeepSeek Factory: DSH binary не исполняемый файл');
  }
  if (!inside(runDir, promptFile) || !inside(runDir, args.runtimeHome)) {
    throw new Error('DeepSeek Factory: служебные пути вышли из RUN_DIR');
  }
  return { ...args, cwd, runDir, bin, promptFile };
}

function runIdentity(env: NodeJS.ProcessEnv) {
  const task = String(env.FACTORY_RUN_TASK || '');
  const stage = String(env.FACTORY_RUN_STAGE || '');
  const runId = String(env.FACTORY_RUN_ID || '');
  const epoch = String(env.FACTORY_RUN_EPOCH || '');
  if (!/^[0-9]+$/.test(task)
      || !/^[A-Z][A-Z0-9_]*$/.test(stage)
      || !/^[A-Za-z0-9._-]+$/.test(runId)
      || !/^[1-9][0-9]*$/.test(epoch)
      || env.FACTORY_STATUS_MODE !== 'request'
      || !path.isAbsolute(String(env.FACTORY_STATUS_REQUEST_DIR || ''))) {
    throw new Error('DeepSeek Factory: server-owned run/status identity повреждена');
  }
  return { task, stage, runId, epoch };
}

function statusEnvironment(env: NodeJS.ProcessEnv): Array<{ name: string; value: string }> {
  const output: Array<{ name: string; value: string }> = [];
  for (const name of STATUS_ENV_NAMES) {
    const value = env[name];
    if (typeof value === 'string' && value && !value.includes('\0')) output.push({ name, value });
  }
  return output;
}

function textContent(value: unknown): string {
  const content = value as { type?: unknown; text?: unknown } | null;
  if (content?.type === 'text') return String(content.text || '');
  if (!Array.isArray(value)) return '';
  return value.map((entry) => textContent((entry as { content?: unknown })?.content))
    .filter(Boolean).join('\n');
}

function emit(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
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
  let message = String((error as { message?: unknown } | null)?.message || error);
  const key = process.env.DEEPSEEK_API_KEY;
  if (key) message = message.replaceAll(key, '<redacted>');
  return message.slice(0, 8_192);
}

function errorCode(error: unknown, message: string): string {
  const code = String((error as { code?: unknown } | null)?.code || '');
  if (code) return code;
  return /sandbox.{0,40}unavailable|SANDBOX_UNAVAILABLE/iu.test(message)
    ? 'sandbox_unavailable'
    : 'deepseek_wrapper_error';
}

async function writeLast(runDir: string, text: string): Promise<void> {
  const target = path.join(runDir, 'last.md');
  await fs.writeFile(target, text, { mode: 0o600 });
  await fs.chmod(target, 0o600);
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
  const args = await validatePaths(parseArguments(argv));
  const identity = runIdentity(env);
  const runtimeMode = env.GRIGDESK_DEEPSEEK_RUNTIME_MODE
    || deepSeekDistributionMode(path.join(ROOT, 'server/deepseek-runtime-contract.json'));

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
  const prompt = await fs.readFile(args.promptFile, 'utf8');
  if (Buffer.byteLength(prompt, 'utf8') > 2 * 1024 * 1024) {
    throw new Error('DeepSeek Factory: prompt превышает 2 MiB');
  }
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
        command: process.execPath,
        args: [STATUS_MCP],
        env: statusEnvironment(env),
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
    await writeLast(args.runDir, result.reply || (result.stopReason === 'cancelled'
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runDeepSeekFactory();
  } catch (error) {
    const message = safeError(error);

    emit({ event: 'wrapper_error', code: errorCode(error, message), message });
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
