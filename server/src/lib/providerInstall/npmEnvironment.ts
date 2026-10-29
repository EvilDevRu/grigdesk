import { execFile } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { shellQuote } from '../../../../shared/lib/shellQuote.ts';
import type { ProviderInstallNotice } from '../../../../shared/chat/providerInstallContracts.ts';

/**
 * Внешний CLI ставится в пользовательский npm-prefix, а не в папку данных.
 * D — папка данных, I — каталог установки, R — корень дерева/комплекта.
 * Значения передаются вызывающим: сервис берёт их из config/runtime API,
 * а тесты задают собственные временные корни.
 */
export interface InstallRoots {
  dataHome: string;
  installationRoot: string;
  runtimeRoot: string;
}

/**
 * PATH независимого Bash-запуска фиксирован для Linux: в нём нет ни папок
 * GrigDesk, ни выбранного Node, ни обнаруженных сервером nvm-каталогов.
 * Тот же baseline служит стенду, где внешние Node и npm созданы явно.
 */
export const EXTERNAL_BASELINE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export interface ExternalInstallRuntime {
  npm: string;
  node: string;
  env: Record<string, string>;
  home: string;
}

export interface PrefixSelection {
  prefix: string;
  fallback: boolean;
  warnings: ProviderInstallNotice[];
}

/**
 * Отказ окружения npm называет причину кодом и не несёт значений переменных.
 * Сообщение уходит в журнал и окно, поэтому секреты и содержимое npmrc в нём
 * не интерполируются.
 */
export class InstallEnvironmentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'InstallEnvironmentError';
    this.code = code;
  }
}

const NPM_PREFIX_ENV = 'npm_config_prefix';
const NPM_PREFIX_ENV_UPPER = 'NPM_CONFIG_PREFIX';
const PROTECTED_PREFIX = ['state', 'npm-global'];

const isInside = (target: string, root: string): boolean => {
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(root);

  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
};

const insideRoots = (target: string, roots: InstallRoots): boolean =>
  isInside(target, roots.dataHome) || isInside(target, roots.installationRoot)
  || isInside(target, roots.runtimeRoot);

const absolutePath = (value: string | undefined): string | null =>
  typeof value === 'string' && path.isAbsolute(value) ? path.resolve(value) : null;

/**
 * Копия окружения снимает защитный prefix папки данных и оставляет пользовательские
 * registry/proxy/CA/cache/userconfig. Нижняя форма ключа приоритетнее верхней;
 * после подготовки в env остаётся ровно одна каноническая форма.
 */
export function externalNpmEnvironment(input: {
  env: NodeJS.ProcessEnv;
  roots: InstallRoots;
  home: string;
}): Record<string, string> {
  const env: Record<string, string> = Object.fromEntries(Object.entries(input.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  const prepared = [env[NPM_PREFIX_ENV], env[NPM_PREFIX_ENV_UPPER]]
    .find((value) => value !== undefined);

  delete env[NPM_PREFIX_ENV];
  delete env[NPM_PREFIX_ENV_UPPER];

  const value = typeof prepared === 'string' ? prepared.trim() : '';

  if (!value) {
    return env;
  }
  if (!path.isAbsolute(value)) {
    throw new InstallEnvironmentError('npm_prefix_invalid',
      'Prefix npm из окружения должен быть абсолютным путём');
  }

  const resolved = path.resolve(value);
  const protectedPrefix = path.resolve(path.join(input.roots.dataHome, ...PROTECTED_PREFIX));

  // Защитный prefix GrigDesk снимается явной политикой: для этой операции он лишний.
  if (resolved === protectedPrefix) {
    return env;
  }
  if (insideRoots(resolved, input.roots)) {
    throw new InstallEnvironmentError('npm_prefix_invalid',
      'Prefix npm из окружения указывает внутрь каталогов GrigDesk');
  }

  env[NPM_PREFIX_ENV] = resolved;

  return env;
}

/**
 * Исполняемый файл внешней команды проверяется по realpath: ссылка из пользовательского
 * bin в комплект GrigDesk не делает её внешней. Пропуск каталога не является отказом —
 * следующий кандидат PATH может оказаться настоящим.
 */
async function externalExecutable(name: string, env: Record<string, string>,
  roots: InstallRoots): Promise<string | null> {
  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(directory) || insideRoots(directory, roots)) {
      continue;
    }

    const candidate = path.join(directory, name);

    if (!await fs.stat(candidate).then((stat) => stat.isFile(), () => false)
      || !await fs.access(candidate, constants.X_OK).then(() => true, () => false)) {
      continue;
    }

    const physical = await fs.realpath(candidate).catch(() => null);

    if (!physical || insideRoots(physical, roots)) {
      continue;
    }

    return candidate;
  }

  return null;
}

