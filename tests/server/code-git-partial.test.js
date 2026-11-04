import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { git, indexBytes, mergeConflict, reviewFixture, success } from './code-review-fixture.js';

/**
 * Выбирает серверный атом по исходной координате новой стороны.
 * Идентификатор берётся из канонического ответа, клиентский patch не конструируется.
 */
function atomAt(diff, line) {
  const atom = diff.hunks.flatMap((hunk) => hunk.atoms).find((entry) => entry.newLine === line);

  assert.ok(atom, `Нет атома новой строки ${line}`);

  return atom.id;
}

const partial = async (fixture, group = 'work', file = 'app.txt') => success(
  await fixture.request('partial-diff', undefined, { group, path: file }), 'partial-diff',
);
const apply = (fixture, diff, atomIds, group = 'work', file = 'app.txt') => fixture.request(
  'partial-index', {
    group,
    path: file,
    token: diff.token,
    atomIds,
  },
);

test('CODE-PARTIAL-MIXED: stage C и unstage B сохраняют D и рабочие байты', async (t) => {
  const fixture = await reviewFixture(t);
  const { root, write } = fixture;

  await write('app.txt', 'a\nB\nc\nd\n');
  await git(root, ['add', 'app.txt']);
  await write('app.txt', 'a\nB\nC\nD\n');

  const disk = await readFile(path.join(root, 'app.txt'));
  const work = await partial(fixture);

  success(await apply(fixture, work, [atomAt(work, 3)]), 'stage C');
  assert.equal(await git(root, ['show', ':app.txt']), 'a\nB\nC\nd\n');
  assert.deepEqual(await readFile(path.join(root, 'app.txt')), disk);

  const staged = await partial(fixture, 'staged');

  success(await apply(fixture, staged, [atomAt(staged, 2)], 'staged'), 'unstage B');
  assert.equal(await git(root, ['show', ':app.txt']), 'a\nb\nC\nd\n');
  assert.deepEqual(await readFile(path.join(root, 'app.txt')), disk);
});

test('CODE-PARTIAL-LINES: C/D одного хунка независимы, весь хунк переносит оба', async (t) => {
  const fixture = await reviewFixture(t);

  await fixture.write('app.txt', 'a\nb\nC\nD\n');

  const diff = await partial(fixture);

  assert.equal(diff.hunks.length, 1);
  assert.notEqual(atomAt(diff, 3), atomAt(diff, 4));
  success(await apply(fixture, diff, [atomAt(diff, 3), atomAt(diff, 4)]), 'весь хунк');
  assert.equal(await git(fixture.root, ['show', ':app.txt']), 'a\nb\nC\nD\n');
});

for (const side of ['work', 'index']) {
  test(`CODE-PARTIAL-STALE: same-count ${side} отвергается без записи`, async (t) => {
    const fixture = await reviewFixture(t);

    await fixture.write('app.txt', 'a\nb\nC\nD\n');

    const diff = await partial(fixture);

    const disk = side === 'index' ? 'a\nb\nC\nD\n' : 'a\nb\nX\nY\n';

    if (side === 'index') {
      await fixture.write('app.txt', 'a\nB\nc\nd\n');
      await git(fixture.root, ['add', 'app.txt']);
    }

    await fixture.write('app.txt', disk);

    const before = await indexBytes(fixture.root);
    const response = await apply(fixture, diff, [atomAt(diff, 3)]);

    assert.equal(response.statusCode, 409, response.body);
    assert.deepEqual(await indexBytes(fixture.root), before);
    assert.equal(await readFile(path.join(fixture.root, 'app.txt'), 'utf8'), disk);
  });
}

