// Источник рассказа: что из репозитория стенда доезжает до промпта по выбору человека.
//
// Главное — выбор не расширяется и не подменяется: подряд выбранные коммиты дают
// один кусок, пропуск — отдельный, слияние выбрать нельзя, а умолчание песочницы
// остаётся прежним diff ветки байт в байт. Проверка идёт на настоящем git.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { collectDiffContext } from '../../server/src/lib/showcase/script/context.ts';
import {
  assertSelectionCurrent,
  collectStoryContext,
  prepareSelection,
  readSourceOptions,
  sourceProblem,
} from '../../server/src/lib/showcase/script/source.ts';

const run = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.test',
};

async function git(cwd, args) {
  const { stdout } = await run('git', ['-C', cwd, ...args], { env: GIT_ENV });

  return stdout.trim();
}

/**
 * Коммит одного файла с заголовком и телом. Возвращает полный идентификатор: им
 * человек и выбирает коммит в списке.
 */
async function commitFile(root, file, content, message) {
  await writeFile(path.join(root, file), content, 'utf8');
  await git(root, ['add', file]);
  await git(root, ['commit', '-q', '-m', message]);

  return git(root, ['rev-parse', 'HEAD']);
}

/**
 * Ветка задачи из трёх коммитов поверх главной и незакоммиченная правка с новым
 * файлом — так выглядит ручная песочница, где часть работы уже закоммичена.
 */
async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-story-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  await git(root, ['init', '-q', '-b', 'main']);
  await commitFile(root, 'app.js', 'export const filter = false;\n', 'база');
  await git(root, ['checkout', '-q', '-b', 'route-task-1']);

  const first = await commitFile(
    root,
    'app.js',
    'export const filter = true;\n',
    'Фильтр включён\n\nТело первого',
  );
  const second = await commitFile(root, 'dialog.vue', '<template>Массовый съём</template>\n', 'Диалог съёма');
  const third = await commitFile(root, 'board.js', 'export const board = 1;\n', 'Доска задач');

  await writeFile(path.join(root, 'app.js'), 'export const filter = "черновик";\n', 'utf8');
  await writeFile(path.join(root, 'fresh.vue'), '<template>Новый экран</template>\n', 'utf8');

  return {
    root,
    first,
    second,
    third,
    repos: [{
      name: 'frontend',
      path: root,
      branch: 'route-task-1',
    }],
  };
}

/**
 * Выбор «О чём ролик» с одним репозиторием стенда: по умолчанию в нём ничего не
 * отмечено, и тест дописывает нужные коммиты и признак незакоммиченного.
 */
function choice(selection = {}) {
  return {
    task: true,
    note: '',
    code: true,
    repos: [{
      name: 'frontend',
      work: false,
      commits: [],
      ...selection,
    }],
  };
}

test('умолчание песочницы — прежний diff ветки байт в байт, а описания — её коммиты', async (t) => {
  const { repos } = await repository(t);
  const story = await collectStoryContext(repos, null, 'sandbox');
  const before = await collectDiffContext(repos);

  assert.equal(story.diff, before.diff, 'ролик без выбора не меняется');
  assert.equal(story.base, before.base);
  assert.match(story.commits, /Фильтр включён\n {2}Тело первого/);
  assert.match(story.commits, /Диалог съёма/);
  assert.ok(
    story.commits.indexOf('Фильтр включён') < story.commits.indexOf('Доска задач'),
    'описания идут от старого коммита к новому',
  );
  assert.doesNotMatch(story.commits, /база/, 'коммит главной ветки — не работа задачи');

  const project = await collectStoryContext(repos, null, 'project');

  assert.equal(project.diff, '', 'у постоянного стенда умолчание пустое');
  assert.equal(project.commits, '');
});

