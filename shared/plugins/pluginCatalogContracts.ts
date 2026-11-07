import { isRecord } from '../lib/objects.ts';
import { contractDecoders, type Decoder } from '../lib/contractDecoders.ts';
import { isInstallPluginId, isInstallText, isInstallTimestamp } from './pluginInstallValues.ts';

const d = contractDecoders((path) => {
  throw new TypeError(`Каталог: некорректные данные ${path}`);
});

/**
 * Текст каталога ограничен до публикации DTO и не получает интерпретацию HTML.
 * Пустота разрешается только для описаний, а не для identity и названий.
 */
function bounded(maximum: number, empty = false): Decoder<string> {
  return (value, path) => {
    if (!isInstallText(value, maximum) || !empty && !value.trim()) {
      throw new TypeError(`Каталог: некорректные данные ${path}`);
    }

    return value;
  };
}

/**
 * Версия каталога стабильная; ограничение длины не допускает огромные числовые части.
 * Сравнение чисел выполняется отдельно после этой проверки, а не лексикографически.
 */
function stable(value: unknown, path: string): string {
  const result = bounded(64)(value, path);

  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(result)) {
    throw new TypeError(`Каталог: некорректные данные ${path}`);
  }

  return result;
}

/**
 * Дата берётся из общего guard установщика и должна обозначать существующий UTC момент.
 * Неканоническое значение не становится временем успешного обновления каталога.
 */
function timestamp(value: unknown, path: string): string {
  if (!isInstallTimestamp(value)) {
    throw new TypeError(`Каталог: некорректные данные ${path}`);
  }

  return value;
}

/**
 * Public API использует тот же безопасный ID, исключая собственные имена документов.
 * ID остаётся данными и никогда не превращается в произвольный путь запроса.
 */
function pluginId(value: unknown, path: string): string {
  if (!isInstallPluginId(value) || ['index', 'api'].includes(value)) {
    throw new TypeError(`Каталог: некорректные данные ${path}`);
  }

  return value;
}

const versionFields = d.objectOf({
  version: stable,
  tag: bounded(65),
  sha: bounded(40),
  api: d.oneOf(1, 2),
  minGrigDeskVersion: d.nullable(stable),
});

/**
 * Тег и SHA — единая ссылка на стабильную версию GitHub, не независимые строки.
 * Повреждённая версия отвергается и в latest, и в полном списке detail.
 */
function version(value: unknown, path: string) {
  const result = versionFields(value, path);

  if (result.tag !== `v${result.version}` || !/^[a-f0-9]{40}$/u.test(result.sha)) {
    throw new TypeError(`Каталог: некорректные данные ${path}`);
  }

  return result;
}

const baseFields = {
  id: pluginId,
  repository: bounded(200),
  origin: d.oneOf('official', 'community'),
  category: d.oneOf('work', 'dev', 'knowledge', 'other'),
  summary: d.objectOf({ ru: bounded(400), en: bounded(400) }),
  name: bounded(200),
  source: d.objectOf({ kind: d.oneOf('git'), url: bounded(512) }),
  license: d.nullable(bounded(80)),
  archived: d.boolean,
  checkedAt: timestamp,
};

const summary = d.objectOf({
  ...baseFields,
  latest: d.nullable(version),
  details: bounded(64),
});
const pluginFields = d.objectOf({
  ...baseFields,
  description: bounded(16 * 1024, true),
  versions: d.listOf(version),
  readme: d.nullable(bounded(256 * 1024, true)),
  releaseNotes: d.nullable(bounded(64 * 1024, true)),
});

export interface CatalogMedia {
  path: string;
  sha: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: number;
}

/**
 * Медиа принадлежат старшей версии и не могут подменить источник произвольным URL.
 * Старый сайт без новых полей получает пустую галерею и нейтральную иконку.
 */
function catalogMedia(raw: unknown, sha: string | undefined, maximum: number): CatalogMedia {
  if (!isRecord(raw) || typeof raw.path !== 'string' || !raw.path
    || /[:?#\\\x00-\x1f\x7f]/u.test(raw.path)
    || raw.path.split('/').some((part) => !part || part.startsWith('.') || part === 'node_modules')
    || raw.sha !== sha || !Number.isSafeInteger(raw.bytes) || Number(raw.bytes) <= 0
    || Number(raw.bytes) > maximum) {
    throw new TypeError('Каталог: некорректное изображение');
  }

  const formats: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
  };
  const extension = raw.path.split('.').at(-1)?.toLowerCase() ?? '';

  if (!formats[extension] || raw.mediaType !== formats[extension]) {
    throw new TypeError('Каталог: некорректный формат изображения');
  }

  return {
    path: raw.path,
    sha: String(raw.sha),
    mediaType: raw.mediaType as CatalogMedia['mediaType'],
    bytes: Number(raw.bytes),
  };
}

/**
 * Краткий индекс не меняется: расширение применяется только к подробной карточке.
 * README сохраняется прежней проверенной проекцией без редакционных преобразований.
 */
