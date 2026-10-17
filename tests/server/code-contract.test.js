// Реальные HTTP-ответы «Кода» проходят те же декодеры, что использует браузер.
// Git-мутации ограничены временным репозиторием; модель заменена локальным транспортом.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import codeModule from '../../server/src/modules/code/index.ts';
import {
  parseCodeCommitResponse,
  parseCodeCommitTitleResponse,
  parseCodeDirectory,
  parseCodeFile,
  parseCodeGit,
  parseCodePushResponse,
  parseCodeRepos,
  parseCodeRoots,
  parseCodeStageResponse,
} from '../../shared/plugins/code/codeContracts.ts';

const exec = promisify(execFile);
const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const git = (cwd, args) => exec('git', ['-C', cwd, ...args]);
const actionUrl = (action) => `/api/code/demo/${action}?repo=main`;

/**
 * Локальный проект с одним коммитом позволяет проверить индекс, worktree и push,
 * не затрагивая рабочую копию человека и не обращаясь к внешнему remote.
 */
async function fixture(t, resolveCommitTarget = async () => ({ ok: false, error: 'no_model' })) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cockpit-code-contract-'));
  const root = path.join(temp, 'repo');
  const remote = path.join(temp, 'remote');

  await mkdir(root);
  await mkdir(remote);
  await git(root, ['init', '-q', '-b', 'main', '.']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'user.name', 'test']);
  await writeFile(path.join(root, 'app.ts'), 'export const value = 1;\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-qm', 'Начальное состояние']);
  await git(remote, ['init', '--bare', '-q', '.']);
  await git(root, ['remote', 'add', 'origin', remote]);

  let enabled = true;
  const app = Fastify({ logger: false });

  app.decorate('pluginEnabled', () => enabled);
  app.decorate('pluginSettings', () => ({ commitMessageModel: { provider: 'test', model: 'test' } }));
  app.register(codeModule, {
    config: { profilesDir: path.join(temp, 'profiles') },
    prefs: {
      read: () => ({
        projects: { demo: { repos: [{ key: 'main', dir: root }] } },
        providerSettings: { test: { selected: true } },
      }),
    },
    resolveCommitTarget,
  });
  await app.ready();
  t.after(async () => {
    await app.close();
    await rm(temp, { recursive: true, force: true });
  });

  return {
    app,
    root,
    remote,
    disable: () => {
      enabled = false;
    },
  };
}

/** Проверяет HTTP-статус до декодирования сериализованного ответа маршрута. */
async function request(app, method, action, parse, payload) {
  const response = await app.inject({ method, url: actionUrl(action), payload });

  assert.equal(response.statusCode, 200, response.body);

  return parse(response.json());
}

test('CODE-CONTRACT-01: чтение и Git-действия сериализуются по общему TS-контракту', async (t) => {
  const { app, root } = await fixture(t);
  const rootsResponse = await app.inject('/api/code/roots');

  assert.equal(rootsResponse.statusCode, 200);
  assert.equal(parseCodeRoots(rootsResponse.json()).roots[0].root, root);

  const repos = await request(app, 'GET', 'repos', parseCodeRepos);
  const directory = await request(app, 'GET', 'ls', parseCodeDirectory);
  const fileResponse = await app.inject(`${actionUrl('file')}&path=app.ts`);

  assert.equal(fileResponse.statusCode, 200);
  const file = parseCodeFile(fileResponse.json());

  assert.equal(repos.repos[0].trees[0].branch, 'main');
  assert.deepEqual(directory.entries, [{ name: 'app.ts', dir: false }]);
  assert.equal(file.content, 'export const value = 1;\n');

  await writeFile(path.join(root, 'app.ts'), 'export const value = 2;\n');
  const staged = await request(app, 'POST', 'stage', parseCodeStageResponse, { paths: ['app.ts'] });
  const snapshot = await request(app, 'GET', 'git', parseCodeGit);

  assert.equal(staged.changed, 1);
  assert.equal(snapshot.staged[0].path, 'app.ts');
  assert.equal(snapshot.files.length, 0);
  assert.equal(snapshot.log[0].subject, 'Начальное состояние');

  const unstaged = await request(app, 'POST', 'unstage', parseCodeStageResponse, { all: true });

  assert.equal(unstaged.changed, 1);
  await request(app, 'POST', 'stage', parseCodeStageResponse, { all: true });
  const commit = await request(app, 'POST', 'commit', parseCodeCommitResponse, {
    message: 'Изменить значение',
  });
  const push = await request(app, 'POST', 'push', parseCodePushResponse, {});

  assert.equal(commit.subject, 'Изменить значение');
  assert.equal(push.published, true);
  assert.equal(push.tracking.upstream, 'origin/main');
});