for (const file of ['app.txt', 'пробел файл.txt', ':(glob)*.txt']) {
  for (const ending of ['\n', '\r\n', '']) {
    test(`CODE-PARTIAL-EDGES: literal ${file}, окончание ${JSON.stringify(ending)}`, async (t) => {
      const eol = ending === '\r\n' ? '\r\n' : '\n';
      const base = ['a', 'b', 'c'].join(eol) + ending;
      const changed = ['A', 'b', 'C'].join(eol) + ending;
      const fixture = await reviewFixture(t, { files: { [file]: base, 'neighbor.txt': 'сосед\n' } });

      await fixture.write(file, changed);

      const before = await git(fixture.root, ['show', ':neighbor.txt']);
      const diff = await partial(fixture, 'work', file);

      success(await apply(fixture, diff, [atomAt(diff, 1)], 'work', file), 'literal partial');
      assert.equal(await git(fixture.root, ['show', `:${file}`]), ['A', 'b', 'c'].join(eol) + ending);
      assert.equal(await git(fixture.root, ['show', ':neighbor.txt']), before);
      assert.equal(await readFile(path.join(fixture.root, file), 'utf8'), changed);
    });
  }
}

for (const unborn of [false, true]) {
  test(`CODE-PARTIAL-EDGES: новый файл, unborn=${unborn}`, async (t) => {
    const fixture = await reviewFixture(t, { unborn });

    await fixture.write('new.txt', 'first\nsecond\n');

    const diff = await partial(fixture, 'work', 'new.txt');

    success(await apply(fixture, diff, [atomAt(diff, 2)], 'work', 'new.txt'), 'часть нового');
    assert.equal(await git(fixture.root, ['show', ':new.txt']), 'second\n');
    assert.equal(await readFile(path.join(fixture.root, 'new.txt'), 'utf8'), 'first\nsecond\n');
  });
}

test('CODE-PARTIAL-EDGES: частичное удаление меняет только index', async (t) => {
  const fixture = await reviewFixture(t);

  await fixture.write('app.txt', '');

  const diff = await partial(fixture);
  const atoms = diff.hunks.flatMap((hunk) => hunk.atoms);

  success(await apply(fixture, diff, [atoms[0].id]), 'удаление одной строки');
  assert.equal(await git(fixture.root, ['show', ':app.txt']), 'b\nc\nd\n');
  assert.equal(await readFile(path.join(fixture.root, 'app.txt'), 'utf8'), '');
});

test('CODE-PARTIAL-EDGES: unstage текста rename сохраняет новое имя', async (t) => {
  const fixture = await reviewFixture(t);

  await git(fixture.root, ['mv', 'app.txt', 'renamed.txt']);
  await fixture.write('renamed.txt', 'a\nb\nC\nd\n');
  await git(fixture.root, ['add', 'renamed.txt']);

  const diff = await partial(fixture, 'staged', 'renamed.txt');

  success(await apply(fixture, diff, [atomAt(diff, 3)], 'staged', 'renamed.txt'), 'rename text');
  assert.equal(await git(fixture.root, ['show', ':renamed.txt']), 'a\nb\nc\nd\n');
  assert.equal(await git(fixture.root, ['ls-files', '--', 'app.txt']), '');
  assert.equal(await readFile(path.join(fixture.root, 'renamed.txt'), 'utf8'), 'a\nb\nC\nd\n');
});

test('CODE-PARTIAL-LOCK: чужой index.lock сохраняется, публикации нет', async (t) => {
  const fixture = await reviewFixture(t);

  await fixture.write('app.txt', 'a\nb\nC\nd\n');

  const diff = await partial(fixture);
  const before = await indexBytes(fixture.root);
  const lock = path.join(fixture.root, '.git/index.lock');

  await writeFile(lock, 'чужой lock');

  const response = await apply(fixture, diff, [atomAt(diff, 3)]);

  assert.equal(response.statusCode, 409, response.body);
  assert.deepEqual(await indexBytes(fixture.root), before);
  assert.equal(await readFile(lock, 'utf8'), 'чужой lock');
});

