import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'bin', 'release');

async function git(cwd, ...args) {
  return (await exec('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
}

/**
 * Временный стенд выпуска: bare origin и рабочий клон на main с VERSION 0.1.0.
 * Копия bin/release лежит внутри дерева — скрипт считает корнем каталог над собой,
 * как и в настоящем репозитории.
 */
async function makeRepo(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cockpit-release-script.'));
  t.after(() => rm(temp, { recursive: true, force: true }));

  const origin = path.join(temp, 'origin.git');
  const work = path.join(temp, 'work');
  await git(temp, 'init', '-q', '--bare', '-b', 'main', origin);
  await git(temp, 'init', '-q', '-b', 'main', work);
  await git(work, 'config', 'user.name', 'Cockpit Test');
  await git(work, 'config', 'user.email', 'cockpit@example.invalid');
  await mkdir(path.join(work, 'bin'));
  await copyFile(SCRIPT, path.join(work, 'bin', 'release'));
  await chmod(path.join(work, 'bin', 'release'), 0o755);
  await writeFile(path.join(work, 'VERSION'), '0.1.0\n');
  await writeFile(path.join(work, 'README.md'), 'начало\n');
  await git(work, 'add', '.');
  await git(work, 'commit', '-q', '-m', 'Кокпит: начальное состояние');
  await git(work, 'remote', 'add', 'origin', origin);
  await git(work, 'push', '-q', 'origin', 'main');

  return { temp, origin, work };
}

async function commitChange(work, message) {
  await writeFile(path.join(work, 'README.md'), `${message}\n`);
  await git(work, 'add', 'README.md');
  await git(work, 'commit', '-q', '-m', message);
}

/**
 * Запуск скрипта с подменой тестов и сборки. Маркер вне дерева доказывает, что
 * проверки действительно вызывались, и не делает checkout грязным.
 */
async function release(repo, args, { check } = {}) {
  const command = check ?? `printf ok > '${path.join(repo.temp, 'checked')}'`;
  const options = {
    cwd: repo.work,
    encoding: 'utf8',
    env: { ...process.env, COCKPIT_RELEASE_CHECK_COMMAND: command },
  };

  try {
    const result = await exec('bash', [path.join(repo.work, 'bin', 'release'), ...args], options);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') };
  }
}

test('пробный запуск печатает план и ничего не меняет', async (t) => {
  const repo = await makeRepo(t);
  await commitChange(repo.work, 'Кокпит: правка перед релизом');

  const result = await release(repo, ['minor', '--dry-run']);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /0\.1\.0 → 0\.2\.0 \(minor\)/);
  assert.match(result.stdout, /локальных коммитов к отправке: 1/);
  assert.match(result.stdout, /Первый стабильный релиз/);
  assert.match(result.stdout, /План: коммит «Кокпит: релиз v0\.2\.0» → тесты и сборка → тег v0\.2\.0/);
  assert.equal(await readFile(path.join(repo.work, 'VERSION'), 'utf8'), '0.1.0\n');
  assert.equal(await git(repo.work, 'tag', '-l'), '');
  await assert.rejects(stat(path.join(repo.temp, 'checked')), 'в пробном запуске тесты не гоняются');
});

test('bump готовит release-коммит и тег локально, publish отправляет атомарно и повторяем', async (t) => {
  const repo = await makeRepo(t);
  await commitChange(repo.work, 'Кокпит: новая возможность');
  await writeFile(path.join(repo.temp, 'notes.md'), 'Добавлен раздел выпуска.\n');

  const prepared = await release(repo, ['minor', '--no-github', '--notes', path.join(repo.temp, 'notes.md')]);

  assert.equal(prepared.code, 0, prepared.stderr);
  assert.equal(await readFile(path.join(repo.work, 'VERSION'), 'utf8'), '0.2.0\n');
  assert.equal(await git(repo.work, 'log', '-1', '--format=%s'), 'Кокпит: релиз v0.2.0');
  assert.equal(await git(repo.work, 'cat-file', '-t', 'v0.2.0'), 'tag', 'тег аннотированный');
  const head = await git(repo.work, 'rev-parse', 'HEAD');
  assert.equal(await git(repo.work, 'rev-parse', 'v0.2.0^{commit}'), head);
  const message = await git(repo.work, 'for-each-ref', 'refs/tags/v0.2.0', '--format=%(contents)');
  assert.match(message, /^Cockpit v0\.2\.0\n\nДобавлен раздел выпуска\./);
  await stat(path.join(repo.temp, 'checked'));
  assert.equal(await git(repo.origin, 'tag', '-l'), '', 'до publish тег наружу не уходит');
  assert.notEqual(await git(repo.origin, 'rev-parse', 'main'), head, 'до publish main не отправляется');
  assert.match(prepared.stdout, /Отправить: bin\/release publish/);

  const published = await release(repo, ['publish', '--no-github']);

  assert.equal(published.code, 0, published.stderr);
  assert.equal(await git(repo.origin, 'rev-parse', 'main'), head);
  assert.equal(
    await git(repo.origin, 'rev-parse', 'refs/tags/v0.2.0'),
    await git(repo.work, 'rev-parse', 'refs/tags/v0.2.0'),
  );

  const again = await release(repo, ['publish', '--no-github']);

  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /уже опубликован/);
});

