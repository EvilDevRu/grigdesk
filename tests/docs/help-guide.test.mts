import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileHelpSources } from '../../shared/node/helpSources.ts';
import { scanText } from './helpers/privateIdentifiers.mjs';
import { localeSource } from '../helpers/helpLocale.mts';
import { queryHelp } from '../../shared/help/helpQuery.ts';
import { verifyHelpBundle } from '../../shared/node/helpSources.ts';

/**
 * Временный checkout содержит только синтетический guide и чужой sentinel снаружи.
 * Негативные сценарии проверяют actual filesystem boundary, а не мок readFile.
 */
async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'help-source-'));
  const guide = path.join(root, 'docs/grigdesk/guide');
  const russian = path.join(guide, 'ru');

  t.after(() => rm(root, {
    recursive: true, force: true
  }));
  await mkdir(russian, {
    recursive: true
  });
  await writeFile(path.join(russian, 'catalog.json'), JSON.stringify([
    {
      id: 'overview',
      file: 'README.md',
      title: 'Начало',
      section: 'Основы',
      keywords: []
    },
    {
      id: 'chats',
      file: 'chats.md',
      title: 'Чаты',
      section: 'Основы',
      keywords: []
    },
  ]));
  await writeFile(path.join(guide, 'README.md'), '# SOURCE-INDEX-SENTINEL');
  await writeFile(path.join(russian, 'README.md'), '# Начало\n[Чаты](chats.md)');
  await writeFile(path.join(russian, 'chats.md'), '# Чаты\nРабочая папка.');

  return {
    root,
    guide,
    russian,
  };
}

const identity = {
  version: '0.1.0', commit: 'c'.repeat(40)
};

test('HELP-S1: источник воспроизводим, замкнут и не читает соседние планы', async (t) => {
  const box = await fixture(t);

  await mkdir(path.join(box.root, 'docs/local'), {
    recursive: true
  });
  await writeFile(path.join(box.root, 'docs/local/private.md'), 'PRIVATE-SENTINEL');

  const first = await compileHelpSources(box.root, identity);
  const second = await compileHelpSources(box.root, identity);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first).includes('PRIVATE-SENTINEL'), false);
  assert.equal(JSON.stringify(first).includes('SOURCE-INDEX-SENTINEL'), false);
  await writeFile(path.join(box.russian, 'chats.md'), '# Чаты\nНовый текст.');
  assert.notEqual((await compileHelpSources(box.root, identity)).revision, first.revision);
});
test('HELP-S2: ссылки наружу, пропавшая цель, необъявленная статья и symlink дают отказ', async (t) => {
  const box = await fixture(t);

  for (const bad of ['[Нет](missing.md)', '[Локальное](../local/private.md)',
    '[Опасно](javascript:alert)', '[ref]: chats.md',
    '<a href="chats.md">HTML</a>', '[Внешняя](//example.com/help)', '![Картинка](image.png)']) {
    await writeFile(path.join(box.russian, 'README.md'), `# Начало\n${bad}`);
    await assert.rejects(() => compileHelpSources(box.root, identity));
  }

  await writeFile(path.join(box.russian, 'README.md'), '# Начало');
  await writeFile(path.join(box.russian, 'orphan.md'), '# Потерян');
  await assert.rejects(() => compileHelpSources(box.root, identity));
  await rm(path.join(box.russian, 'orphan.md'));
  await writeFile(path.join(box.russian, 'extra.txt'), 'PRIVATE-SENTINEL');
  await assert.rejects(() => compileHelpSources(box.root, identity));
  await rm(path.join(box.russian, 'extra.txt'));
  await writeFile(path.join(box.russian, 'chats.md'), 'я'.repeat(128001));
  await assert.rejects(() => compileHelpSources(box.root, identity));
  await rm(path.join(box.russian, 'chats.md'));
  await writeFile(path.join(box.root, 'sentinel.md'), '# SENTINEL');
  await symlink(path.join(box.root, 'sentinel.md'), path.join(box.russian, 'chats.md'));
  await assert.rejects(() => compileHelpSources(box.root, identity));
});
test('HELP-S3: фактический корпус полный, обезличенный и помещается в runtime лимит', async () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const languages = await readdir(path.join(root, 'docs/grigdesk/guide'));

  assert.deepEqual(languages.sort(), ['README.md', 'en', 'ru']);

  const version = (await readFile(path.join(root, 'VERSION'), 'utf8')).trim();
  const catalog: Array<{
    id: string;
    file: string;
  }> = JSON.parse(await readFile(path.join(root, 'docs/grigdesk/guide/ru/catalog.json'), 'utf8'));
  const corpus = await compileHelpSources(root, {
    version, commit: 'source'
  });
  const failures = corpus.articles.flatMap((article) =>
    scanText(`docs/grigdesk/guide/ru/${article.file}`, article.markdown));

  assert.deepEqual(failures, []);

  for (const article of corpus.articles) {
    assert.equal(article.markdown.split('\n')[0], `# ${article.title}`);
  }

  assert.deepEqual(
    corpus.articles.map(({ id, file }) => ({ id, file })),
    catalog.map(({ id, file }) => ({ id, file }))
  );
  assert.equal(corpus.articles.some((entry) => entry.id === 'studio3d'), false);
  assert.ok(corpus.articles.some((entry) => entry.id === 'getting-started'));
  assert.ok(corpus.articles.some((entry) => entry.id === 'troubleshooting'));
});

