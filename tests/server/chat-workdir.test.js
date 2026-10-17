import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeChatWorkdir, sameChatWorkdir } from '../../shared/chat/chatWorkdir.ts';
import { resolveChatWorkdir, validateWorkdirPath } from '../../server/src/lib/chat/workdir.ts';

/**
 * Каждый сценарий работает в отдельных реальных каталогах.
 * Профиль фабрики не читается: проект задаётся только паспортом теста.
 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-workdir-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');

  await fs.mkdir(first);
  await fs.mkdir(second);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  return {
    root,
    first,
    second,
    input: {
      config: { rootDir: root, profilesDir: path.join(root, 'profiles') },
      prefs: {
        read: () => ({
          projects: {
            sample: {
              repos: [{ key: 'a', dir: first }, { key: 'b', dir: second }],
              defaultRepoKey: 'b',
            }
          }
        })
      },
      provider: 'test',
      caps: { switch: 'reseed', roots: 'single' },
      factoryState: { readEnv: async () => ({ WORKSPACE_MODE: 'isolated' }) },
      trustedProject: async () => null,
    },
  };
}

test('форма выбора строгая, отсутствие поля отдельно от повреждения', () => {
  assert.deepEqual(normalizeChatWorkdir(undefined), { kind: 'cockpit' });
  assert.equal(normalizeChatWorkdir({ kind: 'path', path: 'relative' }), null);
  assert.equal(normalizeChatWorkdir({ kind: 'cockpit', path: '/tmp' }), null);
  assert.ok(sameChatWorkdir(undefined, { kind: 'cockpit' }));
});

test('проект: default, явный ключ, single без расширения до общего предка', async (t) => {
  const f = await fixture(t);
  const result = await resolveChatWorkdir({
    ...f.input,
    workdir: {
      kind: 'project',
      projectId: 'sample',
      repoKey: null
    },
  });

  assert.equal(result.cwd, f.second);
  assert.deepEqual(result.extraDirs, [f.first]);
  assert.equal(result.copies.length, 2);
  assert.match(result.warnings.join(' '), /разрешен/u);
  await assert.rejects(resolveChatWorkdir({
    ...f.input,
    workdir: {
      kind: 'project',
      projectId: 'sample',
      repoKey: 'gone'
    },
  }), { code: 'workdir_unknown_repo' });
});

test('realpath блокирует корень/home и сохраняет один физический каталог', async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.root, 'alias');

  await fs.symlink(f.first, alias);
  assert.equal(await validateWorkdirPath(alias), f.first);
  await assert.rejects(validateWorkdirPath('/'), { code: 'bad_workdir' });
  await assert.rejects(validateWorkdirPath(os.homedir()), { code: 'bad_workdir' });
  await assert.rejects(validateWorkdirPath(path.join(f.root, 'gone')), { code: 'workdir_missing' });
});

test('задача без доверенного проекта возвращает выбранную папку; битый env не маскируется', async (t) => {
  const f = await fixture(t);
  const input = {
    ...f.input,
    taskId: '12',
    workdir: {
      kind: 'path',
      path: f.first
    }
  };

  assert.equal((await resolveChatWorkdir(input)).cwd, f.first);
  await assert.rejects(resolveChatWorkdir({
    ...input,
    factoryState: { readEnv: async () => ({ REPO_COUNT: '1' }) },
  }), { code: 'invalid_sandbox_env' });
});

test('старый snapshot не откатывает выбор и память; omission сохраняет папку', async (t) => {
  const f = await fixture(t);
  const { ChatHistoryStore } = await import('../../server/src/lib/chat/historyStore.ts');
  const history = new ChatHistoryStore({ chatsDir: path.join(f.root, 'chats') });
  const initial = {
    id: 'chat',
    messages: [{
      role: 'user',
      text: 'Начали'
    }],
    createdAt: Date.now()
  };

  await history.saveOne(initial);
  await history.patchExecution('chat', () => ({
    workdir: { kind: 'path', path: f.first },
    taskId: '12',
    sessionId: null,
    workdirState: { epoch: 1, seed: 'Память' },
  }));
  await history.saveOne({
    ...initial,
    sessionId: 'old',
    taskId: null,
    updatedAt: Date.now() + 1000
  });

  const saved = await history.readOne('chat');

  assert.equal(saved.workdir.path, f.first);
  assert.equal(saved.taskId, '12');
  assert.equal(saved.sessionId, null);
  assert.equal(saved.workdirState.seed, 'Память');
  await assert.rejects(history.saveOne({ ...saved, workdir: { kind: 'cockpit' } }), {
    code: 'workdir_change_required',
  });
});

test('мета старого полного PUT сохраняет defWorkdir и ограничивает recents восемью', async (t) => {
  const f = await fixture(t);
  const { ChatHistoryStore } = await import('../../server/src/lib/chat/historyStore.ts');
  const history = new ChatHistoryStore({ chatsDir: path.join(f.root, 'chats') });
  const selected = { kind: 'path', path: f.first };

  await history.saveMeta({
    defWorkdir: selected,
    recentWorkdirs: [selected, selected, ...Array.from({ length: 12 }, (_, index) => ({
      kind: 'path', path: `/workspace/${index}`,
    }))],
  });
  await history.save({
    sessions: [],
    archived: [],
    defMode: 'auto'
  });

  const read = await history.read();

  assert.deepEqual(read.defWorkdir, selected);
  assert.equal(read.recentWorkdirs.length, 8);
  assert.deepEqual(read.recentWorkdirs[0], selected);
});

test('несколько repo keys одного realpath сохраняются в описании без повторов roots', async (t) => {
  const f = await fixture(t);
  const input = {
    ...f.input,
    workdir: {
      kind: 'project',
      projectId: 'sample',
      repoKey: null
    },
    prefs: {
      read: () => ({
        projects: {
          sample: {
            repos: [
              { key: 'a', dir: f.first },
              { key: 'alias', dir: f.first },
              { key: 'b', dir: f.second },
            ],
          }
        }
      })
    },
  };
  const result = await resolveChatWorkdir(input);

  assert.equal(result.cwd, f.first);
  assert.deepEqual(result.extraDirs, [f.second]);
  assert.deepEqual(result.copies.map((entry) => entry.key), ['a', 'alias', 'b']);
});
