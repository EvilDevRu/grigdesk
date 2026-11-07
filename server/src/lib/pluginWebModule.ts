import type { PluginWebModule } from '../../../shared/plugins/pluginsContracts.ts';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import type { ResolvedPluginWebModule } from '../../../packages/plugin-types/src/manifest.ts';
import { pluginResourcePath } from './pluginAssets.ts';
import { isRecord } from '../../../shared/lib/objects.ts';

export type { ResolvedPluginWebModule } from '../../../packages/plugin-types/src/manifest.ts';

type NormalizePath = (raw: unknown, rootAllowed: boolean) => string | null;

/**
 * Объявление называет только обычные файлы в собственном подкаталоге пакета.
 * Нормализатор общий со scanner/installer; неподдерживаемые языки не подключаются.
 */
export function resolvePluginWebModule(
  root: string,
  id: string,
  raw: unknown,
  normalize: NormalizePath,
  warn: (message: string) => void,
): ResolvedPluginWebModule | null {
  if (raw == null) {
    return null;
  }

  try {
    if (!isRecord(raw)) {
      throw new Error('entrypoints.web должен быть объектом');
    }

    const dirPath = modulePath(raw.dir, normalize);
    const dir = path.join(root, dirPath);
    const entry = modulePath(raw.entry, normalize);
    const background = raw.background === undefined ? undefined : modulePath(raw.background, normalize);

    if (!/\.m?js$/u.test(entry) || background !== undefined && !/\.m?js$/u.test(background)
      || !ordinaryPath(root, dirPath, true)) {
      throw new Error('неверная папка или расширение entry/background');
    }
    if (raw.css != null && !Array.isArray(raw.css)
      || raw.locales != null && !isRecord(raw.locales)) {
      throw new Error('неверный список CSS или языков');
    }

    const css = (raw.css ?? []).map((item: unknown) => modulePath(item, normalize));
    const locales: PluginWebModule['locales'] = {};

    for (const language of ['ru', 'en'] as const) {
      if (isRecord(raw.locales) && raw.locales[language] != null) {
        locales[language] = modulePath(raw.locales[language], normalize);
      }
    }

    const files = [
      entry,
      ...(background === undefined ? [] : [background]),
      ...css,
      ...Object.values(locales),
    ];

    if (!files.every((file) => ordinaryPath(dir, file))) {
      throw new Error('ресурс отсутствует или содержит ссылку');
    }

    const prefix = `/api/ext/${id}/module/`;
    const url = (file: string) => prefix + file.split('/').map(encodeURIComponent).join('/');

    return {
      dir,
      entry: url(entry),
      ...(background === undefined ? {} : { background: url(background) }),
      css: css.map(url),
      locales: Object.fromEntries(Object.entries(locales).map(([language, file]) => [language, url(file)])),
    };
  } catch (error) {
    warn(`entrypoints.web пропущен: ${(error as Error).message}`);

    return null;
  }
}

/**
 * Дополнительные ограничения URL применяются до файловой нормализации.
 * Скрытые компоненты и схемы нельзя превратить в адрес исполняемого ресурса.
 */
function modulePath(raw: unknown, normalize: NormalizePath): string {
  pluginResourcePath(raw);

  const normalized = normalize(raw, false);

  if (!normalized || typeof raw !== 'string' || /[:?#]/u.test(raw)
    || raw.split('/').some((part) => part.startsWith('.'))) {
    throw new Error('нужен относительный путь без скрытых компонентов');
  }

  return normalized;
}

/**
 * Каждый компонент проверяется через lstat, поэтому ссылки не раскрываются.
 * Проверка вызывается и при scan, и синхронно перед каждой статической выдачей.
 */
function ordinaryPath(root: string, relative: string, directory = false): boolean {
  const parts = relative.split('/');
  let current = root;

  try {
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
      return false;
    }

    for (const [index, part] of parts.entries()) {
      if (!part || part.startsWith('.') || part === 'node_modules' || /[\\\x00-\x1f\x7f]/u.test(part)) {
        return false;
      }

      current = path.join(current, part);

      const stat = lstatSync(current);
      const needsDirectory = index < parts.length - 1 || directory;

      if (stat.isSymbolicLink() || (needsDirectory ? !stat.isDirectory() : !stat.isFile())) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Static ожидает синхронный boolean, а не Promise разрешения доступа.
 * Корень пакета никогда не публикуется: относительный путь считается от module.dir.
 */
export function pluginModuleStaticOptions(module: ResolvedPluginWebModule, id: string) {
  return {
    root: module.dir,
    prefix: `/api/ext/${id}/module/`,
    decorateReply: false,
    index: false as const,
    list: false as const,
    maxAge: 0,
    allowedPath: (pathname: string) => {
      try {
        return ordinaryPath(module.dir, decodeURIComponent(pathname).replace(/^\//u, ''));
      } catch {
        return false;
      }
    },
  };
}
