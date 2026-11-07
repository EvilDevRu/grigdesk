import assert from 'node:assert/strict';
import { rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { scanText, scanRepository } from './helpers/privateIdentifiers.mjs';
import { ROOT, scratch, put, repository, run, ok } from '../fixtures/pipelineSample.mjs';

const THIS_FILE = path.relative(ROOT, import.meta.filename);
const PUBLIC_UPSTREAM = ['Evil', 'DevRu'].join('');

test('detector distinguishes private values from documented synthetic fixtures', () => {
  const privateHome = '/home/operator-name/project';
  const unknownChat = '-1003141592653';

  assert.equal(scanText('server/example.js', privateHome).length, 1);
  assert.equal(scanText('server/example.js', unknownChat).length, 1);
  assert.equal(scanText('server/example.js', 'profiles/customer-project/profile.sh').length, 1);
  assert.equal(scanText('tests/example.js', 'https://t.me/customer_team/42').length, 1);
  assert.equal(scanText('tests/example.js', 'abcdef12-3456-4789-abcd-ef1234567890').length, 1);
  assert.deepEqual(scanText('tests/example.js', '/home/user/project -1001000000042'), []);
  assert.deepEqual(scanText('tests/example.js', 'profiles/fixture https://t.me/example_team/42'), []);
  assert.deepEqual(scanText('tests/example.js', '00000000-0000-4000-8000-000000000001'), []);
  assert.deepEqual(scanText('README.md', PUBLIC_UPSTREAM), []);
  assert.equal(scanText('web/example.vue', PUBLIC_UPSTREAM).length, 1);
  assert.equal(scanText('docs/x.md', 'profiles/Customer-Project/profile.sh').length, 1);
});

// Живые ссылки карт снятой базы знаний несли runtime UUID законно; карт больше нет, и
// документация областей ссылается на файлы, поэтому исключения для UUID не осталось.
test('detector ловит runtime UUID и в бывшей ссылке карты, и голым', () => {
  const uuid = ['abcdef12', '3456', '4789', 'abcd', 'ef1234567890'].join('-');
  const cases = [
    `- [Проверенная запись](#/knowledge/${uuid}) · карта, ссылка`,
    `Голая identity ${uuid}`,
  ];

  assert.deepEqual(
    cases.map((source) => scanText('docs/grigdesk/example/README.md', source).length),
    [1, 1],
  );
});

test('Д2: имя с заглавной буквой ловится, символ Profiles не считается путём', () => {
  // План называет эти значения искусственными fixtures. Неизвестные соседи
  // остаются под прежними положительными assertions detector-теста выше.
  const synthetic = [
    'Profiles/clientRuntime',
    '12345678-1234-4234-8234-123456789abc',
    '11111111-2222-4333-8444-555555555555',
    'profiles/private.json',
    'profiles/sentinel',
    'profiles/s27-sentinel',
  ];

  assert.deepEqual(synthetic.map((source) => scanText('docs/x.md', source).length), [0, 0, 0, 0, 0, 0]);
});

test('regular-file scan skips links and still checks untracked sample files', async (t) => {
  const root = await scratch(t);
  const source = await repository(root);
  const outside = await put(root, 'outside/private.md', '/home/operator-name/project');

  await symlink(path.dirname(outside), path.join(source, 'directory-link'));
  await symlink(outside, path.join(source, 'file-link'));
  await symlink(path.join(root, 'missing'), path.join(source, 'broken-link'));
  await put(source, 'tracked.md', '/home/operator-name/tracked');
  await put(source, 'vanished.md', 'Исчезающий tracked файл');
  ok(run('git', ['-C', source, 'add', '.']));
  await rm(path.join(source, 'vanished.md'));
  await put(source, 'server/seed/pipeline-sample/untracked.md', '/home/operator-name/untracked');
  await put(source, 'binary.bin', '/home/operator-name/binary\0');
  await put(source, 'oversized.md', `${'x'.repeat(4 * 1024 * 1024)}/home/operator-name/oversized`);

  const hits = await scanRepository(source);

  assert.equal(hits.length, 2);
  assert.ok(hits.some((hit) => hit.startsWith('tracked.md:1:')));
  assert.ok(hits.some((hit) => hit.startsWith('server/seed/pipeline-sample/untracked.md:1:')));
  assert.ok(hits.every((hit) => !hit.includes('-link')));
});

test('sample injection detects a concrete profile name and home path', async (t) => {
  const root = await scratch(t);
  const source = await repository(root);
  const relative = 'server/seed/pipeline-sample/README.md';
  const file = await put(source, relative, 'Общий образец.\n');

  assert.deepEqual(await scanRepository(source), []);

  for (const injection of ['профиль customer-project', '/home/operator-name/project',
    'https://customer-project.example.org']) {
    await writeFile(file, `Общий образец.\n${injection}\n`);

    const hits = await scanRepository(source);

    assert.equal(hits.length, 1, injection);
    assert.ok(hits[0].startsWith(`${relative}:2:`));
  }

  await writeFile(file, 'Общий образец.\n');
  assert.deepEqual(await scanRepository(source), []);
});

test('tracked text contains no private profile, account, host or runtime identifiers', async () => {
  assert.deepEqual(await scanRepository(ROOT, [THIS_FILE]), []);
});
