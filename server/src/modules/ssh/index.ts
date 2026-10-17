// Модуль SSH: HTTP человека и один WebSocket терминала.
//
// Плагин не оборачивается fastify-plugin намеренно: его onRequest-хук должен остаться
// внутри этой регистрации. Вынесенный наружу, он потребовал бы сессию человека от
// всего сервера, включая CLI-канал агента.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {} from '@fastify/websocket';
import type { WebSocket } from 'ws';

import { objectOrEmpty } from '../../../../shared/lib/objects.ts';

import { isLocalRequest, isSecureRequest } from '../../plugins/auth.ts';

/**
 * Служба SSH собирается в приложении из хранилища, менеджера сессий и журнала.
 * Здесь она описана снаружи — тем, что реально зовут маршруты. Почти всё
 * необязательно: тесты подставляют неполную службу, и отсутствие метода обязано
 * давать пустой ответ, а не падение всего раздела.
 */
export interface SshService {
  listConnections?: () => unknown;
  createConnection?: (input: unknown) => unknown;
  updateConnection?: (id: string, input: unknown) => unknown;
  deleteConnection?: (id: string) => unknown;
  probeHostKey?: (id: string) => unknown;
  decideHostKey?: (challengeId: string, decision: string) => unknown;
  openSession: (id: string, password: Buffer) => Promise<unknown>;
  listSessions?: () => unknown;
  setAgentAccess?: (id: string, allowed: boolean) => unknown;
  closeSession?: (id: string) => unknown;
  attachTerminal: (id: string, socket: WebSocket) => (() => void) | undefined;
  writeTerminal?: (id: string, data: string) => unknown;
  resizeTerminal?: (id: string, cols: unknown, rows: unknown) => unknown;
  listFiles?: (id: string, remotePath: unknown) => unknown;
  downloadFile?: (id: string, remotePath: unknown) => unknown;
  uploadFile?: (id: string, request: FastifyRequest) => unknown;
  listAudit?: (query: unknown) => unknown;
  answerApproval?: (pid: string, body: { allow: boolean; comment: string }) => unknown;
  disable?: () => Promise<void>;
}

export interface SshModuleOptions {
  service: SshService;
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
  Querystring: {
    path?: unknown;
  };
  Body: unknown;
}

interface ChallengeRoute {
  Params: {
    challengeId: string;
  };
  Body: unknown;
}

interface ApprovalRoute {
  Params: {
    pid: string;
  };
  Body: unknown;
}

interface AuditRoute {
  Querystring: Record<string, unknown>;
}

/**
 * Вызов метода службы с запасным ответом. Служба приходит извне и может оказаться
 * неполной; результат остаётся unknown — маршрут разбирает его сам, а не принимает
 * форму чужого объекта на веру.
 */
function wrap(name: keyof SshService, fallback: unknown) {
  return async (service: SshService, ...args: unknown[]): Promise<unknown> => {
    const operation = service?.[name] as ((...rest: unknown[]) => unknown) | undefined;

    if (typeof operation !== 'function') {
      return fallback;
    }

    return operation.call(service, ...args);
  };
}

const call = {
  listConnections: wrap('listConnections', []),
  createConnection: wrap('createConnection', null),
  updateConnection: wrap('updateConnection', null),
  deleteConnection: wrap('deleteConnection', false),
  probeHostKey: wrap('probeHostKey', null),
  decideHostKey: wrap('decideHostKey', null),
  listSessions: wrap('listSessions', []),
  setAgentAccess: wrap('setAgentAccess', null),
  closeSession: wrap('closeSession', false),
  listFiles: wrap('listFiles', []),
  downloadFile: wrap('downloadFile', null),
  uploadFile: wrap('uploadFile', null),
  listAudit: wrap('listAudit', { items: [], nextCursor: null }),
  answerApproval: wrap('answerApproval', { ok: false, error: 'not_found' }),
};

/**
 * Машинный код отказа переводится в статус ответа. Панель решает по коду, а не по
 * тексту: «сессия потеряна» и «так нельзя» ведут человека к разным следующим шагам.
 */
function sendError(reply: FastifyReply, error: unknown) {
  const source = objectOrEmpty(error);
  const value = source.code || source.error;
  const code = typeof value === 'string' && value ? value : 'ssh_error';
  const statuses: Record<string, number> = {
    not_found: 404,
    session_not_found: 404,
    challenge_not_found: 404,
    duplicate_selector: 409,
    trust_required: 409,
    origin_mismatch: 409,
    already_resolved: 409,
    invalid_connection: 400,
    invalid_decision: 400,
    project_not_found: 400,
  };

  return reply.code(statuses[code] || 500).send({
    error: code,
    ...(typeof source.message === 'string' && source.message ? { message: source.message } : {}),
  });
}

/**
 * Human API проверяет живой флаг на каждом запросе, включая WebSocket upgrade.
 * Auth provenance дополнительно закрывает SFTP и пароль от internal/CLI каналов.
 */
