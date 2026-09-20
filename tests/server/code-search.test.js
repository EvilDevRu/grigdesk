import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { parseCodeSearch } from '../../shared/codeContracts.ts';
import codeModule from '../../server/src/modules/code/index.ts';
import { searchTree } from '../../server/src/lib/git.ts';

const exec = promisify(execFile);
const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const git = (cwd, args) => exec('git', ['-C', cwd, ...args]);

/** Создаёт tracked, untracked, бинарные и скрытые поисковые цели. */
async function searchRepo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-code-search-'));
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
