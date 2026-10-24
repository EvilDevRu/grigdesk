import type {
  PluginInstallRecord,
  PluginInstalledVersion,
  PluginSourceRef,
} from '../../../../shared/plugins/pluginInstallContracts.ts';
import { isRecord } from '../../../../shared/lib/objects.ts';
import { normalizePluginPackagePath } from '../pluginsRegistry.ts';
import { readPluginManifest } from './validatePackage.ts';

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
 * Sensitive показывает только эвристику путей, не аудит безопасности кода.
 * Manifest/сервер/dependencies важны даже внутри пользовательского web.
 */
export function sensitivePluginFile(
  file: string,
  webDir: string | null,
  moduleDirs: readonly string[] = [],
): boolean {
  const basename = file.split('/').at(-1) ?? '';

  if (moduleDirs.some((dir) => file.startsWith(`${dir}/`))) {
    return true;
  }

  if (['plugin.json', 'server.js', 'server.ts', 'package.json', 'package-lock.json'].includes(basename)) {
    return true;
  }

  return !(webDir && file.startsWith(`${webDir}/`))
    && !/^docs?\//iu.test(file) && !/\.(md|txt|rst)$/iu.test(file);
}

/**
 * Прежняя папка нужна только для подписи удалённых или перемещённых файлов модуля.
 * Повреждённая установленная копия не мешает принудительной замене и не исполняется.
 */
export async function installedWebModuleDir(directory: string): Promise<string | null> {
  try {
    const manifest = await readPluginManifest(directory);

    return manifest.api === 2 && isRecord(manifest.webModule)
      ? normalizePluginPackagePath(manifest.webModule.dir, false) : null;
  } catch {
    return null;
  }
}
