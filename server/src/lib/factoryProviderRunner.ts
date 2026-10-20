import { promises as fs } from 'node:fs';
import path from 'node:path';

// Общая часть host-wrapper-ов DSH-исполнителей Factory: разбор argv, private пути RUN_DIR,
// server-owned identity этапа, env статусного MCP и private I/O. Ход модели и каталог —
// у конкретного исполнителя; сообщения об ошибках несут его подпись.

export interface FactoryRunnerPaths {
  bin: string;
  cwd: string;
  runDir: string;
  runtimeHome: string;
  promptFile: string;
  cacheDir?: string;
}

export interface FactoryRunIdentity {
  task: string;
  stage: string;
  runId: string;
  epoch: string;
}

// Статусный MCP получает только identity этапа и каналы движка, без модельных ключей.
export const FACTORY_STATUS_ENV_NAMES: readonly string[] = Object.freeze([
  'FACTORY_RUN_TASK',
  'FACTORY_RUN_STAGE',
  'FACTORY_RUN_ID',
  'FACTORY_RUN_EPOCH',
  'FACTORY_STATUS_MODE',
  'FACTORY_STATUS_REQUEST_DIR',
  'FACTORY_STATE',
  'STATE_DIR',
  'FACTORY_STAGE_RESULT_CHECK',
  'FACTORY_LOOP_ROLE',
]);

// Prompt этапа читается целиком в память: предел защищает wrapper от чужого огромного файла.
const PROMPT_LIMIT = 2 * 1024 * 1024;

/**
 * Разбирает только пары `--имя значение`: повтор, NUL и неизвестное имя — отказ до эффектов.
 * required даёт непустое значение обязательного аргумента с подписью исполнителя.
 */
export function parseRunnerArguments(argv: readonly string[], label: string, known: readonly string[]) {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];

    if (!name?.startsWith('--') || value === undefined || value.includes('\0')) {
      throw new Error(`${label}: повреждены аргументы wrapper-а`);
    }

    if (values.has(name)) {
      throw new Error(`${label}: повторён аргумент ${name}`);
    }

    values.set(name, value);
  }

  for (const name of values.keys()) {
    if (!known.includes(name)) {
      throw new Error(`${label}: неизвестный аргумент ${name}`);
    }
  }

  return {
    values,
    required(name: string): string {
      const value = values.get(name) || '';

      if (!value) {
        throw new Error(`${label}: не задан ${name}`);
      }

      return value;
    },
  };
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);

  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Пути попытки абсолютные и физические: prompt — private regular file внутри RUN_DIR,
 * runtime home тоже внутри RUN_DIR, DSH binary — исполняемый файл.
 */
export async function validateRunnerPaths<T extends FactoryRunnerPaths>(args: T, label: string): Promise<T> {
  for (const [name, value] of Object.entries({
    bin: args.bin,
    cwd: args.cwd,
    runDir: args.runDir,
    runtimeHome: args.runtimeHome,
    promptFile: args.promptFile,
    ...(args.cacheDir ? { cacheDir: args.cacheDir } : {}),
  })) {
    if (!path.isAbsolute(value)) {
      throw new Error(`${label}: ${name} не абсолютный`);
    }
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
    throw new Error(`${label}: prompt-file должен быть private regular file`);
  }

  if (!binStat.isFile() || (binStat.mode & 0o111) === 0) {
    throw new Error(`${label}: DSH binary не исполняемый файл`);
  }

  if (!inside(runDir, promptFile) || !inside(runDir, args.runtimeHome)) {
    throw new Error(`${label}: служебные пути вышли из RUN_DIR`);
  }

  return {
    ...args,
    cwd,
    runDir,
    bin,
    promptFile,
  };
}

/**
 * Identity этапа задаёт только движок через env: task, stage, run и epoch попытки
 * и request-канал статуса. Порча любого поля останавливает wrapper до модели.
 */
export function factoryRunIdentity(env: NodeJS.ProcessEnv, label: string): FactoryRunIdentity {
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
    throw new Error(`${label}: server-owned run/status identity повреждена`);
  }

  return {
    task,
    stage,
    runId,
    epoch,
  };
}

/**
 * Env статусного MCP — точный allowlist имён движка без пустых значений и NUL.
 * Модельные ключи и режим доступа сюда не попадают ни при каком окружении.
 */
export function factoryStatusEnvironment(env: NodeJS.ProcessEnv): Array<{ name: string; value: string }> {
  const output: Array<{ name: string; value: string }> = [];

  for (const name of FACTORY_STATUS_ENV_NAMES) {
    const value = env[name];

    if (typeof value === 'string' && value && !value.includes('\0')) {
      output.push({ name, value });
    }
  }

  return output;
}

/**
 * Событие wrapper-а — одна JSON-строка stdout для retained журнала попытки движка.
 * Вызывающий передаёт только безопасные поля без prompt, ключей и аргументов инструментов.
 */
export function emitRunnerEvent(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * Текст ошибки для retained событий: значения переданных секретов вырезаются,
 * длина ограничена, чтобы журнал попытки не принимал произвольный объём.
 */
export function redactRunnerError(error: unknown, secrets: readonly (string | undefined)[]): string {
  let message = String((error as { message?: unknown } | null)?.message || error);

  for (const secret of secrets) {
    if (secret) {
      message = message.replaceAll(secret, '<redacted>');
    }
  }

  return message.slice(0, 8_192);
}

/**
 * last.md попытки — private файл: ответ модели не становится читаемым другим.
 * chmod повторяется, если файл уже существовал с иными правами.
 */
export async function writeRunnerLast(runDir: string, text: string): Promise<void> {
  const target = path.join(runDir, 'last.md');

  await fs.writeFile(target, text, { mode: 0o600 });
  await fs.chmod(target, 0o600);
}

/**
 * Prompt читается после проверки пути и до старта модели; превышение предела — отказ
 * без частичного prompt. Текст prompt в события wrapper не выводится.
 */
export async function readRunnerPrompt(file: string, label: string): Promise<string> {
  const prompt = await fs.readFile(file, 'utf8');

  if (Buffer.byteLength(prompt, 'utf8') > PROMPT_LIMIT) {
    throw new Error(`${label}: prompt превышает 2 MiB`);
  }

  return prompt;
}
