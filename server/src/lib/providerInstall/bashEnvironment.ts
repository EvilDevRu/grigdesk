import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { EXTERNAL_BASELINE_PATH, type InstallRoots } from './npmEnvironment.ts';

/**
 * Проверка внешней оболочки — часть явной операции установки и не запускается
 * при чтении реестра. Интерактивный и login-запуск идут с фиксированным baseline
 * PATH, поэтому серверный PATH не подтверждает готовность пользовательского.
 */
export const BASH_PROBE_TIMEOUT_MS = 15_000;
export const BASH_PROBE_VERSION = 'grigdesk-bash-probe-1';

const MAX_PROTOCOL_BYTES = 64 * 1024;
const MAX_STREAM_BYTES = 64 * 1024;
const PROBE_FIELD_COUNT = 11;

export type BashCommandKind = 'file' | 'alias' | 'function' | 'builtin' | 'keyword' | 'missing';

const COMMAND_KINDS: readonly BashCommandKind[] = ['file', 'alias', 'function', 'builtin',
  'keyword', 'missing'];

export interface BashCommandState {
  kind: BashCommandKind;
  path: string;
}

export interface BashProbeSnapshot {
  path: string;
  node: BashCommandState;
  npm: BashCommandState;
  cli: BashCommandState;
  prefix: string;
}

export interface BashProbeReport {
  shell: 'bash' | 'other';
  bash: string | null;
  interactive: BashProbeSnapshot | null;
  login: BashProbeSnapshot | null;
  failed: boolean;
}

export interface BashProbeInput {
  env: NodeJS.ProcessEnv;
  roots: InstallRoots;
  cliName: string;
  scratch: string;
  nonce: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

// Служебные переменные сервера и защитный npm-prefix не должны влиять на startup.
// Пользовательские locale/XDG/proxy остаются: их читают rc-файлы и npm.
const PROBE_ENV_DENY = new Set([
  'BASH_ENV', 'ENV', 'CDPATH', 'PROMPT_COMMAND', 'PS1', 'PS2', 'PS4',
  'NODE_OPTIONS', 'NODE_PATH', 'npm_config_prefix', 'NPM_CONFIG_PREFIX',
]);

/**
 * Поддержана только абсолютная оболочка, чей realpath является Bash.
 * Ссылка из пользовательского каталога на /bin/bash остаётся допустимой.
 */
export async function resolveBashShell(env: NodeJS.ProcessEnv): Promise<string | null> {
  const shell = env.SHELL;

  if (typeof shell !== 'string' || !path.isAbsolute(shell)) {
    return null;
  }

  const physical = await fs.realpath(shell).catch(() => null);

  return physical && path.basename(physical) === 'bash' ? shell : null;
}

/**
 * Протокол — ровно одиннадцать строковых полей, разделённых NUL, с завершающим NUL.
 * Node не нужен ни для ответа об отсутствии Node, ни для самого файла протокола.
 */
const PROBE_SCRIPT = [
  'builtin set +e +u',
  '__gd_version="grigdesk-bash-probe-1"',
  '__gd_nonce="$2"',
  '__gd_out="$1"',
  '__gd_kind() {',
  '  __gd_value="$(builtin type -t "$1" 2>/dev/null)"',
  '  case "$__gd_value" in',
  '    file|alias|function|builtin|keyword) builtin printf %s "$__gd_value" ;;',
  '    "") builtin printf missing ;;',
  '    *) builtin printf missing ;;',
  '  esac',
  '}',
  '__gd_path() {',
  '  case "$1" in',
  '    file) __gd_value="$(builtin command -v "$2" 2>/dev/null)" ;;',
  '    *) __gd_value="" ;;',
  '  esac',
  '  case "$__gd_value" in',
  '    /*) builtin printf %s "$__gd_value" ;;',
  '    *) builtin printf "" ;;',
  '  esac',
  '}',
  '__gd_node_kind="$(__gd_kind node)"',
  '__gd_node_path="$(__gd_path "$__gd_node_kind" node)"',
  '__gd_npm_kind="$(__gd_kind npm)"',
  '__gd_npm_path="$(__gd_path "$__gd_npm_kind" npm)"',
  '__gd_cli_kind="$(__gd_kind "$3")"',
  '__gd_cli_path="$(__gd_path "$__gd_cli_kind" "$3")"',
  '__gd_prefix=""',
  'if [ "$__gd_npm_kind" = file ] && [ -n "$__gd_npm_path" ]; then',
  '  __gd_prefix="$("$__gd_npm_path" prefix -g 2>/dev/null)"',
  '  __gd_prefix="${__gd_prefix%%$\'\\n\'*}"',
  '  case "$__gd_prefix" in',
  '    /*) ;;',
  '    *) __gd_prefix="" ;;',
  '  esac',
  'fi',
  'builtin printf \'%s\\0\' "$__gd_version" "$__gd_nonce" "ok" "$PATH" "$__gd_node_kind" '
    + '"$__gd_node_path" "$__gd_npm_kind" "$__gd_npm_path" "$__gd_cli_kind" "$__gd_cli_path" '
    + '"$__gd_prefix" >"$__gd_out"',
  '',
].join('\n');

/**
 * Окружение probe — baseline PATH и пользовательские параметры, но без служебных
 * переменных сервера. Startup-файлы Bash сами добавляют то, что нужно человеку.
 */
export function bashProbeEnvironment(env: NodeJS.ProcessEnv, bash: string): Record<string, string> {
  const prepared: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || PROBE_ENV_DENY.has(key) || key.startsWith('GRIGDESK_')) {
      continue;
    }

