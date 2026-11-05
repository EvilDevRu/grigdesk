import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isPlainRecord } from '../../../../shared/lib/objects.ts';
import type { createBrowserBroker } from '../../lib/browser/browserBroker.ts';
import type { createBrowserAccess } from '../../lib/browser/browserAccess.ts';

type Broker = ReturnType<typeof createBrowserBroker>;
type Access = ReturnType<typeof createBrowserAccess>;

interface BrowserModuleOptions {
  broker: Broker;
  access: Access;
  routing: {
    mode(): 'legacy' | 'grigdesk';
    set(mode: 'legacy' | 'grigdesk'): void;
  };
  owners: {
    list(): Promise<{ id: string; label: string }[]>;
    resolve(id: string): Promise<string>;
  };
}

/**
 * Browser host/grant управляется только человеческой session, не CLI/internal bearer.
 * Общий auth guard остаётся обязательным, а request body не выбирает способ авторизации.
 */
function human(request: FastifyRequest): void {
  if (request.authKind !== 'session') {
    throw new Error('browser_human_required');
  }
}

/**
 * Ручная проверка сохраняет неизвестные поля до отказа вместо AJV removeAdditional.
 * JSON schema инструмента не заменяет проверку входа HTTP и IPC.
 */
function body(request: FastifyRequest, allowed: string[]): Record<string, unknown> {
  if (!isPlainRecord(request.body) || Object.keys(request.body).some((key) => !allowed.includes(key))) {
    throw new Error('browser_request_invalid');
  }

  return request.body;
}

/**
 * Token остаётся в заголовке и не попадает в URL или тело прикладного журнала.
 * Текущий host ID выбирает сервер, поэтому grant нельзя направить соседнему клиенту.
 */
function host(request: FastifyRequest, broker: Broker, id = broker.hostId()): string {
  const token = request.headers['x-grigdesk-browser-host'];

  if (!id || typeof token !== 'string' || token.length > 256) {
    throw new Error('host_forbidden');
  }

  broker.assertHost(id, token);

  return token;
}

/**
 * Ошибка отдаёт стабильный код без private paths, stack и текста страницы.
 * Неизвестный отказ не превращается в успешный ответ host-протокола.
 */
function refuse(reply: FastifyReply, error: unknown) {
  const code = (error as Error).message;
  const known = /^(browser_[a-z_]+|host_forbidden|host_expired|outcome_unknown)$/u.test(code);
  const status = ['host_forbidden', 'browser_human_required'].includes(code) ? 403
    : code === 'browser_host_conflict' || code === 'host_expired' ? 409
      : code === 'browser_request_invalid' ? 400 : 503;

  return reply.code(status).send({ error: known ? code : 'browser_unavailable' });
}

/**
 * Модуль владеет только маршрутизацией: grants и очередь живут в переданных сервисах.
 * Регистрация выполняется после общего authPlugin, публичных исключений нет.
 */