test('подряд выбранные коммиты склеиваются, а пропуск даёт отдельный кусок', async (t) => {
  const { repos, first, second, third } = await repository(t);
  const gap = await collectStoryContext(repos, choice({ commits: [first, third] }), 'sandbox');

  assert.match(gap.diff, new RegExp(`## коммит ${first.slice(0, 7)}\\n`));
  assert.match(gap.diff, new RegExp(`## коммит ${third.slice(0, 7)}\\n`));
  assert.match(gap.diff, /\+export const filter = true;/);
  assert.match(gap.diff, /\+export const board = 1;/);
  assert.doesNotMatch(gap.diff, /Массовый съём/, 'пропущенный коммит не читается');
  assert.doesNotMatch(gap.diff, /черновик/, 'незакоммиченное не выбрано');
  assert.doesNotMatch(gap.commits, /Диалог съёма/);

  const adjacent = await collectStoryContext(repos, choice({ commits: [second, first] }), 'sandbox');

  const range = `${first.slice(0, 7)}\\.\\.${second.slice(0, 7)}`;

  assert.match(adjacent.diff, new RegExp(`## коммиты ${range} \\(2\\)`));
  assert.match(adjacent.diff, /Массовый съём/);
  assert.equal(adjacent.diff.match(/^## коммит/gm).length, 1, 'два соседних коммита — один кусок');
  assert.doesNotMatch(adjacent.diff, /board/);
});

test('HEAD с незакоммиченным читается до диска, а одно незакоммиченное — своим куском', async (t) => {
  const { repos, third } = await repository(t);
  const head = await collectStoryContext(repos, choice({ commits: [third], work: true }), 'sandbox');

  assert.match(head.diff, new RegExp(`## коммит ${third.slice(0, 7)} и незакоммиченные правки`));
  assert.match(head.diff, /\+export const board = 1;/);
  assert.match(head.diff, /черновик/);
  assert.match(head.diff, /новый файл fresh\.vue/);
  assert.match(head.head, /frontend:рабочее дерево/);

  const work = await collectStoryContext(repos, choice({ work: true }), 'sandbox');

  assert.match(work.diff, /## незакоммиченные правки/);
  assert.match(work.diff, /черновик/);
  assert.doesNotMatch(work.diff, /board = 1/, 'закоммиченное без выбора не читается');
  assert.equal(work.commits, '', 'без выбранных коммитов описаний нет');
});

test('без кода модель видит сводку и имена новых файлов, но не строки', async (t) => {
  const { repos, first } = await repository(t);
  const story = await collectStoryContext(repos, {
    ...choice({ commits: [first], work: true }),
    code: false,
  }, 'sandbox');

  assert.match(story.diff, /app\.js \|/);
  assert.match(story.diff, /## новые файлы\nfresh\.vue/);
  assert.doesNotMatch(story.diff, /^\+/m, 'строк кода нет');
  assert.doesNotMatch(story.diff, /Новый экран/);
  assert.match(story.commits, /Фильтр включён/, 'описания коммитов остаются');
});

test('список выбора: линия ветки, свои коммиты, слияние без выбора и без путей', async (t) => {
  const { root, repos, first, second, third } = await repository(t);

  await git(root, ['stash', '-u', '-q']);
  await git(root, ['checkout', '-q', 'main']);

  const mainTip = await commitFile(root, 'readme.md', 'главная\n', 'Правка главной');

  await git(root, ['checkout', '-q', 'route-task-1']);
  await git(root, ['merge', '-q', '--no-ff', '-m', 'Слияние главной', 'main']);
  await git(root, ['stash', 'pop', '-q']);

  const merge = await git(root, ['rev-parse', 'HEAD']);
  const options = await readSourceOptions(repos, { kind: 'sandbox', taskAvailable: true });
  const [repo] = options.repos;
  const ids = repo.commits.map((commit) => commit.id);

  assert.equal(repo.branch, 'route-task-1');
  assert.equal(repo.workFiles, 2);
  assert.deepEqual(ids.slice(0, 4), [merge, third, second, first], 'линия по первому родителю');
  assert.equal(ids.includes(mainTip), false, 'коммит другой ветки в линию не входит');
  assert.equal(repo.commits[0].merge, true);
  assert.equal(repo.commits[1].own, true);
  assert.equal(repo.commits.at(-1).own, false, 'базовый коммит главной — не своя ветка');
  assert.deepEqual(options.defaults.repos[0].commits, [third, second, first]);
  assert.equal(options.defaults.repos[0].work, true);
  assert.equal(JSON.stringify(options).includes(root), false, 'путь на диске наружу не уходит');

  const project = await readSourceOptions(repos, { kind: 'project', taskAvailable: false });

  assert.deepEqual(project.defaults.repos[0].commits, [], 'у постоянного стенда ничего не выбрано');
  assert.equal(project.defaults.repos[0].work, false);
  assert.equal(project.defaults.task, false);
});

test('выбор проверяется по живой истории репозитория, а не по запросу', async (t) => {
  const { root, repos, first } = await repository(t);

  await git(root, ['stash', '-u', '-q']);
  await git(root, ['checkout', '-q', 'main']);
  await commitFile(root, 'readme.md', 'главная\n', 'Правка главной');
  await git(root, ['checkout', '-q', 'route-task-1']);
  await git(root, ['merge', '-q', '--no-ff', '-m', 'Слияние главной', 'main']);

  const merge = await git(root, ['rev-parse', 'HEAD']);

  assert.equal(await sourceProblem(null, repos), null);
  assert.equal(await sourceProblem(choice({ commits: [first], work: true }), repos), null);

  const stranger = {
    ...choice(),
    repos: [{
      name: 'чужой',
      work: true,
      commits: [],
    }],
  };

  assert.match(await sourceProblem(stranger, repos), /не принадлежит стенду/);
  assert.match(await sourceProblem(choice({ commits: [first.slice(0, 7)] }), repos), /полными/);
  assert.match(await sourceProblem(choice({ commits: ['f'.repeat(40)] }), repos), /не найден/);
  assert.match(await sourceProblem(choice({ commits: [merge] }), repos), /слияние/);
  assert.match(
    await sourceProblem({ ...choice(), note: 'я'.repeat(2001) }, repos),
    /длиннее 2000/,
  );
});

/**
 * Пустые коммиты одним вызовом оболочки: сотни отдельных процессов git из теста шли бы
 * секундами. Возвращает идентификаторы от нового к старому — позиции в списке выбора.
 */
async function emptyCommits(root, count) {
  const script = `for i in $(seq 1 ${count}); do git commit -q --allow-empty -m "шаг $i"; done`;

  await run('bash', ['-c', script], { cwd: root, env: GIT_ENV });

  return (await git(root, ['rev-list', `--max-count=${count}`, 'HEAD'])).split('\n');
}

function repoAt(root, branch = '') {
  return [{
    name: 'frontend',
    path: root,
    branch,
  }];
}

test('корень читается от пустого дерева, а репозиторий без коммитов — незакоммиченным', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-story-root-'));
  const empty = await mkdtemp(path.join(os.tmpdir(), 'showcase-story-empty-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(empty, { recursive: true, force: true }));

  await git(root, ['init', '-q', '-b', 'main']);
  await git(empty, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(empty, 'fresh.vue'), '<template>Новый экран</template>\n', 'utf8');

  const only = await commitFile(root, 'app.js', 'export const filter = false;\n', 'Первый коммит');
  const story = await collectStoryContext(repoAt(root, 'main'), choice({ commits: [only] }), 'sandbox');
  const work = await collectStoryContext(repoAt(empty), choice({ work: true }), 'sandbox');
  const options = await readSourceOptions(repoAt(empty), { kind: 'sandbox', taskAvailable: false });

  assert.match(story.diff, /\+export const filter = false;/);
  assert.match(story.commits, /Первый коммит/);
  assert.match(work.diff, /## новый файл fresh\.vue\n<template>Новый экран<\/template>/);
  assert.deepEqual(options.repos[0].commits, []);
  assert.equal(options.repos[0].error, null, 'репозиторий без коммитов — не ошибка чтения');
  assert.equal(options.repos[0].workFiles, 1);
});

// Каталог показывает 50 коммитов, а сохранённый выбор проверяется по окну 200: пока
// человек выбирал, ветка могла уйти вперёд. Всё выбранное вне списка остаётся видимым.
test('список — ровно 50 коммитов, проверка — окно 200, выбор вне списка виден', async (t) => {
  const { root, repos } = await repository(t);
  const newest = await emptyCommits(root, 201);
  const at = (position) => newest[position - 1];
  const saved = choice({ commits: [at(1), at(51), at(201)] });

  saved.repos.push({
    name: 'пропавший',
    work: true,
    commits: ['9'.repeat(40)],
  });

  const options = await readSourceOptions(repos, {
    kind: 'sandbox',
    taskAvailable: true,
    saved,
  });
  const [frontend, missing] = options.selectedOutsideCatalog;
  const states = Object.fromEntries(frontend.commits.map((commit) => [commit.id, commit]));

  assert.equal(options.repos[0].commits.length, 50);
  assert.equal(options.repos[0].commits[0].id, at(1));
  assert.equal(options.requiresExplicitSelectionConfirmation, true, 'своих коммитов больше, чем видно');
  assert.equal(frontend.name, 'frontend');
  assert.equal(at(1) in states, false, 'коммит из списка отдельной строкой не дублируется');
  assert.equal(states[at(51)].state, 'available');
  assert.equal(states[at(51)].subject, 'шаг 151');
  assert.equal(states[at(201)].state, 'outdated');
  assert.equal(states[at(201)].subject, null);
  assert.equal(missing.name, 'пропавший');
  assert.equal(missing.missing, true);
  assert.equal(await sourceProblem(choice({ commits: [at(51)] }), repos), null);
  assert.equal(await sourceProblem(choice({ commits: [at(200)] }), repos), null);
  assert.match(await sourceProblem(choice({ commits: [at(201)] }), repos), /не найден/);
});

test('короткая ветка без слияний подтверждения сужения не просит', async (t) => {
  const { repos } = await repository(t);
  const options = await readSourceOptions(repos, { kind: 'sandbox', taskAvailable: true });
  const project = await readSourceOptions(repos, { kind: 'project', taskAvailable: false });

  assert.equal(options.requiresExplicitSelectionConfirmation, false);
  assert.deepEqual(options.selectedOutsideCatalog, []);
  assert.equal(project.requiresExplicitSelectionConfirmation, false, 'умолчание стенда ничего не читает');
});

test('отказ git на явном выборе — ошибка без пути, а умолчание по-прежнему тихое', async (t) => {
  const gone = path.join(os.tmpdir(), `showcase-story-нет-${process.pid}`);
  const repos = repoAt(gone);
  const unavailable = (error) => (
    error.code === 'source_unavailable' && error.status === 503 && !error.message.includes(gone)
  );

  await assert.rejects(collectStoryContext(repos, choice({ work: true }), 'sandbox'), unavailable);
  await assert.rejects(sourceProblem(choice({ commits: ['a'.repeat(40)] }), repos), unavailable);
  assert.equal((await collectStoryContext(repos, null, 'sandbox')).diff, '', 'прежний путь не меняется');

  const options = await readSourceOptions(repos, { kind: 'sandbox', taskAvailable: false });

  assert.match(options.repos[0].error, /не читается/);
  assert.equal(options.requiresExplicitSelectionConfirmation, true, 'нечитаемое умолчание — повод спросить');
});

test('сдвиг HEAD между подготовкой и чтением делает выбор устаревшим', async (t) => {
  const { root, repos, first } = await repository(t);
  const prepared = await prepareSelection(repos, choice({ commits: [first] }).repos);

  await assertSelectionCurrent(prepared);
  await commitFile(root, 'late.js', 'export const late = 1;\n', 'Поздний коммит');
  await assert.rejects(
    assertSelectionCurrent(prepared),
    (error) => error.code === 'source_outdated' && /сдвинулась/.test(error.message),
  );
});

test('новые файлы явного выбора: имена как есть, исключения общие, без кода — без содержимого', async (t) => {
  const { root, repos } = await repository(t);
  const files = [
    ['новый экран.vue', '<template>Экран</template>\n'],
    ['две\nстроки.vue', '<template>Две</template>\n'],
    ['.env.local', 'TOKEN=секрет\n'],
    ['package-lock.json', '{}\n'],
    ['yarn.lock', 'lock\n'],
    ['tests/panel.test.js', 'test("панель", () => {});\n'],
  ];

  await mkdir(path.join(root, 'tests'), { recursive: true });

  for (const [name, content] of files) {
    await writeFile(path.join(root, name), content, 'utf8');
  }

  const cyrillic = await commitFile(root, 'фильтры.js', 'export const filters = 1;\n', 'Фильтры');
  const names = await collectStoryContext(repos, {
    ...choice({ commits: [cyrillic], work: true }),
    code: false,
  }, 'sandbox');
  const content = await collectStoryContext(repos, choice({ work: true }), 'sandbox');

  assert.match(names.diff, /фильтры\.js \|/, 'кириллица в сводке без восьмеричных кодов');
  assert.match(names.diff, /новый экран\.vue/);
  assert.ok(names.diff.includes(JSON.stringify('две\nстроки.vue')), 'перевод строки в имени не рвёт список');
  assert.doesNotMatch(names.diff, /<template>/, 'без кода содержимое новых файлов не читается');
  assert.match(content.diff, /## новый файл новый экран\.vue\n<template>Экран<\/template>/);

  for (const text of [names.diff, content.diff]) {
    assert.doesNotMatch(text, /\.env\.local|секрет|package-lock\.json|yarn\.lock|panel\.test\.js/);
  }
});

test('описание коммита — до 600 знаков с заголовком, весь блок — до 8000', async (t) => {
  const { root, repos } = await repository(t);
  const longMessage = `Длинный\n\n${'тело '.repeat(300)}`;
  const long = await commitFile(root, 'long.js', 'export const long = 1;\n', longMessage);
  const picked = [long];

  for (let index = 0; index < 20; index += 1) {
    const body = 'описание '.repeat(80);

    const content = `export const n = ${index};\n`;

    picked.push(await commitFile(root, `f${index}.js`, content, `Коммит ${index}\n\n${body}`));
  }

  const single = await collectStoryContext(repos, { ...choice({ commits: [long] }), code: false }, 'sandbox');
  const all = await collectStoryContext(repos, { ...choice({ commits: picked }), code: false }, 'sandbox');
  const entry = single.commits.slice(single.commits.indexOf('- '));

  assert.ok(entry.length <= 600 + 16, `описание одного коммита: ${entry.length} знаков`);
  assert.match(entry, /…$/);
  assert.ok(all.commits.length <= 8000, `блок описаний: ${all.commits.length} знаков`);
  assert.match(all.commits, /… \(описания коммитов обрезаны\)$/);
});

test('слияние между выбранными коммитами делит выбор и не приносит чужой ветки', async (t) => {
  const { root, repos, third } = await repository(t);

  await git(root, ['stash', '-u', '-q']);
  await git(root, ['checkout', '-q', '-b', 'side', 'main']);
  await commitFile(root, 'side.js', 'export const side = "чужая ветка";\n', 'Боковая ветка');
  await git(root, ['checkout', '-q', 'route-task-1']);
  await git(root, ['merge', '-q', '--no-ff', '-m', 'Слияние боковой', 'side']);

  const after = await commitFile(root, 'after.js', 'export const after = 1;\n', 'После слияния');
  const story = await collectStoryContext(repos, choice({ commits: [third, after] }), 'sandbox');

  assert.equal(story.diff.match(/^## коммит /gm).length, 2, 'слияние между ними делит выбор на два куска');
  assert.doesNotMatch(story.diff, /чужая ветка/);
  assert.match(story.diff, /board = 1/);
  assert.match(story.diff, /after = 1/);
});

test('повторы имён репозиториев и коммитов выбора отвергаются', async (t) => {
  const { repos, first } = await repository(t);
  const twice = {
    ...choice(),
    repos: [...choice().repos, ...choice().repos],
  };

  assert.match(await sourceProblem(twice, repos), /назван дважды/);
  assert.match(await sourceProblem(choice({ commits: [first, first] }), repos), /повторяются/);
});

test('новые ссылки не читают файлы вне репозитория или исключённое окружение', async (t) => {
  const { root, repos } = await repository(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'showcase-story-outside-'));

  t.after(() => rm(outside, { recursive: true, force: true }));

  await writeFile(path.join(outside, 'private.txt'), 'PRIVATE_OUTSIDE_CONTENT\n');
  await writeFile(path.join(root, '.env.local'), 'PRIVATE_ENV_CONTENT\n');
  await symlink(path.join(outside, 'private.txt'), path.join(root, 'alias.txt'));
  await symlink('.env.local', path.join(root, 'config.txt'));

  for (const source of [null, choice({ work: true })]) {
    const story = await collectStoryContext(repos, source, 'sandbox');

    assert.doesNotMatch(story.diff, /PRIVATE_OUTSIDE_CONTENT|PRIVATE_ENV_CONTENT/);
    assert.match(story.diff, /Новый экран/, 'обычные новые файлы остаются в контексте');
  }
});

test('обрезка новых файлов помечает контекст неполным', async (t) => {
  const { root, repos } = await repository(t);

  await writeFile(path.join(root, 'large.txt'), 'я'.repeat(20_000));

  for (const source of [null, choice({ work: true })]) {
    const story = await collectStoryContext(repos, source, 'sandbox');

    assert.match(story.diff, /файл обрезан/);
    assert.equal(story.truncated, true, 'интерфейс должен сообщить о неполном чтении');
  }
});

test('управляющий символ в описании не создаёт поддельный коммит каталога', async (t) => {
  const { root, repos } = await repository(t);
  const message = 'Описание\n\nДо разделителя\x1eПосле разделителя';
  const id = await commitFile(root, 'message.js', 'export const message = 1;\n', message);
  const options = await readSourceOptions(repos, { kind: 'sandbox', taskAvailable: false });
  const story = await collectStoryContext(repos, choice({ commits: [id] }), 'sandbox');

  assert.equal(options.repos[0].commits.length, 5, 'описание не добавляет запись истории');
  assert.ok(options.repos[0].commits.every((commit) => /^[a-f0-9]{40}$/.test(commit.id)));
  assert.match(story.commits, /До разделителя\x1eПосле разделителя/);
});

test('полный идентификатор SHA-256 выбирается и читается от пустого дерева', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-story-sha256-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  await git(root, ['init', '-q', '-b', 'main', '--object-format=sha256']);

  const id = await commitFile(root, 'app.js', 'export const ready = true;\n', 'Первый коммит');
  const repos = repoAt(root);

  assert.equal(id.length, 64);
  assert.equal(await sourceProblem(choice({ commits: [id] }), repos), null);
  assert.match((await collectStoryContext(repos, choice({ commits: [id] }), 'project')).diff, /ready = true/);
});

test('чтение изменений не запускает внешние diff и textconv из настроек репозитория', async (t) => {
  for (const driver of ['external', 'textconv']) {
    for (const explicit of [false, true]) {
      await t.test(`${driver}, явный выбор: ${explicit}`, async (part) => {
        const { root, repos } = await repository(part);
        const converter = path.join(root, '.git', 'converter');
        const marker = path.join(root, '.git', 'converter-called');

        await writeFile(converter, [
          '#!/bin/sh',
          'printf invoked > "$(dirname "$0")/converter-called"',
          'printf replacement',
          '',
        ].join('\n'), { mode: 0o700 });

        if (driver === 'external') {
          await git(root, ['config', 'diff.external', converter]);
        } else {
          await writeFile(path.join(root, '.git', 'info', 'attributes'), '*.js diff=custom\n');
          await git(root, ['config', 'diff.custom.textconv', converter]);
        }

        const source = explicit ? choice({ work: true }) : null;
        const story = await collectStoryContext(repos, source, 'sandbox');

        await assert.rejects(access(marker), { code: 'ENOENT' }, 'репозиторий не исполнил свою команду');
        assert.match(story.diff, /черновик/, 'в контекст попали исходные изменения');
      });
    }
  }
});
