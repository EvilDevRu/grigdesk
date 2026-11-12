import { parseProductVersion } from '../runtime/productReleaseVersion.ts';
import { contractDecoders } from '../lib/contractDecoders.ts';

export const HELP_FORMAT = 1;
export const HELP_MAX_BYTES = 1024 * 1024;
export const HELP_PAGE_SIZE = 12000;
export const HELP_LOCALES = ['ru', 'en'] as const;

export type HelpLocale = typeof HELP_LOCALES[number];

export const HELP_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
/**
 * Ошибка публичного корпуса не раскрывает путь или содержимое файла машины.
 * Один код распознаётся API, инструментом и сетевым декодером интерфейса.
 */
export function helpInvalid(): never {
  throw Object.assign(new Error('help_unavailable'), {
    code: 'help_unavailable'
  });
}

const d = contractDecoders(helpInvalid);
const article = d.objectOf({
  id: d.text,
  file: d.text,
  title: d.text,
  section: d.text,
  keywords: d.listOf(d.text),
  routes: d.listOf(d.text),
  markdown: d.text,
});
const bundle = d.objectOf({
  format: d.oneOf(1),
  version: d.text,
  commit: d.text,
  revision: d.text,
  locale: d.oneOf('ru', 'en'),
  articles: d.listOf(article),
});

export type HelpArticle = ReturnType<typeof article>;
export type HelpBundle = ReturnType<typeof bundle>;
export type HelpInput = {
  locale?: HelpLocale;
} & ({
  action: 'index';
} | {
  action: 'search';
  query: string;
} | {
  action: 'read';
  id: string;
  offset: number;
});
/**
 * JSON из сети и payload получает одинаковые пределы, уникальные ID и простые пути.
 * Неизвестная схема либо лишние поля не превращаются в частично прочитанное руководство.
 */
export function decodeHelpBundle(value: unknown): HelpBundle {
  const result = bundle(value, 'help');
  const keys = ['articles', 'commit', 'format', 'locale', 'revision', 'version'];

  if (Object.keys(value as object).sort().join(',') !== keys.join(',')
    || !parseProductVersion(result.version)
    || !/^(?:[a-f0-9]{40}|source)$/u.test(result.commit)
    || !/^[a-f0-9]{64}$/u.test(result.revision)
    || result.articles.length === 0 || result.articles.length > 128) {
    helpInvalid();
  }

  const ids = new Set<string>();
  const files = new Set<string>();

  for (const [index, entry] of result.articles.entries()) {
    const original = (value as {
      articles: object[];
    }).articles[index]!;

    if (!HELP_ID.test(entry.id) || ids.has(entry.id) || files.has(entry.file)
      || !/^(?:README|[a-z][a-z0-9-]*)\.md$/u.test(entry.file)
      || !entry.title.trim() || entry.title.length > 200
      || !entry.section.trim() || entry.section.length > 100
      || entry.keywords.length > 30 || entry.keywords.some((item) => item.length > 100)
      || entry.routes.length > 10 || entry.routes.some((item) => !/^\/[a-z0-9/-]*$/u.test(item))
      || entry.markdown.length === 0 || entry.markdown.length > 128000
      || Object.keys(original).sort().join(',') !== 'file,id,keywords,markdown,routes,section,title') {
      helpInvalid();
    }

    ids.add(entry.id);
    files.add(entry.file);
  }

  if (!ids.has('overview') || new TextEncoder().encode(JSON.stringify(result)).length > HELP_MAX_BYTES) {
    helpInvalid();
  }

  return result;
}
/**
 * Tool не принимает пути, управляющие поля или настройки произвольного лимита.
 * Смещение измеряется Unicode code points и остаётся безопасным целым числом.
 */
export function parseHelpInput(value: unknown): HelpInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('help_input_invalid');
  }

  const source = value as Record<string, unknown>;
  const action = source.action;
  const allowed = action === 'index' ? ['action', 'locale'] : action === 'search'
    ? ['action', 'query', 'locale'] : action === 'read' ? ['action', 'id', 'offset', 'locale'] : [];
  const locale = source.locale;

  if ('locale' in source && locale !== 'ru' && locale !== 'en') {
    throw new Error('help_input_invalid');
  }

  const preference: { locale?: HelpLocale } = locale === 'ru' || locale === 'en' ? { locale } : {};

  if (allowed.length === 0 || Object.keys(source).some((key) => !allowed.includes(key))) {
    throw new Error('help_input_invalid');
  }
  if (action === 'index') {
    return {
      action,
      ...preference
    };
  }
  if (action === 'search' && typeof source.query === 'string' && source.query.length <= 256) {
    return {
      action,
      ...preference,
      query: source.query
    };
  }
  if (action === 'read' && typeof source.id === 'string' && HELP_ID.test(source.id)
    && (source.offset === undefined || Number.isSafeInteger(source.offset)
      && Number(source.offset) >= 0 && Number(source.offset) <= 128000)) {
    return {
      action,
      ...preference,
      id: source.id,
      offset: Number(source.offset ?? 0)
    };
  }

  throw new Error('help_input_invalid');
}
