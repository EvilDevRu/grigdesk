import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import {
  chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { Analyzer } from '../../server/src/lib/analysis/analyzer.ts';
import { AnalysisArbiter } from '../../server/src/lib/analysis/arbiter.ts';
import { loadTriageProfile } from '../../server/src/lib/analysis/profile.ts';
import { TriageSources } from '../../server/src/lib/analysis/triageSource.ts';

const exec = promisify(execFile);

const RESULT = {
  task: 42,
  project: 'Demo',
  complexity: 2,
  risk: 2,
  diff_size: 'S',
  areas: ['BE'],
  files: ['be:app.txt', 'be:untouched.txt'],
  risk_markers: [],
  unknowns: [],
  questions: [],
  needs_clarification: false,
  confidence: 'high',
  summary: 'Проверка кода захода.',
};

const PLUGIN_SETTINGS = {
  triageModel: {
    provider: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
  },
  autoArbitrate: false,
};

const PROVIDER_REGISTRY = { codex: [{ id: 'gpt-5.6-sol', efforts: ['high'] }] };

async function git(cwd, ...args) {
  return (await exec('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
}

async function exists(file) {
  return stat(file).then(() => true, () => false);
}

function isolatedSourceProfile(project) {
  return {
    name: 'demo',
    cwd: project.main,
    dirs: [],
    repos: [{ key: 'be', dir: project.main }],
    workspaceMode: 'isolated',
  };
}

/**
 * Публикует в origin коммит с новым содержимым app.txt от имени другого разработчика
 * и подтягивает его в основную копию: после этого он вершина origin/master.
 */
async function publish(project, contents) {
  await writeFile(path.join(project.publisher, 'app.txt'), `${contents}\n`);
  await git(project.publisher, 'commit', '-qam', contents);
  await git(project.publisher, 'push', '-q', 'origin', 'master');
  await git(project.main, 'fetch', '-q');

  return git(project.publisher, 'rev-parse', 'HEAD');
}

/**
 * Проект как у isolated-профиля: origin со свежим master и основная копия человека
 * на отделённом HEAD со старым кодом и незакоммиченной правкой поверх.
 */
async function isolatedProject(t, { mode = 'isolated' } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'triage-source-')));

  t.after(() => rm(root, { recursive: true, force: true }));

  const origin = path.join(root, 'origin.git');
  const publisher = path.join(root, 'publisher');
  const main = path.join(root, 'be', 'html');
  const profileDir = path.join(root, 'profiles', 'demo');

  await git(root, 'init', '-q', '--bare', '-b', 'master', origin);
  await git(root, 'init', '-q', '-b', 'master', publisher);
  await git(publisher, 'config', 'user.name', 'Fixture');
  await git(publisher, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(publisher, 'app.txt'), 'old\n');
  await writeFile(path.join(publisher, 'untouched.txt'), 'same\n');
  await git(publisher, 'add', '.');
  await git(publisher, 'commit', '-qm', 'old');
  await git(publisher, 'remote', 'add', 'origin', origin);
  await git(publisher, 'push', '-q', 'origin', 'master');
  await mkdir(path.dirname(main), { recursive: true });
  await git(root, 'clone', '-q', origin, main);

  const old = await git(main, 'rev-parse', 'HEAD');

  await git(main, 'checkout', '-q', '--detach', old);
  await writeFile(path.join(main, 'app.txt'), 'правка человека\n');
  await mkdir(profileDir, { recursive: true });
  await writeFile(path.join(profileDir, 'profile.sh'), [
    `PROFILE_AGENT_CWD=${JSON.stringify(main)}`,
    `PROFILE_AGENT_DIRS=${JSON.stringify(path.join(root, 'be'))}`,
    `PROFILE_TRIAGE_REPOS=${JSON.stringify(`be:${main}`)}`,
    `profile_workspace_mode() { printf '%s\\n' ${JSON.stringify(mode)}; }`,
  ].join('\n'));

  const project = {
    root,
    publisher,
    main,
    old,
    analysisDir: path.join(root, 'analysis'),
    snapshot: path.join(root, 'analysis', '.source', 'demo', 'triage-be'),
  };

  project.fresh = await publish(project, 'fresh');

  return project;
}

