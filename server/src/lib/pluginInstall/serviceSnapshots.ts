import type {
  PluginInstallRecord,
  PluginInstalledVersion,
  PluginSourceRef,
} from '../../../../shared/plugins/pluginInstallContracts.ts';

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
export function sensitivePluginFile(file: string, webDir: string | null): boolean {
  const basename = file.split('/').at(-1) ?? '';

  if (['plugin.json', 'server.js', 'package.json', 'package-lock.json'].includes(basename)) {
    return true;
  }

  return !(webDir && file.startsWith(`${webDir}/`))
    && !/^docs?\//iu.test(file) && !/\.(md|txt|rst)$/iu.test(file);
}
