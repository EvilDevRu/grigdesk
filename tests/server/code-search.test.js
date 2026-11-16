import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { parseCodeSearch } from '../../shared/plugins/code/codeContracts.ts';
import codeModule from '../../server/src/modules/code/index.ts';
import { searchTree } from '../../server/src/lib/git.ts';

const exec = promisify(execFile);
const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const git = (cwd, args) => exec('git', ['-C', cwd, ...args]);

/** Создаёт tracked, untracked, бинарные и скрытые поисковые цели. */
async function searchRepo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-code-search-'));
  const privateDir = path.join(root, 'private-chat');

  await git(root, ['init', '-q', '-b', 'main', '.']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'user.name', 'test']);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, '.state'), { recursive: true });
  await mkdir(privateDir, { recursive: true });
  await writeFile(path.join(root, 'src', 'Needle-literal.().ts'), [
    'первая строка',
    'const needle = ".()";',
    'Needle again',
  ].join('\n'));
  await writeFile(path.join(root, 'README.md'), 'Needle in docs\n');
  await writeFile(path.join(root, 'binary.bin'), Buffer.from('Needle\0binary'));
  await writeFile(path.join(root, '.state', 'secret.txt'), 'Needle secret\n');
  await writeFile(path.join(privateDir, 'session.txt'), 'Needle private\n');
  await git(root, ['add', '-f', '.']);
  await git(root, ['commit', '-qm', 'search fixtures']);
  await writeFile(path.join(root, 'untracked.txt'), 'Needle untracked\n');
  t.after(() => rm(root, { recursive: true, force: true }));

  return { root, privateDir };
}

/** Поднимает HTTP-модуль с настраиваемым потолком stdout поиска. */
async function codeApp(t, root, privateDir, searchMaxBytes) {
  const app = Fastify({ logger: false });

  app.decorate('pluginEnabled', () => true);
  app.register(codeModule, {
    config: {
      profilesDir: path.join(root, 'profiles'),
      chatsDir: privateDir,
    },
    prefs: { read: () => ({ projects: { demo: { repos: [{ key: 'main', dir: root }] } } }) },
    searchMaxBytes,
  });
  await app.ready();
  t.after(() => app.close());

  return app;
}

test('CODE-SEARCH-01: совпадения несут путь, строку, текст и untracked-файл', async (t) => {
  const { root } = await searchRepo(t);
  const result = await searchTree(root, 'Needle');

  assert.ok(result.files.some((item) => item.path === 'src/Needle-literal.().ts'));
  assert.deepEqual(
    result.matches.find((item) => item.path === 'src/Needle-literal.().ts'),
    { path: 'src/Needle-literal.().ts', line: 3, text: 'Needle again' },
  );
  assert.ok(result.matches.some((item) => item.path === 'untracked.txt' && item.line === 1));
  assert.equal(result.matches.some((item) => item.path === 'binary.bin'), false);
});

test('CODE-SEARCH-02: -F ищет точку и скобки буквально', async (t) => {
  const { root } = await searchRepo(t);
  const result = await searchTree(root, '.()');

  assert.deepEqual(result.files, [{ path: 'src/Needle-literal.().ts' }]);
  assert.deepEqual(result.matches, [{
    path: 'src/Needle-literal.().ts',
    line: 2,
    text: 'const needle = ".()";',
  }]);
});

test('CODE-SEARCH-03: HTTP скрывает служебные пути и проверяет запрос', async (t) => {
  const { root, privateDir } = await searchRepo(t);
  const app = await codeApp(t, root, privateDir);
  const response = await app.inject({
    method: 'GET',
    url: '/api/code/demo/search?repo=main&q=Needle',
  });

  assert.equal(response.statusCode, 200);
  assert.doesNotThrow(() => parseCodeSearch(response.json()));
  assert.equal(response.json().files.some((item) => item.path.startsWith('.state/')), false);
  assert.equal(response.json().matches.some((item) => item.path.startsWith('.state/')), false);
  assert.equal(response.json().matches.some((item) => item.path.startsWith('private-chat/')), false);

  const invalid = await app.inject({
    method: 'GET',
    url: '/api/code/demo/search?repo=main&q=x',
  });

  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error, 'bad_query');
});

