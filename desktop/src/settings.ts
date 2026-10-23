import { desktopText } from './locale.ts';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { FileHandle } from 'node:fs/promises';

import { locales } from '../../shared/i18n/catalogs.ts';

import { recordOrNull } from '../../shared/lib/objects.ts';

import { localOrigin } from './connection.ts';
import { normalizeSurfaceGeometry } from './surfaceGeometry.ts';
import { normalizeExitPreference } from './desktopExitPreference.ts';
import type { SurfaceGeometry } from './surfaceGeometry.ts';

import type { Connection } from './connection.ts';
import { normalizeProfile } from './profiles.ts';
import type { DesktopProfile } from './profiles.ts';

export type WindowState = {
  width: number;
  height: number;
  maximized: boolean;
};

export type DesktopSettings = {
  skipExitConfirmation?: boolean;
  uiLanguage?: string;
  version: 2;
  profiles: DesktopProfile[];
  selected: string | null;
  window: WindowState;
  surfaceWindows?: { task: SurfaceGeometry };
};

export const DEFAULT_WINDOW: Readonly<WindowState> = Object.freeze({
  width: 1280,
  height: 860,
  maximized: false,
});

const queues = new Map<string, Promise<void>>();

function dimension(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(10000, Math.max(600, Math.round(value)))
    : fallback;
}

/**
 * Настройка адреса хранит канонический origin, а не свободную строку URL.
 * Неподдерживаемый kind или адрес сбрасывает только подключение, сохраняя окно.
 */
function normalizedConnection(value: unknown): Connection | null {
  const connection = recordOrNull(value);

  if (connection?.kind !== 'local' || typeof connection.origin !== 'string') {
    return null;
  }

  const origin = connection.origin;

  if (origin !== 'http://127.0.0.1' && localOrigin(origin) !== origin) {
    return null;
  }

  return {
    kind: 'local',
    origin,
  };
}

/**
 * Настройки неподдерживаемой версии полностью заменяются безопасными значениями.
 * В поддерживаемой версии подключение и размеры проверяются независимо друг от друга.
 */
export function normalizeSettings(value: unknown): DesktopSettings {
  const settings = recordOrNull(value);
  const supported = settings?.version === 1 || settings?.version === 2;
  const window = supported ? recordOrNull(settings.window) : null;
  const profiles: DesktopProfile[] = [];
  let selected: string | null = null;

  if (settings?.version === 1) {
    const connection = normalizedConnection(settings.connection);

    if (connection) {
      profiles.push({
        id: 'local',
        name: 'Этот компьютер',
        kind: 'local',
        address: connection.origin,
        fp: null,
        port: 47101,
        createdAt: 0,
      });
      selected = 'local';
    }
  } else if (settings?.version === 2 && Array.isArray(settings.profiles)) {
    for (const candidate of settings.profiles) {
      const profile = normalizeProfile(candidate);

      if (profile && !profiles.some((item) => item.id === profile.id || item.port === profile.port)) {
        profiles.push(profile);
      }
    }

    selected = profiles.some((item) => item.id === settings.selected) ? settings.selected as string : null;
  }

  const taskWindow = supported
    ? normalizeSurfaceGeometry(recordOrNull(settings?.surfaceWindows)?.task)
    : null;

  return {
    ...(supported && normalizeExitPreference(settings.skipExitConfirmation)
      ? { skipExitConfirmation: true } : {}),
    ...(taskWindow ? { surfaceWindows: { task: taskWindow } } : {}),
    version: 2,
    ...(supported && (settings.uiLanguage === 'system'
      || locales.some((item) => item.id === settings.uiLanguage))
      ? { uiLanguage: settings.uiLanguage as string } : {}),
    profiles,
    selected,
    window: {
      width: dimension(window?.width, DEFAULT_WINDOW.width),
      height: dimension(window?.height, DEFAULT_WINDOW.height),
      maximized: typeof window?.maximized === 'boolean' ? window.maximized : false,
    },
  };
}

/**
 * Ошибка чтения не должна мешать запуску окна с настройками по умолчанию.
 * Содержимое повреждённого файла не попадает в сообщения пользователю.
 */
export async function readSettings(file: string): Promise<DesktopSettings> {
  try {
    return normalizeSettings(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch {
    return normalizeSettings(null);
  }
}

/**
 * Проверяет именно личный каталог назначения через lstat, не проходя по его ссылке.
 * Чужие или общедоступные каталоги отклоняются без изменения прав родителя.
 */
async function checkDestination(file: string): Promise<void> {
  const directory = path.dirname(file);

  await fs.mkdir(directory, {
    recursive: true,
    mode: 0o700,
  });

  const stat = await fs.lstat(directory);
  const uid = process.getuid?.();

  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || (uid !== undefined && stat.uid !== uid)) {
    throw new Error(desktopText('desktop.settingsDirectoryUnsafe'));
  }

  try {
    const target = await fs.lstat(file);

    if (!target.isFile() || (uid !== undefined && target.uid !== uid)) {
      throw new Error(desktopText('desktop.settingsFileUnsafe'));
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
}

/**
 * Готовит полный файл с закрытыми правами, затем атомарно заменяет прежнюю версию.
 * Очистка касается только temporary, который эта операция действительно создала.
 */
async function atomicWrite(file: string, content: string): Promise<void> {
  await checkDestination(file);

  const temporary = path.join(path.dirname(file), `${path.basename(file)}.tmp-${randomUUID()}`);
  let handle: FileHandle | undefined;
  let created = false;

  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    created = true;
    await handle.writeFile(content, 'utf8');
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
  } finally {
    await handle?.close().catch(() => undefined);

    if (created) {
      await fs.rm(temporary, { force: true });
    }
  }
}

/**
 * Сохранения одного пути выполняются последовательно и заменяют файл атомарно.
 * Собственные временные файлы удаляются также при отказе записи или переименования.
 */
export function writeSettings(file: string, settings: DesktopSettings): Promise<void> {
  const destination = path.resolve(file);
  const content = JSON.stringify(normalizeSettings(settings), null, 2) + '\n';
  const previous = queues.get(destination) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(() => atomicWrite(destination, content));

  queues.set(destination, pending);

  const release = () => {
    if (queues.get(destination) === pending) {
      queues.delete(destination);
    }
  };

  void pending.then(release, release);

  return pending;
}
