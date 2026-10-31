import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { isPlainRecord } from '../../../shared/lib/objects.ts';

export interface ManualBrowser {
  id: string;
  path: string;
  name: string;
}

/**
 * Settings содержат только bounded opaque ID и уже выбранный native путь.
 * Отсутствие executable сейчас не удаляет регистрацию с временно снятого диска.
 */
export function normalizeManualBrowserApps(value: unknown): ManualBrowser[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: ManualBrowser[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  const uuid = /^app:manual-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

  for (const row of value.slice(0, 4096)) {
    if (!isPlainRecord(row) || Object.keys(row).sort().join() !== 'id,name,path'
      || typeof row.id !== 'string' || !uuid.test(row.id)
      || typeof row.path !== 'string' || row.path.length > 4096 || row.path.includes('\0')
      || !path.isAbsolute(row.path) || path.normalize(row.path) !== row.path
      || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 160
      || ids.has(row.id) || paths.has(row.path)) {
      continue;
    }

    result.push({
      id: row.id,
      path: row.path,
      name: row.name
    });
    ids.add(row.id);
    paths.add(row.path);

    if (result.length === 32) {
      break;
    }
  }

  return result;
}

interface AppEntry {
  id: string;
  name: string;
  command: string;
  args: string[];
}

/**
 * Desktop Entry читается как данные, без исполнения Exec и shell-подстановок.
 * Повтор ключа считается повреждением записи, а секции действий пропускаются.
 */
function desktopEntry(text: string): Record<string, string> | null {
  let active = false;
  const fields: Record<string, string> = {};

  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith('[')) {
      active = line === '[Desktop Entry]';

      continue;
    }

    if (!active || !line.trim() || line.startsWith('#')) {
      continue;
    }

    const index = line.indexOf('=');

    if (index < 1) {
      return null;
    }

    const key = line.slice(0, index);

    if (Object.hasOwn(fields, key)) {
      return null;
    }

    fields[key] = line.slice(index + 1);
  }

  return fields;
}

/**
 * TryExec проверяется как имя файла или точный PATH-кандидат, без shell.
 * Пустой TryExec не требует дополнительной установленной программы.
 */
async function executable(value: string, searchPath: string): Promise<boolean> {
  if (!value) {
    return true;
  }

  const candidates = path.isAbsolute(value)
    ? [value] : searchPath.split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, value));

  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) {
        await access(candidate, constants.X_OK);

        return true;
      }
    } catch {
      // Следующий PATH-кандидат проверяется независимо от предыдущего.
    }
  }

  return false;
}

/**
 * Пользовательский desktop ID перекрывает системный даже при Hidden=true.
 * Ручной executable появляется только после выбора native-диалогом и проверки файла.
 */
export function createBrowserApps(options: {
  dataHome: string;
  dataDirs: string[];
  manual: ManualBrowser[];
  searchPath?: string;
  save?(): Promise<void>;
}) {
  const manual = options.manual;
  let registrationQueue = Promise.resolve();

  /**
   * Catalog пересобирается перед каждым запуском, чтобы удалённая запись не оживала из cache.
   * Наружу отдаётся ID и имя; Exec и локальные пути не становятся полями renderer.
   */
  async function catalog(): Promise<AppEntry[]> {
    const entries: AppEntry[] = [];
    const seen = new Set<string>();

    for (const root of [options.dataHome, ...options.dataDirs]) {
      const directory = path.join(root, 'applications');
      let files: string[];

      try {
        files = await readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }

        throw new Error('browser_catalog_unavailable');
      }

      for (const filename of files.sort().filter((name) => name.endsWith('.desktop')).slice(0, 5000)) {
        if (seen.has(filename)) {
          continue;
        }

        seen.add(filename);

        const file = path.join(directory, filename);
        const info = await stat(file).catch(() => null);

        if (!info?.isFile() || info.size > 65536) {
          continue;
        }

        const fields = desktopEntry(await readFile(file, 'utf8'));
        const types = fields?.MimeType?.split(';') ?? [];

        if (!fields || fields.Type !== 'Application' || fields.Hidden === 'true'
          || fields.NoDisplay === 'true' || !fields.Exec || !fields.Name
          || !types.some((type) => ['x-scheme-handler/http', 'x-scheme-handler/https'].includes(type))
          || !await executable(fields.TryExec ?? '', options.searchPath ?? process.env.PATH ?? '')) {
          continue;
        }

        entries.push({
          id: `app:${createHash('sha256').update(filename).digest('hex').slice(0, 32)}`,
          name: fields.Name.slice(0, 160),
          command: '/usr/bin/gio',
          args: ['launch', file],
        });
      }
    }

    for (const item of manual) {
      if (await executable(item.path, '')) {
        entries.push({
          id: item.id,
          name: item.name,
          command: item.path,
          args: []
        });
      }
    }

    return entries;
  }

  /**
   * Только native picker инициирует регистрацию; private array отделён от committed settings.
   * Повтор того же executable после full registry возвращает существующий ID без записи.
   */
  async function registerSelected(selected: string) {
    if (!options.save) {
      throw new Error('browser_app_registration_unavailable');
    }

    const file = await realpath(selected);

    if (!path.isAbsolute(file) || !await executable(file, '')) {
      throw new Error('browser_app_invalid');
    }

    const existing = manual.find((item) => item.path === file);

    if (existing) {
      return { id: existing.id, name: existing.name };
    }

    if (manual.length >= 32) {
      throw new Error('browser_app_limit');
    }

    const item = {
      id: `app:manual-${randomUUID()}`,
      path: file,
      name: path.basename(file).slice(0, 160),
    };

    if (normalizeManualBrowserApps([item]).length !== 1) {
      throw new Error('browser_app_invalid');
    }

    manual.push(item);

    try {
      await options.save();
    } catch (error) {
      manual.splice(manual.indexOf(item), 1);

      throw error;
    }

    return { id: item.id, name: item.name };
  }

  return {
    async list() {
      return (await catalog()).map(({ id, name }) => ({ id, name }));
    },
    async resolve(id: string) {
      const entry = (await catalog()).find((item) => item.id === id);

      return entry ? { command: entry.command, args: [...entry.args] } : null;
    },
    /**
     * Вторая регистрация не получает ID ещё не подтверждённой первой записи.
     * После отказа очереди повтор проверяет актуальный private registry заново.
     */
    registerManual(selected: string) {
      const pending = registrationQueue.then(() => registerSelected(selected));

      registrationQueue = pending.then(() => undefined, () => undefined);

      return pending;
    },
  };
}
