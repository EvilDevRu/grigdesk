// Изолированные данные удаления регистрации: реальные файлы и Git,
// синтетические владельцы и настоящий сервис, без запуска инфраструктуры.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PrefsStore } from '../../../server/src/lib/prefsStore.ts';
import { ChatSessionBindingStore } from '../../../server/src/lib/chat/sessionBindingStore.ts';
import { AuthStore } from '../../../server/src/lib/authStore.ts';
import authPlugin from '../../../server/src/plugins/auth.ts';
import projectsModule from '../../../server/src/modules/projects/index.ts';
import routesModule from '../../../server/src/modules/routes/index.ts';
import documentsModule from '../../../server/src/modules/documents/index.ts';
import { DocumentReader } from '../../../server/src/lib/documents/reader.ts';
import { createProjectsService } from '../../../server/src/modules/projects/service.ts';
import { chatAppFixture, Fastify, TEST_MODEL_REF } from './chat-turns.js';

export const PD_NOW = '2026-10-20T10:00:00.000Z';
export const PD_CHOICE = {
  kind: 'project',
  projectId: 'demo',
  repoKey: null
};
export const PD_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHioAAAAASUVORK5CYII=',
  'base64',
);

/**
 * Управляемая пауза останавливает операцию точно на границе записи.
 * Тест освобождает её сам, без таймеров и зависимости от скорости диска.
 */
export function pdDeferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

/**
 * Временный корень принадлежит одному тесту; паспорт и физический профиль
 * создаются независимо, чтобы проверять все три источника регистрации.
 */
export async function pdFixture(t, { source = 'both', git = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-project-delete-'));
  const profilesDir = path.join(root, 'profiles');
  const routesDir = path.join(root, 'routes');
  const main = path.join(root, 'main');
  const extra = path.join(root, 'extra');
  const appRoot = path.join(root, 'application');
  const prefsPath = path.join(root, 'prefs.json');
  const repos = [{ key: 'extra', dir: extra }, { key: 'main', dir: main }];

  for (const dir of [profilesDir, routesDir, main, extra, appRoot]) {
    await fs.mkdir(dir, { recursive: true });
  }

  t.after(() => fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5
  }));

  const prefs = new PrefsStore({ prefsPath });
  const record = {
    title: 'Демо',
    repos,
    defaultRepoKey: 'main',
    revision: 1,
    archivedAt: null
  };

  prefs.write({
    projects: {
      ...(source === 'profile' ? {} : { demo: record }),
      other: {
        ...record,
        title: 'Другой',
        repos: [{
          key: 'main',
          dir: appRoot
        }]
      },
    },
    projectsMeta: { marker: 'соседнее поле', tombstones: {} },
    theme: 'dark',
  });

  if (source !== 'prefs') {
    await fs.mkdir(path.join(profilesDir, 'demo'));
    await fs.writeFile(path.join(profilesDir, 'demo', 'graph.json'), '{"capabilities":[]}');
    await fs.writeFile(
      path.join(profilesDir, 'demo', 'profile.sh'),
      `PROFILE_TRIAGE_REPOS="extra:${extra} main:${main}"\n`,
    );
  }

  const owned = [
    'chats/owner.json', 'bindings/owner.json', 'ssh/connections.json', 'db/profiles.json',
    'routes/demo/draft.json', 'attempts/attempt.json', 'showcase/movie.json', 'sandboxes/state.json',
  ];

  for (const name of owned) {
    const file = path.join(root, 'owned', name);

    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ project: 'other', marker: name }));
  }

  await fs.writeFile(path.join(main, 'source.txt'), 'исходный файл\n');

  if (git) {
    const options = {
      cwd: main,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    };

    execFileSync('git', ['init', '-q'], options);
    execFileSync('git', ['add', '.'], options);
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'fixture'], options);
    execFileSync('git', ['branch', 'preserved'], options);
    execFileSync('git', ['worktree', 'add', '-qb', 'copy', path.join(root, 'copy')], options);
  }

  const config = {
    factoryHome: root,
    profilesDir,
    routesDir
  };
  const events = [];
  const service = createProjectsService({
    config,
    prefs,
    now: () => PD_NOW,
    broadcast: (event, data) => events.push({ event, data }),
  });

  return {
    root,
    profilesDir,
    routesDir,
    main,
    extra,
    appRoot,
    repos,
    prefsPath,
    prefs,
    service,
    events,
    config
  };
}