function recordingExecutor(calls) {
  return {
    id: 'codex',
    scopedWorkspace: true,

    /**
     * Модель в тесте пишет те же два файла, что и настоящий заход, и запоминает, что
     * видела: промпт, границы чтения и содержимое app.txt в каталоге репозитория.
     */
    async run(options) {
      const prompt = String(options.message || options.prompt || '');
      const jsonPath = prompt.match(/(?:- |\[Схема )([^\s\]]+\.analysis\.json)/)?.[1];
      const notePath = prompt.match(/- ([^\s]+\/t\d+\.md)/)?.[1];
      const repoDir = prompt.match(/^be: (\S+)/m)?.[1] || '';
      const appText = await readFile(path.join(repoDir, 'app.txt'), 'utf8').catch(() => null);

      calls.push({
        prompt,
        readable: options.workspaceAccess?.readableRoots || [],
        appText,
      });
      await writeFile(jsonPath, JSON.stringify(RESULT));
      await writeFile(notePath, '# Разведка\n');

      return { reply: 'ok', actualModel: options.model };
    },
  };
}

function analyzerFor(project, executor) {
  return new Analyzer({
    config: {
      analysisDir: project.analysisDir,
      chatsDir: path.join(project.root, 'chats'),
      factoryHome: project.root,
      profilesDir: path.join(project.root, 'profiles'),
      factoryProfile: 'demo',
      analysisTimeoutMs: 1000,
      analysisConcurrency: 1,
    },
    claudeAuth: { env: () => process.env },
    tracker: {
      async taskDetail() {
        return { title: 'Demo | задача', description: '' };
      },
      async taskPageData() {
        return { comments: [] };
      },
    },
    factoryState: {
      async primaryProfile() {
        return 'demo';
      },
    },
    prefs: { read: () => ({}) },
    log: null,
    pluginEnabled: () => true,
    pluginSettings: () => PLUGIN_SETTINGS,
    providerRegistry: async () => PROVIDER_REGISTRY,
    executorFor: async () => executor,
  });
}

/**
 * Один заход триажа задачи 42 по проекту: что вернул раннер, что видела модель и что
 * легло в файл оценки (null, если заход упал раньше записи).
 */
async function triageRun(project, analyzer = null) {
  const calls = [];
  const runner = analyzer || analyzerFor(project, recordingExecutor(calls));
  const result = await runner.analyze('42');
  const saved = await readFile(path.join(project.analysisDir, 't42.analysis.json'), 'utf8')
    .then(JSON.parse, () => null);

  return {
    analyzer: runner,
    call: calls[0] || null,
    result,
    saved,
  };
}

test('загрузчик профиля знает режим workspace и не верит мусору', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'triage-profile-mode-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const profiles = {
    isolated: "profile_workspace_mode() { printf 'isolated\\n'; }",
    shared: "profile_workspace_mode() { printf 'shared\\n'; }",
    weird: "profile_workspace_mode() { printf 'sometimes\\n'; }",
    silent: 'PROFILE_TRIAGE_REPOS="be:/tmp/x"',
  };
  const modes = {};

  for (const [name, body] of Object.entries(profiles)) {
    await mkdir(path.join(root, name), { recursive: true });
    await writeFile(path.join(root, name, 'profile.sh'), `${body}\n`);

    const profile = await loadTriageProfile({ factoryHome: root, profilesDir: root }, name);

    modes[name] = profile.workspaceMode;
  }

  assert.deepEqual(modes, {
    isolated: 'isolated',
    shared: 'shared',
    weird: null,
    silent: null,
  });
});

