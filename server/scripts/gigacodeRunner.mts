import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFactoryStatusPort } from '../src/lib/factory/statusPort.ts';
import { runGigaCodeTurn } from '../src/lib/gigacode/runtime.ts';
import { gigaCodeError, gigaCodeRootContains } from '../src/lib/gigacode/profile.ts';
import { cleanRunnerFailureMessage } from '../src/lib/runnerFailure.ts';
/**
 * Wrapper принимает только host-пути и точный model id; prompt остаётся private-файлом.
 * Ничего из аргументов модели не становится task/run/epoch или loop role.
 */
function argumentsMap(argv: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const known = new Set(['--cwd', '--run-dir', '--prompt-file', '--model', '--effort', '--mode']);

  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];

    if (!name || !known.has(name) || value === undefined || value.includes('\0') || result.has(name)) {
      throw gigaCodeError('gigacode_invalid_config', 'Повреждены аргументы Factory wrapper');
    }

    result.set(name, value);
  }

  return result;
}
/**
 * Prompt читается удерживаемым no-follow fd с фиксированным лимитом.
 * Модель не видит этот файл и не может изменить его во время запуска через свои mounts.
 */
async function readPrompt(file: string, runDir: string): Promise<string> {
  const relative = path.relative(runDir, file);

  if (!path.isAbsolute(file) || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw gigaCodeError('gigacode_invalid_config', 'Prompt вышел из private run directory');
  }

  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const stat = await handle.stat();
    const maximum = 2 * 1024 * 1024;

    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > maximum) {
      throw gigaCodeError('gigacode_invalid_config', 'Недопустимый private prompt');
    }

    const buffer = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);

    if (bytesRead !== stat.size || bytesRead > maximum) {
      throw gigaCodeError('gigacode_invalid_config', 'Prompt изменился во время чтения');
    }

    return buffer.subarray(0, bytesRead).toString('utf8');
  }
  finally {
    await handle.close();
  }
}
/**
 * Единственный писатель stdout публикует versioned host events без private ACP payload.
 * Usage не выдумывается; retained-FD finalizer отдельно сохранит безопасную диагностику.
 */
function emit(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({
    schema: 'gigacode-acp-v1', ...value
  })}\n`);
}
/**
 * Статусный MCP выполняет штатные writers на host, файловые tools живут внутри namespace.
 * Отмена убивает только этот runtime; после эффектов wrapper никогда не повторяет prompt.
 */
export async function runGigaCodeFactory(argv = process.argv.slice(2), env = process.env): Promise<number> {
  let phase = 'pre-prompt';
  const controller = new AbortController();
  const cancel = () => controller.abort();

  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);

  try {
    const args = argumentsMap(argv);
    const mode = args.get('--mode');

    if (!['state-only', 'workspace-write'].includes(mode || '')) {
      throw gigaCodeError('gigacode_invalid_mode', 'Неизвестная filesystem policy Factory');
    }
    if (env.FACTORY_PROVIDER_SESSION_MODE && env.FACTORY_PROVIDER_SESSION_MODE !== 'fresh') {
      throw gigaCodeError('gigacode_resume_unsupported', 'Нативное продолжение Factory не поддержано');
    }

    const cwd = args.get('--cwd') || '';
    const runDir = args.get('--run-dir') || '';
    const state = env.FACTORY_STATE || env.STATE_DIR || '';
    const task = env.FACTORY_RUN_TASK || '';

    if (![cwd, runDir, state].every((value) => path.isAbsolute(value)) || !/^\d+$/u.test(task)) {
      throw gigaCodeError('gigacode_invalid_config', 'Повреждены host roots Factory');
    }

    const workTools = createFactoryStatusPort(env);
    const message = await readPrompt(args.get('--prompt-file') || '', runDir);
    const reports = path.join(state, 'reports', `t${task}`);

    await fs.mkdir(reports, {
      recursive: true, mode: 0o700
    });

    const extraDirs = (env.RUNNER_GIGACODE_ADD_DIRS || '').split('\n')
      .filter((root) => root && path.resolve(root) !== path.resolve(state));
    const realState = await fs.realpath(state);

    if ([cwd, ...extraDirs].some((root) => gigaCodeRootContains(path.resolve(root), realState))) {
      throw gigaCodeError('gigacode_invalid_roots', 'Рабочий корень раскрывает весь Factory state');
    }

    const config = {
      gigacodeBin: env.GRIGDESK_GIGACODE_BIN,
      gigacodeHome: env.GRIGDESK_GIGACODE_HOME,
      gigacodeRuntimeHome: env.GRIGDESK_GIGACODE_RUNTIME_HOME,
      gigacodeBwrapBin: env.GRIGDESK_GIGACODE_BWRAP_BIN,
    };

    const result = await runGigaCodeTurn({
      config,
      cwd,
      extraDirs,
      writableRoots: mode === 'state-only' ? [reports] : [cwd, reports],
      permissionMode: mode === 'state-only' ? 'state-only' : 'default',
      model: args.get('--model'),
      effort: args.get('--effort'),
      message: `Каталог для отчётов этого задания: ${reports}\n\n${message}`,
      workTools,
      mcpName: 'factory-status',
      factory: true,
      signal: controller.signal,
      onRunMetadata: (metadata) => emit({
        event: 'run_start',
        model: metadata.actualModelId,
        cliVersion: metadata.cliVersion,
        mode,
      }),
      onPromptStarted: () => {
        phase = 'prompt';
        emit({
          event: 'prompt_started'
        });
      },
      onRawUpdate: (update) => {
        const event = update?.sessionUpdate;

        if (event === 'agent_message_chunk') {
          emit({
            event, text: String(update.content?.text || '')
          });
        }
        else if (event === 'tool_call' || event === 'tool_call_update') {
          emit({
            event,
            name: String(update._meta?.toolName || update.title || '').slice(0, 200),
            toolCallId: String(update.toolCallId || '').slice(0, 200),
            status: update.status,
          });
        }
      },
    });

    await fs.writeFile(path.join(runDir, 'last.md'), result.reply, {
      mode: 0o600
    });
    emit({
      event: 'turn_end',
      stopReason: result.stopReason,
      model: result.actualModelId
    });

    return 0;
  }
  catch (error) {
    const failure = error as {
      code?: unknown;
      message?: unknown;
      stopped?: unknown;
    };

    if (controller.signal.aborted || failure.stopped) {
      return 130;
    }

    emit({
      event: 'run_error',
      phase,
      code: String(failure.code || 'gigacode_wrapper_error'),
      message: cleanRunnerFailureMessage(String(failure.message || 'Ошибка GigaCode')),
    });

    return phase === 'pre-prompt' ? 4 : 1;
  }
  finally {
    process.off('SIGTERM', cancel);
    process.off('SIGINT', cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runGigaCodeFactory();
}
