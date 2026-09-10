import type { FastifyInstance, FastifyReply } from 'fastify';

import { isLocalRequest, isSecureRequest } from '../../plugins/auth.ts';

type Payload = Record<string, unknown>;

/**
 * Служба баз собирается в приложении из реестра движков, хранилища профилей,
 * менеджера сессий и журнала. Здесь она описана снаружи — тем, что реально зовут
 * маршруты. Всё необязательно: тесты подставляют неполную службу, и отсутствие
 * метода обязано давать пустой ответ, а не падение всего раздела.
 */
export interface DbService {
  listEngines?: () => unknown;
  listProfiles?: () => unknown;
  createProfile?: (input: unknown) => unknown;
  updateProfile?: (id: string, input: unknown) => unknown;
  deleteProfile?: (id: string) => unknown;
  openSession?: (id: string, password: Buffer, sshSessionId: string) => unknown;
  listSessions?: () => unknown;
  setAgentAccess?: (id: string, allowed: boolean) => unknown;
  closeSession?: (id: string) => unknown;
  schema?: (id: string) => unknown;
  query?: (id: string, input: unknown) => unknown;
  listQueries?: () => unknown;
  getQuery?: (id: string) => unknown;
  cancelQuery?: (id: string) => unknown;
  listAudit?: (query: unknown) => unknown;
  answerApproval?: (pid: string, body: Payload) => unknown;
  disable?: () => Promise<void>;
}

export interface DbModuleOptions {
  service?: DbService;
}

interface IdRoute {
  Params: {
    id: string;
  };
  Body: unknown;
}

interface SessionRoute {
  Params: {
    sid: string;
  };
  Body: unknown;
}

interface QueryRoute {
  Params: {
    qid: string;
  };
  Body: unknown;
}

interface ApprovalRoute {
  Params: {
    pid: string;
  };
  Body: unknown;
}

function asRecord(value: unknown): Payload {
  return value !== null && typeof value === 'object' ? value as Payload : {};
}

/**
 * Вызов метода службы с запасным ответом. Служба приходит извне и может оказаться
 * неполной; результат остаётся unknown — маршрут разбирает его сам, а не принимает
 * форму чужого объекта на веру.
 */
function operation(
  service: DbService | undefined,
  name: keyof DbService,
  fallback: unknown,
): (...args: unknown[]) => Promise<unknown> {
  const method = service?.[name] as ((...args: unknown[]) => unknown) | undefined;

  return typeof method === 'function'
    ? (...args: unknown[]) => Promise.resolve(method.apply(service, args))
    : async () => fallback;
}

// Машинный код отказа переводится в статус ответа: панель решает по коду, а не по
// тексту — «сессия потеряна» и «так нельзя» ведут человека к разным шагам.
function sendError(reply: FastifyReply, error: unknown) {
  const source = asRecord(error);
  const value = source.code || source.error;
  const code = typeof value === 'string' && value ? value : 'db_error';
  const status: Record<string, number> = {
    not_found: 404,
    session_not_found: 404,
    origin_mismatch: 409,
    already_resolved: 409,
    duplicate_selector: 409,
    invalid_profile: 400,
    project_not_found: 400,
    secure_connect_required: 403,
  };

  return reply.code(status[code] || 500).send({
    error: code,
    ...(typeof source.message === 'string' && source.message ? { message: source.message } : {}),
  });
}

/** Session-only HTTP API живо проверяет плагин до каждой операции. */
export default async function dbModule(
  fastify: FastifyInstance,
  { service }: DbModuleOptions = {},
): Promise<void> {
  if (!fastify.hasContentTypeParser('application/octet-stream')) {
    fastify.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: 16 * 1_024 },
      (_request, body, done) => done(null, body),
    );
  }
  fastify.addHook('onRequest', async (request, reply) => {
    if (!fastify.pluginEnabled('db')) return reply.code(404).send({ error: 'plugin_disabled' });
    if (request.authKind !== 'session') return reply.code(403).send({ error: 'session_required' });
  });

  const call = (name: keyof DbService, fallback: unknown) => operation(service, name, fallback);
  fastify.get('/api/db/engines', async () => ({ engines: await call('listEngines', [])() }));
  fastify.get('/api/db/profiles', async () => ({ profiles: await call('listProfiles', [])() }));
  fastify.post<IdRoute>('/api/db/profiles', async (request, reply) => {
    try { return await call('createProfile', null)(request.body || {}); } catch (error) {
      return sendError(reply, error);
    }
  });
  fastify.put<IdRoute>('/api/db/profiles/:id', async (request, reply) => {
    try { return await call('updateProfile', null)(String(request.params.id), request.body || {}); }
    catch (error) { return sendError(reply, error); }
  });
  fastify.delete<IdRoute>('/api/db/profiles/:id', async (request, reply) => {
    try { return { ok: await call('deleteProfile', false)(String(request.params.id)) }; }
    catch (error) { return sendError(reply, error); }
  });
  fastify.post<IdRoute>('/api/db/profiles/:id/sessions', async (request, reply) => {
    if (!isLocalRequest(request) && !isSecureRequest(request)) {
      return reply.code(403).send({ error: 'secure_connect_required' });
    }
    const password = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from((request.body || '') as string);
    try {
      return await call('openSession', null)(
        String(request.params.id),
        password,
        String(request.headers['x-cockpit-ssh-session-id'] || ''),
      );
    } catch (error) {
      return sendError(reply, error);
    } finally {
      password.fill(0);
    }
  });
  fastify.get('/api/db/sessions', async () => ({ sessions: await call('listSessions', [])() }));
  fastify.put<SessionRoute>('/api/db/sessions/:sid/agent-access', async (request, reply) => {
    try {
      return await call('setAgentAccess', null)(
        String(request.params.sid), asRecord(request.body).allowed === true,
      );
    } catch (error) { return sendError(reply, error); }
  });
  fastify.delete<SessionRoute>('/api/db/sessions/:sid', async (request, reply) => {
    try { return { ok: await call('closeSession', false)(String(request.params.sid)) }; }
    catch (error) { return sendError(reply, error); }
  });
  fastify.get<SessionRoute>('/api/db/sessions/:sid/schema', async (request, reply) => {
    try { return await call('schema', null)(String(request.params.sid)); }
    catch (error) { return sendError(reply, error); }
  });
  fastify.post<SessionRoute>('/api/db/sessions/:sid/query', async (request, reply) => {
    try {
      const result = await call('query', null)(String(request.params.sid), request.body || {});
      return reply.code(202).send(result);
    } catch (error) { return sendError(reply, error); }
  });
  fastify.get('/api/db/queries', async () => ({ queries: await call('listQueries', [])() }));
  fastify.get<QueryRoute>('/api/db/queries/:qid', async (request, reply) => {
    try { return await call('getQuery', null)(String(request.params.qid)); }
    catch (error) { return sendError(reply, error); }
  });
  fastify.post<QueryRoute>('/api/db/queries/:qid/cancel', async (request, reply) => {
    try { return await call('cancelQuery', null)(String(request.params.qid)); }
    catch (error) { return sendError(reply, error); }
  });
  fastify.get('/api/db/audit', async (request) => call('listAudit', { items: [] })(request.query));
  fastify.post<ApprovalRoute>('/api/db/approvals/:pid', async (request, reply) => {
    try {
      const result = await call('answerApproval', { ok: false, error: 'not_found' })(
        String(request.params.pid), { allow: asRecord(request.body).allow === true },
      );

      return asRecord(result).ok === false ? sendError(reply, result) : result;
    } catch (error) { return sendError(reply, error); }
  });
}