async function sshModule(fastify: FastifyInstance, options: SshModuleOptions): Promise<void> {
  const { service } = options;

  if (!fastify.hasContentTypeParser('application/octet-stream')) {
    fastify.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: 16 * 1_024 },
      (_request, body, done) => done(null, body),
    );
  }

  fastify.addHook('onRequest', async (request, reply) => {
    if (!fastify.pluginEnabled('ssh')) {
      return reply.code(404).send({ error: 'plugin_disabled' });
    }
    if (request.authKind !== 'session') {
      return reply.code(403).send({ error: 'session_required' });
    }
  });

  fastify.get('/api/ssh/connections', async (_request, reply) => {
    try {
      const result = await call.listConnections(service);
      return Array.isArray(result) ? { connections: result } : result;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<IdRoute>('/api/ssh/connections', async (request, reply) => {
    try {
      return await call.createConnection(service, request.body || {});
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.put<IdRoute>('/api/ssh/connections/:id', async (request, reply) => {
    try {
      return await call.updateConnection(service, String(request.params.id), request.body || {});
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.delete<IdRoute>('/api/ssh/connections/:id', async (request, reply) => {
    try {
      return { ok: await call.deleteConnection(service, String(request.params.id)) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<IdRoute>('/api/ssh/connections/:id/host-key/probe', async (request, reply) => {
    try {
      return await call.probeHostKey(service, String(request.params.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<ChallengeRoute>('/api/ssh/host-key/:challengeId', async (request, reply) => {
    try {
      return await call.decideHostKey(
        service,
        String(request.params.challengeId),
        String(objectOrEmpty(request.body).decision || ''),
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get('/api/ssh/sessions', async (_request, reply) => {
    try {
      const result = await call.listSessions(service);
      return Array.isArray(result) ? { sessions: result } : result;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<IdRoute>('/api/ssh/connections/:id/sessions', async (request, reply) => {
    if (!isLocalRequest(request) && !isSecureRequest(request)) {
      return reply.code(403).send({ error: 'secure_connect_required' });
    }
    const password = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from((request.body || '') as string);
    try {
      return await service.openSession(String(request.params.id), password);
    } catch (error) {
      return sendError(reply, error);
    } finally {
      password.fill(0);
    }
  });

  fastify.put<SessionRoute>('/api/ssh/sessions/:sid/agent-access', async (request, reply) => {
    try {
      return await call.setAgentAccess(
        service,
        String(request.params.sid),
        objectOrEmpty(request.body).allowed === true,
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.delete<SessionRoute>('/api/ssh/sessions/:sid', async (request, reply) => {
    try {
      return { ok: await call.closeSession(service, String(request.params.sid)) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get<SessionRoute>(
    '/api/ssh/sessions/:sid/terminal',
    { websocket: true },
    (socket, request) => {
      const sid = String(request.params.sid);
      let detach: (() => void) | undefined;

      try {
        detach = service.attachTerminal(sid, socket);
      } catch {
        socket.close(1008, 'session_not_found');

        return;
      }

      socket.on('message', (raw: unknown) => {
        let message: Record<string, unknown>;

        try {
          message = objectOrEmpty(JSON.parse(String(raw)));
        } catch {
          return;
        }
        if (message.t === 'in' && typeof message.d === 'string') {
          service.writeTerminal?.(sid, message.d);
        }
        if (message.t === 'resize') {
          service.resizeTerminal?.(sid, message.cols, message.rows);
        }
      });
      socket.once('close', () => detach?.());
      socket.once('error', () => detach?.());
    },
  );

  fastify.get<SessionRoute>('/api/ssh/sessions/:sid/files', async (request, reply) => {
    try {
      const result = await call.listFiles(service, String(request.params.sid), request.query?.path);
      return Array.isArray(result) ? { files: result } : result;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get<SessionRoute>('/api/ssh/sessions/:sid/files/download', async (request, reply) => {
    try {
      const result = await call.downloadFile(
        service,
        String(request.params.sid),
        request.query?.path,
      );
      const source = objectOrEmpty(result);
      if (typeof source.contentType === 'string') {
        reply.type(source.contentType);
      }
      return reply.send(source.stream || source.data || result);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<SessionRoute>('/api/ssh/sessions/:sid/files/upload', async (request, reply) => {
    try {
      return await call.uploadFile(service, String(request.params.sid), request);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get<AuditRoute>('/api/ssh/audit', async (request, reply) => {
    try {
      return await call.listAudit(service, request.query || {});
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<ApprovalRoute>('/api/ssh/approvals/:pid', async (request, reply) => {
    // Пояснение необязательно: трение стоит на разрешении, а не на отказе. Требование
    // текста заворачивало пустой отказ в 400, клиент молча перечитывал очередь, и
    // карточка возвращалась на экран без единого слова о причине.
    const source = objectOrEmpty(request.body);
    const body = {
      allow: source.allow === true,
      comment: String(source.comment || '').trim().slice(0, 4_000),
    };

    try {
      const result = await call.answerApproval(service, String(request.params.pid), body);
      if (objectOrEmpty(result).ok === false) {
        return sendError(reply, result);
      }
      return result;
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

export default sshModule;
