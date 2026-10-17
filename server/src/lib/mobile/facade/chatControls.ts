import { createHash } from 'node:crypto';

import { recordOrEmpty } from '../../../../../shared/lib/objects.ts';

import { normalizeChatWorkdir, chatWorkdirLabel } from '../../../../../shared/chat/chatWorkdir.ts';
import { normalizeContextUsage } from '../../../../../shared/chat/chatContextUsage.ts';
import { normalizeModelRef } from '../../chat/modelRef.ts';
import { decodeContract } from '../contract.ts';
import type { ChatModel, ChatOptions, ChatSettings } from '../contract.ts';
import { MobileInputError } from '../errors.ts';
import type { MobileApp } from '../mobileServer.ts';
import { resourceId, text, upstream } from './common.ts';
import type { FacadeDeps, Payload } from './common.ts';

/**
 * Кольцо использует снимок контекста, а не накопительный расход вывода.
 * Неизвестное окно и отсутствующий замер остаются null, измеренный ноль сохраняется.
 */
export function chatSettings(chat: Payload, run: Payload | undefined, deps: FacadeDeps): ChatSettings {
  const live = normalizeContextUsage(run);
  const current = Object.hasOwn(live, 'contextTokens') || live.contextMetric
    ? live : normalizeContextUsage(chat);
  const workdir = normalizeChatWorkdir(chat.workdir) || { kind: 'cockpit' as const };
  const committed = recordOrEmpty(recordOrEmpty(chat.workdirState).committed);

  return {
    modelRef: normalizeModelRef(chat.modelRef),
    workdir,
    directory: text(committed.cwd || chatWorkdirLabel(workdir), 4096),
    context: {
      tokens: current.contextTokens ?? null,
      window: current.contextWindow ?? null,
      metric: current.contextMetric || '',
      estimate: current.contextIsEstimate === true,
      live: current === live,
      compactWindow: Math.floor(deps.chat.compactWindow?.() || 0),
    },
  };
}

/**
 * Каталог отдаёт только поля управления чатом, без credentials, команд установки и runtime.
 * Ограничение задач и проектов обозначено числом, а не молчаливым обрезанием списка.
 */
async function options(deps: FacadeDeps): Promise<ChatOptions> {
  const [source, tasks, projects, saved] = await Promise.all([
    upstream(deps, 'GET', '/api/providers'),
    upstream(deps, 'GET', '/api/tasks'),
    upstream(deps, 'GET', '/api/projects'),
    deps.chat.defaults?.() || {},
  ]);
  const models: ChatModel[] = [];

  for (const provider of Array.isArray(source.providers) ? source.providers.map(recordOrEmpty) : []) {
    if (provider.chatEnabled === false) {
      continue;
    }

    for (const model of Array.isArray(provider.models) ? provider.models.map(recordOrEmpty) : []) {
      models.push({
        provider: text(provider.id, 200),
        providerName: text(provider.name, 200),
        id: text(model.id, 200),
        name: text(model.name || model.id, 200),
        efforts: Array.isArray(model.efforts) ? model.efforts.map((value) => text(value, 120)) : [],
        context: Number.isSafeInteger(model.context) && Number(model.context) > 0
          ? Number(model.context) : null,
        contextVerified: model.contextUnverified !== true && model.contextRuntimeOnly !== true,
        autoCompact: recordOrEmpty(provider.capabilities).chatAutoCompact === true,
        available: provider.available === true,
      });
    }
  }

  const taskList = Array.isArray(tasks.tasks) ? tasks.tasks.map(recordOrEmpty) : [];
  const projectList = Array.isArray(projects.projects) ? projects.projects.map(recordOrEmpty) : [];
  const defaults = recordOrEmpty(saved);
  const explicit = normalizeModelRef(defaults.defModelRef);
  const selected = models.find((model) => explicit
    ? model.provider === explicit.provider && model.id === explicit.model
    : model.id === defaults.defModel);

  return decodeContract('chat-options', {
    models,
    defaultModelRef: selected ? { provider: selected.provider, model: selected.id } : null,
    tasks: taskList.slice(0, 2000).map((item) => ({
      id: resourceId(String(item.task), true),
      title: text(item.title || item.route || `Задача ${item.task}`, 800),
    })),
    projects: projectList.slice(0, 500).map((item) => ({
      id: text(item.id, 200),
      title: text(item.title || item.id, 800),
    })),
    tasksOmitted: Math.max(0, taskList.length - 2000),
    projectsOmitted: Math.max(0, projectList.length - 500),
  });
}

/**
 * Контроллер общего чата выпускает свои ошибки; HTTP-граница сохраняет понятную причину.
 * Неизвестный сбой не превращается в успешную частичную смену настроек.
 */
async function controlled<T>(action: () => Promise<T>) {
  try {
    return await action();
  } catch (error) {
    const value = error as {
      statusCode?: number;
      code?: string;
      message?: string;
    };

    if (value.code && value.statusCode) {
      throw new MobileInputError(value.code, value.message || 'Чат не изменён.', value.statusCode);
    }

    throw error;
  }
}