test('isolated-триаж читает снимок свежего origin/master, а не отделённый HEAD человека', async (t) => {
  const project = await isolatedProject(t);
  const { call, result, saved } = await triageRun(project);

  assert.deepEqual({
    result,
    appText: call?.appText,
    promptRepo: call?.prompt.includes(
      `be: ${project.snapshot} (снимок origin/master @ ${project.fresh.slice(0, 12)})`,
    ),
    snapshotReadable: call?.readable.includes(project.snapshot),
    humanCopyReadable: call?.readable.some((entry) => entry === project.main
      || entry === path.dirname(project.main)),
    humanHead: await git(project.main, 'rev-parse', 'HEAD'),
    humanStatus: await git(project.main, 'status', '--porcelain'),
    repos: saved?.repos,
  }, {
    result: { ok: true },
    appText: 'fresh\n',
    promptRepo: true,
    snapshotReadable: true,
    humanCopyReadable: false,
    humanHead: project.old,
    humanStatus: 'M app.txt',
    repos: {
      be: {
        dir: project.main,
        sha: project.fresh,
        ref: 'origin/master',
      },
    },
  });
});

test('протухание оценки по снимку считается от origin, а следующий заход сдвигает снимок', async (t) => {
  const project = await isolatedProject(t);
  const { analyzer } = await triageRun(project);
  const before = (await analyzer.get('42')).stale;
  const newer = await publish(project, 'newer');

  analyzer._diffCache = null;

  const after = (await analyzer.get('42')).stale;
  const second = await triageRun(project);

  assert.deepEqual({
    before,
    after,
    appText: second.call?.appText,
    revision: second.call?.prompt.includes(`снимок origin/master @ ${newer.slice(0, 12)}`),
    humanHead: await git(project.main, 'rev-parse', 'HEAD'),
  }, {
    before: [],
    after: ['be:app.txt'],
    appText: 'newer\n',
    revision: true,
    humanHead: project.old,
  });
});

test('занятый снимок не сдвигается под читающим заходом', async (t) => {
  const project = await isolatedProject(t);
  const sources = new TriageSources(path.join(project.root, 'sources'));
  const profile = isolatedSourceProfile(project);
  const [first, twin] = await Promise.all([sources.acquire(profile), sources.acquire(profile)]);
  const newer = await publish(project, 'newer');
  const busy = await sources.acquire(profile);
  const busyText = await readFile(path.join(busy.repos[0].dir, 'app.txt'), 'utf8');

  first.release();
  twin.release();
  busy.release();
  busy.release();

  const idle = await sources.acquire(profile);
  const idleText = await readFile(path.join(idle.repos[0].dir, 'app.txt'), 'utf8');

  idle.release();

  assert.deepEqual({
    first: first.repos[0].sha,
    twin: twin.repos[0].sha,
    busy: busy.repos[0].sha,
    busyNoted: /соседний заход/.test(busy.repos[0].note),
    busyText,
    idle: idle.repos[0].sha,
    idleNote: idle.repos[0].note,
    idleText,
    roots: idle.roots,
    readers: sources._readers.size,
  }, {
    first: project.fresh,
    twin: project.fresh,
    busy: project.fresh,
    busyNoted: true,
    busyText: 'fresh\n',
    idle: newer,
    idleNote: '',
    idleText: 'newer\n',
    roots: [idle.repos[0].dir],
    readers: 0,
  });
});

