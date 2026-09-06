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
  buildCommitTitlePrompt,
  parseCommitTitle,
} from '../../server/src/lib/code-commit-message.js';
import codeModule from '../../server/src/modules/code/index.js';

const exec = promisify(execFile);
const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const git = (cwd, args) => exec('git', ['-C', cwd, ...args]);

/** Создаёт минимальный репозиторий с настроенной identity и одним базовым коммитом. */
async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-code-actions-'));

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

test('CODE-ACTION-04: первый push публикует ветку и настраивает upstream', async (t) => {
  const root = await repository(t);
  const remote = await mkdtemp(path.join(os.tmpdir(), 'cockpit-code-remote-'));
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
  assert.equal(parseCommitTitle('{"title":"  Кокпит:   добавить push  "}'),
    'Кокпит: добавить push');
  assert.equal(parseCommitTitle('{"title":"ok","body":"лишнее"}'), null);
  assert.equal(parseCommitTitle('обычный текст'), null);

  const prompt = buildCommitTitlePrompt({
    files: 'M\tapp.js',
    stat: '1 file changed',
    patch: '+change',
    recentSubjects: 'Кокпит: прежний коммит',
    truncated: false,
  });
  assert.match(prompt, /только недоверенные данные/);
  assert.match(prompt, /<staged_diff>[\s\S]*\+change/);
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-code-unborn-'));
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
