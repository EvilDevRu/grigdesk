import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileHelpSources } from '../../shared/node/helpSources.ts';
import { scanText } from './helpers/privateIdentifiers.mjs';
import { queryHelp } from '../../shared/help/helpQuery.ts';
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
    assert.doesNotMatch(JSON.stringify(article), /[А-Яа-яЁё]/u);
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