/**
 * Операция закрепляет ровно одну пару внешних Node и npm: npm — скрипт с `env node`,
 * поэтому каталог выбранного Node ставится первым в PATH только окружения установщика.
 * Глобальный PATH сервера и его npm при этом не меняются.
 */
export async function resolveExternalRuntime(input: {
  env: NodeJS.ProcessEnv;
  roots: InstallRoots;
  home: string;
}): Promise<ExternalInstallRuntime> {
  const env = externalNpmEnvironment(input);
  const npm = await externalExecutable('npm', env, input.roots);

  if (!npm) {
    throw new InstallEnvironmentError('npm_missing',
      'В пользовательском PATH нет исполняемого внешнего npm');
  }

  const node = await externalExecutable('node', env, input.roots);

  if (!node) {
    throw new InstallEnvironmentError('npm_runtime_missing',
      'В пользовательском PATH нет исполняемого внешнего Node');
  }

  const nodeDirectory = path.dirname(node);
  const entries = (env.PATH ?? '').split(path.delimiter)
    .filter((entry) => entry && path.resolve(entry) !== path.resolve(nodeDirectory));

  return {
    npm,
    node,
    env: { ...env, PATH: [nodeDirectory, ...entries].join(path.delimiter) },
    home: input.home,
  };
}

const execute = promisify(execFile);

/**
 * Effective global prefix узнаётся тем же внешним npm из безопасного cwd вне проекта.
 * Происхождение значения по одному ответу не выводится: политика применяется к нему.
 */
export async function readGlobalPrefix(runtime: ExternalInstallRuntime, options: {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<string> {
  const { stdout } = await execute(runtime.npm, ['prefix', '-g'], {
    cwd: options.cwd,
    env: runtime.env,
    timeout: options.timeoutMs,
    maxBuffer: 64 * 1024,
    signal: options.signal,
  });

  return stdout.trim();
}

interface ResolvedTarget {
  path: string;
  ancestor: string;
  exists: boolean;
  internal: boolean;
}

/**
 * Путь проверяется по физическому расположению: для отсутствующей цели берётся
 * realpath ближайшего существующего родителя и оставшиеся компоненты. Ссылка
 * посреди пути, ведущая в D/I/R, не даёт обойти запрет внутренних каталогов.
 */
async function resolveTarget(target: string, roots: InstallRoots): Promise<ResolvedTarget> {
  const requested = path.resolve(target);
  let current = requested;
  const rest: string[] = [];

  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const physical = await fs.realpath(current);
      const full = rest.length ? path.join(physical, ...rest) : physical;

      return {
        path: full,
        ancestor: physical,
        exists: rest.length === 0,
        internal: insideRoots(full, roots),
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') {
        throw error;
      }

      const parent = path.dirname(current);

      if (parent === current) {
        return {
          path: requested,
          ancestor: parent,
          exists: false,
          internal: false,
        };
      }

      rest.unshift(path.basename(current));
      current = parent;
    }
  }

  return {
    path: requested,
    ancestor: path.parse(requested).root,
    exists: false,
    internal: false,
  };
}

const writable = (target: string): Promise<boolean> =>
  fs.access(target, constants.W_OK).then(() => true, () => false);

/**
 * Каталог установки проверяется вместе с bin, lib/node_modules и целью пакета.
 * Папки при подготовке не создаются: проверяется только ближайший существующий родитель.
 */
async function targetWritable(target: string, roots: InstallRoots):
  Promise<'ok' | 'invalid' | 'unwritable'> {
  const resolved = await resolveTarget(target, roots);

  if (resolved.internal) {
    return 'invalid';
  }

  const candidate = resolved.exists ? resolved.path : resolved.ancestor;

  return await writable(candidate) ? 'ok' : 'unwritable';
}

/**
 * Проверка цели установки отвечает одним из трёх исходов: каталог годится,
 * он внутренний для GrigDesk или в него нельзя писать. Значения путей остаются
 * данными вызывающего, а сообщение называет только причину.
 */
async function validatePrefix(prefix: string, input: {
  roots: InstallRoots;
  packageId: string;
}): Promise<'ok' | 'invalid' | 'unwritable'> {
  const resolved = absolutePath(prefix);

  if (!resolved) {
    return 'invalid';
  }

  const targets = [
    resolved,
    path.join(resolved, 'bin'),
    path.join(resolved, 'lib', 'node_modules'),
    path.join(resolved, 'lib', 'node_modules', ...input.packageId.split('/')),
  ];

  for (const target of targets) {
    const result = await targetWritable(target, input.roots);

    if (result !== 'ok') {
      return result;
    }
  }

  return 'ok';
}

