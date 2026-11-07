import { evaluateDirectCommand } from '../executors/_directSshPolicy.ts';
import type { DirectCommandOptions, DirectCommandDecision } from '../executors/_directSshPolicy.ts';
import { runCommand } from '../packageInstall/runCommand.ts';
import type { PluginCommandRunner } from '../packageInstall/runCommand.ts';
import { COMMAND_TOOL } from './commandProfile.ts';

interface Options {
  cwd: string;
  env: NodeJS.ProcessEnv;
  settings: DirectCommandOptions;
  permissionMode: string;
  commandsAllowed: boolean;
  blockedReason?: string;
  signal?: AbortSignal;
  nativeGuard?: () => Promise<boolean>;
  authorize?: (ask: Record<string, unknown>) => Promise<{ allow?: unknown } | null | undefined>;
  evaluate?: typeof evaluateDirectCommand;
  run?: PluginCommandRunner;
}

const MAX_TIMEOUT = 7_200_000;
const MAX_COMMAND = 32_768;

/**
 * Ожидание человека не имеет автоматического allow или короткого таймаута.
 * Отмена хода снимает только наше ожидание и не запускает поздно одобренную команду.
 */
function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new Error('command_cancelled'));

    if (signal.aborted) {
      aborted();
    } else {
      signal.addEventListener('abort', aborted, { once: true });
    }

    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

/**
 * Только этот серверный объект владеет policy, рабочей папкой и запуском процесса.
 * MCP передаёт данные команды; исключения проверок превращаются в отказ до runner.
 */
export function createKimiCommandTool(options: Options) {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const settings = Object.freeze({ ...options.settings });
  const env = { ...options.env };
  const evaluate = options.evaluate ?? evaluateDirectCommand;
  const run = options.run ?? runCommand;
  const jobs = new Set<Promise<Record<string, unknown>>>();
  const failure = (error: string, message = error) => ({
    ok: false,
    error,
    message,
  });

  /**
   * Проверка выполняется непосредственно перед разрешением и запуском команды.
   * Даже доверенный callback разрешения не может переопределить запрет policy.
   */
  async function execute(name: string, input: Record<string, unknown>) {
    if (name !== COMMAND_TOOL) {
      return failure('tool_not_found');
    }
    if (signal.aborted) {
      return failure('command_cancelled');
    }
    if (!options.commandsAllowed) {
      return failure('user_shell_policy_unsupported', options.blockedReason);
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return failure('invalid_command');
    }

    const command = input.command;
    const timeoutMs = input.timeout_ms ?? 120_000;
    const validKeys = Object.keys(input).every((key) => key === 'command' || key === 'timeout_ms');

    if (!validKeys || typeof command !== 'string' || !command.trim() || command.includes('\0')
      || Buffer.byteLength(command) > MAX_COMMAND || typeof timeoutMs !== 'number'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT) {
      return failure('invalid_command');
    }

    try {
      if (await options.nativeGuard?.() !== true) {
        return failure('native_shell_policy_denied');
      }
    } catch {
      return failure('native_shell_policy_unavailable');
    }

    let decision: DirectCommandDecision;

    try {
      decision = evaluate(command, settings);

      if (!decision || !['allow', 'deny', 'unknown'].includes(decision.verdict)
        || !['db', 'ssh', 'other'].includes(decision.kind)) {
        throw new Error('invalid_policy_result');
      }
    } catch {
      return failure('policy_unavailable', 'Проверка команды недоступна; команда не запущена.');
    }

    if (decision.verdict === 'deny'
      || (decision.verdict === 'unknown' && settings.strictUnknownDbClient === true)) {
      return failure('direct_command_denied', 'Используй надзорный инструмент GrigDesk для SSH или БД.');
    }

    try {
      if (options.permissionMode !== 'yolo') {
        const answer = await untilAbort(Promise.resolve(options.authorize?.({
          tool: 'Bash',
          input: {
            command,
            kind: 'execute',
            description: 'Выполнить команду в рабочей папке разговора',
          },
          acceptsComment: true,
          canRemember: false,
          signal,
        })), signal);

        if (answer?.allow !== true) {
          return failure('permission_denied');
        }
      }
      if (signal.aborted) {
        return failure('command_cancelled');
      }
      if (await options.nativeGuard?.() !== true) {
        return failure('native_shell_policy_denied');
      }

      if (signal.aborted) {
        return failure('command_cancelled');
      }

      const result = await run('/bin/bash', ['--noprofile', '--norc', '-c', command], {
        cwd: options.cwd,
        env,
        timeoutMs,
        signal,
      });

      return { ok: result.code === 0 && !result.aborted && !result.timedOut, ...result };
    } catch {
      return failure(signal.aborted ? 'command_cancelled' : 'command_failed');
    }
  }

  return {
    descriptors: [{
      name: COMMAND_TOOL,
      description: 'Выполнить команду вместо Bash. Проверки SSH/БД и разрешения выполняет GrigDesk.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['command'],
        properties: {
          command: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_COMMAND,
          },
          timeout_ms: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_TIMEOUT,
          },
        },
      },
    }],
    /**
     * Регистрирует незавершённую команду для отмены и ожидания cleanup.
     * Удаление promise из списка не создаёт необработанный rejection.
     */
    invoke(name: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      const job = execute(name, input);

      jobs.add(job);
      void job.then(() => jobs.delete(job), () => jobs.delete(job));

      return job;
    },
    async close(): Promise<void> {
      controller.abort();
      await Promise.allSettled(jobs);
    },
  };
}
