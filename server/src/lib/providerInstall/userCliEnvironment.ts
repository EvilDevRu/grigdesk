import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  captureUserCliParent, decodeUserCliParent, USER_CLI_PARENT_KEY,
} from '../../../../shared/node/userCliParentEnvironment.ts';
import { resolveBashShell, runBashCommand, type BashCommandState } from './bashEnvironment.ts';
import {
  InstallEnvironmentError, readGlobalPrefix, resolveExternalRuntime, selectInstallPrefix,
  type InstallRoots,
} from './npmEnvironment.ts';

export interface UserCliEnvironmentInput {
  env: NodeJS.ProcessEnv;
  cliName: string;
  scratch: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface UserCliShellSnapshot {
  env: Record<string, string>;
  node: BashCommandState;
  npm: BashCommandState;
  cli: BashCommandState;
}

export interface UserCliEnvironment extends UserCliShellSnapshot {
  loginEnv: Record<string, string>;
}

const MAX_PROTOCOL_BYTES = 256 * 1024;
const DENY = new Set(['NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV', 'CDPATH', 'PROMPT_COMMAND',
  'PS1', 'PS2', 'PS4', 'SHELLOPTS', 'BASHOPTS']);
const SCRIPT = [
  'builtin set +e +u',
  'builtin umask 077',
  'builtin printf "%s\\0" grigdesk-user-env-1 "$2" >"$1"',
  'for __gd_cmd in node npm "$3"; do',
  '  __gd_kind="$(builtin type -t "$__gd_cmd" 2>/dev/null)"',
  '  __gd_path=""',
  '  if [[ "$__gd_kind" = file ]]; then',
  '    __gd_path="$(builtin command -v "$__gd_cmd")"',
  '  fi',
  '  builtin printf "%s\\0" "${__gd_kind:-missing}" "$__gd_path" >>"$1"',
  'done',
  'while IFS= builtin read -r __gd_key; do',
  '  if [[ "$__gd_key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then',
  '    builtin printf "%s\\0" "$__gd_key=${!__gd_key}" >>"$1"',
  '  fi',
  'done < <(builtin compgen -e)',
].join('\n');

/**
 * Служебный bootstrap и loaders не пересекают внешнюю границу даже из shell startup.
 * Остальные exports, включая proxy/CA/npmrc, сохраняются приватно без публикации в DTO.
 */
function cleanEnvironment(input: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && !DENY.has(key) && !key.startsWith('GRIGDESK_')
      && !key.startsWith('BASH_FUNC_')) {
      env[key] = value;
    }
  }

  const prefix = env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX;

  delete env.NPM_CONFIG_PREFIX;

  if (prefix !== undefined) {
    env.npm_config_prefix = prefix;
  }

  return env;
}

/**
 * NUL отделяет поля, поэтому пробелы, переводы строк и знак равенства остаются данными.
 * Неожиданная команда, повтор ключа и шум вместо протокола отвергаются целиком.
 */
function decode(payload: Buffer, nonce: string): UserCliShellSnapshot | null {
  const fields = payload.toString('utf8').split('\0');

  if (fields.length < 10 || fields[0] !== 'grigdesk-user-env-1' || fields[1] !== nonce
    || fields.at(-1) !== '') {
    return null;
  }

  const commands: BashCommandState[] = [];

  for (const index of [2, 4, 6]) {
    const kind = fields[index];
    const file = fields[index + 1] ?? '';

    if (kind !== 'file' && kind !== 'missing') {
      throw new InstallEnvironmentError('shell_command_unsupported',
        'Оболочка определяет команду как alias или функцию');
    }
    if (kind === 'file' ? !path.isAbsolute(file) : file !== '') {
      return null;
    }

    commands.push({ kind, path: file });
  }

  const env: Record<string, string> = {};

  for (const field of fields.slice(8, -1)) {
    const separator = field.indexOf('=');
    const key = field.slice(0, separator);

    if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || Object.hasOwn(env, key)) {
      return null;
    }

    Object.defineProperty(env, key, { value: field.slice(separator + 1), enumerable: true });
  }

  return {
    env: cleanEnvironment(env),
    node: commands[0]!,
    npm: commands[1]!,
    cli: commands[2]!,
  };
}

/**
 * Каждая форма Bash пишет в приватный одноразовый каталог, stdout rc не становится ответом.
 * Файл читается без следования ссылке и удаляется вместе с каталогом при любом исходе.
 */
