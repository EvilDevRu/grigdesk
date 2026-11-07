import { readInstallation, readInstalledPointer } from '../../shared/node/installedLayout.ts';
import { desktopText } from './locale.ts';
import { assertServerBinaryFile, recoverRuntimeSelection } from '../../server/src/lib/selectSeaServer.ts';
import { applyBuiltServer } from '../../server/src/lib/builtServerSelection.ts';
import { readTextOrNull } from '../../shared/node/files.ts';
import { verifySeaRuntime } from '../../shared/node/seaRuntime.ts';
import { packagedChildEnvironment } from '../../shared/node/packagedEnvironment.ts';
import { captureUserCliParent, USER_CLI_PARENT_KEY } from '../../shared/node/userCliParentEnvironment.ts';
import { discoverUserCliDirectories, type PackagedCliInput } from '../../shared/node/userCliPaths.ts';
import {
  decodePreparedRuntime,
  prepareServerBinary,
  probeServerBinary,
  releaseServerPreparation,
  type ServerBinaryProbeOptions,
  type PreparedServerRuntime,
} from '../../shared/node/serverBinaryRuntime.ts';

import { dataHome, dataPath, envFilePath } from '../../shared/runtime/dataHome.ts';
import { legacyRootProblem } from '../../shared/runtime/legacyBrand.ts';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  realpath,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { parseEnv, promisify } from 'node:util';

import {
  desktopRuntimePath,
  effectivePort,
  effectiveValue,
  parseRuntimeDescriptor,
  stopGraceMs,
} from '../../shared/desktop/desktopRuntime.ts';
import type { EnvMap } from '../../shared/desktop/desktopRuntime.ts';
import type { RuntimeDescriptor } from '../../shared/desktop/desktopRuntime.ts';
import { isNodeVersionSupported, MIN_NODE_VERSION } from '../../server/src/lib/nodeVersion.ts';
import { localOrigin } from './connection.ts';
import { cleanDesktopChildEnvironment } from './childEnvironment.ts';

export type RuntimeProblem = 'not_installed' | 'invalid' | 'root' | 'web' | 'node' | 'package';

export interface ServerRuntime {
  root: string;
  node: string;
  serverCommand: string;
  serverArgs: string[];
  port: number;
  origin: string;
  env: Record<string, string>;
  graceMs: number;
  logPath: string;
  uiReleasesDir: string;
  preparation?: PreparationHandle;
}

export type PreparedBinary = PreparedServerRuntime;

export interface PreparationHandle {
  token: string | null;
  packageId: string | null;
  release(): Promise<void>;
}

export type RuntimeInspection = Pick<ServerRuntime, 'origin' | 'port' | 'env'>;
type RuntimeFailure = { problem: RuntimeProblem; message: string };
type RuntimeLoadResult = { runtime: ServerRuntime } | { inspection: RuntimeInspection } | RuntimeFailure;

interface RuntimeLoadInput {
  env: EnvMap;
  home: string;
  deps: RuntimeDependencies;
  appDir?: string | null;
  bundledUi?: boolean;
  purpose?: 'inspect' | 'start';
}

export interface RuntimeDependencies {
  applyBuildSelection?(input: { env: EnvMap; home: string }): Promise<void>;
  readText(path: string): Promise<string | null>;
  exists(path: string, kind: 'file' | 'dir' | 'exec'): Promise<boolean>;
  nodeVersion(node: string): Promise<string | null>;
  checkRelease(root: string): Promise<boolean>;
  binaryRun?: ServerBinaryProbeOptions['run'];
  prepareBinary?(binary: string, env: EnvMap, run?: ServerBinaryProbeOptions['run']):
    Promise<PreparedBinary>;
  releasePreparation?(binary: string, prepared: PreparedBinary, env: EnvMap,
    run?: ServerBinaryProbeOptions['run']): Promise<void>;
}

const executeFile = promisify(execFile);



