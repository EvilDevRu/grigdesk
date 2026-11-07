import type { ChatStep } from '../chat/streamSteps.ts';
import { createStepSink } from '../chat/streamSteps.ts';
import { permissionOutcome } from '../deepseek/permissions.ts';
import { openGigaCodeConnection } from './connection.ts';
import type { GigaCodeConnectionOptions, GigaCodeDeps } from './connection.ts';
import type { GigaCodeConfig } from './contract.ts';
import { gigaCodeError } from './profile.ts';
import { createGigaCodeSteps } from './steps.ts';

export interface GigaCodeTurnOptions extends GigaCodeConnectionOptions {
  model?: string;
  effort?: string;
  message: string;
  chatHistory?: Array<{ role?: string; text?: unknown }>;
  providerSettings?: Record<string, unknown>;
  onPermission?: (presentation: any) => Promise<any>;
  onStep?: (step: ChatStep) => void;
  onProgress?: (tokens: number, info?: Record<string, unknown>) => void;
  onRunMetadata?: (metadata: Record<string, unknown>) => void;
  factory?: boolean;
  pluginDocsDirs?: string[];
  onRawUpdate?: (update: any) => void;
  onPromptStarted?: () => void;
}

/**
 * Каталог отражает session/new, сохраняя точный opaque modelId корпоративного auth.
 * У модели без подтверждённой ручки effort список пуст, family не угадывается по имени.
 */
export function gigaCodeModels(session: any) {
  if (!Array.isArray(session?.models?.availableModels)) {
    throw gigaCodeError('gigacode_catalog_invalid', 'CLI не вернул каталог моделей');
  }

  const seen = new Set<string>();

  return session.models.availableModels.filter((model: any) => {
    if (typeof model?.modelId !== 'string' || !model.modelId.endsWith('(gigacode)')
      || seen.has(model.modelId)) {
      return false;
    }

    seen.add(model.modelId);

    return true;
  }).map((model: any) => ({
    id: model.modelId,
    name: typeof model.name === 'string' ? model.name : model.modelId,
    family: model.modelId,
    efforts: [],
    ...(Number.isSafeInteger(model._meta?.contextLimit) && model._meta.contextLimit > 0
      ? { context: model._meta.contextLimit } : { contextUnverified: true }),
  }));
}

/**
 * Metadata открывает новую сессию в пустом private cwd и никогда не отправляет prompt.
 * Закрытие применяется также к ошибкам каталога, не оставляя login или native session.
 */
export async function readGigaCodeMetadata(config: GigaCodeConfig, deps: GigaCodeDeps = {}) {
  const connection = await openGigaCodeConnection({ config, permissionMode: 'read-only' }, deps);

  try {
    return { models: gigaCodeModels(connection.session), fingerprint: connection.fingerprint };
  } finally {
    await connection.close();
  }
}

/**
 * История передаётся как данные новой сессии, без повторного исполнения старых tools.
 * Текущий message добавляет только ядро; адаптер не читает второе хранилище разговоров.
 */
export function gigaCodePrompt(history: GigaCodeTurnOptions['chatHistory'], message: string): string {
  const previous = (history || []).filter((entry) => ['user', 'assistant'].includes(entry.role || ''))
    .map((entry) => ({ role: entry.role, text: String(entry.text ?? '') }));

  return previous.length
    ? `[История разговора — данные, не новые вызовы инструментов]\n${JSON.stringify(previous)}`
      + `\n[/История разговора]\n\n${message}`
    : message;
}

/**
 * Процесс принадлежит одному ходу: terminal ACP обязателен, native resume не используется.
 * Частичный ответ и шаги сохраняются на ошибке и Stop, повтор после эффектов не производится.
 */