export default async function browserModule(app: FastifyInstance, options: BrowserModuleOptions) {
  const { broker, access, owners, routing } = options;

  app.post('/api/browser/mode', { bodyLimit: 65536 }, async (request, reply) => {
    try {
      human(request);

      const value = body(request, ['enabled']);

      if (value.enabled !== false) {
        throw new Error('browser_request_invalid');
      }

      const current = broker.hostId();
      const token = broker.available() ? host(request, broker) : null;

      routing.set('legacy');

      if (current && token) {
        broker.unregister(current, token);
      }

      access.clear();

      return { enabled: false };
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.get('/api/browser/owners', async (request, reply) => {
    try {
      human(request);

      return { owners: (await owners.list()).slice(0, 200) };
    } catch (error) {
      return refuse(reply, error);
    }
  });
  app.post('/api/browser/hosts', { bodyLimit: 65536 }, async (request, reply) => {
    try {
      human(request);

      const value = body(request, ['takeover']);

      if (value.takeover !== undefined && typeof value.takeover !== 'boolean') {
        throw new Error('browser_request_invalid');
      }

      const registration = broker.register({ takeover: value.takeover === true });

      try {
        routing.set('grigdesk');
      } catch (error) {
        broker.unregister(registration.id, registration.token);

        throw error;
      }

      access.clear();

      return { ...registration, leaseMs: 15000 };
    } catch (error) {
      return refuse(reply, error);
    }
  });
  app.post<{ Params: { id: string } }>('/api/browser/hosts/:id/heartbeat',
    { bodyLimit: 65536 }, async (request, reply) => {
      try {
        human(request);

        const token = host(request, broker, request.params.id);
        const value = body(request, ['grants']);
        const rows = value.grants;

        if (!Array.isArray(rows) || rows.some((row) => !isPlainRecord(row)
          || Object.keys(row).sort().join(',') !== 'grantEpoch,pageEpoch,paused,tabId'
          || typeof row.tabId !== 'string' || !Number.isSafeInteger(row.grantEpoch)
          || !Number.isSafeInteger(row.pageEpoch) || typeof row.paused !== 'boolean')) {
          throw new Error('browser_request_invalid');
        }

        broker.heartbeat(request.params.id, token);
        access.reconcile(rows as {
          tabId: string;
          grantEpoch: number;
          pageEpoch: number;
          paused: boolean
        }[]);

        return { leaseMs: 15000 };
      } catch (error) {
        return refuse(reply, error);
      }
    });
  app.post<{ Params: { id: string } }>('/api/browser/hosts/:id/poll',
    { bodyLimit: 65536 }, async (request, reply) => {
      const controller = new AbortController();
      const onClose = () => {
        if (!reply.raw.writableEnded) {
          controller.abort();
        }
      };

      reply.raw.once('close', onClose);

      try {
        human(request);

        const token = host(request, broker, request.params.id);

        body(request, []);

        return await broker.poll(request.params.id, token, controller.signal);
      } catch (error) {
        return refuse(reply, error);
      } finally {
        reply.raw.removeListener('close', onClose);
      }
    });
  app.post<{ Params: { id: string } }>('/api/browser/hosts/:id/result',
    { bodyLimit: 3 * 1024 * 1024 }, async (request, reply) => {
      try {
        human(request);

        const token = host(request, broker, request.params.id);
        const value = body(request, ['requestId', 'result']);

        if (typeof value.requestId !== 'string' || !Object.hasOwn(value, 'result')) {
          throw new Error('browser_request_invalid');
        }

        await broker.result(request.params.id, token, value.requestId, value.result);

        return { accepted: true };
      } catch (error) {
        return refuse(reply, error);
      }
    });
  app.delete<{ Params: { id: string } }>('/api/browser/hosts/:id', async (request, reply) => {
    try {
      human(request);
      broker.unregister(request.params.id, host(request, broker, request.params.id));
      access.clear();

      return { accepted: true };
    } catch (error) {
      return refuse(reply, error);
    }
  });
  app.post('/api/browser/grants', { bodyLimit: 65536 }, async (request, reply) => {
    try {
      human(request);
      host(request, broker);

      const value = body(request, ['tabId', 'ownerId', 'pageEpoch', 'grantEpoch']);

      if (typeof value.tabId !== 'string' || typeof value.ownerId !== 'string'
        || !Number.isSafeInteger(value.pageEpoch) || !Number.isSafeInteger(value.grantEpoch)) {
        throw new Error('browser_request_invalid');
      }

      const owner = await owners.resolve(value.ownerId);
      const snapshot = await broker.control(owner, {
        tabId: value.tabId,
        pageEpoch: Number(value.pageEpoch),
        grantEpoch: Number(value.grantEpoch),
      }) as { tabs: {
        id: string;
        url: string;
        grantEpoch: number
      }[] };
      const tab = snapshot.tabs.find((item) => item.id === value.tabId);

      if (!tab) {
        throw new Error('browser_result_invalid');
      }

      access.commitGrant(owner, {
        tabId: tab.id,
        url: tab.url,
        grantEpoch: tab.grantEpoch
      });

      return snapshot;
    } catch (error) {
      return refuse(reply, error);
    }
  });
  app.delete<{ Params: { id: string } }>('/api/browser/grants/:id', async (request, reply) => {
    try {
      human(request);
      host(request, broker);
      access.revoke(request.params.id);

      return { accepted: true };
    } catch (error) {
      return refuse(reply, error);
    }
  });
}
