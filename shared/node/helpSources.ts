import path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { canonicalJson } from '../lib/canonicalJson.ts';
import { decodeHelpBundle, HELP_MAX_BYTES, helpInvalid } from '../help/helpContracts.ts';
import type { HelpBundle, HelpLocale } from '../help/helpContracts.ts';
import { HELP_CONTEXT_ARTICLES, helpHref } from '../help/helpLinks.ts';
import { readContainedText } from './readContainedText.ts';
import { sha256 } from './hash.ts';
/**
 * Отпечаток покрывает метаданные и Markdown без собственного поля revision.
 * Пакет из JSON обязан совпасть с содержимым, на котором строились поиск и сайт.
 */
export function verifyHelpBundle(raw: unknown): HelpBundle {
  const bundle = decodeHelpBundle(raw);
  const { revision, ...content } = bundle;

  if (sha256(canonicalJson(content)) !== revision) {
    helpInvalid();
  }

  return bundle;
}
/**
 * Только каталог выбранного языка guide и его явные обычные файлы образуют корпус.
 * Локальные заметки, планы и внешние каталоги не становятся транзитивными ресурсами.
 */
async function compileLocaleSources(sourceRoot: string, identity: {
  version: string;
  commit: string;
}, locale: HelpLocale): Promise<HelpBundle> {
  const relativeRoot = `docs/grigdesk/guide/${locale}`;
  const root = path.join(sourceRoot, relativeRoot);
  const catalogText = await readContainedText(sourceRoot, `${relativeRoot}/catalog.json`, 64000);

  if (!catalogText || catalogText.length > 64000) {
    helpInvalid();
  }

  const catalog: unknown = JSON.parse(catalogText);

  if (!Array.isArray(catalog) || catalog.length === 0 || catalog.length > 128) {
    helpInvalid();
  }

  if (locale === 'en') {
    const russian = await compileHelpSources(sourceRoot, identity);
    const expected = russian.articles.map(({ id, file }) => ({
      id,
      file
    }));
    const translated = catalog.map((entry) => ({
      id: entry?.id,
      file: entry?.file
    }));

    if (JSON.stringify(expected) !== JSON.stringify(translated)) {
      helpInvalid();
    }
  }

  const articles = [];

  for (const raw of catalog) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).sort().join(',') !== 'file,id,keywords,section,title'
      || typeof raw.file !== 'string'
      || !/^(?:README|[a-z][a-z0-9-]*)\.md$/u.test(raw.file)) {
      helpInvalid();
    }

    const markdown = await readContainedText(sourceRoot, `${relativeRoot}/${raw.file}`, 128000);

    if (!markdown || markdown.length > 128000) {
      helpInvalid();
    }

    const routes = Object.entries(HELP_CONTEXT_ARTICLES)
      .filter(([, id]) => id === raw.id).map(([route]) => route);

    articles.push({
      ...raw,
      routes,
      markdown
    });
  }

  const content = {
    format: 1,
    ...identity,
    locale,
    articles
  };
  const result = decodeHelpBundle({
    ...content, revision: sha256(canonicalJson(content))
  });
  const entries = await readdir(root, { withFileTypes: true });
  const expectedFiles = new Set(['catalog.json', ...result.articles.map((entry) => entry.file)]);

  if (entries.some((entry) => !entry.isFile() || !expectedFiles.has(entry.name))
    || entries.length !== expectedFiles.size) {
    helpInvalid();
  }

  for (const entry of result.articles) {
    // Корпус поддерживает inline-ссылки. Reference definitions, изображения и активный
    // raw HTML отклоняются явно, чтобы простая проверка не давала ложного обещания полноты.
    const prose = entry.markdown.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, '')
      .replace(/`[^`\n]*`/gu, '');

    if (/^\s*\[[^\]]+\]:/mu.test(prose)
      || /<!--|<\/?[a-z][^>\n]*>/iu.test(prose)) {
      helpInvalid();
    }

    for (const match of prose.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/gu)) {
      const raw = match[1]!.trim();
      const href = raw.startsWith('<') ? raw.slice(1, raw.indexOf('>')) : raw.split(/\s/u)[0]!;

      if (match[0].startsWith('!') || helpHref(result, entry.id, href) === false) {
        helpInvalid();
      }
    }
  }

  if (Buffer.byteLength(JSON.stringify(result)) > HELP_MAX_BYTES) {
    helpInvalid();
  }

  return result;
}

/**
 * Закрытая локаль проверяется до построения пути; отсутствующий перевод отличим от повреждения.
 * Любая другая ошибка источника превращается в безопасный публичный код без файловых путей.
 */
export async function compileHelpSources(sourceRoot: string, identity: {
  version: string;
  commit: string;
}, locale: HelpLocale = 'ru'): Promise<HelpBundle> {
  if (locale !== 'ru' && locale !== 'en') {
    helpInvalid();
  }

  if (locale === 'en') {
    const directory = await lstat(path.join(sourceRoot, 'docs/grigdesk/guide/en'))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          throw new Error('help_locale_unavailable');
        }

        helpInvalid();
      });

    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      helpInvalid();
    }

    const catalog = await lstat(path.join(sourceRoot, 'docs/grigdesk/guide/en/catalog.json'))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          throw new Error('help_locale_unavailable');
        }

        helpInvalid();
      });

    if (!catalog.isFile() || catalog.isSymbolicLink()) {
      helpInvalid();
    }
  }

  try {
    return await compileLocaleSources(sourceRoot, identity, locale);
  } catch {
    helpInvalid();
  }
}