function plugin(raw: unknown, path: string) {
  const fields = pluginFields(raw, path);
  const input = isRecord(raw) ? raw : {};
  const latest = [...fields.versions].sort((a, b) => {
    const left = a.version.split('.').map(BigInt);
    const right = b.version.split('.').map(BigInt);
    const index = left.findIndex((part, index) => part !== right[index]);

    return index < 0 ? 0 : left[index]! > right[index]! ? -1 : 1;
  })[0];
  const icon = input.icon == null ? null : catalogMedia(input.icon, latest?.sha, 256 * 1024);

  if (input.gallery !== undefined && !isRecord(input.gallery)) {
    throw new TypeError('Каталог: некорректная галерея');
  }

  const screenshots = isRecord(input.gallery) ? input.gallery.screenshots ?? [] : [];

  if (!Array.isArray(screenshots) || screenshots.length > 6) {
    throw new TypeError('Каталог: некорректная галерея');
  }

  const media = screenshots.map((item) => catalogMedia(item, latest?.sha, 4 * 1024 * 1024));

  if (new Set(media.map((item) => item.path)).size !== media.length) {
    throw new TypeError('Каталог: повтор изображения');
  }

  return {
    ...fields,
    icon,
    gallery: { screenshots: media },
  };
}

/**
 * Адрес строится только из проверенной идентичности карточки и SHA изображения.
 * Отдельного href от автора в контракте нет.
 */
export function catalogMediaUrl(repository: string, media: CatalogMedia | null): string | null {
  return media ? `https://raw.githubusercontent.com/${repository}/${media.sha}/`
    + media.path.split('/').map(encodeURIComponent).join('/') : null;
}

export type CatalogVersion = ReturnType<typeof version>;
export type CatalogSummary = ReturnType<typeof summary>;
export type CatalogPlugin = ReturnType<typeof plugin>;
export interface CatalogIndex {
  schemaVersion: 1;
  generatedAt: string | null;
  plugins: CatalogSummary[];
}
export interface CatalogDetail {
  schemaVersion: 1;
  generatedAt: string;
  plugin: CatalogPlugin;
}

/**
 * Реестр сайта сейчас содержит публичные GitHub repository; URL должен описывать его же.
 * Не принимаем URL другой учётной записи, credentials, query, fragment или другой host.
 */
function identity(value: Pick<CatalogSummary, 'repository' | 'source'>): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value.repository)
    || value.repository.endsWith('.git')
    || value.source.url !== `https://github.com/${value.repository}.git`) {
    throw new TypeError('Каталог: источник не соответствует repository');
  }
}

/**
 * Индекс публикуется одной проверенной проекцией; ошибка одного элемента отвергает весь ответ.
 * Null generatedAt разрешён только для начального пустого снимка сайта.
 */
export function decodeCatalogIndex(raw: unknown): CatalogIndex {
  const result = d.objectOf({
    schemaVersion: d.oneOf(1),
    generatedAt: d.nullable(timestamp),
    plugins: d.listOf(summary),
  })(raw, 'index');
  const ids = new Set(result.plugins.map((item) => item.id));

  if (result.plugins.length > 1000 || ids.size !== result.plugins.length
    || result.generatedAt === null && result.plugins.length > 0) {
    throw new TypeError('Каталог: несогласованный индекс');
  }

  for (const item of result.plugins) {
    identity(item);

    if (item.details !== `${item.id}.json`) {
      throw new TypeError('Каталог: некорректный адрес подробностей');
    }
  }

  return result;
}

/**
 * Detail проверяется независимо от индекса и не допускает повторов версий.
 * Соответствие конкретному index snapshot проверит сервис, который заказывал документ.
 */
export function decodeCatalogDetail(raw: unknown): CatalogDetail {
  const result = d.objectOf({
    schemaVersion: d.oneOf(1),
    generatedAt: timestamp,
    plugin,
  })(raw, 'detail');
  const versions = result.plugin.versions;

  identity(result.plugin);

  if (versions.length > 100 || new Set(versions.map((item) => item.version)).size !== versions.length) {
    throw new TypeError('Каталог: несогласованные версии');
  }

  return result;
}

export type CatalogState = 'fresh' | 'stale' | 'unavailable' | 'unconfigured';
export interface CatalogIndexResponse {
  state: CatalogState;
  applicationVersion: string;
  fetchedAt: string | null;
  catalog: CatalogIndex | null;
}

/**
 * Браузер проверяет локальную оболочку так же строго, как сервер проверяет публичный сайт.
 * Свежесть и наличие снимка согласованы: ошибка не превращается в пустой успешный каталог.
 */
export function decodeCatalogResponse(raw: unknown): CatalogIndexResponse {
  const result = d.objectOf({
    state: d.oneOf('fresh', 'stale', 'unavailable', 'unconfigured'),
    applicationVersion: stable,
    fetchedAt: d.nullable(timestamp),
    catalog: d.nullable(decodeCatalogIndex),
  })(raw, 'response');
  const available = result.state === 'fresh' || result.state === 'stale';

  if (available !== (result.catalog !== null && result.fetchedAt !== null)
    || !available && (result.catalog !== null || result.fetchedAt !== null)) {
    throw new TypeError('Каталог: несогласованная доступность');
  }

  return result;
}