/**
 * Снимок файлов владельцев и Git делается после штатной инициализации.
 * Паспорт исключён: именно его жизненный цикл меняет проверяемая операция.
 */
export async function pdSnapshot(f) {
  const files = {};

  /**
   * Обход сохраняет байты каждого файла владельца под относительным именем.
   * Каталоги раскрываются рекурсивно, метаданные ОС в сравнение не входят.
   */
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await visit(file);
      } else {
        files[path.relative(f.root, file)] = (await fs.readFile(file)).toString('base64');
      }
    }
  }

  await visit(path.join(f.root, 'owned'));
  await visit(f.profilesDir);
  files.source = await fs.readFile(path.join(f.main, 'source.txt'), 'utf8');

  if (await fs.stat(path.join(f.main, '.git')).catch(() => null)) {
    for (const args of [['show-ref'], ['log', '--all', '--format=%H'], ['worktree', 'list', '--porcelain']]) {
      files[args.join(' ')] = execFileSync('git', args, { cwd: f.main, encoding: 'utf8' });
    }
  }

  return files;
}

/**
 * Настоящий общий auth охраняет модуль проектов, токен только синтетический.
 * Сервер использует тот же сервис, который тест может удерживать cleanup hook.
 */
export async function pdProjectsApp(t, f, { auth = false } = {}) {
  const app = Fastify({ logger: false });

  if (auth) {
    const authStore = new AuthStore({
      legacyAccountPath: path.join(f.root, 'account.json'),
      sessionsPath: path.join(f.root, 'sessions.json'),
    });

    await app.register(authPlugin, {
      authStore,
      cliToken: 'pd-cli-token',
      internalToken: 'pd-internal'
    });
  }

  await app.register(projectsModule, {
    config: f.config,
    prefs: f.prefs,
    service: f.service
  });
  await app.register(routesModule, { config: f.config, prefs: f.prefs });
  t.after(() => app.close());

  return app;
}

/**
 * История, документы и проекты соединены теми же портами, что в приложении.
 * Общий корень документов соседний проектным папкам: scope нельзя обойти случайно.
 */
export async function pdHistoryApp(t, f, { projectsService = f.service, factoryState = null } = {}) {
  const runs = [];
  const reader = new DocumentReader({
    maxBytes: 100000,
    rootProviders: [() => [{
      id: 'application',
      label: 'Приложение',
      path: f.appRoot
    }]],
  });
  const http = await chatAppFixture(t, {
    root: f.root,
    configOverrides: { ...f.config, rootDir: f.appRoot },
    syntheticPorts: {
      prefs: f.prefs,
      projectsService,
      documentReader: reader,
      ...(factoryState ? { factoryState } : {}),
    },
    executor: {
      id: 'test-provider',
      workdir: { switch: 'resume', roots: 'multi' },
      async run(options) {
        runs.push({ cwd: options.cwd, extraDirs: options.extraDirs });

        return {
          reply: 'Готово',
          sessionId: 'pd-session',
          steps: []
        };
      },
    },
    extraRoutes: async (app) => {
      await app.register(projectsModule, {
        config: f.config,
        prefs: f.prefs,
        service: f.service
      });
      await app.register(documentsModule, { reader });
    },
  });

  return {
    ...http,
    reader,
    runs
  };
}

/**
 * Большая история проверяет сохранность сообщений вместе с сохранёнными шагами.
 * У разных id различается текст, поэтому потерю второго legacy-чата видно явно.
 */
export function pdChat(id, workdir = PD_CHOICE) {
  return {
    id,
    modelRef: TEST_MODEL_REF,
    createdAt: 1000,
    workdir,
    messages: Array.from({ length: 400 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      text: `${id} сообщение ${index}`,
      at: index + 1,
      ...(index === 1 ? { steps: Array.from({ length: 600 }, () => ({ k: 'text', text: 'шаг' })) } : {}),
    })),
  };
}