test('VER-DEV-HELP: корпус справки получает ту же dev-версию и commit сборки', async (t) => {
  const box = await fixture(t);
  const buildIdentity = { version: '0.2.0-dev.42', commit: 'c'.repeat(40) };
  const corpus = await compileHelpSources(box.root, buildIdentity);

  assert.equal(corpus.version, buildIdentity.version);
  assert.equal(corpus.commit, buildIdentity.commit);
  assert.equal(corpus.articles.length, 2);
});

test('HELP-S4: английский корпус содержит все темы, переведённые заголовки и поиск', async () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const russian = await compileHelpSources(root, identity);
  const english = await compileHelpSources(root, identity, 'en');

  assert.equal(english.locale, 'en');
  assert.notEqual(english.revision, russian.revision);

  const identities = (bundle: typeof english) => bundle.articles.map(({ id, file, routes }) => ({
    id,
    file,
    routes,
  }));

  assert.deepEqual(identities(english), identities(russian));

  for (const article of english.articles) {
    assert.equal(article.markdown.split('\n')[0], `# ${article.title}`);
    // В EN сохранена точная цитата ошибки старого русскоязычного сервера.
    // Остальной текст, метаданные и поисковые слова должны оставаться английскими.
    const text = JSON.stringify(article).replace(
      'Подготовка операции не удалась', 'operation preparation failed',
    );

    assert.doesNotMatch(text, /[А-Яа-яЁё]/u);
    assert.deepEqual(scanText(`docs/grigdesk/guide/en/${article.file}`, article.markdown), []);
  }

  const result = queryHelp(english, { action: 'search', query: 'working folder' });

  assert.ok('items' in result && result.items.some((article) => article.id === 'chat-workdir'));
});

test('HELP-S5: неполный перевод и ссылки вне корпуса отклоняются', async (t) => {
  const box = await fixture(t);

  await mkdir(path.join(box.guide, 'en'));
  await writeFile(path.join(box.guide, 'en/catalog.json'), JSON.stringify([{
    id: 'overview',
    file: 'README.md',
    title: 'Guide',
    section: 'Help',
    keywords: [],
  }]));
  await writeFile(path.join(box.guide, 'en/README.md'), '# Guide');
  await assert.rejects(() => compileHelpSources(box.root, identity, 'en'));
  await writeFile(path.join(box.guide, 'en/catalog.json'),
    await readFile(path.join(box.russian, 'catalog.json')));
  await writeFile(path.join(box.guide, 'en/chats.md'), '# Chats');
  await writeFile(path.join(box.guide, 'en/README.md'), '# Guide\n[Russian](../guide/chats.md)');
  await assert.rejects(() => compileHelpSources(box.root, identity, 'en'));
});


