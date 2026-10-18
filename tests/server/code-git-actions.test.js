// Git-действия плагина «Код»: staging/unstaging, commit, push и название по staged diff.
// Главный инвариант — состав индекса меняют только явные `+/-`; commit и модель не
// подтягивают рабочее дерево скрыто и не видят правки поверх индекса.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  COMMIT_TITLE_MAX,
  buildCommitTitlePrompt,
  generateCommitTitle,
  parseCommitTitle,
} from '../../server/src/lib/codeCommitMessage.ts';
import { COMMIT_MESSAGE_MAX } from '../../server/src/lib/git.ts';
import codeModule from '../../server/src/modules/code/index.ts';

const exec = promisify(execFile);
const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const git = (cwd, args) => exec('git', ['-C', cwd, ...args]);

/** Создаёт минимальный репозиторий с настроенной identity и одним базовым коммитом. */
async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-code-actions-'));

  await git(root, ['init', '-q', '-b', 'main', '.']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'user.name', 'test']);
  await writeFile(path.join(root, 'app.js'), 'base\n');
  await writeFile(path.join(root, 'old.js'), 'rename me\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-qm', 'init']);

  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Поднимает только code-модуль с одним проектом и управляемой моделью теста. */
async function codeApp(t, root, {
  commitMessageModel = null,
  resolveCommitTarget = null,
  providerSettings = {},
} = {}) {
  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', () => true);
  app.decorate('pluginSettings', () => ({ commitMessageModel }));
  app.register(codeModule, {
    config: {
      profilesDir: path.join(root, 'no-profiles'),
      chatsDir: path.join(root, 'chats'),
      telegramDir: path.join(root, 'telegram'),
      githubDir: path.join(root, 'github'),
    },
    prefs: {
      read: () => ({
        projects: {
          demo: {
            repos: [{ key: 'main', dir: root }],
          },
        },
        providerSettings,
      }),
    },
    ...(resolveCommitTarget ? { resolveCommitTarget } : {}),
  });
  await app.ready();
  t.after(() => app.close());

  return app;
}

function actionUrl(action) {
  return `/api/code/demo/${action}?repo=main`;
}

async function gitSnapshot(app) {
  const response = await app.inject({
    method: 'GET',
    url: '/api/code/demo/git?repo=main',
  });

  assert.equal(response.statusCode, 200);
  return response.json();
}

test('CODE-ACTION-01: `+/-` одного файла и группы меняют только индекс', async (t) => {
  const root = await repository(t);
  const app = await codeApp(t, root);

  await writeFile(path.join(root, 'app.js'), 'base\nstaged\n');
  await git(root, ['add', 'app.js']);
  await writeFile(path.join(root, 'app.js'), 'base\nstaged\nwork\n');
  await writeFile(path.join(root, 'new.js'), 'new\n');

  const staged = await app.inject({
    method: 'POST',
    url: actionUrl('stage'),
    payload: { paths: ['new.js'] },
  });
  assert.equal(staged.statusCode, 200);

  let snapshot = await gitSnapshot(app);
  assert.ok(snapshot.staged.some((file) => file.path === 'new.js'));
  assert.ok(snapshot.files.some((file) => file.path === 'app.js'));

  const unstaged = await app.inject({
    method: 'POST',
    url: actionUrl('unstage'),
    payload: { paths: ['new.js'] },
  });
  assert.equal(unstaged.statusCode, 200);

  snapshot = await gitSnapshot(app);
  assert.ok(!snapshot.staged.some((file) => file.path === 'new.js'));
  assert.ok(snapshot.files.some((file) => file.path === 'new.js'));

  const stageAll = await app.inject({
    method: 'POST',
    url: actionUrl('stage'),
    payload: { all: true },
  });
  assert.equal(stageAll.statusCode, 200);
  assert.equal((await gitSnapshot(app)).files.length, 0);

  const unstageAll = await app.inject({
    method: 'POST',
    url: actionUrl('unstage'),
    payload: { all: true },
  });
  assert.equal(unstageAll.statusCode, 200);
  snapshot = await gitSnapshot(app);
  assert.equal(snapshot.staged.length, 0);
  assert.ok(snapshot.files.some((file) => file.path === 'new.js'));
});

