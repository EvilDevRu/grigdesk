import { describeStatus } from '../../b24/status.ts';

import { decodeContract } from '../contract.ts';
import type { B24Summary } from '../contract.ts';
import { MobileInputError } from '../errors.ts';
import { factorySnapshotHash } from '../factoryIdentity.ts';
import type { MobileApp } from '../mobileServer.ts';
import { paginate, record, text, upstream } from './common.ts';
import type { FacadeDeps, Payload } from './common.ts';
import { taskId } from './tasks.ts';

type Deps = Pick<FacadeDeps, 'callApi' | 'tokens'>;

/**
 * Dashboard и detail называют дату разными полями; пустая дата остаётся null.
 * Некорректный текст портала не публикуется числом NaN в контракте.
 */
function deadline(value: unknown) {
  const result = typeof value === 'number' ? value : Date.parse(String(value || ''));

  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

/**
 * Название статуса берётся из серверной семантики Б24, описание остаётся простым текстом.
 * HTML портала не интерпретируется и не удаляется до безопасной интерполяции приложения.
 */
function status(task: Payload) {
  return text(task.statusText || task.statusLabel || describeStatus(task, null).label, 800);
}

/**
 * Запуск с телефона доступен только без отсутствующих обязательных полей формы.
 * Explicit instrumentation требует основного Кокпита; приложение не угадывает файлы.
 */
function disabledReason(option: Payload) {
  return option.instrumentationRequired || option.instrumentationMode === 'explicit'
    ? 'Нужны параметры инструментации в Кокпите.'
    : null;
}

/**
 * Фасад портала читает прежние внутренние ручки; запуск принадлежит общему factory admission.
 * OptionId выбирается только из сохранённого снимка, который владелец сверяет под task lock.
 */
export function registerB24Routes(app: MobileApp, deps: Deps) {
  app.get<{ Querystring: Payload }>('/api/mobile/v1/b24/tasks', async (request) => {
    const source = await upstream(deps, 'GET', '/api/b24/dashboard');
    const pipeline = await upstream(deps, 'GET', '/api/tasks');
    const ids = new Set(
      (Array.isArray(pipeline.tasks) ? pipeline.tasks : []).map((item) =>
        String(record(item).task),
      ),
    );
    const sourceTasks = Array.isArray(source.tasks) ? source.tasks.map(record) : [];
    const tasks: B24Summary[] = sourceTasks.map((task) => ({
      id: taskId(String(task.id)),
      title: text(task.title, 800),
      status: status(task),
      deadline: deadline(task.deadlineRaw),
      priority: Number.isSafeInteger(task.priority) ? Number(task.priority) : 0,
      onPipeline: ids.has(String(task.id)),
    }));
    const page = paginate(tasks, request.query);

    return decodeContract('b24-tasks', {
      tasks: page.items,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    });
  });
  app.get<{ Params: { id: string } }>('/api/mobile/v1/b24/tasks/:id', async (request) => {
    const id = taskId(request.params.id);
    const task = await upstream(deps, 'GET', `/api/b24/task/${id}`);
    const description = text(task.description, 250000);

    return decodeContract('b24-task', {
      task: {
        id,
        title: text(task.title, 800),
        description,
        status: status(task),
        deadline: deadline(task.deadlineRaw || task.deadline),
        responsible: text(task.responsible, 800),
        ...(description.length < String(task.description || '').length ? { truncated: true } : {}),
      },
    });
  });
  app.get<{ Params: { id: string } }>(
    '/api/mobile/v1/b24/tasks/:id/launch-options',
    async (request) => {
      const id = taskId(request.params.id);
      const pipeline = await upstream(deps, 'GET', '/api/tasks');
      const existing =
        Array.isArray(pipeline.tasks) &&
        pipeline.tasks.some((task) => String(record(task).task) === id);

      if (existing) {
        return decodeContract('launch-options', {
          options: [],
          defaultId: null,
          actionToken: null,
          reason: 'Задача уже на конвейере.',
        });
      }

      const snapshot = await upstream(deps, 'GET', `/api/tasks/${id}/launch-options`);
      const routes = Array.isArray(snapshot.routes)
        ? snapshot.routes.filter(
            (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,40}$/.test(id),
          )
        : [];
      const reason = snapshot.onConveyor
        ? 'Задача уже на конвейере.'
        : snapshot.readOnly
          ? 'Прогон доступен только для чтения.'
          : snapshot.profileContractError
            ? text(snapshot.profileContractError, 4000)
            : routes.length > 100
              ? 'Слишком много вариантов; используйте Кокпит.'
              : !snapshot.profile || !/^[a-f0-9]{64}$/.test(String(snapshot.catalogHash))
                ? text(snapshot.message || 'Варианты запуска недоступны.', 4000)
                : null;
      const options = reason
        ? []
        : routes.map((route) => {
            const option = record(record(snapshot.routeOptions)[String(route)]);

            return {
              id: String(route),
              title: text(option.title || route, 800),
              disabledReason: disabledReason(option),
            };
          });
      const available = options.some((option) => !option.disabledReason);

      if (Buffer.byteLength(JSON.stringify(snapshot)) > 256 * 1024) {
        throw new MobileInputError('response_too_large', 'Форма запуска слишком большая.', 503);
      }

      return decodeContract('launch-options', {
        options,
        defaultId: options.some(
          (option) => option.id === snapshot.defaultRoute && !option.disabledReason,
        )
          ? snapshot.defaultRoute
          : (options.find((option) => !option.disabledReason)?.id ?? null),
        actionToken: available
          ? deps.tokens.issue(request.mobileDevice!.id, `b24:${id}`, 'launch', {
              snapshot,
              hash: factorySnapshotHash(snapshot),
            })
          : null,
        reason: reason || (available ? null : 'Нужна форма запуска в Кокпите.'),
      });
    },
  );
  app.post<{
    Params: { id: string };
    Body: Payload;
  }>('/api/mobile/v1/b24/tasks/:id/launch', async (request) => {
    const id = taskId(request.params.id);
    const saved = deps.tokens.take(
      request.mobileDevice!.id,
      `b24:${id}`,
      'launch',
      request.body?.actionToken,
    );
    const snapshot = record(saved.snapshot);
    const optionId = request.body?.optionId;
    const option = record(record(snapshot.routeOptions)[String(optionId)]);

    if (
      typeof optionId !== 'string' ||
      !(snapshot.routes as unknown[])?.includes(optionId) ||
      disabledReason(option)
    ) {
      throw new MobileInputError('bad_request', 'Выберите доступный вариант из этой формы.');
    }

    const result = await upstream(deps, 'POST', `/api/tasks/${id}/launch`, {
      profile: snapshot.profile,
      route: optionId,
      runnerPrimary: snapshot.defaultRunner || '',
      expectedCatalogHash: snapshot.catalogHash,
      expectedLaunch: saved.hash,
    });

    if (result.ok === false) {
      throw new MobileInputError('launch_failed', 'Запуск не подтверждён.', 409);
    }

    return decodeContract('stop', { ok: true });
  });
}