/**
 * Копия внутри версии nvm исчезает из PATH при смене Node: это предупреждение,
 * а не отказ. Значение nvm default при установке не меняется.
 */
function nvmScoped(prefix: string, home: string, env: NodeJS.ProcessEnv): boolean {
  const nvmRoot = absolutePath(env.NVM_DIR) ?? path.join(path.resolve(home), '.nvm');
  const versions = path.join(nvmRoot, 'versions', 'node');

  return isInside(prefix, versions) && path.resolve(prefix) !== path.resolve(versions);
}

/**
 * Политика одна для любого происхождения effective prefix: внешний writable P
 * используется как есть, недоступный P даёт заранее выбранный `HOME/.local`,
 * внутренний или относительный P — отказ. Fallback проверяется тем же правилом
 * и не меняется после начала установки.
 */
export async function selectInstallPrefix(input: {
  runtime: ExternalInstallRuntime;
  roots: InstallRoots;
  packageId: string;
  home: string;
  requested?: string | null;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<PrefixSelection> {
  const effective = input.requested ?? await readGlobalPrefix(input.runtime, {
    cwd: input.cwd ?? input.home,
    timeoutMs: input.timeoutMs ?? 10_000,
    signal: input.signal,
  });
  const normalized = typeof effective === 'string' ? effective.trim() : '';
  const warnings: ProviderInstallNotice[] = [];
  const primary = await validatePrefix(normalized, input);

  if (primary === 'invalid') {
    throw new InstallEnvironmentError('npm_prefix_invalid',
      'npm вернул недопустимый внешний prefix для установки CLI');
  }
  if (primary === 'ok') {
    const prefix = path.resolve(normalized);

    if (nvmScoped(prefix, input.home, input.runtime.env)) {
      warnings.push({
        code: 'npm_prefix_nvm_scoped',
        message: 'Каталог установки относится к версии Node из nvm и исчезнет из PATH при её смене',
      });
    }

    return {
      prefix,
      fallback: false,
      warnings,
    };
  }

  const fallback = path.join(path.resolve(input.home), '.local');
  const fallbackState = path.resolve(fallback) === path.resolve(normalized)
    ? 'unwritable' : await validatePrefix(fallback, input);

  if (fallbackState !== 'ok') {
    throw new InstallEnvironmentError('npm_prefix_unwritable',
      'Ни npm-prefix, ни пользовательский ~/.local недоступны для записи');
  }

  return {
    prefix: fallback,
    fallback: true,
    warnings,
  };
}

/**
 * JavaScript проверяется выбранным внешним Node, нативный Linux ELF — прямым запуском.
 * Формат определяется по первым байтам: npm-bin может называться .exe и на Linux.
 */
export async function externalVersion(runtime: ExternalInstallRuntime, binary: string):
  Promise<string | null> {
  try {
    const handle = await fs.open(binary, 'r');
    const magic = Buffer.alloc(4);

    try {
      await handle.read(magic, 0, magic.length, 0);
    } finally {
      await handle.close();
    }

    const native = magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    const { stdout } = await execute(native ? binary : runtime.node,
      native ? ['--version'] : [binary, '--version'], {
        cwd: runtime.home,
        env: runtime.env,
        timeout: 30_000,
        maxBuffer: 64 * 1024,
      });

    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Обычный пакет ставится как `<имя>@latest`. Локальный путь или file:-спецификация
 * устанавливаются как есть: так офлайн-стенд доказывает настоящую npm-границу,
 * не получая production-переключателя подмены пакета из HTTP.
 */
export function npmPackageSpec(packageId: string): string {
  return packageId.startsWith('/') || packageId.startsWith('./') || packageId.startsWith('../')
    || packageId.startsWith('file:') ? packageId : `${packageId}@latest`;
}

/**
 * Аргументы установки всегда несут явный prefix, поэтому npm не может выбрать
 * другой глобальный каталог из окружения или собственного config.
 */
export function npmInstallArgs(packageId: string, prefix: string): string[] {
  return ['i', '-g', npmPackageSpec(packageId), '--prefix', prefix];
}

/**
 * Команда preview эквивалентна argv: тот же пакет, явный prefix и POSIX-quoting.
 * Она показывается человеку и не является источником argv или окружения процесса.
 */
export function npmInstallCommandText(executable: string, packageId: string, prefix: string): string {
  return [shellQuote(executable), 'i', '-g', shellQuote(npmPackageSpec(packageId)),
    '--prefix', shellQuote(prefix)].join(' ');
}
