import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEEPSEEK_DIALECT } from '../src/lib/deepseek/contract.ts';
import { runDeepSeekTurn } from '../src/lib/deepseek/runtime.ts';
import type { DeepSeekUpdate } from '../src/lib/deepseek/steps.ts';

interface Arguments {
  bin: string;
  cwd: string;
  runDir: string;
  runtimeHome: string;
  promptFile: string;
  model: string;
  effort: string;
  mode: 'read-only' | 'workspace-write';
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
    '--model', '--effort', '--mode',
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

function emitUpdate(update: DeepSeekUpdate): void {
  const event = String(update.sessionUpdate || '');
  if (event === 'agent_message_chunk') {
    emit({ event, text: textContent(update.content) });
  } else if (event === 'agent_thought_chunk') {
    emit({ event });
  } else if (event === 'tool_call') {
    emit({ event, name: String(update.title || ''), toolCallId: String(update.toolCallId || '') });
  } else if (event === 'tool_call_update') {
    emit({
      event,
      toolCallId: String(update.toolCallId || ''),
      status: String(update.status || ''),
    });
  } else if (event === 'usage_update') {
    emit({ event, used: update.used, size: update.size });
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

async function main(): Promise<void> {
  const args = await validatePaths(parseArguments(process.argv.slice(2)));
  const identity = runIdentity(process.env);
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

  emit({ event: 'deepseek_start', dialect: DEEPSEEK_DIALECT, mode: args.mode, model: args.model });
  try {
    const result = await runDeepSeekTurn({
      config: {
        deepseekRuntimeHome: args.runtimeHome,
        deepseekBin: args.bin,
        rootDir: ROOT,
      },
      env: process.env,
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
        env: statusEnvironment(process.env),
      }],
      onRawUpdate: emitUpdate,
      onSessionCreated: () => emit({ event: 'session_created' }),
      onPermissionResolved: ({ context, outcome }) => emit({
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
    emit({
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

try {
  await main();
} catch (error) {
  const message = safeError(error);
  emit({ event: 'wrapper_error', code: errorCode(error, message), message });
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