test('CODE-SEARCH-04: маленький потолок честно отмечает обрезанный результат', async (t) => {
  const { root, privateDir } = await searchRepo(t);

  await writeFile(path.join(root, 'many.txt'), `${'Needle repeated text\n'.repeat(100)}`);
  const app = await codeApp(t, root, privateDir, 80);
  const response = await app.inject({
    method: 'GET',
    url: '/api/code/demo/search?repo=main&q=Needle',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().truncated, true);
  assert.ok(response.json().matches.length < 100);
});

test('CODE-SEARCH-FLAGS: регистр и слово целиком управляются флагами', async (t) => {
  const { root, privateDir } = await searchRepo(t);
  const app = await codeApp(t, root, privateDir);

  // Без флагов контент чувствителен к регистру: 'NEEDLE' не находит 'Needle again'.
  const base = await searchTree(root, 'NEEDLE');

  assert.equal(base.matches.length, 0);

  // ignoreCase включает git grep -i и находит совпадения другого регистра.
  const insensitive = await searchTree(root, 'NEEDLE', { ignoreCase: true });

  assert.ok(insensitive.matches.some((item) => item.text.includes('Needle again')));

  // Слово целиком: подстрока внутри другого слова ('xneedlepointx') без -w находится,
  // с -w — нет; отдельное слово 'needlepoint' остаётся найденным и с -w.
  await writeFile(path.join(root, 'src', 'whole.txt'), 'xneedlepointx\nneedlepoint\n');

  const plain = await searchTree(root, 'needlepoint');

  assert.equal(plain.matches.filter((item) => item.path === 'src/whole.txt').length, 2);

  const word = await searchTree(root, 'needlepoint', { wholeWord: true });
  const wholeLines = word.matches.filter((item) => item.path === 'src/whole.txt');

  assert.equal(wholeLines.length, 1);
  assert.equal(wholeLines[0].text, 'needlepoint');

  // HTTP: case=0 и word=1 передаются до git grep.
  const httpCase = await app.inject({
    method: 'GET',
    url: '/api/code/demo/search?repo=main&q=NEEDLE&case=0',
  });

  assert.equal(httpCase.statusCode, 200);
  assert.ok(httpCase.json().matches.length > 0);

  const httpWord = await app.inject({
    method: 'GET',
    url: '/api/code/demo/search?repo=main&q=needlepoint&word=1',
  });

  assert.equal(httpWord.statusCode, 200);
  assert.equal(httpWord.json().matches.some((item) => item.text === 'xneedlepointx'), false);

  // Путь остаётся без регистра при любых флагах содержимого.
  const pathSensitive = await searchTree(root, 'NEEDLE');
  const pathFlags = await searchTree(root, 'NEEDLE', { ignoreCase: true, wholeWord: true });

  assert.ok(pathSensitive.files.some((item) => item.path === 'src/Needle-literal.().ts'));
  assert.deepEqual(pathFlags.files, pathSensitive.files);
});

test('CODE-QUICK-OPEN: HTTP подбирает пути, фильтрует hidden и ограничивает 50', async (t) => {
  const { root, privateDir } = await searchRepo(t);
  const app = await codeApp(t, root, privateDir);

  await writeFile(path.join(root, '.state', 'needle-hidden.txt'), 'secret\n');
  await writeFile(path.join(privateDir, 'needle-private.txt'), 'private\n');
  await writeFile(path.join(root, 'needle-untracked.txt'), 'local\n');
  await git(root, ['add', '-f', '.state/needle-hidden.txt', 'private-chat/needle-private.txt']);
  await git(root, ['commit', '-qm', 'hidden search targets']);

  const response = await app.inject({
    method: 'GET',
    url: '/api/code/demo/quick-open?repo=main&q=%20NEEDLE%20',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    files: ['needle-untracked.txt', 'src/Needle-literal.().ts'],
  });

  const allNames = Array.from({ length: 60 }, (_, index) => (
    `quick-limit-${String(index).padStart(2, '0')}.txt`
  ));

  for (const name of allNames) {
    await writeFile(path.join(root, name), 'fixture\n');
  }

  const limited = await app.inject({
    method: 'GET',
    url: '/api/code/demo/quick-open?repo=main&q=quick-limit-',
  });

  assert.equal(limited.statusCode, 200);
  assert.deepEqual(limited.json().files, allNames.slice(0, 50));

  const absent = await app.inject({
    method: 'GET',
    url: '/api/code/demo/quick-open?repo=main&q=zz-no-file',
  });

  assert.equal(absent.statusCode, 200);
  assert.deepEqual(absent.json(), { files: [] });

  for (const value of ['', ' ', '\0', 'a'.repeat(201)]) {
    const invalid = await app.inject({
      method: 'GET',
      url: `/api/code/demo/quick-open?repo=main&q=${encodeURIComponent(value)}`,
    });

    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error, 'bad_query');
  }

  // Меняется только декоратор локальной HTTP-фикстуры этого теста.
  app.pluginEnabled = () => false;

  const disabled = await app.inject({
    method: 'GET',
    url: '/api/code/demo/quick-open?repo=main&q=needle',
  });

  assert.equal(disabled.statusCode, 403);
  assert.equal(disabled.json().error, 'plugin_disabled');
});