export const runtimeDependencies: RuntimeDependencies = {
  async applyBuildSelection(input) {
    await applyBuiltServer(input);
  },
  prepareBinary,
  releasePreparation,
  /**
   * Сверяет пакет настоящим SEA без запуска API и чтения папки данных.
   * Безопасное сообщение об отказе формирует загрузчик; вывод процесса не раскрывается.
   */
  async checkRelease(root) {
    try {
      await verifySeaRuntime(root, { mode: 'startup' });

      return true;
    } catch {
      return false;
    }
  },
  /**
   * Отсутствующий файл отличается от ошибки доступа или чтения.
   * Загрузчик сам переводит отказ в безопасную причину без содержимого настроек.
   */
  async readText(file) {
    if (path.basename(file) === 'runtime.json') {
      const parent = await stat(path.dirname(file)).catch(() => null);

      if (parent) {
        await recoverRuntimeSelection(file);
      }
    }

    return readTextOrNull(file);
  },
  /**
   * Проверяет вид объекта и доступ к исполняемому файлу до запуска.
   * Ошибка файловой системы закрывает проверку, не превращаясь в успешное наличие.
   */
  async exists(file, kind) {
    try {
      const info = await stat(file);

      if (kind === 'dir') {
        return info.isDirectory();
      }

      if (!info.isFile()) {
        return false;
      }

      if (kind === 'exec') {
        await access(file, constants.X_OK);
      }

      return true;
    } catch {
      return false;
    }
  },
  /**
   * Спрашивает версию именно у Node из описания установки с бюджетом пять секунд.
   * Отказ и зависание дают отсутствие версии для общей проверки совместимости.
   */
  async nodeVersion(node) {
    try {
      const result = await executeFile(node, ['-p', 'process.versions.node'], { timeout: 5000 });

      return result.stdout.trim();
    } catch {
      return null;
    }
  },
};

/**
 * Закрытый JSON подготовки связывает packageId и физические пути с выбранным ELF.
 * Ни сохранённый cache path, ни Node вне R не становятся командой окна.
 */
export function decodePreparedBinary(value: unknown, binary: string, expected?: string): PreparedBinary {
  const prepared = decodePreparedRuntime(value, expected ?? (value as PreparedBinary)?.packageId);

  if (prepared.installationBin !== path.dirname(binary)) {
    throw new Error(desktopText('desktop.preparationMismatch'));
  }

  return prepared;
}

/**
 * Снимает только prepare-владение координатора; путь ELF мог уже измениться A→B.
 * Команда ограничена по времени и не запускает API, helper или произвольный JavaScript.
 */
async function releasePreparation(
  binary: string,
  prepared: PreparedBinary,
  env: EnvMap,
  run?: ServerBinaryProbeOptions['run'],
): Promise<void> {
  await releaseServerPreparation(binary, {
    home: env.GRIGDESK_HOME!,
    packageId: prepared.packageId,
    token: prepared.preparationToken,
    timeoutMs: 10000,
    run,
  });
}

/**
 * Сначала читает metadata без D, затем закрепляет её packageId в prepare.
 * Все возвращённые пути проверяются физически; неудачная проверка снимает полученный lease.
 */
async function prepareBinary(
  binary: string,
  env: EnvMap,
  run?: ServerBinaryProbeOptions['run'],
): Promise<PreparedBinary> {
  await assertServerBinaryFile(binary);

  let raw: PreparedBinary | undefined;
  /**
   * Запоминает только закрытый prepare JSON для cleanup при отказе декодера.
   * Содержимое env и stderr не сохраняется и не выводится в диагностику окна.
   */
  const capture: ServerBinaryProbeOptions['run'] = async (file, args, options) => {
    const result = await (run ?? executeFile)(file, args, options);

    if (args.includes('--prepare')) {
      try {
        raw = JSON.parse(result.stdout);
      } catch {
        // Неразборчивый JSON не даёт полномочий снимать неизвестный lease.
        // Launcher сохраняет защиту консервативно до проверки kernel owner.
      }
    }

    return result;
  };
  const info = await probeServerBinary(binary, { run: capture });

  try {
    const prepared = decodePreparedBinary(await prepareServerBinary(binary, {
      home: env.GRIGDESK_HOME!,
      expectPackageId: info.packageId,
      timeoutMs: 120000,
      run: capture,
    }), binary, info.packageId);

    for (const file of [prepared.root, prepared.node, prepared.engine, prepared.installationBin]) {
      if (await realpath(file) !== file) {
        throw new Error(desktopText('desktop.preparationSymlink'));
      }
    }

    return prepared;
  } catch (error) {
    if (raw?.packageId === info.packageId && typeof raw?.preparationToken === 'string'
      && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(raw.preparationToken)) {
      await releasePreparation(binary, raw, env, run);
    }

    throw error;
  }
}

