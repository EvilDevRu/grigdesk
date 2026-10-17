import { setTimeout as pause } from 'node:timers/promises';

import { recordOrEmpty } from '../../../../shared/lib/objects.ts';

import { glmAccessError } from './env.ts';
import { glmMcpLossError } from './mcp.ts';
import { GLM_WORK_SERVER_NAME, glmArgumentsHash, glmMcpToolName, glmToolKind } from './policy.ts';

interface CallRecord {
  name: string;
  hash: string | null;
  input: Record<string, unknown>;
}

interface Descriptor {
  name: string;
  sha256: string;
  kind: string;
  decision: string;
}

export type GlmApprovalVerdict = { allow: boolean } | { presentation: Record<string, unknown> };

const MARKER = 'GLM-POLICY ';
const HOOK_MISSING = 'Hooks политики GLM не подтвердили этот вызов; ход остановлен.';

/**
 * Дескрипторы hook из stderr события hook/result: строки с префиксом GLM-POLICY.
 * Неразбираемая строка пропускается: без дескриптора вызов дальше не пройдёт.
 */
function descriptorsOf(summary: unknown): Record<string, unknown>[] {
  return String(summary ?? '').split('\n').filter((line) => line.startsWith(MARKER)).flatMap((line) => {
    try {
      return [recordOrEmpty(JSON.parse(line.slice(MARKER.length)))];
    } catch {
      return [];
    }
  });
}

/**
 * Сторож одного хода GLM: регистрация hooks (маркер хода и дескриптор каждого вызова),
 * перевод approval по точному имени и сверке аргументов, разовые ответы и отказ после стопа.
 */
export function createGlmTurnGuard(options: {
  workTools: readonly string[];
  sessionId?: string;
  signal?: AbortSignal;
  waitMs?: number;
}) {
  const workNames = new Set(options.workTools.map((tool) => glmMcpToolName(GLM_WORK_SERVER_NAME, tool)));
  const calls = new Map<string, CallRecord>();
  const descriptors = new Map<string, Descriptor>();
  const waitMs = options.waitMs ?? 2000;
  let markerTurn: number | null = null;

  /**
   * Разбор события follow до его обработки ходом. Возвращает ошибку, если вызов
   * инструмента идёт без маркера hooks этого хода или результат — без дескриптора hook.
   */
  const inspect = (event: Record<string, unknown>): (Error & { code: string }) | null => {
    const data = recordOrEmpty(event.data);

    if (event.type === 'hook/result') {
      for (const item of descriptorsOf(data.stderrSummary)) {
        if (item.event === 'UserPromptSubmit' && item.marker === 'hooks-alive' && data.exitCode === 0) {
          markerTurn = Number(data.turn);
        } else if (item.event === 'PreToolUse' && typeof item.tool_use_id === 'string') {
          descriptors.set(item.tool_use_id, {
            name: String(item.name ?? ''),
            sha256: String(item.sha256 ?? ''),
            kind: String(item.kind ?? ''),
            decision: String(item.decision ?? ''),
          });
        }
      }

      return null;
    }

    if (event.type === 'tool/call') {
      let input: unknown = null;
      let hash: string | null = null;

      try {
        input = JSON.parse(String(data.arguments ?? ''));
        hash = glmArgumentsHash(input);
      } catch { /* неразбираемые аргументы = расхождение со сверкой hook */ }

      calls.set(String(data.callId ?? ''), {
        name: String(data.name ?? ''),
        hash,
        input: recordOrEmpty(input),
      });

      return markerTurn !== null && markerTurn === Number(data.turn) ? null
        : glmAccessError('glm_policy_hook_missing', HOOK_MISSING);
    }

    if (event.type === 'tool/result') {
      // DSH кладёт id вызова в source сообщения и в каждый tool-result блок.
      const message = recordOrEmpty(data.message);
      const content = Array.isArray(message.content) ? message.content.map(recordOrEmpty) : [];
      const id = String(
        recordOrEmpty(message.source).callId
        ?? content.find((block) => block.toolCallId)?.toolCallId
        ?? message.toolCallId ?? ''
      );

      if (!descriptors.has(id)) {
        return glmAccessError('glm_policy_hook_missing', HOOK_MISSING);
      }

      const block = content.find((item) => item.toolCallId === id) ?? message;

      return glmMcpLossError(calls.get(id)?.name ?? '', block.content, block.isError === true);
    }

    return null;
  };

  /**
   * Дескриптор hook приходит по follow, approval — по $events: короткое ожидание
   * сглаживает гонку двух потоков. Не пришёл — отказ без вопроса человеку.
   */
  const descriptorFor = async (callId: string): Promise<Descriptor | undefined> => {
    const deadline = Date.now() + waitMs;

    while (!descriptors.has(callId) && Date.now() < deadline && !options.signal?.aborted) {
      await pause(20);
    }

    return descriptors.get(callId);
  };

  /**
   * approval/request: тип — по точному toolName, аргументы — из tool/call этого хода,
   * сверенные с хэшем hook. Чужие вызовы и расхождения отклоняются без UI.
   */
  const approve = async (request: Record<string, unknown>): Promise<GlmApprovalVerdict> => {
    const toolName = String(request.toolName ?? '');
    const callId = String(request.callId ?? '');
    const call = calls.get(callId);

    if (request.sessionId !== undefined && request.sessionId !== options.sessionId) {
      return { allow: false };
    }

    if (!call || call.name !== toolName || call.hash === null) {
      return { allow: false };
    }

    const descriptor = await descriptorFor(callId);

    if (!descriptor || descriptor.name !== toolName || descriptor.sha256 !== call.hash
      || descriptor.decision !== 'allow') {
      return { allow: false };
    }

    const kind = glmToolKind(toolName);
    const raw = call.input;
    const text = (key: string) => typeof raw[key] === 'string' ? { [key]: raw[key] } : {};
    const escalation = typeof raw.sandbox_permissions === 'string';

    return {
      presentation: {
        isQuestion: false,
        acceptsComment: false,
        canRemember: false,
        tool: toolName,
        source: 'GLM',
        requiresExplicitUser: escalation || kind === 'mcp' || kind === 'other',
        input: {
          kind,
          ...text('command'),
          ...text('file_path'),
          ...text('description'),
          ...(typeof raw.justification === 'string' && typeof raw.description !== 'string'
            ? { description: raw.justification } : {}),
          ...text('sandbox_permissions'),
        },
      },
    };
  };

  return {
    inspect,
    approve,
    autoApprove: (toolName: string) => workNames.has(toolName),
    // Поздний ответ после стопа не превращается в разрешение.
    settle: (answer: { allow?: boolean } | null | undefined) => ({
      allow: answer?.allow === true && !options.signal?.aborted,
    }),
  };
}
