import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseEnv } from 'node:util';

import {
  EnvFileError,
  applyEnvChanges,
  readEnvFile,
  updateEnvFile,
} from '../../server/src/lib/envFile.ts';

/**
 * Временный каталог на тест: env-файл и соседи живут только в нём.
 * Права файла задаются явно, чтобы проверка их сохранения не зависела от umask.
 */
async function envFixture(t, content, mode = 0o600) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'env-file-'));
  const file = path.join(root, '.env');

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  if (content !== null) {
    await fs.writeFile(file, content);
    await fs.chmod(file, mode);
  }

  return { root, file };
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => error instanceof EnvFileError && error.code === code);
}

test('правка меняет только строки названных переменных и сохраняет остальные байты', async (t) => {
  const source = [
    '# Машинные настройки',
    '',
    'GRIGDESK_PORT=8140',
    'QUOTED="значение с пробелом"   # комментарий',
    'export EXPORTED=1',
    'WIN=crlf\r',
    '; комментарий systemd',
    'DEEPSEEK_API_KEY=old-key',
    'TAIL=без-перевода-строки',
  ].join('\n');
  const { file } = await envFixture(t, source);

  const result = await updateEnvFile(file, { DEEPSEEK_API_KEY: 'sk-new_key.1', NEW_KEY: 'a/b+c=' });

  assert.deepEqual(result.changed, ['DEEPSEEK_API_KEY', 'NEW_KEY']);
  assert.equal(await fs.readFile(file, 'utf8'), [
    '# Машинные настройки',
    '',
    'GRIGDESK_PORT=8140',
    'QUOTED="значение с пробелом"   # комментарий',
    'export EXPORTED=1',
    'WIN=crlf\r',
    '; комментарий systemd',
    'DEEPSEEK_API_KEY=sk-new_key.1',
    'TAIL=без-перевода-строки',
    'NEW_KEY=a/b+c=',
    '',
  ].join('\n'));
  assert.equal(parseEnv(await fs.readFile(file, 'utf8')).DEEPSEEK_API_KEY, 'sk-new_key.1');
});

test('задание меняет действующее последнее присваивание, удаление снимает все', async (t) => {
  const { file } = await envFixture(t, 'KEY=first\n# KEY=commented\nOTHER=x\nKEY=second\n');

  await updateEnvFile(file, { KEY: 'third' });
  assert.equal(await fs.readFile(file, 'utf8'), 'KEY=first\n# KEY=commented\nOTHER=x\nKEY=third\n');

  const removed = await updateEnvFile(file, { KEY: null, ABSENT: null });

  assert.deepEqual(removed.changed, ['KEY']);
  assert.equal(await fs.readFile(file, 'utf8'), '# KEY=commented\nOTHER=x\n');
});

test('строка с хвостом-комментарием переписывается: systemd читает хвост как часть значения', async (t) => {
  const { file } = await envFixture(t, 'KEY=same # заметка\nOTHER=1\n');

  const result = await updateEnvFile(file, { KEY: 'same' });

  assert.deepEqual(result.changed, ['KEY']);
  assert.equal(await fs.readFile(file, 'utf8'), 'KEY=same\nOTHER=1\n');
});

test('то же значение, даже в кавычках, файл не переписывает', async (t) => {
  const { file } = await envFixture(t, 'KEY="same"\n');
  const before = await fs.stat(file);

  const result = await updateEnvFile(file, { KEY: 'same' });
  const after = await fs.stat(file);

  assert.deepEqual(result.changed, []);
  assert.equal(after.ino, before.ino);
  assert.equal(await fs.readFile(file, 'utf8'), 'KEY="same"\n');
});

test('неоднозначный для systemd и Node файл не правится вовсе', async (t) => {
  const cases = [
    ['многострочные кавычки', 'A=1\nMULTI="first\nsecond"\n', 2],
    ['перенос через косую черту', 'A=1\nB=value\\\nC=2\n', 2],
    ['комментарий с переносом', '# note \\\nKEY=1\n', 1],
    ['непонятная строка', 'A=1\nnot an assignment\n', 2],
    ['кавычка в хвосте', 'A="x" "y\n', 1],
    ['экранированная кавычка', 'A="x\\"\n', 1],
  ];

  for (const [name, content, line] of cases) {
    const { file } = await envFixture(t, content);

    await assert.rejects(
      updateEnvFile(file, { KEY: 'value' }),
      (error) => error.code === 'env_file_unsupported' && error.line === line,
      name,
    );
    assert.equal(await fs.readFile(file, 'utf8'), content, name);
  }
});

