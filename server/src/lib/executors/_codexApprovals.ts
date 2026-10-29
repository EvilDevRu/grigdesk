import { isRecord } from '../../../../shared/lib/objects.ts';
import { PERMISSION_WAIT_MS } from '../chat/permissionQueue.ts';

/**
 * Только доказанное разовое решение пересекается с native availableDecisions.
 * Standing grants и permissions profiles не маскируются обычным accept.
 */
export function codexApprovalPresentation(method: string, params: unknown, item?: unknown) {
  if (!isRecord(params) || typeof params.itemId !== 'string' || !params.itemId) {
    return null;
  }

  if (method === 'item/commandExecution/requestApproval') {
    if (typeof params.command !== 'string' || !params.command || typeof params.cwd !== 'string'
      || (params.kind != null && params.kind !== 'command')
      || params.networkApprovalContext != null || params.additionalPermissions != null
      || (params.approvalId != null && typeof params.approvalId !== 'string')) {
      return null;
    }

    const choices = params.availableDecisions;

    if (choices != null && (!Array.isArray(choices) || !choices.includes('accept'))) {
      return null;
    }

    return {
      tool: 'Bash',
      requiresExplicitUser: true,
      canRemember: false,
      input: {
        command: params.command,
        cwd: params.cwd,
        description: typeof params.reason === 'string' ? params.reason : ''
      }
    };
  }
  if (method === 'item/fileChange/requestApproval') {
    if (params.grantRoot != null || !isRecord(item) || item.type !== 'fileChange'
      || !Array.isArray(item.changes) || !item.changes.length) {
      return null;
    }

    return {
      tool: 'Правка файлов',
      requiresExplicitUser: true,
      canRemember: false,
      input: { changes: structuredClone(item.changes),
        description: typeof params.reason === 'string' ? params.reason : '' }
    };
  }

  return null;
}

/**
 * Решение человека действует на один вызов: session/execpolicy grants не отправляются.
 * Непроверенная форма или отмена остаются native отказом, включая permissions request.
 */
export function codexApprovalResponse(method: string, decision: unknown) {
  if (method === 'item/permissions/requestApproval') {
    return { permissions: {}, scope: 'turn' };
  }

  return { decision: isRecord(decision) && decision.allow === true && decision.remember !== true
    ? 'accept' : 'decline' };
}

interface Waiter {
  controller: AbortController;
  owner: object;
  finish: (value: unknown, respond: boolean) => void;
}

/**
 * Один экземпляр принадлежит одному процессу; Map различает строковые и числовые RPC ID.
 * Суточный deadline и native resolved снимают только своё ожидание и игнорируют поздний allow.
 */
export function createCodexInteractionWaiters(options: {
  send: (id: string | number, result: unknown) => void;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const active = new Map<string | number, Waiter>();
  const seenByOwner = new WeakMap<object, Set<string | number>>();
  const unowned = {};
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;

  return {
    /**
     * Снимок presentation отделён от native args до первого await пользователя.
     * Ошибка bridge и отсутствие callback завершают запрос одним отказом.
     */
    ask(id: string | number, owner: object, presentation: Record<string, unknown>,
      onPermission: ((ask: Record<string, unknown>) => unknown) | undefined,
      decode: (decision: unknown) => unknown, cancelled: unknown) {
      const seen = seenByOwner.get(owner) || new Set<string | number>();

      if (seen.has(id) || active.has(id)) {
        return;
      }

      seen.add(id);
      seenByOwner.set(owner, seen);

      const snapshot = structuredClone(presentation);
      const controller = new AbortController();
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      /**
       * Единственный финализатор снимает таймер и карточку до native ответа.
       * После отмены повторное решение уже не действует на следующий запрос.
       */
      const finish = (value: unknown, respond = true) => {
        if (done) {
          return;
        }

        done = true;
        active.delete(id);
        clearTimer(timer);
        controller.abort();

        if (respond) {
          options.send(id, value);
        }
      };

      timer = setTimer(() => finish(cancelled), PERMISSION_WAIT_MS);
      timer.unref?.();
      active.set(id, {
        controller,
        owner,
        finish
      });
      Promise.resolve().then(() => onPermission?.({ ...snapshot,
        signal: controller.signal })).then(
        (decision) => finish(decode(decision)),
        () => finish(cancelled),
      ).catch(() => finish(cancelled));
    },
    resolved(id: unknown) {
      if (typeof id === 'string' || typeof id === 'number') {
        active.get(id)?.finish(undefined, false);
      }
    },
    replyOnce(id: string | number, result: unknown, owner: object = unowned) {
      const seen = seenByOwner.get(owner) || new Set<string | number>();

      if (!seen.has(id)) {
        seen.add(id);
        seenByOwner.set(owner, seen);
        options.send(id, result);
      }
    },
    /**
     * Завершение хода отменяет только его callbacks, закрытие процесса — все.
     * Native уже снял запросы, поэтому поздний ответ в закрытый turn не отправляется.
     */
    cancel(owner?: object) {
      for (const waiter of [...active.values()]) {
        if (!owner || waiter.owner === owner) {
          waiter.finish(undefined, false);
        }
      }
    },
    get size() {
      return active.size;
    },
  };
}