/**
 * Ветка v4 читает D из descriptor и готовит runtime отдельной командой ELF.
 * Discovery CLI выполняется один раз; каждый отказ после prepare освобождает handle.
 */
async function loadBinaryRuntime(
  input: RuntimeLoadInput,
  descriptor: Extract<RuntimeDescriptor, { version: 4 }>,
): Promise<RuntimeLoadResult> {
  let handle: PreparationHandle | undefined;

  try {
    const parent = { ...input.env, GRIGDESK_HOME: descriptor.home };
    const fileText = await input.deps.readText(envFilePath({ env: parent, home: input.home }));
    const dotenv: Record<string, string> = fileText === null ? {}
      : Object.fromEntries(Object.entries(parseEnv(fileText))
        .filter((entry): entry is [string, string] => entry[1] !== undefined));
    const problem = legacyRootProblem(parent) || legacyRootProblem(dotenv, true);

    if (problem) {
      throw new Error(problem);
    }

    const port = effectivePort(parent, dotenv);
    const origin = localOrigin(`http://127.0.0.1:${port}`);

    if (!origin) {
      throw new Error(desktopText('desktop.invalidPort'));
    }

    if (input.purpose === 'inspect') {
      return {
        inspection: {
          origin,
          port,
          env: parent,
        },
      };
    }

    const probeEnv = buildServerEnv({
      parent,
      dotenv,
      node: process.execPath,
      home: input.home,
      appDir: input.appDir,
      sea: true,
    });

    delete probeEnv.NODE_PATH;
    delete probeEnv.LD_PRELOAD;

    const prepared = decodePreparedBinary(
      await (input.deps.prepareBinary ?? prepareBinary)(
        descriptor.binary, probeEnv, input.deps.binaryRun,
      ), descriptor.binary,
    );
    let released: Promise<void> | undefined;

    handle = {
      token: prepared.preparationToken,
      packageId: prepared.packageId,
      release() {
        released ??= (input.deps.releasePreparation ?? releasePreparation)(
          descriptor.binary, prepared, probeEnv, input.deps.binaryRun,
        );

        return released;
      },
    };

    const cli = await discoverUserCliDirectories({
      env: probeEnv,
      home: input.home,
      dataHome: descriptor.home,
    });

    return {
      runtime: {
        root: prepared.root,
        node: prepared.node,
        serverCommand: descriptor.binary,
        serverArgs: [
          '--expect-package-id', prepared.packageId, '--preparation-token', prepared.preparationToken,
        ],
        port,
        origin,
        env: buildServerEnv({
          parent,
          dotenv,
          node: prepared.node,
          home: input.home,
          appDir: input.appDir,
          sea: true,
          cli: {
            ...cli,
            installationBin: prepared.installationBin,
            saved: descriptor.cliPaths,
          },
        }),
        graceMs: stopGraceMs(parent, dotenv),
        logPath: effectiveValue(parent, dotenv, 'GRIGDESK_LOG') || dataPath(descriptor.home, 'log'),
        uiReleasesDir: effectiveValue(parent, dotenv, 'GRIGDESK_UI_RELEASES_DIR')
          || dataPath(descriptor.home, 'uiReleases'),
        preparation: handle,
      },
    };
  } catch {
    await handle?.release();

    return { problem: 'package', message: desktopText('desktop.serverElfDamaged') };
  }
}

/**
 * Очищает объединённое окружение от упаковки, сохраняя приоритет родителя над файлом.
 * Сервер и VPN-ворота получают один PATH и маркер; исходные снимки не меняются.
 * Packaged-запуск с готовыми каталогами CLI строит PATH общим userCliPath; без них
 * прежние source и v3 сохраняют свой порядок байт в байт.
 * Каталог пакета — APPDIR окружения и appDir главного процесса: распакованный AppRun
 * вычисляет APPDIR, но не экспортирует его, а пути пакета в PATH всё равно дописывает.
 */
