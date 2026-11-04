import assert from 'node:assert/strict';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { git, indexBytes, reviewFixture, success } from './code-review-fixture.js';

/**
 * Предварительный ответ используется целиком как подтверждённый состав ignore.
 * Тест не подменяет экранирование правила: его проверяет настоящий git check-ignore.
 */
async function ignore(fixture, paths, target, query = {}) {
  const responsePreview = await fixture.request('ignore-preview', { paths, target }, query);
  const preview = success(responsePreview, 'ignore-preview');
  const response = await fixture.request('ignore', {
    paths,
    target,
    token: preview.token,
  }, query);

  return { preview, response };
}

for (const target of ['shared', 'local']) {
  test(`CODE-IGNORE-TARGET: ${target}, только выбранный файл и без дублей`, async (t) => {
    const fixture = await reviewFixture(t);
    const { root, write } = fixture;

    await write('.gitignore', '# общие\r\nexisting.txt\r\n');
    await write('.git/info/exclude', '# локальные\n');
    await write('new.txt', 'байты нового файла\n');

    const before = await indexBytes(root);
    const sharedBefore = await readFile(path.join(root, '.gitignore'), 'utf8');
    const localBefore = await readFile(path.join(root, '.git/info/exclude'), 'utf8');
    const first = await ignore(fixture, ['new.txt'], target);

    success(first.response, 'ignore');
    assert.equal((await git(root, ['check-ignore', '--no-index', '--', 'new.txt'])).trim(), 'new.txt');
    assert.equal(await readFile(path.join(root, 'new.txt'), 'utf8'), 'байты нового файла\n');
    assert.deepEqual(await indexBytes(root), before);

    const changed = target === 'shared' ? '.gitignore' : '.git/info/exclude';
    const untouched = target === 'shared' ? '.git/info/exclude' : '.gitignore';
    const rules = await readFile(path.join(root, changed), 'utf8');

    assert.match(rules, /\/new\.txt/);
    assert.ok(rules.startsWith(target === 'shared' ? sharedBefore : localBefore));
    assert.equal(await readFile(path.join(root, untouched), 'utf8'),
      target === 'shared' ? localBefore : sharedBefore);

    // Повтор того же подтверждённого правила не должен создавать вторую строку.
    const repeated = await fixture.request('ignore', {
      paths: ['new.txt'],
      target,
      token: first.preview.token,
    });

    assert.ok([200, 409].includes(repeated.statusCode), repeated.body);
    assert.equal(await readFile(path.join(root, changed), 'utf8'), rules);
  });
}

for (const file of ['[ab]*?.txt', '#заметка !.txt', 'пробел файл.txt', 'trailing ']) {
  test(`CODE-IGNORE-LITERAL: точное anchored правило для ${JSON.stringify(file)}`, async (t) => {
    const fixture = await reviewFixture(t);

    await fixture.write(file, 'новый\n');
    await fixture.write('neighbor.txt', 'сосед\n');
    await fixture.write(`nested/${file}`, 'вложенный\n');

    const { response } = await ignore(fixture, [file], 'shared');

    success(response, 'literal ignore');
    // Без --no-index Git сопоставляет метасимволы имени с tracked app.txt ещё до проверки ignore.
    assert.equal(await git(fixture.root, ['check-ignore', '--no-index', '--', file]), `${file}\n`);
    await assert.rejects(git(fixture.root, ['check-ignore', '--no-index', '--', 'neighbor.txt']),
      { code: 1 });
    await assert.rejects(git(fixture.root, ['check-ignore', '--no-index', '--', `nested/${file}`]),
      { code: 1 });
    assert.equal(await readFile(path.join(fixture.root, file), 'utf8'), 'новый\n');
  });
}

for (const staged of [false, true]) {
  test(`CODE-IGNORE-TRACKED: tracked/staged=${staged} не снимается из индекса`, async (t) => {
    const fixture = await reviewFixture(t);

    await fixture.write('app.txt', 'изменено\n');

    if (staged) {
      await git(fixture.root, ['add', 'app.txt']);
    }

    const before = await indexBytes(fixture.root);
    const response = await fixture.request('ignore-preview', { paths: ['app.txt'], target: 'shared' });

    assert.equal(response.statusCode, 409, response.body);
    assert.deepEqual(await indexBytes(fixture.root), before);
    assert.equal(await readFile(path.join(fixture.root, 'app.txt'), 'utf8'), 'изменено\n');
    await assert.rejects(readFile(path.join(fixture.root, '.gitignore')), { code: 'ENOENT' });
  });
}

