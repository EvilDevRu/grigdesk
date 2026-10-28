import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  desktopRuntimePath,
  parseRuntimeDescriptor,
  type EnvMap,
  type RuntimeDescriptor,
} from '../../../shared/desktop/desktopRuntime.ts';
import { readTextOrNull, syncDirectory } from '../../../shared/node/files.ts';
import { sha256File } from '../../../shared/node/hash.ts';
import { dataHome } from '../../../shared/runtime/dataHome.ts';
import {
  assertDataIdle,
  assertServerBinaryFile,
  selectSeaServer,
  withRuntimeSelectionLock,
  type SelectSeaServerInput,
} from './selectSeaServer.ts';

interface SelectionInput {
  env: EnvMap;
  home: string;
}

interface BuiltSelection {
  format: 1;
  root: string;
  binary: string;
  sha256: string;
  home: string;
  previous: string;
}

/**
 * Автопривязка ограничена этой копией исходников и её собственным release/.
 * Другая установка и другая папка данных сохраняют явно выбранный человеком сервер.
 */
function belongsToBuild(descriptor: RuntimeDescriptor, root: string, selectedHome: string): boolean {
  if (descriptor.version !== 1 && descriptor.home !== selectedHome) {
    return false;
  }

  if (descriptor.version === 4) {
    return [path.join(root, 'bin/grigdesk-server'), path.join(root, 'release/bin/grigdesk-server')]
      .includes(descriptor.binary);
  }

  return descriptor.root === root
    || descriptor.version === 3 && descriptor.root === path.join(root, 'release');
}

/**
 * Файл намерения приватный и ограниченный: ссылки, чужой владелец и лишние поля запрещены.
 * Отсутствие очереди штатно, повреждение остаётся видимым отказом запуска.
 */
async function readBuildSelection(file: string): Promise<{ text: string; value: BuiltSelection } | null> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null;
      }

      throw error;
    });

  if (!handle) {
    return null;
  }

  try {
    const info = await handle.stat();

    if (!info.isFile() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o600
      || info.size > 256 * 1024) {
      throw new Error('Некорректный файл отложенного выбора сервера.');
    }

    const text = await handle.readFile('utf8');
    const value = JSON.parse(text) as BuiltSelection;
    const absolute = (item: unknown): item is string => typeof item === 'string'
      && path.isAbsolute(item) && !item.includes('\0');

    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'binary,format,home,previous,root,sha256'
      || value.format !== 1 || !absolute(value.root) || !absolute(value.binary) || !absolute(value.home)
      || value.binary !== path.join(value.root, 'bin/grigdesk-server')
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)
      || typeof value.previous !== 'string') {
      throw new Error('Некорректный файл отложенного выбора сервера.');
    }

    const previous = parseRuntimeDescriptor(value.previous);

    if (!previous || !belongsToBuild(previous, value.root, value.home)) {
      throw new Error('Отложенный выбор не относится к этой установке.');
    }

    return { text, value };
  } finally {
    await handle.close();
  }
}

/**
 * Вызывается только после успешной установки всех компонентов полной сборки.
 * Primary и живой сервер остаются прежними; намерение публикуется атомарно под общим lock.
 */
export async function queueBuiltServer(input: SelectionInput & { root: string }):
  Promise<'queued' | 'current' | 'foreign'> {
  const root = await realpath(input.root);
  const binary = path.join(root, 'bin/grigdesk-server');
  const selectedHome = dataHome(input);
  const runtimePath = desktopRuntimePath(input);
  const directory = path.dirname(runtimePath);

  if (!await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  })) {
    return 'foreign';
  }

  return withRuntimeSelectionLock(runtimePath, async () => {
    const previous = await readTextOrNull(runtimePath);
    const descriptor = previous === null ? null : parseRuntimeDescriptor(previous);

    if (!descriptor || !belongsToBuild(descriptor, root, selectedHome)) {
      return 'foreign';
    }

    if (descriptor.version === 4 && descriptor.binary === binary) {
      return 'current';
    }

    await assertServerBinaryFile(binary);

    const file = `${runtimePath}.build-selection`;
    const temporary = `${file}.${randomUUID()}.tmp`;
    const value: BuiltSelection = {
      format: 1,
      root,
      binary,
      sha256: await sha256File(binary),
      home: selectedHome,
      previous: previous!,
    };

    try {
      const handle = await open(temporary, 'wx', 0o600);

      try {
        await handle.writeFile(JSON.stringify(value) + '\n');
        await handle.sync();
      } finally {
        await handle.close();
      }

      await rename(temporary, file);
      await syncDirectory(directory);
    } finally {
      await rm(temporary, { force: true });
    }

    return 'queued';
  });
}

/**
 * Перед загрузкой runtime применяется только намерение с неизменившимся primary.
 * Живой сервер откладывает выбор; verify, CAS, backup и восстановление выполняет общий selector.
 */
export async function applyBuiltServer(input: SelectionInput & {
  verifyBinary?: SelectSeaServerInput['verifyBinary'];
  select?: typeof selectSeaServer;
}): Promise<boolean> {
  const runtimePath = desktopRuntimePath(input);
  const file = `${runtimePath}.build-selection`;

  if (!await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  })) {
    return false;
  }

  try {
    const pending = await withRuntimeSelectionLock(runtimePath, async () => {
      const queued = await readBuildSelection(file);

      if (!queued) {
        return null;
      }

      const previous = parseRuntimeDescriptor(queued.value.previous)!;
      const selectedHome = previous.version === 1 ? dataHome(input) : previous.home;

      if (selectedHome !== queued.value.home
        || await readTextOrNull(runtimePath) !== queued.value.previous) {
        await rm(file);
        await syncDirectory(path.dirname(file));

        return null;
      }

      await assertDataIdle(queued.value.home);

      return queued;
    });

    if (!pending) {
      return false;
    }

    await (input.select ?? selectSeaServer)({
      root: pending.value.binary,
      env: { ...input.env, GRIGDESK_HOME: pending.value.home },
      home: input.home,
      windowVersion: 4,
      expectedPrevious: pending.value.previous,
      expectedBuildSelection: pending.text,
      expectedBinarySha256: pending.value.sha256,
      verifyBinary: input.verifyBinary,
    });

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'server_selection_data_busy') {
      return false;
    }

    throw Object.assign(new Error('Не удалось применить сервер полной сборки.', { cause: error }), {
      code: 'server_selection_build_failed',
    });
  }
}
