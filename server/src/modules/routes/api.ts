// HTTP namespace immutable route bundles протокола route-v2.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { buildRouteDef } from '../../lib/routeGraph.ts';
import { helperModule, nodeExecutable } from '../../lib/runtimePaths.ts';
import type { CatalogObserver } from './catalogObserver.ts';
import { RoutesEditorStoreError } from './draftStore.ts';
import { assertProfileId, assertRevisionHash, assertRouteId, RoutesError } from './schema.ts';
import { RoutesStore } from './store.ts';

const runScript = promisify(execFile);

// Адрес ревизии в пути запроса. Каждое поле проходит проверки хранилища.
type RoutesRequest = FastifyRequest<{
  Params: {
    profile: string;
    routeId: string;
    routeHash: string;
    catalogHash: string;
  };
  Body: Record<string, unknown> | null;
  Querystring: { route?: string; c?: string };
}>;

export interface RoutesApiOptions {
  store?: RoutesStore;
  baseDir?: string;
  profilesDir?: string | null;
  observer?: CatalogObserver;
}

// Собрать бандл умеет только сам проект: состав маршрутов, промпты и bootstrap живут
// в профиле. GrigDesk не сочиняет их за него — он запускает скрипт публикации профиля
// по фиксированному пути и подставляет ровно два своих аргумента: куда публиковать и
// поверх какой ревизии (CAS). Нет скрипта — нет и кнопки, никакого «дефолтного» проекта.
const PUBLISH_SCRIPT = ['routes', 'publish.mjs'];
const PUBLISH_TIMEOUT_MS = 120_000;
const PUBLISH_MAX_OUTPUT = 4 * 1024 * 1024;

// Скрипт профиля не ищет код сервера сам: в комплекте из бинарника исходников нет,
// а путь от папки данных никуда не ведёт. Сервер даёт ему путь к набору схемы и хранилища.
const ROUTES_KIT_ENV = 'GRIGDESK_ROUTES_KIT';
const ROUTES_KIT_HELPER = 'routes-publish-kit';

const BAD_REQUEST_CODES = new Set([
  'ROUTES_V2_INVALID_SCHEMA',
  'ROUTES_V2_PATH_TRAVERSAL',
  'ROUTES_V2_INVALID_ID',
  'ROUTES_V2_INVALID_HASH',
  'ROUTES_V2_FORBIDDEN_FIELD',
]);

function requestError(message: string): RoutesError {
  return new RoutesError('ROUTES_V2_INVALID_SCHEMA', message);
}

function assertBody(
  body: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts body is Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw requestError('Тело запроса должно быть JSON-объектом');
  }
  const allowed = new Set([...required, ...optional]);
  for (const field of Object.keys(body)) {
    if (!allowed.has(field)) throw requestError(`Неизвестное поле запроса «${field}»`);
  }
  for (const field of required) {
    if (!Object.hasOwn(body, field)) throw requestError(`Отсутствует поле запроса «${field}»`);
  }
}

/**
 * Скрипт публикации профиля. Имя профиля проходит ту же проверку, что и пути
 * хранилища (traversal отсекается), путь внутри профиля фиксирован — из запроса
 * не приходит ни одного компонента пути и ни одного аргумента команды.
 */
async function profilePublishScript(
  profilesDir: string | null,
  profile: string,
): Promise<string | null> {
  if (!profilesDir) return null;
  assertProfileId(profile);
  const script = path.join(profilesDir, profile, ...PUBLISH_SCRIPT);
  const info = await fs.lstat(script).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isFile()) return null;
  return script;
}

function lastMeaningfulLine(text: unknown): string {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.at(-1) ?? '';
}

// Режим workspace профиля — trusted executable configuration из profile.sh (тот же
// подход, что launch contract: source скрипта позиционными аргументами, без интерполяции).
// Нужен схеме маршрута: shared-профиль рисуется без ромба песочницы, которой у него нет.
// Любой отказ → null → схема с ромбом (прежнее поведение — fail-safe, а не fail-closed:
// это просмотровая схема, а не запуск).
const WORKSPACE_MODE_SCRIPT = String.raw`
source "$1" >/dev/null 2>&1 || exit 1
declare -F profile_workspace_mode >/dev/null || exit 2
profile_workspace_mode
`;