/**
 * Id создания и перехода выводится из durable ключа устройства, не из случайного повтора запроса.
 * Ключи другого телефона не могут назначить ту же идентичность операции.
 */
function operationId(device: string, key: unknown) {
  return 'm' + createHash('sha256').update(device + ':' + String(key)).digest('hex').slice(0, 40);
}

/**
 * Ошибка формы возвращается как явный отказ клиента до выполнения операции.
 * Несовпадение выходного DTO остаётся серверным сбоем и не скрывается этим адаптером.
 */
function input(kind: string, value: unknown) {
  try {
    return decodeContract<Payload>(kind, value);
  } catch {
    throw new MobileInputError('bad_request', 'Проверьте параметры действия.');
  }
}

/**
 * Новые действия v1 передают решения существующим владельцам модели и рабочей папки.
 * Предпросмотр связывается actionToken с устройством, ревизией и точным выбором цели.
 */
export function registerChatControlRoutes(app: MobileApp, deps: FacadeDeps) {
  const controls = () => {
    if (!deps.chat.controls) {
      throw new MobileInputError('unsupported', 'Обновите сервер для настройки чатов.', 503);
    }

    return deps.chat.controls;
  };
  const result = (chat: Payload) => decodeContract('chat-result', {
    id: String(chat.id), revision: Number(chat.revision || 0),
  });

  app.get('/api/mobile/v1/chat-options', () => options(deps));
  app.post<{ Body: Payload }>('/api/mobile/v1/chats', async (request) => {
    const body = input('chat-create-request', request.body);
    const id = operationId(request.mobileDevice!.id, request.headers['idempotency-key']);

    return result(await controlled(() => controls().create(id, body.modelRef)));
  });
  app.post<{ Params: { id: string }; Body: Payload }>(
    '/api/mobile/v1/chats/:id/settings', async (request) => {
      const id = resourceId(request.params.id);
      const body = input('chat-settings-request', request.body);
      const expected = deps.tokens.take(
        request.mobileDevice!.id, `chat:${id}`, 'configure', body.actionToken,
      );

      return result(await controlled(() => controls().configure(id, {
        expectedRevision: Number(expected.revision),
        modelRef: body.modelRef,
        effort: String(body.effort),
        reset: body.reset === true,
      })));
    },
  );
  app.post<{ Params: { id: string }; Body: Payload }>(
    '/api/mobile/v1/chats/:id/read', async (request) => {
      const id = resourceId(request.params.id);
      const body = input('action-request', request.body);
      const expected = deps.tokens.take(request.mobileDevice!.id, `chat:${id}`, 'read', body.actionToken);

      return result(await controlled(() => controls().read(id, Number(expected.revision))));
    },
  );
  app.post<{ Params: { id: string }; Body: Payload }>(
    '/api/mobile/v1/chats/:id/workspace/preview', async (request) => {
      const id = resourceId(request.params.id);
      const body = input('workspace-request', request.body);
      const workdir = normalizeChatWorkdir(body.workdir);
      const taskId = body.taskId === null ? null : resourceId(body.taskId, true);

      if (!workdir) {
        throw new MobileInputError('bad_workdir', 'Выберите допустимую папку.');
      }

      const preview = await upstream(deps, 'POST', '/api/chat/workdir/preview', {
        chatKey: id, candidate: { workdir, taskId },
      });
      const target = recordOrEmpty(preview.target);
      const actionToken = deps.tokens.issue(request.mobileDevice!.id, `chat:${id}`, 'workspace', {
        revision: preview.revision,
        workspaceKey: preview.workspaceKey,
        workdir,
        taskId,
      });

      return decodeContract('workspace-preview', {
        directory: text(target.cwd, 4096),
        previousDirectory: text(recordOrEmpty(preview.current).cwd, 4096),
        transfer: preview.transfer,
        summaryAvailable: preview.summaryAvailable === true,
        warnings: Array.isArray(target.warnings) ? target.warnings.map((value) => text(value)) : [],
        actionToken,
      });
    },
  );
  app.post<{ Params: { id: string }; Body: Payload }>(
    '/api/mobile/v1/chats/:id/workspace', async (request) => {
      const id = resourceId(request.params.id);
      const body = input('workspace-change-request', request.body);
      const expected = deps.tokens.take(
        request.mobileDevice!.id, `chat:${id}`, 'workspace', body.actionToken,
      );
      const changed = await upstream(deps, 'POST', '/api/chat/workdir/change', {
        chatKey: id,
        operationId: operationId(request.mobileDevice!.id, request.headers['idempotency-key']),
        expectedRevision: expected.revision,
        expectedWorkspaceKey: expected.workspaceKey,
        taskId: expected.taskId,
        workdir: expected.workdir,
        transfer: body.transfer,
      });

      return result(recordOrEmpty(changed.chat));
    },
  );
}
