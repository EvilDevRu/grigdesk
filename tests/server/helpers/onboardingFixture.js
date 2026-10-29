import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import documentsModule from '../../../server/src/modules/documents/index.ts';
import { DocumentReader } from '../../../server/src/lib/documents/reader.ts';
import projectsModule from '../../../server/src/modules/projects/index.ts';
import { PrefsStore } from '../../../server/src/lib/prefsStore.ts';
import authPlugin, { SESSION_COOKIE } from '../../../server/src/plugins/auth.ts';

const require = createRequire(new URL('../../../server/package.json', import.meta.url));
const Fastify = require('fastify');
const moduleUrl = new URL('../../../server/src/modules/onboarding/index.ts', import.meta.url);

export const cookie = `${SESSION_COOKIE}=onboarding-fixture`;

/**
 * Git работает только с временным репозиторием без пользовательских настроек и hooks.
 * Явные имя и почта фикстуры нужны только для её первого локального коммита.
 */
export function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    },
  }).trim();
}

/**
 * Репозиторий содержит main, feature и remote-only, а также незакоммиченные данные.
 * Все ожидаемые имена берутся из refs того же репозитория, который читает сервер.
 */
export async function repository(root, name = 'repo', unborn = false) {
  const dir = path.join(root, name);

  await mkdir(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');

  if (!unborn) {
    await writeFile(path.join(dir, 'tracked.txt'), 'исходное\n');
    git(dir, 'add', 'tracked.txt');
    git(dir, '-c', 'user.name=Фикстура', '-c', 'user.email=fixture@example.invalid',
      '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Фикстура');
    git(dir, 'branch', 'feature');
    git(dir, 'update-ref', 'refs/remotes/origin/remote-only', 'HEAD');
    await writeFile(path.join(dir, 'tracked.txt'), 'правка владельца\n');
    await writeFile(path.join(dir, 'untracked.txt'), 'неотслеживаемое\n');
  }

  return dir;
}

/**
 * Настоящие проекты и новый модуль разделяют только временную папку установки.
 * Отсутствующий новый модуль оставляет настоящий HTTP404, а не ошибку загрузчика.
 */
export async function onboardingFixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'onboarding-'));
  const config = {
    factoryHome: root,
    rootDir: root,
    dataStateDir: path.join(root, 'state'),
    profilesDir: path.join(root, 'profiles'),
    routesDir: path.join(root, 'routes'),
    pipelineSampleDir: path.resolve(import.meta.dirname, '../../../server/seed/pipeline-sample'),
  };
  const prefs = new PrefsStore({ prefsPath: path.join(root, 'prefs.json') });
  const events = [];
  const apps = [];

  await Promise.all([config.dataStateDir, config.profilesDir, config.routesDir]
    .map((dir) => mkdir(dir, { recursive: true })));
  t.after(async () => {
    for (const app of apps.reverse()) {
      await app.close();
    }

    await rm(root, { recursive: true, force: true });
  });

  /**
   * Второй экземпляр восстанавливает состояние с диска без общей памяти сервиса.
   * Авторизация использует тот же plugin, что соседние проверки HTTP-модулей.
   */
  async function open() {
    const app = Fastify({ logger: false });

    apps.push(app);
    app.decorate('sse', { broadcast: (event, data) => events.push({ event, data }) });

    if (options.auth) {
      await app.register(authPlugin, {
        authStore: {
          isConfigured: () => true,
          isValidSession: (token) => token === 'onboarding-fixture',
          clientScope: () => 'onboarding-fixture',
        },
      });
    }

    await app.register(projectsModule, { config, prefs });
    await app.register(documentsModule, {
      reader: new DocumentReader({
        rootProviders: [() => [{
          id: 'grigdesk',
          label: 'GrigDesk',
          path: config.rootDir,
        }]],
      }),
    });

    if (existsSync(moduleUrl)) {
      const { default: onboardingModule } = await import(moduleUrl.href);

      await app.register(onboardingModule, {
        config,
        prefs,
        projectsService: app.projects,
        ...options.moduleOptions,
      });
    }

    await app.ready();

    return app;
  }

  const sample = path.join(root, 'server/seed/pipeline-sample');

  await mkdir(sample, { recursive: true });
  await writeFile(path.join(sample, 'README.md'),
    await readFile(path.join(config.pipelineSampleDir, 'README.md'), 'utf8'));

  const app = await open();

  return {
    app,
    open,
    root,
    config,
    prefs,
    events,
  };
}

/**
 * Каждый переход использует последнюю подтверждённую ревизию и sessionId.
 * Неуспех HTTP остаётся явным assertion с телом ответа, а не неверной фикстурой.
 */
export async function request(app, method = 'GET', suffix = '', payload, status = 200) {
  const response = await app.inject({
    method,
    url: `/api/onboarding${suffix}`,
    ...(payload === undefined ? {} : { payload }),
    headers: { cookie },
  });

  assert.equal(response.statusCode, status, response.body);

  if (status === 200) {
    assert.match(response.headers['cache-control'] || '', /no-store/);
  }

  return response.json();
}

/**
 * Токен перехода строится только из подтверждённого снимка сервера.
 * Смешивание ревизии и sessionId разных проходов должно быть отвергнуто.
 */
export function token(state) {
  return { expectedRevision: state.revision, sessionId: state.active.id };
}

/**
 * Обычный паспорт создаётся тем же контрактом, что старая форма «Проекты».
 * Ветка и режим остаются ответами мастера и в этот паспорт не добавляются.
 */
export function projectInput(id, repos = []) {
  return {
    id,
    title: `Проект ${id}`,
    description: '',
    tags: [],
    repos,
    defaultRepoKey: repos[0]?.key ?? null,
  };
}

/**
 * Проектная часть проходит только публичные переходы с настоящими Git-папками.
 * Названия строк стабильны и совпадают с будущими repositories[].name.
 */
export async function atProject(fixture, mode = 'auto') {
  let state = await request(fixture.app);

  state = await request(fixture.app, 'POST', '/start', { expectedRevision: state.revision, mode });
  state = await request(fixture.app, 'POST', '/advance', { ...token(state), skipAi: true });

  return state;
}

/**
 * До создания паспорта сохраняются две папки с ветками из их локальных refs.
 * Возвращённый снимок подтверждает запись, а не оптимистическое состояние клиента.
 */
export async function atWorkspace(fixture, mode = 'auto') {
  let state = await atProject(fixture, mode);
  const first = await repository(fixture.root, 'first');
  const second = await repository(fixture.root, 'second');
  const draft = {
    title: 'Мой проект',
    repositories: [first, second].map((source, index) => ({
      name: `repo${index + 1}`,
      source,
      baseBranch: git(source, 'symbolic-ref', '--short', 'HEAD'),
    })),
    workspace: { mode: 'isolated' },
  };

  state = await request(fixture.app, 'PATCH', '', { ...token(state), draft });
  state = await request(fixture.app, 'POST', '/advance', token(state));

  return state;
}

/**
 * Доказательство сохранения читается из собственного файла установки.
 * Оно не зависит от кеша сервиса или optimistic-состояния клиента.
 */
export async function document(fixture) {
  return JSON.parse(await readFile(path.join(fixture.config.dataStateDir, 'onboarding.json'), 'utf8'));
}