/**
 * Reflect сохраняет поведенческий RED до появления третьего аргумента в контракте.
 * Ошибка типов старой сигнатуры не используется как доказательство нового поведения.
 */
function compileLocale(root: string, locale: string) {
  return Reflect.apply(compileHelpSources, undefined, [root, identity, locale]);
}

test('HELP-S-L1: оба безопасных источника дают свои metadata, текст и SHA', async (t) => {
  const box = await localeSource(t);

  for (const directory of ['docs/local', 'docs/grigdesk/server', 'plugins/external/docs']) {
    await mkdir(path.join(box.root, directory), { recursive: true });
    await writeFile(path.join(box.root, directory, 'private.md'), 'PRIVATE-SENTINEL');
  }

  const english = await compileLocale(box.root, 'en');
  const russian = await compileHelpSources(box.root, identity);

  assert.equal(english.locale, 'en');
  assert.equal(english.articles[1].title, 'Chat working directory');
  assert.equal(russian.locale, 'ru');
  assert.equal(russian.articles[1]?.title, 'Рабочая папка');
  assert.deepEqual(verifyHelpBundle(english), english);
  assert.notEqual(english.revision, russian.revision);
  assert.equal(JSON.stringify([english, russian]).includes('PRIVATE-SENTINEL'), false);
  await assert.rejects(() => compileLocale(box.root, '../en'));
});

for (const defect of ['missing-id', 'extra-id', 'orphan.md', 'extra.txt', 'technical-link',
  'html', 'image', 'reference', 'oversize', 'article-symlink', 'catalog-symlink', 'directory-symlink']) {
  test(`HELP-S-L1: EN отклоняет ${defect} после успешного контрольного чтения`, async (t) => {
    const box = await localeSource(t);
    const english = await compileLocale(box.root, 'en');

    assert.equal(english.locale, 'en');

    const article = path.join(box.english, 'chats.md');
    const catalogFile = path.join(box.english, 'catalog.json');
    const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
    const badText: Record<string, string> = {
      'technical-link': '# Chat working directory\n[Technical](../technical.md)',
      html: '# Chat working directory\n<a href="chats.md">Active</a>',
      image: '# Chat working directory\n![Image](image.png)',
      reference: '# Chat working directory\n[ref]: README.md',
      oversize: 'x'.repeat(128001),
    };

    if (defect === 'missing-id' || defect === 'extra-id') {
      await writeFile(catalogFile, JSON.stringify(defect === 'missing-id' ? catalog.slice(0, 1)
        : [...catalog, {
          ...catalog[1],
          id: 'extra',
          file: 'extra.md',
        }]));

      if (defect === 'extra-id') {
        await writeFile(path.join(box.english, 'extra.md'), '# Chat working directory');
      } else {
        await rm(article);
      }
    } else if (defect.endsWith('symlink')) {
      const victim = defect === 'article-symlink' ? article
        : defect === 'catalog-symlink' ? catalogFile : box.english;
      const sentinel = path.join(box.root, 'sentinel');

      if (defect === 'directory-symlink') {
        await cp(box.english, sentinel, { recursive: true });
      } else {
        await writeFile(sentinel, defect === 'catalog-symlink'
          ? JSON.stringify(catalog) : '# Chat working directory\nPRIVATE-SENTINEL');
      }

      await rm(victim, { recursive: true, force: true });
      await symlink(sentinel, victim);
    } else if (badText[defect]) {
      await writeFile(article, badText[defect]!);
    } else {
      await writeFile(path.join(box.english, defect), 'PRIVATE-SENTINEL');
    }

    await assert.rejects(() => compileLocale(box.root, 'en'));
  });
}