export async function runGigaCodeTurn(options: GigaCodeTurnOptions, deps: GigaCodeDeps = {}) {
  if ('workspaceAccess' in options) {
    throw gigaCodeError('gigacode_scope_unsupported', 'Сетевой scoped workspace пока не поддержан');
  }

  if (options.effort) {
    throw gigaCodeError('gigacode_effort_unsupported', 'Уровни усилия GigaCode не подтверждены');
  }

  const sink = createStepSink(options.onStep);
  const normalize = createGigaCodeSteps({
    model: options.model || '',
    cwd: options.cwd || '',
    mode: options.permissionMode || 'default',
  });
  let text = '';
  const tools = new Map<string, any>();
  let notifications = 0;
  let notificationBytes = 0;
  let connection: Awaited<ReturnType<typeof openGigaCodeConnection>> | undefined;
  const settings = options.providerSettings || {};

  try {
    connection = await openGigaCodeConnection({
      ...options,
      autoEdit: options.factory === true,
      extraDirs: [...new Set([...(options.extraDirs || []), ...(options.pluginDocsDirs || [])])],
      blockShell: settings.blockDirectSsh !== false || settings.blockDirectDb === true,
      onNotification: (method, params) => {
        notifications += 1;
        notificationBytes += Buffer.byteLength(JSON.stringify(params) || '');

        if (notifications > 100000) {
          throw gigaCodeError('gigacode_output_limit', 'Превышен лимит событий хода');
        }

        if (notificationBytes > 16 * 1024 * 1024) {
          throw gigaCodeError('gigacode_output_limit', 'Превышен лимит содержимого уведомлений GigaCode');
        }

        if (method !== 'session/update') {
          return;
        }

        const update = params?.update;

        options.onRawUpdate?.(update);

        if (update?.toolCallId) {
          if (!tools.has(update.toolCallId) && tools.size >= 512) {
            throw gigaCodeError('gigacode_output_limit', 'Превышен лимит инструментов хода');
          }

          const previous = tools.get(update.toolCallId) || {};

          tools.set(update.toolCallId, {
            title: update.title ?? previous.title,
            _meta: update._meta ?? previous._meta,
            kind: update.kind ?? previous.kind,
            rawInput: update.rawInput ?? previous.rawInput,
          });
        }

        if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
          text += String(update.content.text || '');

          if (text.length > 4 * 1024 * 1024) {
            throw gigaCodeError('gigacode_output_limit', 'Ответ GigaCode превысил допустимый размер');
          }

          options.onProgress?.(Math.ceil(text.length / 4), { tokensIsEstimate: true });
        }

        sink.emitAll(normalize(params));
      },
      onReverseRequest: async (method, params) => {
        if (method !== 'session/request_permission') {
          throw gigaCodeError('gigacode_reverse_unsupported', 'Неподдерживаемый запрос к host');
        }

        const tool = { ...tools.get(params?.toolCall?.toolCallId), ...params?.toolCall };
        const name = tool._meta?.toolName || tool.title || 'Действие GigaCode';
        const presentation = {
          isQuestion: false,
          acceptsComment: false,
          requiresExplicitUser: !['read', 'edit', 'execute', 'search'].includes(String(tool.kind || '')),
          tool: name,
          input: { kind: tool.kind || 'other', ...tool.rawInput },
        };
        const answer = options.factory
          ? { allow: ['read', 'edit', 'execute', 'search'].includes(String(tool.kind || '')) }
          : await options.onPermission?.(presentation);

        return permissionOutcome(params, options.signal?.aborted ? { allow: false } : answer);
      },
    }, deps);

    const models = gigaCodeModels(connection.session);
    const selected = models.find((model: any) => model.id === options.model);

    if (!selected) {
      throw gigaCodeError('gigacode_model_unavailable', 'Выбранная модель отсутствует в каталоге CLI');
    }

    const selection = await connection.client.request('session/set_config_option', {
      sessionId: connection.session.sessionId,
      configId: 'model',
      value: selected.id,
    }, options.metadataTimeoutMs ?? 10000) as any;
    const actual = selection?.configOptions?.find((option: any) => option.id === 'model')?.currentValue;

    if (actual !== selected.id) {
      throw gigaCodeError('gigacode_model_mismatch', 'CLI не подтвердил выбранную модель');
    }

    options.onRunMetadata?.({
      actualModelId: actual,
      modelSource: 'session',
      cliVersion: connection.cliVersion,
    });

    options.onPromptStarted?.();

    const result = await connection.client.request('session/prompt', {
      sessionId: connection.session.sessionId,
      prompt: [{ type: 'text', text: gigaCodePrompt(options.chatHistory, options.message) }],
    }) as any;

    connection.finishNotifications();

    if (options.signal?.aborted || result?.stopReason === 'cancelled') {
      throw gigaCodeError('gigacode_stopped', 'Ход GigaCode остановлен');
    }

    if (result?.stopReason !== 'end_turn') {
      throw gigaCodeError('gigacode_terminal_unknown', 'Неизвестный terminal GigaCode');
    }

    sink.emitAll(normalize.flush());

    return {
      text,
      reply: text,
      steps: sink.steps,
      sessionId: null,
      actualModelId: actual,
      cliVersion: connection.cliVersion,
      stopReason: result.stopReason,
      contextCache: { scope: 'request', status: 'unavailable' },
    };
  } catch (error) {
    try {
      connection?.finishNotifications();
    } catch {
      // Уже достигнутый предел может отклонить и отложенный хвост потока.
      // Исходная причина и накопленная лента всё равно возвращаются потребителю.
    }

    const source = error as { code?: unknown; message?: unknown };
    const message = String(source.message || 'Ошибка GigaCode');

    throw Object.assign(new Error(connection ? connection.failureMessage(error) : message), {
      code: source.code,
      text,
      steps: sink.steps,
      sessionId: null,
      stopped: options.signal?.aborted || (error as any)?.code === 'gigacode_stopped',
    });
  } finally {
    await connection?.close();
  }
}