export function buildServerEnv(input: {
  parent: EnvMap;
  dotenv: Record<string, string>;
  node: string;
  home: string;
  appDir?: string | null;
  sea?: boolean;
  cli?: PackagedCliInput;
}): Record<string, string> {
  const inherited: Record<string, string> = Object.fromEntries(Object.entries({
    ...input.dotenv,
    ...input.parent,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const env = cleanDesktopChildEnvironment(inherited, input.appDir);

  env[USER_CLI_PARENT_KEY] = captureUserCliParent(inherited);

  // Packaged-сервер с готовыми каталогами CLI получает общий порядок в packagedChildEnvironment.
  if (!input.sea || !input.cli) {
    const entries = [
      path.join(input.home, '.kimi-code/bin'),
      path.join(input.home, '.local/bin'),
      path.dirname(input.node),
      ...(env.PATH?.split(':') ?? []),
    ];

    env.PATH = [...new Set(entries.filter(Boolean))].join(':');
  }

  env.GRIGDESK_DESKTOP_CHILD = '1';

  if (input.sea) {
    delete env.NODE_OPTIONS;

    return packagedChildEnvironment({
      node: input.node,
      env,
      home: input.home,
      cli: input.cli,
    });
  }

  return env;
}

/**
 * Проверяет описание установки через явные порты файлов и версии Node.
 * Проблема установки запрещает только свой запуск, подключение к внешнему серверу остаётся возможным.
 */
export function loadServerRuntime(input: RuntimeLoadInput & { purpose: 'inspect' }):
  Promise<{ inspection: RuntimeInspection } | RuntimeFailure>;

export function loadServerRuntime(input: RuntimeLoadInput & { purpose?: 'start' }):
  Promise<{ runtime: ServerRuntime } | RuntimeFailure>;

/**
 * Проверяет descriptor через явные файловые порты и выбранную цель загрузки.
 * Inspect не выдаёт spawn-ready runtime, start передаёт владение preparation handle.
 */
export async function loadServerRuntime(input: RuntimeLoadInput): Promise<RuntimeLoadResult> {
  const descriptorPath = desktopRuntimePath(input);
  let text: string | null;

  try {
    await input.deps.applyBuildSelection?.({ env: input.env, home: input.home });
    text = await input.deps.readText(descriptorPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code?.startsWith('server_selection_')) {
      return { problem: 'invalid', message: desktopText('desktop.serverSelectionIncomplete', { code }) };
    }

    text = '';
  }

  if (text === null) {
    return {
      problem: 'not_installed',
      message: desktopText('desktop.serverNotInstalled'),
    };
  }

  const descriptor = parseRuntimeDescriptor(text);

  if (!descriptor) {
    return {
      problem: 'invalid',
      message: desktopText('desktop.serverDescriptorDamaged', { path: descriptorPath }),
    };
  }

  if (descriptor.version === 5) {
    try {
      const receipt = await readInstallation(descriptor.root);
      const current = await readInstalledPointer(receipt);

      if (receipt.installationId !== descriptor.installationId || receipt.mode !== 'local'
        || receipt.dataHome !== descriptor.home || !current.server) {
        throw new Error(desktopText('desktop.serverNotPrepared'));
      }

      return loadBinaryRuntime(input, {
        version: 4,
        kind: 'binary',
        binary: path.join(receipt.root, current.server, 'bin/grigdesk-server'),
        home: receipt.dataHome,
        cliPaths: [path.join(receipt.root, current.server, 'bin')],
      });
    } catch {
      return { problem: 'invalid', message: desktopText('desktop.serverNotPrepared') };
    }
  }

  if (descriptor.version === 4) {
    return loadBinaryRuntime(input, descriptor);
  }

  const { root } = descriptor;
  const sea = descriptor.version === 3;
  const node = descriptor.version === 3 ? path.join(root, 'runtime/node/bin/node') : descriptor.node;
  const serverCommand = sea ? path.join(root, 'server/grigdesk-server') : node;
  const serverArgs = sea ? [] : [path.join(root, 'server/src/app.ts')];
  const required: [string, 'file' | 'dir' | 'exec'][] = sea ? [
    ['release.json', 'file'],
    ['server/grigdesk-server', 'exec'],
    ['runtime/node/bin/node', 'exec'],
    ['server/node_modules', 'dir'],
    ['deploy/require-vpn.sh', 'file'],
  ] : [
    ['server/src/app.ts', 'file'],
    ['server/node_modules', 'dir'],
    ['deploy/require-vpn.sh', 'file'],
  ];

  for (const [relative, kind] of required) {
    if (!await input.deps.exists(path.join(root, relative), kind)) {
      return {
        problem: 'root',
        message: desktopText('desktop.runtimeFileMissing', { root, relative }),
      };
    }
  }

  if (sea && !await input.deps.checkRelease(root)) {
    return { problem: 'package', message: desktopText('desktop.serverPackageDamaged', { root }) };
  }

  const parent = descriptor.version !== 1 ? { ...input.env, GRIGDESK_HOME: descriptor.home } : input.env;
  let envPath: string;
  let selectedHome: string;

  try {
    const problem = legacyRootProblem(parent);

    if (problem) {
      throw new Error(problem);
    }

    selectedHome = dataHome({ env: parent, home: input.home });
    envPath = envFilePath({ env: parent, home: input.home });
  } catch (error) {
    return { problem: 'invalid', message: (error as Error).message };
  }

  let dotenv: Record<string, string>;

  try {
    const fileText = await input.deps.readText(envPath);

    dotenv = fileText === null ? {} : Object.fromEntries(Object.entries(parseEnv(fileText))
      .filter((entry): entry is [string, string] => entry[1] !== undefined));
  } catch {
    return {
      problem: 'invalid',
      message: desktopText('desktop.serverSettingsUnreadable', { path: envPath }),
    };
  }

  const problem = legacyRootProblem(dotenv, true);

  if (problem) {
    return {
      problem: 'invalid',
      message: problem,
    };
  }

  const dist = effectiveValue(input.env, dotenv, 'GRIGDESK_WEB_DIST') || path.join(root, 'web/dist');
  const index = path.join(dist, 'index.html');

  if (!sea && !input.bundledUi && !await input.deps.exists(index, 'file')) {
    return {
      problem: 'web',
      message: desktopText('desktop.interfaceMissing', { path: index }),
    };
  }

  if (!sea) {
    const version = await input.deps.exists(node, 'exec') ? await input.deps.nodeVersion(node) : null;

    if (!version || !isNodeVersionSupported(version)) {
      return {
        problem: 'node',
        message: desktopText('desktop.unsupportedNode', {
          node,
          minimum: MIN_NODE_VERSION.split('.').slice(0, 2).join('.'),
          required: MIN_NODE_VERSION,
        }),
      };
    }
  }

  const port = effectivePort(input.env, dotenv);
  const origin = localOrigin(`http://127.0.0.1:${port}`);

  if (!origin) {
    return {
      problem: 'invalid',
      message: desktopText('desktop.invalidPortValue', { port: String(port) }),
    };
  }

  if (input.purpose === 'inspect') {
    return {
      inspection: {
        origin,
        port,
        env: buildServerEnv({
          parent,
          dotenv,
          node,
          home: input.home,
          appDir: input.appDir,
          sea,
        }),
      },
    };
  }

  return {
    runtime: {
      root,
      node,
      serverCommand,
      serverArgs,
      port,
      origin,
      env: buildServerEnv({
        parent,
        dotenv,
        node,
        home: input.home,
        appDir: input.appDir,
        sea,
      }),
      graceMs: stopGraceMs(input.env, dotenv),
      logPath: effectiveValue(input.env, dotenv, 'GRIGDESK_LOG')
        || dataPath(selectedHome, 'log'),
      uiReleasesDir: effectiveValue(input.env, dotenv, 'GRIGDESK_UI_RELEASES_DIR')
        || dataPath(selectedHome, 'uiReleases'),
      preparation: {
        token: null,
        packageId: null,
        release: async () => {},
      },
    },
  };
}