    prepared[key] = value;
  }

  prepared.PATH = EXTERNAL_BASELINE_PATH;
  prepared.HOME = env.HOME ?? '';
  prepared.SHELL = bash;

  return prepared;
}

/**
 * Несовпадение версии, nonce, количества или типов полей означает повреждённый
 * протокол, а не «среда готова». Пустые пути допустимы только для отсутствующих
 * команд и не влияют на решение о готовности.
 */
export function decodeBashProbe(payload: Buffer, nonce: string): BashProbeSnapshot | null {
  if (!payload || payload.length === 0 || payload.length > MAX_PROTOCOL_BYTES) {
    return null;
  }

  const fields = payload.toString('utf8').split('\0');

  if (fields.length !== PROBE_FIELD_COUNT + 1 || fields[PROBE_FIELD_COUNT] !== '') {
    return null;
  }

  const [version, probeNonce, status, probePath, nodeKind, nodePath, npmKind, npmPath,
    cliKind, cliPath, prefix] = fields as string[];

  if (version !== BASH_PROBE_VERSION || probeNonce !== nonce || status !== 'ok'
    || nodeKind === undefined || npmKind === undefined || cliKind === undefined
    || !COMMAND_KINDS.includes(nodeKind as BashCommandKind)
    || !COMMAND_KINDS.includes(npmKind as BashCommandKind)
    || !COMMAND_KINDS.includes(cliKind as BashCommandKind)) {
    return null;
  }

  /**
   * Путь принимается только у вида `file` и только абсолютный. Alias и функция
   * не дают пути: для автоматической ветки это отдельный отказ, а не готовая среда.
   */
  const command = (kind: BashCommandKind, value: string): BashCommandState | null => {
    if (kind !== 'file') {
      return value === '' ? { kind, path: '' } : null;
    }

    return path.isAbsolute(value) ? { kind, path: value } : null;
  };
  const node = command(nodeKind as BashCommandKind, nodePath ?? '');
  const npm = command(npmKind as BashCommandKind, npmPath ?? '');
  const cli = command(cliKind as BashCommandKind, cliPath ?? '');

  if (!node || !npm || !cli || typeof prefix !== 'string'
    || (prefix !== '' && !path.isAbsolute(prefix))) {
    return null;
  }

  return {
    path: probePath ?? '',
    node,
    npm,
    cli,
    prefix: prefix ?? '',
  };
}

