import { promises as fs } from 'node:fs';

import qwen from '../src/lib/executors/qwen.ts';
import { externalCliAdapter } from '../src/lib/providerInstall/externalCliAdapter.ts';
import { createQwenFactoryStatus } from '../src/lib/qwen/factoryStatus.ts';
import { readQwenSnapshot } from '../src/lib/qwen/settings.ts';
import { record } from '../src/lib/qwen/transport.ts';
import {
  emitRunnerEvent,
  factoryRunIdentity,
  factoryRunnerErrorEvent,
  parseRunnerArguments,
  readRunnerPrompt,
  redactRunnerError,
  validateRunnerPaths,
  writeRunnerLast,
} from '../src/lib/factoryProviderRunner.ts';
import { isDirectRun } from '../src/lib/helperEntry.ts';

const LABEL = 'Qwen Factory';

/**
 * Источник моделей закреплён сервером, а cwd узла задаёт только границу записи.
 * Выбранный движком CLI передаётся явно и не заменяется другой копией из PATH.
 */
function runnerConfig(bin: string, env: NodeJS.ProcessEnv) {
  return {
    qwenBin: bin,
    qwenHome: env.GRIGDESK_QWEN_HOME || env.QWEN_HOME,
    rootDir: env.GRIGDESK_QWEN_CONFIG_ROOT || process.cwd(),
    dataHome: env.GRIGDESK_HOME,
  };
}

/**
 * Один metadata-only путь обслуживает models.tsv и варианты запуска раннера.
 * CLI подтверждает ids без prompt; чатовый models.json не читается и не пишется.
 */
async function metadata(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  const { required } = parseRunnerArguments(argv, LABEL, ['--metadata', '--bin']);
  const mode = required('--metadata');
  const config = runnerConfig(required('--bin'), env);
  const adapter = externalCliAdapter(qwen, env);
  const discovered = await adapter.catalog!(config);
  const entries = Array.isArray(discovered) ? discovered.map(record) : [];

  if (!entries?.length) {
    throw new Error(`${LABEL}: каталог моделей недоступен, настройте modelProviders`);
  }

  if (mode === 'options') {
    process.stdout.write(`${JSON.stringify(entries.map((entry) => ({
      id: entry.id,
      label: entry.name || entry.id,
      efforts: [''],
      aliases: [],
    })))}\n`);

    return;
  }

  if (mode !== 'catalog') {
    throw new Error(`${LABEL}: неизвестный metadata режим`);
  }

  for (const [index, entry] of entries.entries()) {
    if (/[\t\r\n\0]/u.test(String(entry.id))) {
      throw new Error(`${LABEL}: неверный id модели`);
    }

    const row = [entry.id, 'qwen', 'default', '1', 'default', 100 - index, '1', '0', '1', '*', '*'];

    process.stdout.write(`${row.join('\t')}\n`);
  }
}

/**
 * Host-wrapper проверяет пути и identity до модели и выдаёт только статусный MCP.
 * Режим never запрещает вопросы; timeout завершает тот же отменяемый runtime чата.
 */
export async function runQwenFactory(argv = process.argv.slice(2), env = process.env): Promise<void> {
  if (argv.includes('--metadata')) {
    await metadata(argv, env);

    return;
  }

  const { required } = parseRunnerArguments(argv, LABEL, [
    '--bin', '--cwd', '--run-dir', '--runtime-home', '--prompt-file', '--model', '--mode',
  ]);
  const args = await validateRunnerPaths({
    bin: required('--bin'),
    cwd: required('--cwd'),
    runDir: required('--run-dir'),
    runtimeHome: required('--runtime-home'),
    promptFile: required('--prompt-file'),
  }, LABEL);
  const identity = factoryRunIdentity(env, LABEL);
  const mode = required('--mode');

  if (!['state-only', 'workspace-write'].includes(mode)
    || (mode === 'state-only' && (!env.STATE_DIR || await fs.realpath(env.STATE_DIR) !== args.cwd))) {
    throw new Error(`${LABEL}: неверная граница файловой системы`);
  }

  const config = { ...runnerConfig(args.bin, env), qwenRuntimeHome: args.runtimeHome };
  const snapshot = readQwenSnapshot(config);
  const model = required('--model');

  if (!snapshot.models.some((entry) => entry.id === model)) {
    throw new Error(`${LABEL}: модель отсутствует в modelProviders`);
  }

  const prompt = await readRunnerPrompt(args.promptFile, LABEL);
  const controller = new AbortController();
  const cancel = () => controller.abort();

  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);

  await fs.mkdir(args.runtimeHome, { recursive: true, mode: 0o700 });

  const status = await createQwenFactoryStatus(args.runtimeHome, env);

  try {
    const adapter = externalCliAdapter(qwen, env);
    const result = await adapter.run!({
      config,
      message: prompt,
      model,
      cwd: args.cwd,
      readonlyRoots: mode === 'state-only' ? [config.rootDir] : [],
      signal: controller.signal,
      chatKey: `factory:${identity.task}:${identity.stage}:${identity.runId}:${identity.epoch}`,
      factory: true,
      permissionMode: 'yolo',
      mcpServers: [status.mcpServer],
      onPermission: async () => ({ allow: false }),
      onStep: (step) => {
        if (step.k === 'tool' || step.k === 'res') {
          emitRunnerEvent({ event: step.k === 'tool' ? 'tool_call' : 'tool_result', name: step.name });
        }
      },
    });

    controller.signal.throwIfAborted();
    await writeRunnerLast(args.runDir, String(result.reply || ''));
    emitRunnerEvent({ event: 'result', stopReason: 'end_turn' });
  } finally {
    await status.close();
    process.removeListener('SIGTERM', cancel);
    process.removeListener('SIGINT', cancel);
  }
}

/**
 * Source и упакованный helper возвращают одинаковый структурный отказ.
 * Полные ключи вырезаются из сообщения до stdout и stderr.
 */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    await runQwenFactory(argv);
  } catch (error) {
    const secrets = Object.entries(process.env).filter(([key]) => /KEY|TOKEN|SECRET/.test(key));
    const message = redactRunnerError(error, secrets.map(([, value]) => value));

    emitRunnerEvent(factoryRunnerErrorEvent(error, 'qwen_wrapper_error', message));
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (isDirectRun(import.meta.url)) {
  void main();
}