test('CODE-ACTION-02: `−` переименования возвращает оба пути из индекса', async (t) => {
  const root = await repository(t);
  const app = await codeApp(t, root);

  await git(root, ['mv', 'old.js', 'renamed.js']);
  const before = await gitSnapshot(app);
  assert.equal(before.staged.find((file) => file.path === 'renamed.js')?.oldPath, 'old.js');

  const response = await app.inject({
    method: 'POST',
    url: actionUrl('unstage'),
    payload: { paths: ['renamed.js'] },
  });
  assert.equal(response.statusCode, 200);

  const cached = await git(root, ['diff', '--cached', '--name-only']);
  assert.equal(cached.stdout.trim(), '');
  assert.equal((await readFile(path.join(root, 'renamed.js'), 'utf8')), 'rename me\n');
});

test('CODE-DISCARD-01: откат рабочей правки сохраняет подготовленную часть', async (t) => {
  const root = await repository(t);
  const app = await codeApp(t, root);

  await writeFile(path.join(root, 'app.js'), 'base\nstaged\n');
  await git(root, ['add', 'app.js']);
  await writeFile(path.join(root, 'app.js'), 'base\nstaged\nwork\n');

  const response = await app.inject({
    method: 'POST',
    url: actionUrl('discard'),
    payload: { paths: ['app.js'] },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true, changed: 1 });
  assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'base\nstaged\n');
  assert.match((await git(root, ['diff', '--cached', '--', 'app.js'])).stdout, /staged/);
});

test('CODE-DISCARD-02: откат восстанавливает удалённый tracked-файл', async (t) => {
  const root = await repository(t);
  const app = await codeApp(t, root);

  await rm(path.join(root, 'app.js'));
  const response = await app.inject({
    method: 'POST',
    url: actionUrl('discard'),
    payload: { paths: ['app.js'] },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'base\n');
});

test('CODE-DISCARD-03: откат передаёт pathspec-подобное имя буквально', async (t) => {
  const root = await repository(t);
  const special = ':(glob)*.txt';

  await writeFile(path.join(root, special), 'special base\n');
  await writeFile(path.join(root, 'keep.txt'), 'keep base\n');
  await git(root, ['add', '--', special, 'keep.txt']);
  await git(root, ['commit', '-qm', 'literal files']);
  await writeFile(path.join(root, special), 'special changed\n');
  await writeFile(path.join(root, 'keep.txt'), 'keep changed\n');

  const app = await codeApp(t, root);
  const response = await app.inject({
    method: 'POST',
    url: actionUrl('discard'),
    payload: { paths: [special] },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(await readFile(path.join(root, special), 'utf8'), 'special base\n');
  assert.equal(await readFile(path.join(root, 'keep.txt'), 'utf8'), 'keep changed\n');
});

test('CODE-CLEAN-01: удаляется только проверенный untracked-путь', async (t) => {
  const root = await repository(t);

  await writeFile(path.join(root, 'trash.js'), 'trash\n');
  await writeFile(path.join(root, 'keep-new.js'), 'keep\n');

  const app = await codeApp(t, root);
  const rejected = await app.inject({
    method: 'POST',
    url: actionUrl('clean'),
    payload: { paths: ['trash.js', 'app.js'] },
  });

  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.json().error, 'bad_paths');
  assert.equal(await readFile(path.join(root, 'trash.js'), 'utf8'), 'trash\n');

  const cleaned = await app.inject({
    method: 'POST',
    url: actionUrl('clean'),
    payload: { paths: ['trash.js'] },
  });

  assert.equal(cleaned.statusCode, 200);
  await assert.rejects(readFile(path.join(root, 'trash.js'), 'utf8'), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(root, 'keep-new.js'), 'utf8'), 'keep\n');
  assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'base\n');
});

