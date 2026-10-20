export type ServerBinaryMode = 'run' | 'help' | 'version' | 'license' | 'runtime-info'
  | 'prepare' | 'verify' | 'release-preparation' | 'cache-prune';

export type ServerBinaryArgs = {
  mode: ServerBinaryMode;
  json: boolean;
  expectPackageId?: string;
  preparationToken?: string;
  packageId?: string;
} | {
  mode: 'error';
  message: string;
};

const modes = new Map<string, ServerBinaryMode>([
  ['--help', 'help'],
  ['--version', 'version'],
  ['--license', 'license'],
  ['--runtime-info', 'runtime-info'],
  ['--prepare', 'prepare'],
  ['--check-startup', 'prepare'],
  ['--verify', 'verify'],
  ['--check-runtime', 'verify'],
  ['--release-preparation', 'release-preparation'],
  ['--cache-prune', 'cache-prune'],
]);
const hashPattern = /^[a-f0-9]{64}$/u;
const tokenPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;

/**
 * Разбирает закрытую таблицу CLI до доступа к окружению и файловой системе.
 * Взаимоисключающие режимы и дубли флагов не допускают частичных эффектов запуска.
 */
export function parseServerBinaryArgs(argv: readonly string[]): ServerBinaryArgs {
  let selected: ServerBinaryMode | undefined;
  let json = false;
  let expectPackageId: string | undefined;
  let preparationToken: string | undefined;
  let packageId: string | undefined;
  const seen = new Set<string>();
  const error = (): ServerBinaryArgs => ({
    mode: 'error',
    message: 'Неверные или несовместимые аргументы сервера GrigDesk',
  });

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;

    if (seen.has(flag)) {
      return error();
    }

    seen.add(flag);

    const mode = modes.get(flag);

    if (mode !== undefined) {
      if (selected !== undefined) {
        return error();
      }

      selected = mode;

      if (mode !== 'release-preparation') {
        continue;
      }
    } else if (flag === '--json') {
      json = true;
      continue;
    } else if (!['--expect-package-id', '--preparation-token', '--package-id'].includes(flag)) {
      return error();
    }

    const value = argv[++index];
    const token = flag === '--preparation-token' || flag === '--release-preparation';

    if (value === undefined || !(token ? tokenPattern : hashPattern).test(value)) {
      return error();
    }

    if (flag === '--expect-package-id') {
      expectPackageId = value;
    } else if (flag === '--package-id') {
      packageId = value;
    } else {
      preparationToken = value;
    }
  }

  const mode = selected ?? 'run';
  const aliasJson = seen.has('--check-startup') || seen.has('--check-runtime');
  const requiresJson = ['runtime-info', 'prepare', 'release-preparation', 'cache-prune'].includes(mode);

  if ((requiresJson && !json && !aliasJson) || (json && ['run', 'help', 'license'].includes(mode))) {
    return error();
  }

  if (expectPackageId !== undefined && !['run', 'prepare', 'verify'].includes(mode)) {
    return error();
  }

  if (mode === 'release-preparation') {
    if (packageId === undefined || preparationToken === undefined || seen.has('--preparation-token')) {
      return error();
    }
  } else if (packageId !== undefined
    || (preparationToken !== undefined && (mode !== 'run' || expectPackageId === undefined))) {
    return error();
  }

  return {
    mode,
    json: json || aliasJson,
    ...(expectPackageId === undefined ? {} : { expectPackageId }),
    ...(preparationToken === undefined ? {} : { preparationToken }),
    ...(packageId === undefined ? {} : { packageId }),
  };
}