test('CODE-COMMIT-SEARCH: порядок, полные запросы и range для коммита за первыми 50', async (t) => {
  const { root, privateDir } = await searchRepo(t);
  const app = await codeApp(t, root, privateDir);

  for (let index = 1; index <= 205; index += 1) {
    if (index === 130) {
      await writeFile(path.join(root, 'history-marker.txt'), 'old selected content\n');
      await git(root, ['add', 'history-marker.txt']);
    }

    const subject = index === 130 ? 'cap-marker OLD-TARGET' : `cap-marker ${index}`;

    await git(root, ['commit', '--allow-empty', '-qm', subject]);
  }

  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  const oldFull = (await git(root, ['rev-parse', 'HEAD~75'])).stdout.trim();
  const oldShort = (await git(root, ['log', '-1', '--format=%h', oldFull])).stdout.trim();
  const request = (q) => app.inject({
    method: 'GET',
    url: `/api/code/demo/commit-search?repo=main&q=${encodeURIComponent(q)}`,
  });
  const found = await request('old-target');

  assert.equal(found.statusCode, 200);
  assert.equal(found.json().head, head);
  assert.deepEqual(found.json().log.map(({ hash, subject, ordinal }) => ({
    hash,
    subject,
    ordinal,
  })), [{
    hash: oldShort,
    subject: 'cap-marker OLD-TARGET',
    ordinal: 75,
  }]);

  const byFullPrefix = await request(oldFull.slice(0, 16));

  assert.equal(byFullPrefix.statusCode, 200);
  assert.equal(byFullPrefix.json().log[0].hash, oldShort);
  assert.equal(byFullPrefix.json().log[0].oid, oldFull);

  const capped = await request('CAP-MARKER');

  assert.equal(capped.json().log.length, 50);
  assert.deepEqual(capped.json().log.map((entry) => entry.ordinal),
    Array.from({ length: 50 }, (_, index) => index));

  const outsideFull = (await git(root, ['rev-parse', 'HEAD~204'])).stdout.trim();
  const outside = await request(outsideFull);

  assert.deepEqual(outside.json(), { head, log: [] });

  const snapshot = await app.inject({ method: 'GET', url: '/api/code/demo/git?repo=main' });

  assert.equal(snapshot.json().log.length, 50);
  assert.equal(snapshot.json().log[0].hash, capped.json().log[0].hash);
  assert.equal(snapshot.json().log.some((entry) => entry.hash === oldShort), false);

  const range = await app.inject({
    method: 'GET',
    url: `/api/code/demo/commits-diff?repo=main&from=${oldShort}&to=${oldShort}`,
  });

  assert.equal(range.statusCode, 200);
  assert.equal(range.json().range.from, oldFull);
  assert.equal(range.json().range.to, oldFull);
  assert.equal(range.json().range.commits, 1);
  assert.ok(range.json().files.some((entry) => entry.path === 'history-marker.txt'));

  await git(root, ['config', 'core.abbrev', '4']);

  const shortConfigured = await request('old-target');
  const configuredEntry = shortConfigured.json().log[0];
  const configuredHash = (await git(root, ['log', '-1', '--format=%h', oldFull])).stdout.trim();

  assert.equal(configuredEntry.hash, configuredHash);
  assert.equal(configuredEntry.oid, oldFull);

  const fullRange = await app.inject({
    method: 'GET',
    url: `/api/code/demo/commits-diff?repo=main&from=${configuredEntry.oid}&to=${configuredEntry.oid}`,
  });

  assert.equal(fullRange.statusCode, 200);
  assert.equal(fullRange.json().range.from, oldFull);

  for (const q of ['', 'x', '   ', 'x'.repeat(201), 'ok\0bad']) {
    const invalid = await request(q);

    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error, 'bad_query');
  }
});

test('CODE-COMMIT-SEARCH-EMPTY: unborn возвращает успешный пустой журнал', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-code-history-empty-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q', '-b', 'main', '.']);

  const app = await codeApp(t, root, path.join(root, 'private-chat'));
  const response = await app.inject({
    method: 'GET',
    url: '/api/code/demo/commit-search?repo=main&q=anything',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { head: '', log: [] });
});