test('CODE-PARTIAL-EDGES: конфликт, binary и commits не получают partial', async (t) => {
  const fixture = await reviewFixture(t);
  const file = await mergeConflict(fixture);
  const before = await indexBytes(fixture.root);

  await fixture.write('binary.bin', Buffer.from([0, 1, 2]));

  for (const [group, selected] of [['work', file], ['work', 'binary.bin'], ['commits', file]]) {
    const response = await fixture.request('partial-diff', undefined, { group, path: selected });

    assert.ok([400, 409, 422].includes(response.statusCode), response.body);
    assert.deepEqual(await indexBytes(fixture.root), before);
  }
});

test('CODE-PARTIAL-EDGES: полный выбор удаления убирает entry, сосед остаётся', async (t) => {
  const fixture = await reviewFixture(t, { files: { 'app.txt': 'a\nb\n', 'keep.txt': 'сосед\n' } });

  await rm(path.join(fixture.root, 'app.txt'));


  const diff = await partial(fixture);
  const ids = diff.hunks.flatMap((hunk) => hunk.atoms.map((atom) => atom.id));

  success(await apply(fixture, diff, ids), 'полное удаление из индекса');
  assert.equal(await git(fixture.root, ['ls-files', '--', 'app.txt']), '');
  assert.equal(await git(fixture.root, ['show', ':keep.txt']), 'сосед\n');
  await assert.rejects(readFile(path.join(fixture.root, 'app.txt')), { code: 'ENOENT' });
});

test('CODE-PARTIAL-LOCK: отказ до публикации не оставляет свой lock и частный index', async (t) => {
  const fixture = await reviewFixture(t);

  await fixture.write('app.txt', 'a\nb\nC\nd\n');

  const diff = await partial(fixture);
  const before = await indexBytes(fixture.root);
  const response = await apply(fixture, diff, ['несуществующий-атом']);

  assert.ok([400, 409, 422].includes(response.statusCode), response.body);
  assert.deepEqual(await indexBytes(fixture.root), before);
  assert.equal(await readFile(path.join(fixture.root, 'app.txt'), 'utf8'), 'a\nb\nC\nd\n');
  await assert.rejects(readFile(path.join(fixture.root, '.git/index.lock')), { code: 'ENOENT' });
});

test('CODE-PARTIAL-LOCK: реальный apply отказал до publish, index/work прежние', async (t) => {
  const fixture = await reviewFixture(t);
  const exec = promisify(execFile);
  const realGit = (await exec('sh', ['-c', 'command -v git'])).stdout.trim();
  const bin = path.join(fixture.temp, 'bin');
  const wrapper = path.join(bin, 'git');
  const previousPath = process.env.PATH;

  await fixture.write('app.txt', 'a\nb\nC\nd\n');
  await mkdir(bin);
  await writeFile(wrapper, `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('apply') && !args.includes('--check')) process.exit(73);
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
  await chmod(wrapper, 0o755);

  const patchFile = path.join(fixture.temp, 'change.patch');
  const privateIndex = path.join(fixture.temp, 'probe.index');
  const before = await indexBytes(fixture.root);

  await writeFile(patchFile, await git(fixture.root, ['diff', '--', 'app.txt']));
  await writeFile(privateIndex, before);
  t.after(() => {
    process.env.PATH = previousPath;
  });
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  // Самопроверка инъекции доказывает, что check работает, а запись apply действительно отказала.
  await git(fixture.root, ['apply', '--cached', '--check', patchFile], {
    env: { ...process.env, GIT_INDEX_FILE: privateIndex },
  });
  await assert.rejects(git(fixture.root, ['apply', '--cached', patchFile], {
    env: { ...process.env, GIT_INDEX_FILE: privateIndex },
  }), { code: 73 });

  const diff = await partial(fixture);
  const response = await apply(fixture, diff, [atomAt(diff, 3)]);

  assert.ok(response.statusCode >= 400, response.body);
  assert.deepEqual(await indexBytes(fixture.root), before);
  assert.equal(await readFile(path.join(fixture.root, 'app.txt'), 'utf8'), 'a\nb\nC\nd\n');
  await assert.rejects(readFile(path.join(fixture.root, '.git/index.lock')), { code: 'ENOENT' });
});