export interface BashCommandResult {
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Запускается только собственная группа процессов: при таймауте или отмене
 * сигнал получает вся группа, а не чужой процесс с тем же PID. Вывод ограничен
 * по объёму и не публикуется: probe отвечает файлом, а версия запуска — краткой строкой.
 */
export function runBashCommand(input: {
  bash: string;
  mode: 'interactive' | 'login';
  command: string;
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  args?: string[];
  signal?: AbortSignal;
}): Promise<BashCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(input.bash, [input.mode === 'login' ? '-lic' : '-ic', input.command,
      'grigdesk-probe', ...(input.args ?? [])], {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = { stdout: '', stderr: '' };
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const collect = (key: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (output[key].length < MAX_STREAM_BYTES) {
        output[key] += chunk.toString('utf8').slice(0, MAX_STREAM_BYTES);
      }
    };
    /**
     * Ровно один результат на процесс: error и close могут прийти вместе,
     * а отмена и таймаут уже отправляют сигнал собственной группе.
     */
    const finish = (code: number | null): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        timedOut,
        aborted,
        stdout: output.stdout,
        stderr: output.stderr,
      });
    };
    /**
     * Сигнал получает только собственная группа процессов этого запуска.
     * Ошибка kill не превращается в исключение: результат всё равно нужен.
     */
    const stop = (): void => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    };
    const onAbort = (): void => {
      aborted = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, input.timeoutMs);

    input.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => collect('stderr', chunk));
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

/**
 * Один режим startup пишет результат в отдельный файл scratch-каталога операции:
 * шум rc на stdout не считается ответом. Файл удаляется в любом исходе.
 */
async function probeMode(input: BashProbeInput, mode: 'interactive' | 'login',
  bash: string): Promise<{ snapshot: BashProbeSnapshot | null; failed: boolean }> {
  const resultFile = path.join(input.scratch,
    `probe-${mode}-${randomBytes(8).toString('hex')}.bin`);
  const run = await runBashCommand({
    bash,
    mode,
    command: PROBE_SCRIPT,
    args: [resultFile, input.nonce, input.cliName],
    env: bashProbeEnvironment(input.env, bash),
    cwd: input.scratch,
    timeoutMs: input.timeoutMs ?? BASH_PROBE_TIMEOUT_MS,
    signal: input.signal,
  });

  try {
    const stat = await fs.stat(resultFile).catch(() => null);

    if (!stat || !stat.isFile() || stat.size > MAX_PROTOCOL_BYTES) {
      return { snapshot: null, failed: run.timedOut || run.aborted || !stat };
    }

    const payload = await fs.readFile(resultFile).catch(() => null);

    return {
      snapshot: payload ? decodeBashProbe(payload, input.nonce) : null,
      failed: run.timedOut || run.aborted || !payload,
    };
  } finally {
    await fs.rm(resultFile, { force: true }).catch(() => {});
  }
}

/**
 * Обе поддерживаемые формы Bash проверяются независимо и последовательно.
 * Неудача любой формы — деградация в needs_setup, а не отказ установки пакета.
 */
export async function probeBashEnvironment(input: BashProbeInput): Promise<BashProbeReport> {
  const bash = await resolveBashShell(input.env);

  if (!bash) {
    return {
      shell: 'other',
      bash: null,
      interactive: null,
      login: null,
      failed: false,
    };
  }

  const home = input.env.HOME;

  if (typeof home !== 'string' || !path.isAbsolute(home)) {
    return {
      shell: 'bash',
      bash,
      interactive: null,
      login: null,
      failed: true,
    };
  }

  await fs.mkdir(input.scratch, { recursive: true, mode: 0o700 });

  const interactive = await probeMode(input, 'interactive', bash);

  if (interactive.failed && !interactive.snapshot) {
    return {
      shell: 'bash',
      bash,
      interactive: null,
      login: null,
      failed: true,
    };
  }

  const login = await probeMode(input, 'login', bash);
  const failed = (interactive.snapshot === null) || (login.failed && !login.snapshot);

  return {
    shell: 'bash',
    bash,
    interactive: interactive.snapshot,
    login: login.snapshot,
    failed,
  };
}