async function sourceProfileWorkspaceMode(
  profilesDir: string | null,
  profile: string,
): Promise<'shared' | 'isolated' | null> {
  if (!profilesDir) return null;
  assertProfileId(profile);
  const profileFile = path.join(profilesDir, profile, 'profile.sh');
  try {
    const { stdout } = await runScript(
      'bash',
      ['--noprofile', '--norc', '-c', WORKSPACE_MODE_SCRIPT, 'workspace-mode', profileFile],
      { timeout: 10_000, maxBuffer: 64 * 1024 },
    );
    const mode = String(stdout || '').trim();
    return mode === 'shared' || mode === 'isolated' ? mode : null;
  } catch {
    return null;
  }
}

function sendRoutesError(
  fastify: FastifyInstance,
  reply: FastifyReply,
  error: unknown,
): unknown {
  reply.header('cache-control', 'no-store');
  if (error instanceof RoutesEditorStoreError && error.code === 'routes_recovery_conflict') {
    return reply.code(409).send({
      error: 'routes_recovery_conflict',
      message: 'Нельзя определить итог предыдущей публикации.',
      ...error.details,
    });
  }
  if (!(error instanceof RoutesError)) {
    fastify.log.error({ err: error }, 'routes v2: внутренняя ошибка');
    return reply.code(500).send({
      error: 'routes_v2_unavailable',
      message: 'Хранилище маршрутов временно недоступно.',
    });
  }

  if (BAD_REQUEST_CODES.has(error.code)) {
    return reply.code(400).send({
      error: 'bad_routes_v2_request',
      code: error.code,
      message: 'Запрос не соответствует контракту маршрутов v2.',
    });
  }
  if (error.code === 'ROUTES_V2_NOT_FOUND') {
    return reply.code(404).send({
      error: 'routes_v2_not_found',
      code: error.code,
      message: 'Запрошенная ревизия не найдена.',
    });
  }
  if (error.code === 'ROUTES_V2_STALE_REVISION') {
    return reply.code(409).send({
      error: 'routes_v2_revision_conflict',
      code: error.code,
      message: 'Текущий каталог уже изменился.',
      currentCatalogHash: error.details?.currentCatalogHash ?? null,
    });
  }
  if (error.code === 'routes_source_conflict') {
    return reply.code(409).send({
      error: 'routes_source_conflict',
      message: 'Источник управления каталогом изменился.',
      sourceRevision: error.details?.sourceRevision ?? null,
    });
  }
  if (error.code === 'ROUTES_V2_LOCKED') {
    return reply.code(409).send({
      error: 'routes_v2_locked',
      code: error.code,
      message: 'Указатель каталога сейчас изменяется другим запросом.',
    });
  }
  if (error.code === 'ROUTES_V2_TAMPERED') {
    fastify.log.warn({ err: error }, 'routes v2: нарушена целостность ревизии');
    return reply.code(422).send({
      error: 'routes_v2_tampered',
      code: error.code,
      message: 'Целостность опубликованной ревизии нарушена.',
    });
  }

  fastify.log.error({ err: error }, 'routes v2: необработанная ошибка хранилища');
  return reply.code(500).send({
    error: 'routes_v2_unavailable',
    message: 'Хранилище маршрутов временно недоступно.',
  });
}

function guarded(
  fastify: FastifyInstance,
  handler: (request: RoutesRequest, reply: FastifyReply) => Promise<unknown>,
) {
  return async function routesHandler(request: RoutesRequest, reply: FastifyReply) {
    try {
      return await handler(request, reply);
    } catch (error) {
      return sendRoutesError(fastify, reply, error);
    }
  };
}