/**
 * Чат создаётся публичным PUT; картинка и документ находятся в обоих корнях.
 * Проверка статуса отделяет ошибку fixture от ожидаемого отказа удаления.
 */
export async function pdSeedHistory(h, f) {
  for (const [id, workdir] of [['legacy', PD_CHOICE], ['explicit', { kind: 'grigdesk' }],
  ['neighbor', {
    kind: 'project',
    projectId: 'other',
    repoKey: null
  }]]) {
    const saved = await h.app.inject({
      method: 'PUT',
      url: '/api/chat/store/chat',
      payload: { chat: pdChat(id, workdir) },
    });

    assert.equal(saved.statusCode, 200, saved.body);
  }

  const candidate = { taskId: null, workdir: { ...PD_CHOICE, repoKey: 'extra' } };
  const preview = await h.app.inject({

    method: 'POST',
    url: '/api/chat/workdir/preview',

    payload: { chatKey: 'explicit', candidate },

  });

  assert.equal(preview.statusCode, 200, preview.body);

  const committed = await h.app.inject({

    method: 'POST',
    url: '/api/chat/workdir/change',

    payload: {

      chatKey: 'explicit',
      ...candidate,
      operationId: 'pd-commit',
      transfer: 'reset',

      expectedRevision: preview.json().revision,
      expectedWorkspaceKey: preview.json().workspaceKey,

    },

  });

  assert.equal(committed.statusCode, 200, committed.body);
  assert.ok(committed.json().chat.workdirState?.committed);

  const bindings = new ChatSessionBindingStore({ dir: h.config.chatBindingsDir });

  await bindings.compareAndSwap({

    chatKey: 'legacy',
    provider: 'test-provider',
    cwdRealpath: f.main,
    model: 'test-model',

    authProfileId: 'fixture',
    securityProfile: 'fixture',
    sessionId: 'preserved-session',

  });

  for (const dir of [f.main, f.extra]) {
    await fs.writeFile(path.join(dir, 'image.png'), PD_PNG);
    await fs.writeFile(path.join(dir, 'document.md'), '# Старый документ\n');
  }

  const resolved = await h.reader.resolveAbsolute(path.join(f.main, 'document.md'), 'chat:legacy');

  return resolved.ref;
}

/**
 * Проверяем содержимое по сохранённой ссылке, байтам картинки и границе чужого scope.
 * Успешный GET списка истории сам по себе не подтверждает доступ к старым корням.
 */
export async function pdAssertHistory(h, f, ref) {
  const document = await h.reader.read(ref);

  assert.equal(document.content, '# Старый документ\n');

  const resolved = await h.reader.resolveAbsolute(path.join(f.main, 'document.md'), 'chat:legacy');

  assert.deepEqual(resolved.ref, ref);

  for (const file of [path.join(f.main, 'image.png'), path.join(f.extra, 'image.png')]) {
    const response = await h.app.inject(`/api/chat/legacy/image?path=${encodeURIComponent(file)}`);

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.rawPayload.equals(PD_PNG), true);
  }

  await assert.rejects(
    () => h.reader.resolveAbsolute(path.join(f.main, 'document.md'), 'chat:neighbor'),
    { code: 'document_outside_roots' },
  );
}

/**
 * Байты истории и привязок сравниваются до следующего хода исполнителя.
 * Служебные снимки корней и defaults не относятся к содержимому разговоров.
 */
export async function pdHistoryBytes(h) {
  const files = {};

  /**
   * Обход сохраняет байты каждого файла владельца под относительным именем.
   * Каталоги раскрываются рекурсивно, метаданные ОС в сравнение не входят.
   */
  async function visit(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const file = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await visit(file);
      } else if (!['meta.json', 'project-workspaces.json'].includes(entry.name)) {
        files[file] = (await fs.readFile(file)).toString('base64');
      }
    }
  }

  await visit(h.config.chatsDir);
  await visit(h.config.chatBindingsDir);

  return files;
}