test('HELP-S-L2: реальный EN полон, замкнут, обезличен и соответствует каталогу RU', async () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const english = await compileLocale(root, 'en');
  const russian = await compileHelpSources(root, identity);

  assert.equal(english.locale, 'en');
  assert.equal(english.articles.length, russian.articles.length);
  assert.deepEqual(english.articles.map(({ id, file, routes }: typeof russian.articles[number]) =>
    ({
      id,
      file,
      routes,
    })), russian.articles.map(({ id, file, routes }) => ({
      id,
      file,
      routes,
    })));
  assert.equal(english.version, russian.version);
  assert.equal(english.commit, russian.commit);

  for (const [corpus, query] of [[english, 'working directory'], [russian, 'рабочая папка']] as const) {
    const result = queryHelp(corpus, { action: 'search', query });

    assert.ok('items' in result);
    assert.equal(result.items[0]?.id, 'chat-workdir');
  }

  const overview = english.articles.find((entry: typeof russian.articles[number]) => entry.id === 'overview');
  const expectedTitles: Record<string, string> = {
    overview: 'GrigDesk Guide',
    'getting-started': 'Getting started',
    'chat-workdir': 'Conversation working folder',
  };

  for (const article of english.articles as typeof russian.articles) {
    const source = russian.articles.find((entry) => entry.id === article.id)!;

    assert.equal(article.markdown.split('\n')[0], `# ${article.title}`);
    assert.notEqual(article.markdown, source.markdown);
    assert.equal(article.markdown.match(/^## /gmu)?.length, source.markdown.match(/^## /gmu)?.length);
    assert.notEqual(article.title, source.title);
    assert.notEqual(article.section, source.section);
    assert.ok(article.keywords.length > 0);
    assert.deepEqual(scanText(`guide/en/${article.file}`, article.markdown), []);
    assert.doesNotMatch(article.markdown, /\bTODO\b|\bTBD\b|translation pending/iu);

    if (article.id !== 'overview') {
      assert.ok(overview.markdown.includes(`](${article.file})`), article.id);
    }
    if (expectedTitles[article.id]) {
      assert.equal(article.title, expectedTitles[article.id]);
    }
  }

  assert.ok(Buffer.byteLength(JSON.stringify(english)) <= 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(english)) + Buffer.byteLength(JSON.stringify(russian))
    <= 2 * 1024 * 1024);
});

test('HELP-DOC-L1: публичный README ведёт в EN, явно оставляет RU и общий Plugins', async () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');

  assert.doesNotMatch(readme, /Studio3D|Codex Reset|studio3d|codex-reset|codexreset\.org/iu);
  assert.match(readme, /Plugins/u);
  assert.match(readme, /\]\(docs\/grigdesk\/guide\/ru\/README\.md\)/u);

  for (const file of ['README.md', 'installation.md', 'getting-started.md', 'plugins.md',
    'troubleshooting.md']) {
    assert.ok(readme.includes(`docs/grigdesk/guide/en/${file}`), file);
    assert.ok((await readFile(path.join(root, 'docs/grigdesk/guide/en', file), 'utf8')).trim());
  }
});

test('HELP-S-L1: отсутствующий EN имеет явный отказ, прежний RU-only источник работает', async (t) => {
  const box = await localeSource(t);

  await rm(box.english, { recursive: true });
  assert.equal((await compileHelpSources(box.root, identity)).locale, 'ru');
  await assert.rejects(() => compileLocale(box.root, 'en'), /help_locale_unavailable/u);
});

for (const defect of ['empty-article', 'malformed-catalog', 'reordered-ids']) {
  test(`HELP-S-L1: EN ${defect} не превращается в частичный корпус`, async (t) => {
    const box = await localeSource(t);
    const baseline = await compileLocale(box.root, 'en');

    assert.equal(baseline.locale, 'en');

    if (defect === 'empty-article') {
      await writeFile(path.join(box.english, 'chats.md'), '');
    } else if (defect === 'malformed-catalog') {
      await writeFile(path.join(box.english, 'catalog.json'), '{broken');
    } else {
      const file = path.join(box.english, 'catalog.json');
      const catalog = JSON.parse(await readFile(file, 'utf8'));

      await writeFile(file, JSON.stringify(catalog.reverse()));
    }

    await assert.rejects(() => compileLocale(box.root, 'en'), /help_unavailable/u);
  });
}