test('CODE-IGNORE-TARGET: linked worktree пишет Git-resolved общий exclude', async (t) => {
  const fixture = await reviewFixture(t);
  const linked = path.join(fixture.temp, 'linked');

  await git(fixture.root, ['worktree', 'add', '-qb', 'linked', linked]);
  await writeFile(path.join(linked, 'local.txt'), 'локальный\n');

  const { response } = await ignore(fixture, ['local.txt'], 'local', { root: linked });

  success(response, 'local ignore');

  const mainExclude = (await git(fixture.root, ['rev-parse', '--git-path', 'info/exclude'])).trim();
  const linkedExclude = (await git(linked, ['rev-parse', '--git-path', 'info/exclude'])).trim();

  assert.equal(path.resolve(linked, linkedExclude), path.resolve(fixture.root, mainExclude));
  assert.equal((await git(linked, ['check-ignore', '--no-index', '--', 'local.txt'])).trim(), 'local.txt');
});

test('CODE-IGNORE-TARGET: внешняя правка правил после preview не теряется', async (t) => {
  const fixture = await reviewFixture(t);

  await fixture.write('.gitignore', '# исходный\r\n');
  await fixture.write('new.txt', 'новый\n');

  const preview = success(await fixture.request('ignore-preview', {
    paths: ['new.txt'], target: 'shared',
  }), 'ignore preview');

  await fixture.write('.gitignore', '# чужая правка\r\n');

  const response = await fixture.request('ignore', {
    paths: ['new.txt'],
    target: 'shared',
    token: preview.token,
  });

  assert.equal(response.statusCode, 409, response.body);
  assert.equal(await readFile(path.join(fixture.root, '.gitignore'), 'utf8'), '# чужая правка\r\n');
});

test('CODE-IGNORE-TARGET: symlink rules запрещён без записи в цель', async (t) => {
  const fixture = await reviewFixture(t);

  await fixture.write('outside.txt', 'не менять\n');
  await fixture.write('new.txt', 'новый\n');
  await symlink('outside.txt', path.join(fixture.root, '.gitignore'));

  const response = await fixture.request('ignore-preview', { paths: ['new.txt'], target: 'shared' });

  assert.ok([400, 403, 409].includes(response.statusCode), response.body);
  assert.equal(await readFile(path.join(fixture.root, 'outside.txt'), 'utf8'), 'не менять\n');
});

test('CODE-IGNORE-TARGET: disabled и неверный root не создают правила', async (t) => {
  const fixture = await reviewFixture(t);

  await fixture.write('new.txt', 'новый\n');

  const before = await indexBytes(fixture.root);
  const badRoot = await fixture.request('ignore-preview', {
    paths: ['new.txt'], target: 'local',
  }, { root: path.join(fixture.temp, 'чужой') });

  assert.ok([400, 404].includes(badRoot.statusCode), badRoot.body);
  fixture.disable();

  const disabled = await fixture.request('ignore-preview', { paths: ['new.txt'], target: 'shared' });

  assert.equal(disabled.statusCode, 403, disabled.body);
  assert.deepEqual(await indexBytes(fixture.root), before);
});

test('CODE-IGNORE-TARGET: каталог получает anchored правило с / без удаления файлов', async (t) => {
  const fixture = await reviewFixture(t);

  await fixture.write('new/sub/a.txt', 'новый\n');
  await fixture.write('new-other/b.txt', 'сосед\n');

  const payload = { directory: 'new', target: 'shared' };
  const preview = success(await fixture.request('ignore-preview', payload), 'ignore directory preview');

  success(await fixture.request('ignore', { ...payload, token: preview.token }), 'ignore directory');
  assert.equal((await git(fixture.root, ['check-ignore', '--no-index', '--', 'new/sub/a.txt'])).trim(),
    'new/sub/a.txt');
  await assert.rejects(git(fixture.root, ['check-ignore', '--no-index', '--', 'new-other/b.txt']),
    { code: 1 });
  assert.equal(await readFile(path.join(fixture.root, 'new/sub/a.txt'), 'utf8'), 'новый\n');
  assert.match(await readFile(path.join(fixture.root, '.gitignore'), 'utf8'), /\/new\//);
});