test('снимок не запускает хуки рабочей копии человека', async (t) => {
  const project = await isolatedProject(t);
  const marker = path.join(project.root, 'hook-ran');
  const hook = path.join(project.main, '.git', 'hooks', 'post-checkout');
  const sources = new TriageSources(path.join(project.root, 'sources'));
  const profile = isolatedSourceProfile(project);

  await writeFile(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  await chmod(hook, 0o755);
  (await sources.acquire(profile)).release();
  await publish(project, 'newer');

  const moved = await sources.acquire(profile);

  moved.release();

  assert.deepEqual({
    moved: moved.repos[0].note,
    hookRan: await exists(marker),
  }, {
    moved: '',
    hookRan: false,
  });
});

test('сбой подготовки снимка роняет заход с причиной, а не читает старый код', async (t) => {
  const project = await isolatedProject(t);
  const calls = [];
  const analyzer = analyzerFor(project, recordingExecutor(calls));

  // Файл на месте каталога снимков: подготовить снимок нельзя никак.
  await mkdir(project.analysisDir, { recursive: true });
  await writeFile(path.join(project.analysisDir, '.source'), 'не каталог\n');

  const { result, saved } = await triageRun(project, analyzer);
  const status = JSON.parse(await readFile(path.join(project.analysisDir, 't42.status.json'), 'utf8'));

  assert.deepEqual({
    ok: result.ok,
    reason: /снимок be не подготовлен/.test(String(result.error)),
    modelCalls: calls.length,
    saved,
    status: status.state,
    readers: analyzer._sources._readers.size,
  }, {
    ok: false,
    reason: true,
    modelCalls: 0,
    saved: null,
    status: 'failed',
    readers: 0,
  });
});

test('shared-триаж читает рабочую копию и каталоги профиля, как раньше', async (t) => {
  const project = await isolatedProject(t, { mode: 'shared' });
  const { call, result, saved } = await triageRun(project);

  assert.deepEqual({
    result,
    appText: call?.appText,
    readable: [project.main, path.dirname(project.main)].every((entry) => call?.readable.includes(entry)),
    snapshots: await exists(path.join(project.analysisDir, '.source')),
    repos: saved?.repos,
  }, {
    result: { ok: true },
    appText: 'правка человека\n',
    readable: true,
    snapshots: false,
    repos: { be: { dir: project.main, sha: project.old } },
  });
});

test('без origin снимка нет: заход читает рабочую копию и называет причину', async (t) => {
  const project = await isolatedProject(t);

  await git(project.main, 'remote', 'remove', 'origin');

  const { call, result, saved } = await triageRun(project);
  const note = 'у репозитория нет origin/HEAD, origin/master или origin/main';

  assert.deepEqual({
    result,
    appText: call?.appText,
    explained: call?.prompt.includes(`be: ${project.main} (рабочая копия: ${note})`),
    repos: saved?.repos,
  }, {
    result: { ok: true },
    appText: 'правка человека\n',
    explained: true,
    repos: {
      be: {
        dir: project.main,
        sha: project.old,
        note,
      },
    },
  });
});

test('арбитр вопросов отвечает по тому же снимку, что и триаж', async (t) => {
  const project = await isolatedProject(t);
  const calls = [];
  const analyzer = analyzerFor(project, null);
  const executor = {
    id: 'codex',
    scopedWorkspace: true,
    async run(options) {
      calls.push({ prompt: options.message, access: options.workspaceAccess });

      return { reply: JSON.stringify({ answers: [] }) };
    },
  };
  const arbiter = new AnalysisArbiter({
    analyzer,
    pluginEnabled: () => true,
    pluginSettings: () => PLUGIN_SETTINGS,
    providerRegistry: async () => PROVIDER_REGISTRY,
    executorFor: async () => executor,
    log: null,
  });

  await analyzer._ready;
  await writeFile(path.join(project.analysisDir, 't42.analysis.json'), JSON.stringify({
    task: 42,
    questions: [{ id: 'q-code', text: 'Что лежит в app.txt?' }],
  }));
  await arbiter.arbitrate('42', { automatic: false });

  const readable = calls[0]?.access?.readableRoots || [];

  assert.deepEqual({
    calls: calls.length,
    listed: String(calls[0]?.prompt || '').includes(
      `Код проекта:\nbe: ${project.snapshot} (снимок origin/master @ ${project.fresh.slice(0, 12)})`,
    ),
    snapshotReadable: readable.includes(project.snapshot),
    humanCopyReadable: readable.includes(project.main),
    readers: analyzer._sources._readers.size,
  }, {
    calls: 1,
    listed: true,
    snapshotReadable: true,
    humanCopyReadable: false,
    readers: 0,
  });
});
