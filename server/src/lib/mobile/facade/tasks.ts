import { recordOrEmpty } from '../../../../../shared/lib/objects.ts';

import { waitingReason } from '../../../../../shared/pipeline/pipelineWait.ts';
import type { PipelineGraph } from '../../../../../shared/pipeline/pipelineWait.ts';

import { decodeContract } from '../contract.ts';
import type { Actions, TaskSummary } from '../contract.ts';
import { MobileInputError } from '../errors.ts';
import { factorySnapshotHash } from '../factoryIdentity.ts';
import type { MobileApp } from '../mobileServer.ts';
import { paginate, TextPages, text, upstream } from './common.ts';
import type { FacadeDeps, Payload } from './common.ts';

type Deps = Pick<FacadeDeps, 'callApi' | 'tokens'>;

/**
 * Задачный маршрут принимает канонический числовой id, без удаления посторонних символов.
 * URL не может перенаправить команду на другой ресурс после нормализации.
 */
export function taskId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) {
    throw new MobileInputError('bad_request', 'Неверный номер задачи.');
  }

  return value;
}

/**
 * Сводка знает вмешательства по фактическим полям factory summary.
 * Граф читается только при ожидании; работающие задачи не создают дорогое перечитывание.
 */
function waitingTask(task: Payload) {
  return Boolean(
    task.stalledHuman ||
    task.stall ||
    task.bootstrapStop ||
    task.readOnly ||
    Object.values(recordOrEmpty(task.stages)).some((status) =>
      ['wait', 'waiting', 'premature'].includes(String(status)),
    ),
  );
}

/**
 * Выпускает токены только для проверенной exact identity текущей попытки.
 * Неизвестное вмешательство остаётся текстом без угаданной кнопки ворот.
 */
async function summary(deps: Deps, device: string, task: Payload) {
  const id = taskId(String(task.task));
  let graph: Payload = {};
  let control: Payload = {};

  if (waitingTask(task)) {
    try {
      graph = await upstream(deps, 'GET', `/api/tasks/${id}/graph`);
      control = await upstream(deps, 'GET', `/api/tasks/${id}/mobile-state`);
    } catch {
      // Read-only задача остаётся видимой; отсутствие trusted identity закрывает команды.
      // Общий API не выдаёт права по одному названию gate в старой проекции.
    }
  }

  const identity = recordOrEmpty(control.identity);
  const wait = waitingReason(graph as PipelineGraph);
  const gate = wait ? String(recordOrEmpty(graph.keys)[wait.node] || '') : '';
  const canGate =
    wait &&
    /^GATE_[A-Z0-9_]{1,64}$/.test(gate) &&
    identity.node === wait.node &&
    ['ready', 'paused'].includes(String(identity.state)) &&
    !identity.terminal;
  const needsHuman: TaskSummary['needsHuman'] = canGate
    ? {
        kind: 'gate',
        gate,
        text: text(wait.text, 4000),
        actionToken: deps.tokens.issue(device, `task:${id}`, 'gate', {
          identity,
          gate,
        }),
      }
    : waitingTask(task)
      ? {
          kind: 'other',
          gate: null,
          text: text(
            recordOrEmpty(task.stall).reason ||
              recordOrEmpty(task.bootstrapStop).reason ||
              (task.readOnly ? 'Попытка доступна только для чтения.' : 'Требуется обычный GrigDesk.'),
            4000,
          ),
          actionToken: null,
        }
      : null;
  const stages = recordOrEmpty(task.stages);
  const stage =
    Object.keys(stages).find((key) =>
      ['run', 'running', 'wait', 'waiting', 'premature'].includes(String(stages[key])),
    ) || '';
  const result: TaskSummary = {
    id,
    title: text(task.title || `Задача ${id}`, 800),
    state: ['completed', 'done'].includes(String(task.result))
      ? 'done'
      : needsHuman
        ? 'waiting'
        : task.daemonAlive
          ? 'running'
          : task.attempt
            ? 'stopped'
            : 'idle',
    stage,
    needsHuman,
    updatedAt:
      typeof task.updatedAt === 'number' && Number.isSafeInteger(task.updatedAt)
        ? Math.max(0, task.updatedAt)
        : 0,
  };

  return {
    result,
    graph,
    control,
  };
}

/**
 * Основание ворот берётся из того же документа, который показывает основной GrigDesk.
 * Пустой/пропавший документ запрещает подтверждение вместо чтения выжимки.
 */
async function basis(deps: Deps, id: string, identity: Payload) {
  const name =
    identity.node === 'gate_accept' ? 'report' : identity.node === 'gate_cause' ? 'diag' : 'plan';

  try {
    const document = await upstream(deps, 'GET', `/api/tasks/${id}/doc/${name}`);

    if (typeof document.text === 'string' && document.text.trim()) {
      return document.text;
    }
  } catch (error) {
    if (!(error instanceof MobileInputError) || error.status !== 404) {
      throw error;
    }
  }

  throw new MobileInputError('no_plan', 'Основание решения ещё не найдено.', 404);
}

/**
 * Маршруты выполняют перевод DTO, а команды передают identity общему владельцу factory.
 * Чтение полного основания связано с revision попытки и не переносится на следующий заход.
 */
