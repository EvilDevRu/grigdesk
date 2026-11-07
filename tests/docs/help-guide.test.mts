import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileHelpSources } from '../../shared/node/helpSources.ts';
import { scanText } from './helpers/privateIdentifiers.mjs';
/**
 * Временный checkout содержит только синтетический guide и чужой sentinel снаружи.
 * Негативные сценарии проверяют actual filesystem boundary, а не мок readFile.
 */
async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'help-source-'));
  const guide = path.join(root, 'docs/grigdesk/guide');

  t.after(() => rm(root, {
    recursive: true, force: true
  }));
  await mkdir(guide, {
    recursive: true
  });
  await writeFile(path.join(guide, 'catalog.json'), JSON.stringify([
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
  await writeFile(path.join(guide, 'README.md'), '# Начало\n[Чаты](chats.md)');
  await writeFile(path.join(guide, 'chats.md'), '# Чаты\nРабочая папка.');

  return {
    root, guide
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
  await writeFile(path.join(box.guide, 'chats.md'), '# Чаты\nНовый текст.');
  assert.notEqual((await compileHelpSources(box.root, identity)).revision, first.revision);
});
test('HELP-S2: ссылки наружу, пропавшая цель, необъявленная статья и symlink дают отказ', async (t) => {
  const box = await fixture(t);

  for (const bad of ['[Нет](missing.md)', '[Локальное](../local/private.md)',
    '[Опасно](javascript:alert)', '[ref]: chats.md',
    '<a href="chats.md">HTML</a>', '[Внешняя](//example.com/help)', '![Картинка](image.png)']) {
    await writeFile(path.join(box.guide, 'README.md'), `# Начало\n${bad}`);
    await assert.rejects(() => compileHelpSources(box.root, identity));
  }

  await writeFile(path.join(box.guide, 'README.md'), '# Начало');
  await writeFile(path.join(box.guide, 'orphan.md'), '# Потерян');
  await assert.rejects(() => compileHelpSources(box.root, identity));
  await rm(path.join(box.guide, 'orphan.md'));
  await writeFile(path.join(box.guide, 'extra.txt'), 'PRIVATE-SENTINEL');
  await assert.rejects(() => compileHelpSources(box.root, identity));
  await rm(path.join(box.guide, 'extra.txt'));
  await writeFile(path.join(box.guide, 'chats.md'), 'я'.repeat(128001));
  await assert.rejects(() => compileHelpSources(box.root, identity));
  await rm(path.join(box.guide, 'chats.md'));
  await writeFile(path.join(box.root, 'sentinel.md'), '# SENTINEL');
  await symlink(path.join(box.root, 'sentinel.md'), path.join(box.guide, 'chats.md'));
  await assert.rejects(() => compileHelpSources(box.root, identity));
});
test('HELP-S3: фактический корпус полный, обезличенный и помещается в runtime лимит', async () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const version = (await readFile(path.join(root, 'VERSION'), 'utf8')).trim();
  const corpus = await compileHelpSources(root, {
    version, commit: 'source'
  });
  const failures = corpus.articles.flatMap((article) =>
    scanText(`docs/grigdesk/guide/${article.file}`, article.markdown));

  assert.deepEqual(failures, []);

  for (const article of corpus.articles) {
    assert.equal(article.markdown.split('\n')[0], `# ${article.title}`);
  }

  assert.equal(corpus.articles.length, 29);
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