async function snapshot(input: UserCliEnvironmentInput, bash: string, env: Record<string, string>,
  mode: 'interactive' | 'login'): Promise<UserCliShellSnapshot> {
  await fs.mkdir(input.scratch, { recursive: true, mode: 0o700 });

  const directory = await fs.mkdtemp(path.join(input.scratch, 'user-env-'));
  const file = path.join(directory, 'snapshot');
  const nonce = randomUUID();

  try {
    const result = await runBashCommand({
      bash,
      mode,
      command: SCRIPT,
      args: [file, nonce, input.cliName],
      env,
      cwd: env.HOME!,
      timeoutMs: input.timeoutMs ?? 15_000,
      signal: input.signal,
    });

    if (result.code !== 0 || result.timedOut || result.aborted) {
      throw new Error('probe_failed');
    }

    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let payload: Buffer;

    try {
      const stat = await handle.stat();

      if (!stat.isFile() || stat.size > MAX_PROTOCOL_BYTES) {
        throw new Error('protocol_invalid');
      }

      const buffer = Buffer.alloc(MAX_PROTOCOL_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);

      if (bytesRead > MAX_PROTOCOL_BYTES) {
        throw new Error('protocol_invalid');
      }

      payload = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }

    const value = decode(payload, nonce);

    if (!value || value.env.HOME !== env.HOME) {
      throw new Error('protocol_invalid');
    }

    return value;
  } catch (error) {
    if (error instanceof InstallEnvironmentError) {
      throw error;
    }

    throw new InstallEnvironmentError('shell_probe_failed', 'Не удалось проверить окружение оболочки');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/**
 * Разные ссылки в PATH могут вести к одной установленной программе.
 * Сверяем физические пути, сохраняя исходные пути и env для последующего запуска.
 */
async function shellSelectionFingerprint(value: UserCliShellSnapshot): Promise<string> {
  const commands = await Promise.all([value.node, value.npm, value.cli].map(async (command) => {
    if (command.kind !== 'file') {
      return command;
    }

    try {
      return { ...command, path: await fs.realpath(command.path) };
    } catch {
      throw new InstallEnvironmentError('shell_probe_failed',
        'Не удалось проверить физический путь команды оболочки');
    }
  }));

  return JSON.stringify([
    ...commands, value.env.npm_config_prefix,
    value.env.npm_config_userconfig, value.env.NPM_CONFIG_USERCONFIG,
  ]);
}

/**
 * Обычный Bash определяет среду внешних CLI отдельно от bundled Node и managed-исполнителей.
 * Ошибка или расхождение двух startup-форм запрещает незаметную установку в запасной prefix.
 */
export async function resolveUserCliEnvironment(input: UserCliEnvironmentInput): Promise<UserCliEnvironment> {
  const parent = decodeUserCliParent(input.env[USER_CLI_PARENT_KEY] ?? captureUserCliParent(input.env));

  if (!parent) {
    throw new InstallEnvironmentError('parent_environment_invalid', 'Исходное окружение запуска неизвестно');
  }

  const bash = await resolveBashShell(input.env);

  if (!bash) {
    throw new InstallEnvironmentError('shell_unsupported', 'Автоматическая проверка поддерживает Bash');
  }
  if (!input.env.HOME || !path.isAbsolute(input.env.HOME) || !/^[a-zA-Z0-9_-]+$/u.test(input.cliName)) {
    throw new InstallEnvironmentError('shell_probe_failed', 'Некорректные параметры оболочки');
  }

  const env = cleanEnvironment({
    ...input.env,
    PATH: parent.path ?? '/usr/bin:/bin',
    npm_config_prefix: parent.npmPrefixLower ?? undefined,
    NPM_CONFIG_PREFIX: parent.npmPrefixUpper ?? undefined,
  });
  const interactive = await snapshot(input, bash, env, 'interactive');
  const interactiveFingerprint = await shellSelectionFingerprint(interactive);
  const login = await snapshot(input, bash, env, 'login');

  if (interactiveFingerprint !== await shellSelectionFingerprint(login)) {
    throw new InstallEnvironmentError('shell_conflict', 'Интерактивная и login-оболочка выбирают разные CLI');
  }

  return { ...interactive, loginEnv: login.env };
}

/**
 * PTY запускает пользовательский shell один раз: startup-файлы выполняет уже он сам.
 * Поэтому среда берётся из сохранённого исходного PATH, без пакетного npm-prefix и служебных
 * переменных; неизвестный старый launcher получает ограниченный системный PATH, а не серверный.
 */
export function ptyStartEnvironment(input: NodeJS.ProcessEnv): Record<string, string> {
  const parent = decodeUserCliParent(input[USER_CLI_PARENT_KEY] ?? captureUserCliParent(input));

  if (!parent) {
    throw new InstallEnvironmentError('parent_environment_invalid', 'Исходное окружение запуска неизвестно');
  }

  const env = cleanEnvironment(input);
  const prefix = parent.npmPrefixLower ?? parent.npmPrefixUpper;

  delete env.NPM_CONFIG_PREFIX;

  if (prefix !== null) {
    env.npm_config_prefix = prefix;
  } else {
    delete env.npm_config_prefix;
  }

  if (parent.path !== null) {
    env.PATH = parent.path;
  } else {
    env.PATH = '/usr/bin:/bin';
  }

  return env;
}

/**
 * Npm нужен установщику отдельно: чтение shell и запуск готового native CLI от него не зависят.
 * Effective prefix определяется обычным npm в HOME с пользовательским npmrc.
 */
export async function resolveUserCliNpm(input: UserCliEnvironmentInput & {
  roots: InstallRoots;
  packageId: string;
  shell?: UserCliEnvironment;
}) {
  const shell = input.shell ?? await resolveUserCliEnvironment(input);
  const home = shell.env.HOME!;
  const runtime = await resolveExternalRuntime({
    env: shell.env,
    roots: input.roots,
    home,
  });
  const loginRuntime = await resolveExternalRuntime({
    env: shell.loginEnv,
    roots: input.roots,
    home,
  });
  const options = {
    cwd: home,
    timeoutMs: input.timeoutMs ?? 15_000,
    signal: input.signal,
  };
  const prefix = await readGlobalPrefix(runtime, options);
  const loginPrefix = await readGlobalPrefix(loginRuntime, options);

  if (prefix !== loginPrefix) {
    throw new InstallEnvironmentError('shell_conflict', 'Две формы оболочки используют разные prefix npm');
  }

  const selected = await selectInstallPrefix({
    runtime,
    roots: input.roots,
    packageId: input.packageId,
    home,
    requested: prefix,
    signal: input.signal,
  });

  if (selected.fallback) {
    throw new InstallEnvironmentError('npm_prefix_unwritable',
      'Пользовательский prefix npm недоступен для записи');
  }

  return {
    runtime,
    prefix,
    shell,
  };
}