export function registerTaskRoutes(app: MobileApp, deps: Deps) {
  const pages = new TextPages(deps.tokens);

  app.get<{ Querystring: Payload }>('/api/mobile/v1/tasks', async (request) => {
    const source = await upstream(deps, 'GET', '/api/tasks');
    const tasks = Array.isArray(source.tasks) ? source.tasks.map(recordOrEmpty) : [];
    const page = paginate(tasks, request.query, 8192);
    const mapped = [];

    for (const task of page.items) {
      mapped.push((await summary(deps, request.mobileDevice!.id, task)).result);
    }

    return decodeContract('tasks', {
      tasks: mapped,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    });
  });
  app.get<{ Params: { id: string } }>('/api/mobile/v1/tasks/:id', async (request) => {
    const id = taskId(request.params.id);
    const source = await upstream(deps, 'GET', `/api/tasks/${id}`);
    const mapped = await summary(deps, request.mobileDevice!.id, source);
    const graph = Object.keys(mapped.graph).length
      ? mapped.graph
      : await upstream(deps, 'GET', `/api/tasks/${id}/graph`);
    const control = Object.keys(mapped.control).length
      ? mapped.control
      : await upstream(deps, 'GET', `/api/tasks/${id}/mobile-state`).catch(() => ({}));
    const identity = recordOrEmpty(recordOrEmpty(control).identity);
    const actions: Actions = {};

    if (identity.attempt && !identity.terminal) {
      const action = recordOrEmpty(control).running ? 'stop' : 'resume';

      actions[action] = deps.tokens.issue(request.mobileDevice!.id, `task:${id}`, action, {
        identity,
      });
    }

    const statuses: Record<string, 'done' | 'running' | 'waiting' | 'failed' | 'idle'> = {
      done: 'done',
      approved: 'done',
      run: 'running',
      running: 'running',
      wait: 'waiting',
      waiting: 'waiting',
      premature: 'waiting',
      fail: 'failed',
      failed: 'failed',
      rejected: 'failed',
    };
    const stages = Object.keys(recordOrEmpty(graph.pos))
      .slice(0, 100)
      .map((node) => ({
        key: text(recordOrEmpty(graph.keys)[node] || node, 200),
        title: text((recordOrEmpty(graph.nodes)[node] as unknown[] | undefined)?.[1] || node, 800),
        status: statuses[String(recordOrEmpty(graph.statuses)[node])] || 'idle',
      }));

    return decodeContract('task', {
      task: {
        ...mapped.result,
        stages,
        actions,
      },
    });
  });
  app.get<{
    Params: { id: string };
    Querystring: Payload;
  }>('/api/mobile/v1/tasks/:id/plan', async (request) => {
    const id = taskId(request.params.id);
    const control = await upstream(deps, 'GET', `/api/tasks/${id}/mobile-state`);
    const identity = recordOrEmpty(control.identity);
    const source = await basis(deps, id, identity);

    return decodeContract(
      'plan',
      pages.page(request.mobileDevice!.id, `task:${id}`, source, request.query, { identity }),
    );
  });
  app.post<{
    Params: { id: string };
    Body: Payload;
  }>('/api/mobile/v1/tasks/:id/gate', async (request) => {
    const id = taskId(request.params.id);
    const body = request.body;

    if (
      !body ||
      !['approve', 'reject'].includes(String(body.decision)) ||
      typeof (body.comment ?? '') !== 'string' ||
      String(body.comment || '').length > 4000
    ) {
      throw new MobileInputError('bad_request', 'Неверное решение или слишком длинное пояснение.');
    }

    const snapshot = deps.tokens.take(
      request.mobileDevice!.id,
      `task:${id}`,
      'gate',
      body.actionToken,
    );
    const identity = recordOrEmpty(snapshot.identity);

    if (body.gate !== snapshot.gate || !/^GATE_[A-Z0-9_]{1,64}$/.test(String(body.gate))) {
      throw new MobileInputError('state_changed', 'Ворота изменились; обновите карточку.', 409);
    }

    const source = await basis(deps, id, identity);

    if (!pages.isRead(request.mobileDevice!.id, `task:${id}`, source, { identity })) {
      throw new MobileInputError('content_not_read', 'Прочитайте всё основание решения.', 409);
    }

    const result = await upstream(
      deps,
      'POST',
      `/api/tasks/${id}/gate/${body.gate}/${body.decision}`,
      {
        profile: identity.profile,
        attempt: identity.attempt,
        expectedMobile: identity,
        expectedBasis: {
          name:
            identity.node === 'gate_accept'
              ? 'report'
              : identity.node === 'gate_cause'
                ? 'diag'
                : 'plan',
          hash: factorySnapshotHash(source),
        },
        comment: body.comment || '',
      },
    );

    return decodeContract('gate', {
      ok: true,
      resumed: result.resumed === true,
      resumeError: result.resumeError == null ? null : text(result.resumeError, 4000),
    });
  });

  for (const action of ['resume', 'stop'] as const) {
    app.post<{
      Params: { id: string };
      Body: Payload;
    }>(`/api/mobile/v1/tasks/:id/${action}`, async (request) => {
      const id = taskId(request.params.id);
      const snapshot = deps.tokens.take(
        request.mobileDevice!.id,
        `task:${id}`,
        action,
        request.body?.actionToken,
      );
      const identity = recordOrEmpty(snapshot.identity);

      await upstream(deps, 'POST', `/api/tasks/${id}/${action}`, {
        profile: identity.profile,
        attempt: identity.attempt,
        expectedMobile: identity,
      });

      return decodeContract('stop', { ok: true });
    });
  }
}
