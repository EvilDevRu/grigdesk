import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { canonicalJson } from '../../shared/lib/canonicalJson.ts';
import { sha256 } from '../../shared/node/hash.ts';

/**
 * Две синтетические статьи содержат разные метаданные и связанные ссылки.
 * Revision считается тем же каноническим способом, что и у настоящего источника.
 */
export function localeCorpus(locale: 'ru' | 'en', version = '0.1.0', marker = '') {
  const english = locale === 'en';
  const titles = english ? ['Guide', 'Chat working directory'] : ['Руководство', 'Рабочая папка'];
  const content = {
    format: 1 as const,
    version,
    commit: (version === '0.1.0' ? 'a' : 'c').repeat(40),
    locale,
    articles: ['overview', 'chats'].map((id, index) => ({
      id,
      file: index === 0 ? 'README.md' : 'chats.md',
      title: titles[index]!,
      section: english ? 'Getting started' : 'Начало работы',
      keywords: [english ? 'working directory' : 'рабочая папка'],
      routes: index === 0 ? [] : ['/chats'],
      markdown: `# ${titles[index]}\n${marker}\n`
        + (index === 0 ? `[${titles[1]}](chats.md)` : `[${titles[0]}](README.md)`),
    })),
  };

  return { ...content, revision: sha256(canonicalJson(content)) };
}

/**
 * Источник живёт в одноразовом каталоге и не обращается к данным владельца.
 * EN использует тот же каталог id/file, но собственные тексты и поисковые слова.
 */
export async function localeSource(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'help-locale-'));
  const guide = path.join(root, 'docs/grigdesk/guide');

  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'VERSION'), '0.1.0\n');

  for (const locale of ['ru', 'en'] as const) {
    const directory = path.join(guide, locale);
    const corpus = localeCorpus(locale);
    const catalog = corpus.articles.map(({ id, file, title, section, keywords }) => ({
      id,
      file,
      title,
      section,
      keywords,
    }));

    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'catalog.json'), JSON.stringify(catalog));

    for (const article of corpus.articles) {
      await writeFile(path.join(directory, article.file), article.markdown);
    }
  }

  return {
    root,
    guide,
    english: path.join(guide, 'en'),
  };
}

/**
 * Дополнительная статья меняет весь подписанный корпус, включая revision.
 * Браузерная фикстура остаётся валидной даже при более строгой проверке ресурса.
 */
export function signedCorpus<T extends { revision: string }>(bundle: T): T {
  const { revision: _revision, ...content } = bundle;

  return { ...content, revision: sha256(canonicalJson(content)) } as T;
}
