import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { userCliPath } from '../../../shared/node/cliPathOrder.ts';
import { darwinFactoryToolEnvironment } from '../../../shared/node/processIdentity.ts';

const execute = promisify(execFile);
const homebrewRoot = '/opt/homebrew';
const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin';
export const darwinEngineFormulas = [
  ['bash', 'bin', ['bash']],
  ['coreutils', 'libexec/gnubin', ['timeout', 'date', 'stat', 'realpath', 'sha256sum']],
  ['gnu-sed', 'libexec/gnubin', ['sed']],
  ['findutils', 'libexec/gnubin', ['find', 'xargs']],
  ['grep', 'libexec/gnubin', ['grep']],
  ['jq', 'bin', ['jq']],
  ['flock', 'bin', ['flock']],
  // Homebrew ставит python3 в bin формулы; libexec/bin несёт только неверсионные
  // python/pip-симлинки, поэтому python3 там отсутствует (python@3.15+).
  ['python', 'bin', ['python3']],
] as const;

export type MacEngineTool = typeof darwinEngineFormulas[number][2][number] | 'brew'
  | 'process-identity' | 'setsid';

const macEngineTools = new Set<unknown>([
  'brew', 'process-identity', 'setsid',
  ...darwinEngineFormulas.flatMap(([, , names]): readonly MacEngineTool[] => names),
]);

/**
 * Принимает только ошибки подготовки и известные имена инструментов.
 * Значение пригодно для ответа клиенту без раскрытия локальных путей и argv.
 */
export function macEngineDependency(error: unknown): MacEngineTool | null {
  const failure = error as { code?: unknown; tool?: unknown } | null;

  return failure?.code === 'macos_engine_dependency_missing' && macEngineTools.has(failure.tool)
    ? failure.tool as MacEngineTool : null;
}

function missing(tool: MacEngineTool, cause?: unknown) {
  return Object.assign(new Error(`Для конвейера macOS требуется «${tool}».`, { cause }), {
    code: 'macos_engine_dependency_missing', tool,
  });
}

/**
 * Проверяет физическую исполняемую копию формулы. Чтение не обращается
 * к PATH процесса и не требует запускать Homebrew на каждом захвате lock.
 */
async function checkedBrewTool(directory: string, tool: MacEngineTool): Promise<string> {
  const physical = await realpath(path.join(directory, tool));

  if (!physical.startsWith(`${homebrewRoot}/Cellar/`) || !(await stat(physical)).isFile()) {
    throw new Error('factory_brew_tool_invalid');
  }

  await access(physical, constants.X_OK);

  return physical;
}

/**
 * Серверные блокировки работают и из LaunchAgent с системным PATH.
 * Установленный flock ищется только в закреплённом каталоге формулы.
 */
export async function resolveDarwinFlock(): Promise<string> {
  try {
    const executable = await checkedBrewTool(`${homebrewRoot}/opt/flock/bin`, 'flock');

    if (!executable.startsWith(`${homebrewRoot}/Cellar/flock/`)) {
      throw new Error('factory_brew_tool_invalid');
    }

    return executable;
  } catch (error) {
    throw missing('flock', error);
  }
}

/**
 * Проверяет программы по отдельности в физическом дереве Homebrew.
 * Имя недоступной формулы сохраняется как диагноз без локального пути.
 */
async function brewToolsDirectory(formula: string, subdirectory: string,
  commands: readonly MacEngineTool[]): Promise<string> {
  let tool = commands[0]!;

  try {
    const result = await execute(`${homebrewRoot}/bin/brew`, ['--prefix', formula], {
      timeout: 5000,
      maxBuffer: 4096,
      env: {
        HOME: process.env.HOME,
        PATH: systemPath,
        HOMEBREW_NO_AUTO_UPDATE: '1',
      },
    });
    const prefix = result.stdout.trim();
    const alias = formula === 'python' && /^\/opt\/homebrew\/opt\/python@\d+\.\d+$/u.test(prefix);

    if (prefix !== `${homebrewRoot}/opt/${formula}` && !alias) {
      throw new Error('factory_brew_prefix_invalid');
    }

    const directory = path.join(prefix, subdirectory);

    for (const command of commands) {
      tool = command;
      await checkedBrewTool(directory, command);
    }

    return directory;
  } catch (error) {
    throw missing(tool, error);
  }
}

/**
 * Готовит окружение до spawn дочерней фабрики и только для её процесса.
 * Закреплённые Homebrew-пути идут перед системными и пользовательскими CLI.
 */
export async function prepareDarwinFactoryEnvironment(input: {
  root: string;
  packaged: boolean;
  controlRoot: string;
  node: string;
  env?: NodeJS.ProcessEnv;
}): Promise<Record<string, string>> {
  const environment = input.env ?? process.env;
  const tools = await darwinFactoryToolEnvironment(input, environment)
    .catch((cause) => {
      const tool = (cause as { tool?: unknown } | null)?.tool === 'setsid' ? 'setsid' : 'process-identity';

      throw missing(tool, cause);
    });

  await access(`${homebrewRoot}/bin/brew`, constants.X_OK).catch((cause) => {
    throw missing('brew', cause);
  });

  const [bash, ...directories] = await Promise.all(darwinEngineFormulas.map(
    ([formula, directory, commands]) => brewToolsDirectory(formula, directory, commands)));
  const PATH = userCliPath({
    installationBin: bash!,
    bundledNode: input.node,
    explicit: directories,
    saved: [],
    defaults: [],
    inherited: `${systemPath}:${environment.GRIGDESK_CLI_PATH ?? ''}`,
    discovered: [],
  });

  return {
    ...tools,
    PATH,
    FACTORY_DARWIN_BASH: path.join(bash!, 'bash'),
    FACTORY_DARWIN_TIMEOUT: path.join(directories[0]!, 'timeout'),
    FACTORY_CONTROL_ROOT: input.controlRoot,
    NODE_BIN: input.node,
  };
}
