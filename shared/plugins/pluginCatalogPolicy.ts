import type { PluginSourceRef } from './pluginInstallContracts.ts';
import type {
  CatalogDetail, CatalogIndex, CatalogPlugin, CatalogState, CatalogVersion,
} from './pluginCatalogContracts.ts';

export type SourceMembership = 'official' | 'community' | 'external' | 'unverified' | 'manual';
export interface CatalogInstalled {
  id: string;
  version: string;
  system?: boolean;
  install?: {
    source: PluginSourceRef;
    sha: string;
    version: string
  } | null;
}

/**
 * Эквивалентность адресов ограничена публичным GitHub, который обслуживает каталог v1.
 * Credentials HTTPS, нестандартные порты и похожие hosts не повышают происхождение источника.
 */
function sourceKey(source: PluginSourceRef): string | null {
  if (source.kind !== 'git') {
    return null;
  }

  const input = source.url.trim();
  const prefixes = String.raw`^(?:https://github\.com/|ssh://git@github\.com/|git@github\.com:)`;
  const repository = String.raw`([A-Za-z0-9-]+)/([A-Za-z0-9._-]+)/?$`;
  const match = new RegExp(prefixes + repository, 'iu').exec(input);

  if (!match) {
    return null;
  }

  return `${match[1]}/${match[2]?.replace(/\.git$/iu, '')}`.toLowerCase();
}

/**
 * Равенство источников использует только объявленную equivalence GitHub transport.
 * Null от неподдержанного адреса не считается равным другому неизвестному источнику.
 */
export function sameCatalogSource(left: PluginSourceRef, right: PluginSourceRef): boolean {
  const key = sourceKey(left);

  return key !== null && key === sourceKey(right);
}

/**
 * Происхождение текущего пакета определяется проверенным свежим индексом и его source.
 * Сохранённый снимок полезен для чтения, но не становится актуальной проверкой источника.
 */
export function sourceMembership(
  index: CatalogIndex | null,
  state: CatalogState,
  id: string,
  source: PluginSourceRef | null,
): SourceMembership {
  if (!source) {
    return 'manual';
  }

  if (!index || state !== 'fresh') {
    return 'unverified';
  }

  const entry = index.plugins.find((item) => item.id === id && sameCatalogSource(item.source, source));

  return entry?.origin ?? 'external';
}

/**
 * Уже проверенные версии сравниваются по числовым частям без округления Number.
 * Метод каталога не заменяет parser releaseCommon с его отдельным входным контрактом.
 */
export function compareCatalogVersions(left: string, right: string): number {
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);

  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index]! > b[index]! ? 1 : -1;
    }
  }

  return 0;
}

/**
 * Неизвестный minimum виден отдельной подписью, но не объявляется несовместимостью.
 * Новейший неподходящий релиз не скрывает старые подходящие стабильные версии.
 */
export function compatibleVersions(
  plugin: CatalogPlugin,
  current: string,
  supportedApis: readonly number[] = [1, 2],
) {
  return plugin.versions.filter((item) => supportedApis.includes(item.api)
    && (item.minGrigDeskVersion === null
      || compareCatalogVersions(current, item.minGrigDeskVersion) >= 0))
    .sort((left, right) => compareCatalogVersions(right.version, left.version));
}

/**
 * Карточка и индекс должны принадлежать одному выпуску сайта и описывать один источник.
 * Смена метаданных или latest требует перечитать каталог до доступности install.
 */
export function detailMatchesIndex(index: CatalogIndex, detail: CatalogDetail, id: string): boolean {
  const entry = index.plugins.find((item) => item.id === id);
  const plugin = detail.plugin;

  if (!entry || detail.generatedAt !== index.generatedAt || plugin.id !== id) {
    return false;
  }

  const left = [entry.repository, entry.origin, entry.category, entry.name, entry.source.url,
    entry.license, entry.archived, entry.checkedAt, entry.summary.ru, entry.summary.en];
  const right = [plugin.repository, plugin.origin, plugin.category, plugin.name, plugin.source.url,
    plugin.license, plugin.archived, plugin.checkedAt, plugin.summary.ru, plugin.summary.en];
  const latest = [...plugin.versions]
    .sort((a, b) => compareCatalogVersions(b.version, a.version))[0] ?? null;

  return JSON.stringify(left) === JSON.stringify(right)
    && JSON.stringify(entry.latest) === JSON.stringify(latest);
}

/**
 * Действие привязано к точной выбранной совместимой версии и установленному источнику.
 * Конфликт ID и изменившийся SHA одной версии никогда не превращаются в обновление.
 */
export function catalogAction(
  plugin: CatalogPlugin,
  current: string,
  installed: CatalogInstalled | null,
  selected?: string,
) {
  const versions = compatibleVersions(plugin, current);
  const target = selected ? versions.find((item) => item.version === selected) ?? null
    : versions[0] ?? null;

  if (plugin.archived || !target) {
    return {
      action: 'blocked' as const,
      reason: plugin.archived ? 'archived' : 'incompatible',
      target
    };
  }

  if (!installed) {
    return {
      action: 'install' as const,
      reason: null,
      target
    };
  }

  if (installed.system || !installed.install
    || !sameCatalogSource(installed.install.source, plugin.source)) {
    return {
      action: 'conflict' as const,
      reason: 'sourceConflict',
      target
    };
  }

  if (installed.install.version === target.version && installed.install.sha !== target.sha) {
    return {
      action: 'conflict' as const,
      reason: 'commitConflict',
      target
    };
  }

  return {
    action: compareCatalogVersions(target.version, installed.install.version) > 0 ? 'update' as const
      : 'installed' as const,
    reason: null,
    target,
  };
}

export interface CatalogSelection {
  id: string;
  source: PluginSourceRef;
  target: CatalogVersion;
}