test('CODE-ACTION-03: commit берёт staged snapshot и оставляет рабочую правку', async (t) => {
  const root = await repository(t);
  const app = await codeApp(t, root);

  await writeFile(path.join(root, 'app.js'), 'base\nstaged\n');
  await git(root, ['add', 'app.js']);
  await writeFile(path.join(root, 'app.js'), 'base\nstaged\nwork\n');
  await writeFile(path.join(root, 'not-added.js'), 'outside commit\n');

  const response = await app.inject({
    method: 'POST',
    url: actionUrl('commit'),
    payload: { message: 'Код: проверить точный состав коммита' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().subject, 'Код: проверить точный состав коммита');

  const committed = await git(root, ['show', 'HEAD:app.js']);
  assert.equal(committed.stdout, 'base\nstaged\n');
  assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'base\nstaged\nwork\n');

  const tracked = await git(root, ['ls-files', 'not-added.js']);
  assert.equal(tracked.stdout.trim(), '');
  const snapshot = await gitSnapshot(app);
  assert.equal(snapshot.staged.length, 0);
  assert.ok(snapshot.files.some((file) => file.path === 'app.js'));
  assert.ok(snapshot.files.some((file) => file.path === 'not-added.js'));
});

test('CODE-AMEND-01: amend меняет HEAD и включает индекс без нового коммита', async (t) => {
  const root = await repository(t);
  const app = await codeApp(t, root);

  await writeFile(path.join(root, 'app.js'), 'base\namended\n');
  await git(root, ['add', 'app.js']);
  const beforeCount = Number((await git(root, ['rev-list', '--count', 'HEAD'])).stdout.trim());

  const response = await app.inject({
    method: 'POST',
    url: actionUrl('commit'),
    payload: { message: 'Исправленный заголовок', amend: true },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().subject, 'Исправленный заголовок');
  assert.equal(Number((await git(root, ['rev-list', '--count', 'HEAD'])).stdout.trim()), beforeCount);
  assert.equal((await git(root, ['show', 'HEAD:app.js'])).stdout, 'base\namended\n');
});

test('CODE-AMEND-02: опубликованный HEAD нельзя переписать', async (t) => {
  const root = await repository(t);
  const remote = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-code-amend-remote-'));

  t.after(() => rm(remote, { recursive: true, force: true }));
  await git(remote, ['init', '--bare', '-q', '.']);
  await git(root, ['remote', 'add', 'origin', remote]);
  await git(root, ['push', '-qu', 'origin', 'main']);
  await writeFile(path.join(root, 'app.js'), 'published changed\n');
  await git(root, ['add', 'app.js']);
  const before = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  const app = await codeApp(t, root);

  const response = await app.inject({
    method: 'POST',
    url: actionUrl('commit'),
    payload: { message: 'Нельзя переписать', amend: true },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'amend_published');
  assert.equal((await git(root, ['rev-parse', 'HEAD'])).stdout.trim(), before);
  assert.equal((await git(root, ['log', '-1', '--pretty=%s'])).stdout.trim(), 'init');
});

test('CODE-AMEND-03: amend до первого коммита возвращает no_head', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-code-amend-unborn-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q', '-b', 'main', '.']);
  await writeFile(path.join(root, 'first.js'), 'first\n');
  await git(root, ['add', 'first.js']);
  const app = await codeApp(t, root);
  const response = await app.inject({
    method: 'POST',
    url: actionUrl('commit'),
    payload: { message: 'Некого дополнять', amend: true },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'no_head');
});

test('CODE-UNDO-01: отмена HEAD возвращает его файлы в индекс и сообщение', async (t) => {
  const root = await repository(t);

  await writeFile(path.join(root, 'app.js'), 'base\nsecond\n');
  await git(root, ['add', 'app.js']);
  await git(root, ['commit', '-qm', 'Второй коммит\n\nПодробности']);
  const beforeCount = Number((await git(root, ['rev-list', '--count', 'HEAD'])).stdout.trim());
  const app = await codeApp(t, root);
  const response = await app.inject({
    method: 'POST',
    url: actionUrl('undo-commit'),
    payload: {},
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    ok: true,
    message: 'Второй коммит\n\nПодробности',
  });
  assert.equal(Number((await git(root, ['rev-list', '--count', 'HEAD'])).stdout.trim()),
    beforeCount - 1);
  assert.match((await git(root, ['diff', '--cached', '--', 'app.js'])).stdout, /second/);
});

test('CODE-UNDO-02: опубликованный HEAD нельзя отменить', async (t) => {
  const root = await repository(t);
  const remote = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-code-undo-remote-'));

  t.after(() => rm(remote, { recursive: true, force: true }));
  await writeFile(path.join(root, 'app.js'), 'base\npublished\n');
  await git(root, ['add', 'app.js']);
  await git(root, ['commit', '-qm', 'published']);
  await git(remote, ['init', '--bare', '-q', '.']);
  await git(root, ['remote', 'add', 'origin', remote]);
  await git(root, ['push', '-qu', 'origin', 'main']);
  const before = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  const app = await codeApp(t, root);
  const response = await app.inject({
    method: 'POST',
    url: actionUrl('undo-commit'),
    payload: {},
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'commit_published');
  assert.equal((await git(root, ['rev-parse', 'HEAD'])).stdout.trim(), before);
});

test('CODE-UNDO-03: единственный коммит нельзя отменить через soft reset', async (t) => {
  const root = await repository(t);
  const app = await codeApp(t, root);
  const response = await app.inject({
    method: 'POST',
    url: actionUrl('undo-commit'),
    payload: {},
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'no_parent');
  assert.equal((await git(root, ['log', '--oneline'])).stdout.trim().split('\n').length, 1);
});

test('CODE-ACTION-04: первый push публикует ветку и настраивает upstream', async (t) => {
  const root = await repository(t);
  const remote = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-code-remote-'));
  t.after(() => rm(remote, { recursive: true, force: true }));

  await git(remote, ['init', '--bare', '-q', '.']);
  await git(root, ['remote', 'add', 'origin', remote]);
  const app = await codeApp(t, root);

  const response = await app.inject({
    method: 'POST',
    url: actionUrl('push'),
    payload: {},
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().published, true);
  assert.equal(response.json().tracking.upstream, 'origin/main');

  const remoteHead = await git(remote, ['rev-parse', 'refs/heads/main']);
  const localHead = await git(root, ['rev-parse', 'HEAD']);
  assert.equal(remoteHead.stdout.trim(), localHead.stdout.trim());
});

test('CODE-FETCH-01: fetch обновляет remote-ref и показывает отставание', async (t) => {
  const root = await repository(t);
  const remote = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-code-fetch-remote-'));
  const other = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-code-fetch-other-'));

  t.after(() => rm(remote, { recursive: true, force: true }));
  t.after(() => rm(other, { recursive: true, force: true }));
  await git(remote, ['init', '--bare', '-q', '.']);
  await git(root, ['remote', 'add', 'origin', remote]);
  await git(root, ['push', '-qu', 'origin', 'main']);
  await git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await exec('git', ['clone', '-q', remote, other]);
  await git(other, ['config', 'user.email', 'other@example.com']);
  await git(other, ['config', 'user.name', 'other']);
  await writeFile(path.join(other, 'remote.js'), 'remote\n');
  await git(other, ['add', 'remote.js']);
  await git(other, ['commit', '-qm', 'remote commit']);
  await git(other, ['push', '-q', 'origin', 'main']);

  const app = await codeApp(t, root);
  assert.equal((await gitSnapshot(app)).tracking.behind, 0);

  const response = await app.inject({
    method: 'POST',
    url: actionUrl('fetch'),
    payload: {},
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().remote, 'origin');
  assert.equal(response.json().tracking.behind, 1);
  assert.equal(response.json().tracking.ahead, 0);
});

test('CODE-FETCH-02: fetch без upstream и origin возвращает no_remote', async (t) => {
  const root = await repository(t);
  const app = await codeApp(t, root);
  const response = await app.inject({
    method: 'POST',
    url: actionUrl('fetch'),
    payload: {},
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'no_remote');
});

test('CODE-FETCH-03: ошибка fetch не раскрывает credentials remote', async (t) => {
  const root = await repository(t);

  await git(root, ['remote', 'add', 'origin', 'https://user:pass@127.0.0.1:1/missing.git']);

  const app = await codeApp(t, root);
  const response = await app.inject({
    method: 'POST',
    url: actionUrl('fetch'),
    payload: {},
  });
  const body = response.json();

  assert.equal(response.statusCode, 409);
  assert.doesNotMatch(body.message, /user|pass/);
  assert.match(body.message, /нужен доступ к remote/i);
});

test('CODE-ACTION-05: генератор видит staged diff, модель и выбранный effort', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'app.js'), 'base\nstaged marker\n');
  await git(root, ['add', 'app.js']);
  await writeFile(path.join(root, 'app.js'), 'base\nstaged marker\nUNSTAGED_SECRET\n');

  const calls = [];
  const modelRef = {
    provider: 'claude',
    model: 'claude-test',
    effort: 'high',
  };
  const providerSettings = {
    claude: {
      custom: true,
    },
  };
  const resolveCommitTarget = async (args) => {
    calls.push({ kind: 'resolve', args });
    return {
      ok: true,
      ref: {
        provider: 'claude',
        model: 'claude-test',
      },
      effort: 'high',
      executor: {
        async runUntrusted(runArgs) {
          calls.push({ kind: 'run', args: runArgs });
          return {
            reply: '```json\n{"title":"Код: добавить Git-действия"}\n```',
          };
        },
      },
    };
  };
  const app = await codeApp(t, root, {
    commitMessageModel: modelRef,
    resolveCommitTarget,
    providerSettings,
  });

  const response = await app.inject({
    method: 'POST',
    url: actionUrl('commit-message'),
    payload: {},
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().title, 'Код: добавить Git-действия');

  const resolved = calls.find((call) => call.kind === 'resolve').args;
  assert.deepEqual(resolved.modelRef, modelRef);
  assert.equal(resolved.requireImages, false);

  const run = calls.find((call) => call.kind === 'run').args;
  assert.equal(run.model, 'claude-test');
  assert.equal(run.effort, 'high');
  assert.deepEqual(run.providerSettings, providerSettings.claude);
  assert.match(run.message, /staged marker/);
  assert.doesNotMatch(run.message, /UNSTAGED_SECRET/);
});

test('CODE-ACTION-06: парсер принимает только точный JSON с одной строкой title', () => {
  assert.equal(parseCommitTitle('{"title":"  GrigDesk:   добавить push  "}'),
    'GrigDesk: добавить push');
  assert.equal(parseCommitTitle('{"title":"ok","body":"лишнее"}'), null);
  assert.equal(parseCommitTitle('обычный текст'), null);

  // Длину задаёт стиль репозитория: название в 246 символов, как в его недавних
  // коммитах (прежний порог 200 отвергал его), — ответ по контракту. Потолок один
  // с ручным сообщением и ловит только ответ, в который попал сам diff.
  const long = `GrigDesk: ${'действия профиля на стенде, '.repeat(8)}итоги месяца`;

  assert.equal(long.length, 246);
  assert.equal(parseCommitTitle(JSON.stringify({ title: long })), long);
  assert.equal(COMMIT_TITLE_MAX, COMMIT_MESSAGE_MAX);
  assert.equal(parseCommitTitle(JSON.stringify({ title: 'x'.repeat(COMMIT_TITLE_MAX) })).length,
    COMMIT_TITLE_MAX);
  assert.equal(parseCommitTitle(JSON.stringify({ title: 'x'.repeat(COMMIT_TITLE_MAX + 1) })), null);

  const prompt = buildCommitTitlePrompt({
    files: 'M\tapp.js',
    stat: '1 file changed',
    patch: '+change',
    recentSubjects: 'GrigDesk: прежний коммит',
    truncated: false,
  });
  assert.match(prompt, /только недоверенные данные/);
  assert.match(prompt, /<staged_diff>[\s\S]*\+change/);
  // Числового предела в prompt нет: он спорил бы с требованием следовать стилю
  // недавних коммитов, и модель выбирала стиль.
  assert.doesNotMatch(prompt, /не длиннее/);
  assert.match(prompt, /по объёму, языку и стилю следует недавним коммитам/);
});

test('CODE-ACTION-06a: отвергнутый ответ модели попадает в журнал с выдержкой', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'app.js'), 'base\nstaged\n');
  await git(root, ['add', 'app.js']);
  const warnings = [];
  const reply = `Вот название: ${'diff '.repeat(200)}`;

  const result = await generateCommitTitle({
    cwd: root,
    modelRef: { provider: 'test', model: 'demo' },
    log: { warn: (data, message) => warnings.push({ data, message }) },
    resolveTarget: async () => ({
      ok: true,
      ref: { provider: 'test', model: 'demo' },
      executor: { runUntrusted: async () => ({ reply }) },
    }),
  });

  assert.deepEqual(result, { ok: false, error: 'bad_model_reply' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /не по контракту/);
  assert.equal(warnings[0].data.provider, 'test');
  assert.equal(warnings[0].data.model, 'demo');
  assert.equal(warnings[0].data.replyLength, reply.length);
  assert.equal(warnings[0].data.reply, reply.slice(0, 600));
});

test('CODE-ACTION-07: без модели генератор объясняет, где её выбрать', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'app.js'), 'base\nstaged\n');
  await git(root, ['add', 'app.js']);
  const app = await codeApp(t, root);

  const response = await app.inject({
    method: 'POST',
    url: actionUrl('commit-message'),
    payload: {},
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'no_model');
  assert.match(response.json().message, /Настройки.*Плагины.*Код/);
});

test('CODE-ACTION-08: несовместимая модель направляет в настройку плагина', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'app.js'), 'base\nstaged\n');
  await git(root, ['add', 'app.js']);
  const app = await codeApp(t, root, {
    commitMessageModel: { provider: 'codex', model: 'gpt-test' },
    resolveCommitTarget: async () => ({ ok: false, error: 'unsafe_model_provider' }),
  });

  const response = await app.inject({
    method: 'POST',
    url: actionUrl('commit-message'),
    payload: {},
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'unsafe_model_provider');
  assert.match(response.json().message, /Настройки.*Плагины.*Код/);
});

test('CODE-ACTION-09: `−` работает и до первого коммита', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-code-unborn-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await git(root, ['init', '-q', '-b', 'main', '.']);
  await writeFile(path.join(root, 'first.js'), 'first\n');
  await git(root, ['add', 'first.js']);
  const app = await codeApp(t, root);

  assert.ok((await gitSnapshot(app)).staged.some((file) => file.path === 'first.js'));
  const response = await app.inject({
    method: 'POST',
    url: actionUrl('unstage'),
    payload: { all: true },
  });
  assert.equal(response.statusCode, 200);

  const snapshot = await gitSnapshot(app);
  assert.equal(snapshot.staged.length, 0);
  assert.ok(snapshot.files.some((file) => file.path === 'first.js'));
  assert.equal(await readFile(path.join(root, 'first.js'), 'utf8'), 'first\n');
});