test('CODE-CONTRACT-02: unknown body и живой гейт не меняют индекс', async (t) => {
  const { app, root, disable } = await fixture(t);

  await writeFile(path.join(root, 'app.ts'), 'export const value = 2;\n');
  for (const payload of [null, [], 'строка', { paths: [null] }, { all: 'true' }]) {
    const response = await app.inject({
      method: 'POST',
      url: actionUrl('stage'),
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });

    assert.equal(response.statusCode, 400, response.body);
    assert.equal((await git(root, ['diff', '--cached', '--name-only'])).stdout, '');
  }

  disable();
  const response = await app.inject({
    method: 'POST',
    url: actionUrl('stage'),
    payload: { all: true },
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, 'plugin_disabled');
  assert.equal((await git(root, ['diff', '--cached', '--name-only'])).stdout, '');
});

test('CODE-CONTRACT-03: модель получает только staged prompt и проверенный model-only вызов', async (t) => {
  const calls = [];
  const executor = {
    run() {
      assert.fail('Обычный executor.run запрещён для текста репозитория');
    },
    async runUntrusted(options) {
      assert.equal(this, executor);
      calls.push(options);

      return { reply: '{"title":"Изменить значение"}' };
    },
  };
  const { app, root } = await fixture(t, async () => ({
    ok: true,
    ref: { provider: 'test', model: 'test' },
    effort: 'high',
    executor,
  }));

  await writeFile(path.join(root, 'app.ts'), 'export const value = 2;\n');
  await git(root, ['add', 'app.ts']);
  await writeFile(path.join(root, 'app.ts'), 'UNSTAGED_MARKER\n');
  const result = await request(app, 'POST', 'commit-message', parseCodeCommitTitleResponse, {});

  assert.equal(result.title, 'Изменить значение');
  assert.equal(result.effort, 'high');
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].message, /UNSTAGED_MARKER/);
  assert.deepEqual(calls[0].images, []);
  assert.deepEqual(calls[0].providerSettings, { selected: true });
  for (const key of ['cwd', 'tools', 'mcp', 'session', 'resume', 'workspace']) {
    assert.equal(key in calls[0], false, key);
  }
});

test('CODE-CONTRACT-04: повреждённый JS-результат модели не запускает обычный executor', async (t) => {
  let target;
  const { app, root } = await fixture(t, async () => target);

  await writeFile(path.join(root, 'app.ts'), 'export const value = 2;\n');
  await git(root, ['add', 'app.ts']);
  const cases = [
    [null, 409, 'executor_unavailable'],
    [{ ok: true, ref: { provider: 42, model: 'test' } }, 409, 'invalid_model_ref'],
    [{
      ok: true,
      ref: { provider: 'test', model: 'test' },
      executor: { run: () => assert.fail('Обычный executor.run запрещён') },
    }, 409, 'unsafe_model_provider'],
    [{
      ok: true,
      ref: { provider: 'test', model: 'test' },
      executor: { runUntrusted: async () => ({ reply: { title: 'объект вместо текста' } }) },
    }, 502, 'bad_model_reply'],
  ];

  for (const [value, status, error] of cases) {
    target = value;
    const response = await app.inject({ method: 'POST', url: actionUrl('commit-message'), payload: {} });

    assert.equal(response.statusCode, status, response.body);
    assert.equal(response.json().error, error);
  }
});

test('CODE-CONTRACT-05: commit удерживает и затем освобождает блокировку worktree', async (t) => {
  const { app, root } = await fixture(t);
  const started = path.join(root, 'commit-started');
  const release = path.join(root, 'commit-release');
  const hook = path.join(root, '.git/hooks/pre-commit');

  await writeFile(path.join(root, 'app.ts'), 'export const value = 2;\n');
  await git(root, ['add', 'app.ts']);
  await writeFile(hook, `#!/bin/sh\ntouch '${started}'\nwhile [ ! -f '${release}' ]; do sleep 0.01; done\n`);
  await chmod(hook, 0o755);
  const pending = app.inject({
    method: 'POST',
    url: actionUrl('commit'),
    payload: { message: 'Коммит с удержанием блокировки' },
  }).then((response) => response);

  try {
    let running = false;

    for (let attempt = 0; attempt < 200 && !running; attempt += 1) {
      running = await access(started).then(() => true, () => false);
      if (!running) {
        await delay(10);
      }
    }

    assert.equal(running, true, 'Git должен дойти до pre-commit');
    const blocked = await app.inject({
      method: 'POST',
      url: actionUrl('unstage'),
      payload: { all: true },
    });

    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().error, 'git_busy');
  } finally {
    await writeFile(release, 'готово');
    assert.equal((await pending).statusCode, 200);
  }

  const available = await app.inject({
    method: 'POST',
    url: actionUrl('unstage'),
    payload: { all: true },
  });

  assert.equal(available.statusCode, 409);
  assert.equal(available.json().error, 'no_staged_changes');
  assert.equal(await readFile(path.join(root, 'app.ts'), 'utf8'), 'export const value = 2;\n');
});
