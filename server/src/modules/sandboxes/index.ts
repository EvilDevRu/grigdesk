// Модуль «Песочницы»: обзор стендов, подъём, снос и действия профиля на стенде.
//
// Доступ: общий auth guard закрывает весь /api, а здесь добавлено ещё одно условие —
// СЕССИЯ человека. CLI-токен агента сюда не пускается намеренно: подъём стенда занимает
// слот и десяток минут, а действие профиля гоняет стенд по-настоящему — такие решения
// принимает человек. Агенту остаётся обычный Bash со своими правилами подтверждения.
import fp from 'fastify-plugin';
import type { FastifyReply } from 'fastify';

import { isRecord } from '../../../../shared/lib/objects.ts';

import { PROFILE_RE } from '../../lib/profiles.ts';
import {
  SANDBOX_ACTION_ID_RE,
  SANDBOX_TASK_RE,
} from '../../../../shared/plugins/sandboxes/sandboxContracts.ts';
import type { SandboxService } from '../../lib/sandboxes/service.ts';

interface SandboxesModuleOptions {
  service: SandboxService;
}

interface RaiseRoute {
  Body: {
    profile?: unknown;
    task?: unknown;
  };
}

interface DismantleRoute {
  Body: {
    force?: unknown;
  };
  Params: {
    task: string;
  };
}

interface RunRoute {
  Body: {
    args?: unknown;
  };
  Params: {
    task: string;
    action: string;
  };
}

interface TaskRoute {
  Params: {
    task: string;
  };
}

/**
 * Объявленный отказ службы несёт свой код, статус и текст для человека. Исключение
 * без кода — чужое: оно получает общий ответ, и его текст наружу не уходит.
 */
function sendError(reply: FastifyReply, error: unknown) {
  const source = isRecord(error) ? error : {};
  const code = typeof source.code === 'string' && source.code ? source.code : '';
  const message = typeof source.message === 'string' ? source.message : '';

  if (!code) {
    return reply.code(500).send({ error: 'sandbox_error' });
  }

  return reply.code(Number(source.status) || 500).send({ error: code, message });
}

export default fp<SandboxesModuleOptions>(async function sandboxesModule(fastify, { service }) {
  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/sandboxes')) {
      return;
    }

    if (request.authKind !== 'session') {
      return reply.code(403).send({ error: 'session_required' });
    }
  });

  fastify.get('/api/sandboxes', async (request, reply) => {
    try {
      return await service.overview();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<RaiseRoute>('/api/sandboxes', async (request, reply) => {
    const profile = String(request.body?.profile ?? '');
    const raw = request.body?.task;
    const task = raw === undefined || raw === null || raw === '' ? null : String(raw);

    if (!PROFILE_RE.test(profile)) {
      return reply.code(400).send({ error: 'bad_profile' });
    }

    if (task !== null && !SANDBOX_TASK_RE.test(task)) {
      return reply.code(400).send({ error: 'bad_task' });
    }

    try {
      return await service.raise({ profile, task });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<DismantleRoute>('/api/sandboxes/:task/down', async (request, reply) => {
    const task = String(request.params.task);

    if (!SANDBOX_TASK_RE.test(task)) {
      return reply.code(400).send({ error: 'bad_task' });
    }

    try {
      return await service.dismantle({ task, force: request.body?.force === true });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Действие профиля на поднятом стенде: аргументы приходят телом и проверяются
  // службой по объявлению манифеста — здесь только форма номера и идентификатора.
  fastify.post<RunRoute>('/api/sandboxes/:task/actions/:action', async (request, reply) => {
    const task = String(request.params.task);
    const action = String(request.params.action);

    if (!SANDBOX_TASK_RE.test(task)) {
      return reply.code(400).send({ error: 'bad_task' });
    }

    if (!SANDBOX_ACTION_ID_RE.test(action)) {
      return reply.code(400).send({ error: 'bad_action' });
    }

    try {
      return await service.run({ task, action, args: request.body?.args });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Хвост вывода текущего задания стенда: подъёма, сноса или прогона.
  fastify.get<TaskRoute>('/api/sandboxes/:task/log', async (request, reply) => {
    const task = String(request.params.task);

    if (!SANDBOX_TASK_RE.test(task)) {
      return reply.code(400).send({ error: 'bad_task' });
    }

    try {
      return await service.jobLog(task);
    } catch (error) {
      return sendError(reply, error);
    }
  });
});