test('явная версия, равная VERSION, ставит baseline-тег без нового коммита', async (t) => {
  const repo = await makeRepo(t);
  const head = await git(repo.work, 'rev-parse', 'HEAD');

  const result = await release(repo, ['0.1.0', '--push', '--no-github']);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /уже в VERSION, новый коммит не нужен/);
  assert.equal(await git(repo.work, 'rev-parse', 'HEAD'), head);
  assert.equal(await git(repo.origin, 'rev-parse', 'v0.1.0^{commit}'), head);
  assert.match(result.stdout, /Релиз v0\.1\.0 опубликован/);
});

test('заметки по умолчанию — коммиты с прошлого релиза без служебного release-коммита', async (t) => {
  const repo = await makeRepo(t);
  await git(repo.work, 'tag', '-a', 'v0.1.0', '-m', 'Cockpit v0.1.0');
  await git(repo.work, 'push', '-q', 'origin', 'v0.1.0');
  await commitChange(repo.work, 'Кокпит: первая правка');
  await commitChange(repo.work, 'Кокпит: вторая правка');

  const result = await release(repo, ['patch', '--no-github']);

  assert.equal(result.code, 0, result.stderr);
  const message = await git(repo.work, 'for-each-ref', 'refs/tags/v0.1.1', '--format=%(contents)');
  assert.match(message, /Изменения с v0\.1\.0:/);
  assert.match(message, /- Кокпит: вторая правка\n- Кокпит: первая правка/);
  assert.doesNotMatch(message, /релиз v0\.1\.1/);
});

test('упавшие проверки не ставят тег; повтор с явной версией доводит релиз', async (t) => {
  const repo = await makeRepo(t);
  const base = await git(repo.work, 'rev-parse', 'HEAD');

  const failed = await release(repo, ['patch', '--push', '--no-github'], { check: 'exit 1' });

  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, new RegExp(`git reset --hard ${base}`));
  assert.match(failed.stderr, /bin\/release 0\.1\.1/);
  assert.equal(await git(repo.work, 'tag', '-l'), '');
  assert.equal(await git(repo.origin, 'rev-parse', 'main'), base, 'наружу ничего не ушло');
  assert.equal(await readFile(path.join(repo.work, 'VERSION'), 'utf8'), '0.1.1\n');

  const retried = await release(repo, ['0.1.1', '--push', '--no-github']);

  assert.equal(retried.code, 0, retried.stderr);
  const head = await git(repo.work, 'rev-parse', 'HEAD');
  assert.equal(await git(repo.work, 'log', '-1', '--format=%s'), 'Кокпит: релиз v0.1.1');
  assert.equal(await git(repo.origin, 'rev-parse', 'v0.1.1^{commit}'), head);
  assert.equal(await git(repo.origin, 'rev-parse', 'main'), head);
});

test('отказы состояния: грязное дерево, чужая ветка, версия не выше, существующий тег', async (t) => {
  const repo = await makeRepo(t);

  await writeFile(path.join(repo.work, 'draft.txt'), 'черновик\n');
  let result = await release(repo, ['patch', '--dry-run']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /чистым/);
  await rm(path.join(repo.work, 'draft.txt'));

  await git(repo.work, 'switch', '-q', '-c', 'feature');
  result = await release(repo, ['patch', '--dry-run']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /только из ветки main/);
  await git(repo.work, 'switch', '-q', 'main');

  result = await release(repo, ['0.0.9', '--dry-run']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /ниже текущей/);

  // Стабильный тег старше целевой версии уже опубликован: VERSION отстал от origin.
  await git(repo.work, 'tag', '-a', 'v0.3.0', '-m', 'Cockpit v0.3.0');
  await git(repo.work, 'push', '-q', 'origin', 'v0.3.0');
  await git(repo.work, 'tag', '-d', 'v0.3.0');
  result = await release(repo, ['minor', '--dry-run']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /не выше последнего стабильного тега v0\.3\.0/);

  result = await release(repo, ['0.3.0', '--dry-run']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /уже опубликован/);

  await git(repo.work, 'tag', '-a', 'v0.4.0', '-m', 'Cockpit v0.4.0');
  result = await release(repo, ['0.4.0', '--dry-run']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /уже существует/);
});

test('publish отвергает lightweight-тег: кокпит такие теги не видит', async (t) => {
  const repo = await makeRepo(t);
  await git(repo.work, 'tag', 'v0.1.0');

  const result = await release(repo, ['publish', '--no-github']);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /не аннотированный/);
  assert.equal(await git(repo.origin, 'tag', '-l'), '');
});
