import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const releaseScript = fileURLToPath(new URL('../../relay/scripts/releaseTag.mts', import.meta.url));
const runtimeFile = new URL('../../relay/build/node-runtime.json', import.meta.url);

/**
 * Создаёт отдельную рабочую папку с входами выпуска и при необходимости git-историей.
 * Явное окружение исключает настройки человека и переменные настоящего запуска Actions.
 */
async function createRepository(t, { version = '0.1.0', git = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-release-'));

  t.after(() => rm(directory, { recursive: true, force: true }));

  const output = path.join(directory, 'output');
  const env = {
    PATH: process.env.PATH,
    HOME: directory,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: path.dirname(directory),
    GIT_AUTHOR_NAME: 'Тест посредника',
    GIT_AUTHOR_EMAIL: 'relay@example.invalid',
    GIT_COMMITTER_NAME: 'Тест посредника',
    GIT_COMMITTER_EMAIL: 'relay@example.invalid',
    GITHUB_REF: 'refs/heads/main',
    DEFAULT_BRANCH: 'main',
    GITHUB_OUTPUT: output,
  };

  await mkdir(path.join(directory, 'relay/build'), { recursive: true });
  await writeFile(path.join(directory, 'relay/package.json'), JSON.stringify({ version }));
  await copyFile(runtimeFile, path.join(directory, 'relay/build/node-runtime.json'));
  await writeFile(output, '');

  if (git) {
    await execute('git', ['init', '-q'], { cwd: directory, env });
    await execute('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: directory, env });
  }

  return {
    directory,
    output,
    env,
  };
}

/**
 * Запускает настоящий скрипт из корня фикстуры и сохраняет его код и оба потока вывода.
 * Переопределения касаются только явно перечисленного окружения этой фикстуры.
 */
async function runRelease(repository, env = {}, args = []) {
  try {
    const result = await execute(process.execPath, [releaseScript, ...args], {
      cwd: repository.directory,
      env: { ...repository.env, ...env },
    });

    return {
      code: 0,
      ...result,
    };
  } catch (error) {
    if (typeof error.code !== 'number') {
      throw error;
    }

    return {
      code: error.code,
      stdout: error.stdout,
      stderr: error.stderr,
    };
  }
}

test('RL-45: посредник выпускается через общий workflow комплекта', async () => {
  const text = await readFile(
    new URL('../../.github/workflows/grigdesk-release.yml', import.meta.url), 'utf8',
  );
  const runtime = JSON.parse(await readFile(runtimeFile, 'utf8'));
  const uses = [...text.matchAll(/^\s+uses:\s+(\S+)/gm)].map((match) => {
    return match[1];
  });

  assert.match(text, /^  workflow_dispatch:/m);
  assert.doesNotMatch(text, /^  push:/m);
  assert.match(text, /^permissions:\n  contents: read$/m);
  assert.match(text, /persist-credentials: false/);
  assert.ok(text.includes(`node-version: ${runtime.version}`));
  assert.equal(uses.length, 3);

  for (const action of uses) {
    assert.match(action, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
  }

  let previous = -1;

  for (const command of [
    'npm --prefix server ci',
    'npm --prefix web ci',
    'npm --prefix tracker ci',
    'npm --prefix relay ci',
    'npm --prefix deepseek ci',
    'npm --prefix desktop ci',
    'npm --prefix server test',
    'npm --prefix web test',
    'node tools/bundle.mts',
    'node tools/release-publish.mts "$PWD"',
  ]) {
    const index = text.indexOf(command);

    assert.ok(index > previous, command);
    previous = index;
  }

  assert.doesNotMatch(text, /gh release create|contents: write/);
  await assert.rejects(
    readFile(new URL('../../.github/workflows/relay-release.yml', import.meta.url)),
    { code: 'ENOENT' },
  );
});

test('RL-50: выпуск возвращает метку и версию Node без изменения прежних выходов', async (t) => {
  const repository = await createRepository(t);
  const runtime = JSON.parse(await readFile(runtimeFile, 'utf8'));
  const expected = `tag=relay-v0.1.0\nnode=${runtime.version}\n`;
  const result = await runRelease(repository);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'relay-v0.1.0\n');
  assert.equal(await readFile(repository.output, 'utf8'), expected);

  await writeFile(repository.output, 'previous=value\n');

  const appended = await runRelease(repository);

  assert.equal(appended.code, 0, appended.stderr);
  assert.equal(await readFile(repository.output, 'utf8'), `previous=value\n${expected}`);
});

test('RL-51: выпуск разрешён только из ветки по умолчанию', async (t) => {
  for (const ref of ['refs/heads/dev', 'refs/tags/relay-v0.1.0']) {
    await t.test(ref, async (t) => {
      const repository = await createRepository(t);
      const result = await runRelease(repository, { GITHUB_REF: ref });

      assert.equal(result.code, 1);
      assert.equal(await readFile(repository.output, 'utf8'), '');
      assert.ok(result.stderr.includes('main'), result.stderr);
      assert.ok(result.stderr.includes(ref), result.stderr);
    });
  }
});

test('RL-52: существующая лёгкая или аннотированная метка запрещает повторный выпуск', async (t) => {
  for (const annotated of [false, true]) {
    await t.test(annotated ? 'аннотированная' : 'лёгкая', async (t) => {
      const repository = await createRepository(t);
      const args = annotated ? ['tag', '-a', 'relay-v0.1.0', '-m', 'release'] : ['tag', 'relay-v0.1.0'];

      await execute('git', args, { cwd: repository.directory, env: repository.env });

      const result = await runRelease(repository);

      assert.equal(result.code, 1);
      assert.equal(await readFile(repository.output, 'utf8'), '');
      assert.ok(result.stderr.includes('0.1.0'), result.stderr);
      assert.ok(result.stderr.includes('Поднимите version в relay/package.json'), result.stderr);
    });
  }
});

test('RL-53: версия выпуска состоит ровно из трёх чисел', async (t) => {
  for (const version of ['0.1', '1.2.3-beta', 'v1.2.3']) {
    await t.test(version, async (t) => {
      const repository = await createRepository(t, { version });
      const result = await runRelease(repository);

      assert.equal(result.code, 1);
      assert.equal(await readFile(repository.output, 'utf8'), '');
      assert.ok(result.stderr.includes(version), result.stderr);
    });
  }
});

test('RL-54: неполное окружение и лишние аргументы дают ошибку использования', async (t) => {
  for (const variable of ['GITHUB_REF', 'DEFAULT_BRANCH', 'GITHUB_OUTPUT']) {
    await t.test(variable, async (t) => {
      const repository = await createRepository(t);
      const result = await runRelease(repository, { [variable]: '' });

      assert.equal(result.code, 2);
      assert.equal(await readFile(repository.output, 'utf8'), '');
      assert.ok(result.stderr.includes(variable), result.stderr);
    });
  }

  await t.test('лишний аргумент', async (t) => {
    const repository = await createRepository(t);
    const result = await runRelease(repository, {}, ['extra']);

    assert.equal(result.code, 2);
    assert.equal(await readFile(repository.output, 'utf8'), '');
  });
});

test('RL-55: ошибка проверки меток не считается отсутствием метки', async (t) => {
  const repository = await createRepository(t, { git: false });
  const result = await runRelease(repository);

  assert.equal(result.code, 1);
  assert.equal(await readFile(repository.output, 'utf8'), '');
  assert.ok(result.stderr.includes('Не удалось проверить метки'), result.stderr);
});