test('недопустимые имя и значение отклоняются без значения в сообщении', async (t) => {
  const { file } = await envFixture(t, 'A=1\n');

  await rejectsWith(updateEnvFile(file, { 'bad-name': 'x' }), 'env_name_invalid');
  await rejectsWith(updateEnvFile(file, { lower: 'x' }), 'env_name_invalid');

  for (const value of ['with space', 'quote"', 'hash#tail', 'dollar$X', 'back\\slash', 'semi;colon']) {
    await assert.rejects(
      updateEnvFile(file, { KEY: value }),
      (error) => error.code === 'env_value_invalid' && !(value && error.message.includes(value)),
      value,
    );
  }

  await rejectsWith(updateEnvFile(file, ['KEY']), 'env_changes_invalid');
  assert.equal(await fs.readFile(file, 'utf8'), 'A=1\n');
});

test('права прежнего файла сохраняются, новый файл создаётся только для владельца', async (t) => {
  const existing = await envFixture(t, 'A=1\n', 0o640);

  await updateEnvFile(existing.file, { B: '2' });
  assert.equal((await fs.stat(existing.file)).mode & 0o777, 0o640);

  const fresh = await envFixture(t, null);

  await updateEnvFile(fresh.file, { A: '1' });
  assert.equal((await fs.stat(fresh.file)).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(fresh.file, 'utf8'), 'A=1\n');
});

test('символическая ссылка остаётся ссылкой, висячая — отказ', async (t) => {
  const { root, file } = await envFixture(t, 'A=1\n');
  const link = path.join(root, 'linked.env');

  await fs.symlink(file, link);

  const result = await updateEnvFile(link, { B: '2' });

  assert.equal(result.path, await fs.realpath(file));
  assert.ok((await fs.lstat(link)).isSymbolicLink());
  assert.equal(await fs.readFile(file, 'utf8'), 'A=1\nB=2\n');

  const dangling = path.join(root, 'dangling.env');

  await fs.symlink(path.join(root, 'missing.env'), dangling);
  await rejectsWith(updateEnvFile(dangling, { A: '1' }), 'env_file_not_regular');
  assert.ok((await fs.lstat(dangling)).isSymbolicLink());
});

test('жёсткая ссылка не разрывается молча', async (t) => {
  const { root, file } = await envFixture(t, 'A=1\n');

  await fs.link(file, path.join(root, 'hard.env'));
  await rejectsWith(updateEnvFile(file, { B: '2' }), 'env_file_not_regular');
  assert.equal(await fs.readFile(file, 'utf8'), 'A=1\n');
});

test('CRLF, BOM и отсутствие временных файлов после правки', async (t) => {
  const { root, file } = await envFixture(t, '\uFEFFA=1\r\nB=2\r\n');

  await updateEnvFile(file, { B: '3', C: '4' });

  assert.equal(await fs.readFile(file, 'utf8'), '\uFEFFA=1\r\nB=3\r\nC=4\r\n');
  assert.deepEqual(await fs.readdir(root), ['.env']);
});

test('параллельные правки одного файла не теряют друг друга', async (t) => {
  const { file } = await envFixture(t, '# шапка\n');
  const names = Array.from({ length: 12 }, (_, index) => `KEY_${index}`);

  await Promise.all(names.map((name, index) => updateEnvFile(file, { [name]: `v${index}` })));

  const values = parseEnv(await fs.readFile(file, 'utf8'));

  assert.deepEqual(names.map((name) => values[name]), names.map((_, index) => `v${index}`));
  assert.ok((await fs.readFile(file, 'utf8')).startsWith('# шапка\n'));
});

test('не UTF-8 файл не правится', async (t) => {
  const { file } = await envFixture(t, null);
  const bytes = Buffer.from([0x41, 0x3d, 0xff, 0x0a]);

  await fs.writeFile(file, bytes, { mode: 0o600 });
  await rejectsWith(updateEnvFile(file, { B: '1' }), 'env_file_unsupported');
  assert.ok((await fs.readFile(file)).equals(bytes));
});

test('условное удаление не стирает новую привязку, а совпавшую снимает вместе с дублями', async (t) => {
  const { file } = await envFixture(t, 'BIN=/old\nBIN=/new\nKEEP=1\n');

  await rejectsWith(updateEnvFile(file, { BIN: null }, { expected: { BIN: '/old' } }), 'env_file_conflict');
  assert.equal(await fs.readFile(file, 'utf8'), 'BIN=/old\nBIN=/new\nKEEP=1\n');
  await updateEnvFile(file, { BIN: null }, { expected: { BIN: '/new' } });
  assert.equal(await fs.readFile(file, 'utf8'), 'KEEP=1\n');
  await updateEnvFile(file, { BIN: null }, { expected: { BIN: null } });
  assert.equal(await fs.readFile(file, 'utf8'), 'KEEP=1\n');
});

test('чтение файла и перенос правок в окружение процесса', async (t) => {
  const { file } = await envFixture(t, 'A=1\nB="два"\n');
  const env = { A: 'old', KEEP: 'yes' };

  assert.deepEqual(await readEnvFile(file), { A: '1', B: 'два' });
  assert.deepEqual(await readEnvFile(`${file}.missing`), {});

  applyEnvChanges({
    A: 'new',
    KEEP: null,
    C: '3',
  }, env);
  assert.deepEqual(env, { A: 'new', C: '3' });
});