export async function registerRoutesApi(
  fastify: FastifyInstance,
  options: RoutesApiOptions,
): Promise<void> {
  const store = options.store || new RoutesStore({ baseDir: String(options.baseDir) });
  const profilesDir = options.profilesDir || null;
  const emitCatalog = async (profile: string, catalogHash: string) => {
    const source = await store.readEditorSource(profile);
    options.observer?.note(profile, catalogHash, source.revision);
    fastify.sse?.broadcast?.('routes-catalog-changed', {
      profile, catalogHash, sourceRevision: source.revision,
    });
  };
  // Режим — стабильная конфигурация профиля, а ответ схемы и так immutable по routeHash.
  const workspaceModeByProfile = new Map<string, 'shared' | 'isolated' | null>();
  const profileWorkspaceMode = async (profile: string) => {
    if (!workspaceModeByProfile.has(profile)) {
      workspaceModeByProfile.set(profile, await sourceProfileWorkspaceMode(profilesDir, profile));
    }
    return workspaceModeByProfile.get(profile) ?? null;
  };

  fastify.get(
    '/api/routes/:profile/current',
    guarded(fastify, async (request, reply) => {
      const current = await store.readCurrent(request.params.profile);
      await options.observer?.register(request.params.profile);
      if (!current) {
        throw new RoutesError('ROUTES_V2_NOT_FOUND', 'current catalog отсутствует');
      }
      reply.header('cache-control', 'no-store');
      return current;
    }),
  );

  // Список ревизий + признак наличия скрипта публикации: одним запросом страница
  // узнаёт и что можно откатить, и есть ли чем публиковать.
  fastify.get(
    '/api/routes/:profile/revisions',
    guarded(fastify, async (request, reply) => {
      const { profile } = request.params;
      const listed = await store.listCatalogRevisions(profile);
      await options.observer?.register(profile);
      reply.header('cache-control', 'no-store');
      return {
        profile,
        publishSupported: Boolean(await profilePublishScript(profilesDir, profile)),
        ...listed,
      };
    }),
  );

  fastify.get(
    '/api/routes/:profile/catalog/:catalogHash',
    guarded(fastify, async (request, reply) => {
      const catalog = await store.readCatalog(
        request.params.profile,
        request.params.catalogHash,
      );
      reply.header('cache-control', 'private, max-age=31536000, immutable');
      return catalog;
    }),
  );

  // Точный каталог содержит и закреплённый routeHash, и СВОЮ разведку. current
  // здесь не читается: историческая схема остаётся неизменной после публикации.
  fastify.get(
    '/api/routes/:profile/catalog/:catalogHash/graph',
    guarded(fastify, async (request, reply) => {
      const routeId = request.query?.route;
      if (typeof routeId !== 'string') throw requestError('Укажите route');
      assertRouteId(routeId);
      const catalog = await store.readCatalog(request.params.profile, request.params.catalogHash);
      const routeHash = catalog.catalog.routes[routeId];
      if (!routeHash) throw new RoutesError('ROUTES_V2_NOT_FOUND', 'Маршрут отсутствует в каталоге');
      const route = await store.readRoute(request.params.profile, routeId, routeHash);
      reply.header('cache-control', 'private, no-store');
      return { graph: buildRouteDef(route.route as Parameters<typeof buildRouteDef>[0],
        routeId, {
          bootstrap: catalog.bootstrap as Parameters<typeof buildRouteDef>[0],
          workspaceMode: (await profileWorkspaceMode(request.params.profile)) ?? undefined,
        }) };
    }),
  );

  fastify.get(
    '/api/routes/:profile/routes/:routeId/:routeHash',
    guarded(fastify, async (request, reply) => {
      const route = await store.readRoute(
        request.params.profile,
        request.params.routeId,
        request.params.routeHash,
      );
      reply.header('cache-control', 'private, max-age=31536000, immutable');
      return route;
    }),
  );

  // Схема маршрута для просмотра. Строит её тот же buildRouteDef, что рисует
  // «Конвейер» живой задачи: картинка опубликованного маршрута и картинка прогона
  // обязаны совпадать — расхождение схем и есть та беда, ради которой заведён v2.
  fastify.get(
    '/api/routes/:profile/routes/:routeId/:routeHash/graph',
    guarded(fastify, async (request, reply) => {
      const { routeId } = request.params;
      const catalogHash = request.query?.c;
      if (catalogHash) {
        const catalog = await store.readCatalog(request.params.profile, catalogHash);
        if (catalog.catalog.routes[routeId] !== request.params.routeHash) {
          throw requestError('Хеш маршрута не входит в указанный каталог');
        }
        const { route } = await store.readRoute(
          request.params.profile, routeId, request.params.routeHash,
        );
        reply.header('cache-control', 'private, no-store');
        return { graph: buildRouteDef(route as Parameters<typeof buildRouteDef>[0], routeId, {
          bootstrap: catalog.bootstrap as Parameters<typeof buildRouteDef>[0],
          workspaceMode: (await profileWorkspaceMode(request.params.profile)) ?? undefined,
        }) };
      }
      const { route } = await store.readRoute(
        request.params.profile,
        routeId,
        request.params.routeHash,
      );
      // ВНИМАНИЕ, не immutable: схема — ПРОИЗВОДНАЯ от бандла (рендерит её код сервера,
      // а не содержимое ревизии). После обновления рендера тот же routeHash обязан отдать
      // новую картинку; immutable-кеш браузера однажды уже показал схему недельной давности.
      reply.header('cache-control', 'private, no-store');
      return {
        graph: buildRouteDef(
          {
            entry: route.entry,
            bootstrap: route.bootstrap,
            sequence: {
              main: route.sequence.main ?? [],
              tail: route.sequence.tail ?? [],
            },
            nodes: route.nodes.map((node) => ({
              ...node,
              runKey: String(node.runKey ?? ''),
            })),
          },
          routeId,
          { workspaceMode: (await profileWorkspaceMode(request.params.profile)) ?? undefined },
        ),
      };
    }),
  );

  fastify.post(
    '/api/routes/:profile/routes/:routeId',
    guarded(fastify, async (request, reply) => {
      assertBody(request.body, ['route', 'prompts']);
      const published = await store.publishRoute(
        request.params.profile,
        request.params.routeId,
        {
          route: request.body.route,
          prompts: request.body.prompts,
        },
      );
      const location = [
        '/api/routes',
        encodeURIComponent(request.params.profile),
        'routes',
        encodeURIComponent(request.params.routeId),
        published.routeHash,
      ].join('/');
      reply
        .code(published.created ? 201 : 200)
        .header('location', location)
        .header('cache-control', 'no-store');
      return published;
    }),
  );

  fastify.post(
    '/api/routes/:profile/catalog',
    guarded(fastify, async (request, reply) => {
      assertBody(request.body, [
        'catalog',
        'bootstrap',
        'prompts',
        'expectedCatalogHash',
      ]);
      const published = await store.publishCatalog(
        request.params.profile,
        {
          catalog: request.body.catalog,
          bootstrap: request.body.bootstrap,
          prompts: request.body.prompts,
        },
        { expectedCatalogHash: request.body.expectedCatalogHash as string | null },
      );
      if (published.currentChanged) {
        await emitCatalog(request.params.profile, published.catalogHash);
      }
      const location = [
        '/api/routes',
        encodeURIComponent(request.params.profile),
        'catalog',
        published.catalogHash,
      ].join('/');
      reply
        .code(published.created ? 201 : 200)
        .header('location', location)
        .header('cache-control', 'no-store');
      return published;
    }),
  );

  fastify.put(
    '/api/routes/:profile/current',
    guarded(fastify, async (request, reply) => {
      assertBody(request.body, ['desiredCatalogHash', 'expectedCatalogHash']);
      const result = await store.compareAndSwapCurrent(
        request.params.profile,
        String(request.body.desiredCatalogHash),
        { expectedCatalogHash: request.body.expectedCatalogHash as string | null },
      );
      if (result.changed) await emitCatalog(request.params.profile, result.catalogHash);
      reply.header('cache-control', 'no-store');
      return result;
    }),
  );

  // Сборка и публикация бандла профиля. mode=validate — сухая проверка (ничего не
  // пишется), mode=publish — новая ревизия + CAS-сдвиг current. Скрипт исполняется
  // от пользователя сервера: профили — тот же круг доверия, что и `factory bin`,
  // который сервер шеллит на каждом запуске конвейера.
  fastify.post(
    '/api/routes/:profile/publish',
    guarded(fastify, async (request, reply) => {
      const { profile } = request.params;
      assertBody(request.body, ['mode'], ['expectedCatalogHash']);
      const { mode } = request.body;
      if (mode !== 'validate' && mode !== 'publish') {
        throw requestError('mode: допустимы только «validate» и «publish»');
      }
      if (mode === 'publish' && (await store.readEditorSource(profile)).mode !== 'profile-script') {
        throw new RoutesError('routes_source_conflict',
          'Профильный скрипт не управляет текущим каталогом');
      }
      const script = await profilePublishScript(profilesDir, profile);
      if (!script) {
        reply.header('cache-control', 'no-store');
        return reply.code(404).send({
          error: 'routes_v2_publish_unavailable',
          message: `У профиля «${profile}» нет скрипта публикации ${PUBLISH_SCRIPT.join('/')}.`,
        });
      }

      const beforeCatalogHash = mode === 'publish'
        ? (await store.readCurrent(profile))?.catalogHash ?? null : null;

      const args = [script];
      if (mode === 'validate') {
        args.push('--validate');
      } else {
        const expected = (request.body.expectedCatalogHash ?? null) as string | null;
        if (expected !== null) assertRevisionHash(expected, 'expectedCatalogHash');
        args.push(
          '--publish',
          '--base-dir', store.baseDir,
          '--expected-catalog-hash', expected === null ? 'null' : expected,
        );
      }

      const routesKit = helperModule(ROUTES_KIT_HELPER);
      let stdout = '';
      let stderr = '';
      let failure: string | null = null;

      try {
        const finished = await runScript(nodeExecutable(), args, {
          cwd: path.join(String(profilesDir), profile),
          env: { ...process.env, [ROUTES_KIT_ENV]: routesKit },
          timeout: PUBLISH_TIMEOUT_MS,
          maxBuffer: PUBLISH_MAX_OUTPUT,
        });
        stdout = String(finished.stdout);
        stderr = String(finished.stderr);
      } catch (error) {
        const failed = error as {
          stdout?: unknown;
          stderr?: unknown;
          message?: unknown;
          killed?: unknown;
        };

        stdout = String(failed?.stdout ?? '');
        stderr = String(failed?.stderr ?? failed?.message ?? '');
        failure = failed?.killed ? 'timeout' : 'exit';
      }

      reply.header('cache-control', 'no-store');
      if (failure) {
        fastify.log.warn({ profile, mode, failure, stderr }, 'routes v2: публикация профиля не прошла');
        return reply.code(422).send({
          error: 'routes_v2_publish_failed',
          reason: failure,
          message: failure === 'timeout'
            ? `Скрипт публикации не уложился в ${PUBLISH_TIMEOUT_MS / 1000} с.`
            : lastMeaningfulLine(stderr) || 'Скрипт публикации завершился с ошибкой.',
          stderr,
        });
      }

      let result: unknown;
      try {
        result = JSON.parse(stdout);
      } catch {
        fastify.log.error({ profile, mode, stdout }, 'routes v2: публикатор ответил не JSON');
        return reply.code(500).send({
          error: 'routes_v2_publish_unreadable',
          message: 'Скрипт публикации вернул не JSON — смотри журнал сервера.',
        });
      }
      const pointer = await store.listCatalogRevisions(profile);
      if (mode === 'publish' && pointer.currentCatalogHash
        && pointer.currentCatalogHash !== beforeCatalogHash) {
        await emitCatalog(profile, pointer.currentCatalogHash);
      }
      return {
        profile,
        mode,
        result,
        currentCatalogHash: pointer.currentCatalogHash,
      };
    }),
  );
}

export { sendRoutesError };
export default fp(registerRoutesApi, { name: 'module-routes-api' });
