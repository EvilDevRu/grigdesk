import type {
  PluginInstallRecord,
  PluginInstalledVersion,
  PluginSourceRef,
} from '../../../../shared/plugins/pluginInstallContracts.ts';
import { isRecord } from '../../../../shared/lib/objects.ts';
import { normalizePluginPackagePath } from '../pluginsRegistry.ts';
import { readPluginManifest } from './validatePackage.ts';
import type { PackageKind } from './packagePolicy.ts';

/**
 * Previous удерживает самодостаточную версию без mutable bookkeeping current.
 * Откат возвращает эти поля, включая source, npmDirs и installedAt.
 */
export function installedSnapshot(record: PluginInstallRecord): PluginInstalledVersion {
  return {
    source: structuredClone(record.source),
    version: record.version,
    tag: record.tag,
    sha: record.sha,
    installedAt: record.installedAt,
    payloadDigest: record.payloadDigest,
    gitConfigDigest: record.gitConfigDigest,
    npmDirs: [...record.npmDirs],
  };
}

/**
 * Source identity включает kind: одинаковый URL не означает ту же стратегию.
 * Проверка используется preview и CAS публикации результатов сети.
 */
export function sameSource(left: PluginSourceRef, right: PluginSourceRef): boolean {
  return left.kind === right.kind && left.url === right.url;
}

/**
 * Чувствительность ограничена объявленным кодом и метаданными пакета, без аудита содержимого.
 * Прежние и новые пути сервера и модуля учитываются вместе при обновлении или удалении.
 */
export function sensitivePluginFile(
  file: string,
  moduleDirs: readonly string[] = [],
  serverEntries: readonly string[] = [],
): boolean {
  const basename = file.split('/').at(-1) ?? '';

  if (serverEntries.includes(file)) {
    return true;
  }

  if (moduleDirs.some((dir) => file.startsWith(`${dir}/`))) {
    return true;
  }

  return ['plugin.json', 'engine.json', 'package.json', 'package-lock.json'].includes(basename);
}

/**
 * Прежняя папка нужна только для подписи удалённых или перемещённых файлов модуля.
 * Повреждённая установленная копия не мешает принудительной замене и не исполняется.
 */
export async function installedWebModuleDir(directory: string): Promise<string | null> {
  try {
    const manifest = await readPluginManifest(directory);

    const entries = manifest.entrypoints;

    return isRecord(entries) && isRecord(entries.web)
      ? normalizePluginPackagePath(entries.web.dir, false) : null;
  } catch {
    return null;
  }
}

/**
 * Прежний серверный путь остаётся чувствительным даже после его удаления из нового манифеста.
 * Чтение метаданных не импортирует код и не запрещает замену повреждённого пакета.
 */
export async function installedServerEntry(
  directory: string, kind: PackageKind = 'plugin',
): Promise<string | null> {
  try {
    const manifest = await readPluginManifest(directory, kind);

    if (kind === 'db-engine') {
      return normalizePluginPackagePath(manifest.entry, false);
    }

    const entries = manifest.entrypoints;

    return isRecord(entries) ? normalizePluginPackagePath(entries.server, false) : null;
  } catch {
    return null;
  }
}
