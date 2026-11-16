import { ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../shared/uiLocalePort.ts';

import { canonicalJson } from '../../../shared/lib/canonicalJson.ts';
import { ARBITER_LIMITS, sameStop } from '../../../shared/pipeline/arbiterConversation.ts';
import { isRecord } from '../../../shared/lib/objects.ts';
import type { ConversationSnapshot, StopIdentity } from '../../../shared/pipeline/arbiterConversation.ts';
import { arbiterConversationApi } from '../shared/arbiterConversationApi.ts';
import { ApiError } from '../shared/apiClient.ts';
import type { CurrentArbiterStop } from '../shared/arbiterConversationApi.ts';
import { sseSubscribe } from '../composables/useSse.ts';
import type { SseEventName } from '../composables/useSse.ts';

const t = localeTranslator(uiLocalePort);


interface PendingIntent {
  id: string | null;
  kind: string;
  body: Record<string, unknown>;
}

export interface ConversationDraft {
  text: string;
  instruction: string;
  targetNode: string;
  custom: boolean;
  originalProposalId?: string;
  answers: Record<string, string>;
}

/**
 * Сохранённый intent может вернуться после F5 и выбирает адрес явного повтора.
 * Повреждённое значение закрывает отправку вместо нового UUID поверх неизвестного действия.
 */
function validPending(value: unknown): value is PendingIntent {
  const intent = value as Partial<PendingIntent> | null;

  return Boolean(intent && typeof intent === 'object'
    && (intent.id === null || typeof intent.id === 'string' && /^c_[a-f0-9]{32}$/.test(intent.id))
    && ['start', 'discuss', 'diagnose', 'apply', 'resume'].includes(intent.kind || '')
    && intent.body && typeof intent.body === 'object' && !Array.isArray(intent.body)
    && typeof intent.body.requestId === 'string');
}

/**
 * Черновик читается из browser storage до первого рендера полей.
 * Повреждённая вложенная схема закрывает отправку, сохраняя исходные байты для восстановления.
 */
function validDraft(value: unknown): value is ConversationDraft {
  if (!isRecord(value) || !isRecord(value.answers)) {
    return false;
  }

  return typeof value.text === 'string' && value.text.length <= ARBITER_LIMITS.humanText
    && typeof value.instruction === 'string' && value.instruction.length <= ARBITER_LIMITS.instruction
    && typeof value.targetNode === 'string' && value.targetNode.length <= 64
    && typeof value.custom === 'boolean'
    && (value.originalProposalId === undefined || typeof value.originalProposalId === 'string'
      && value.originalProposalId.length <= 80)
    && Object.keys(value.answers).length <= 1000
    && Object.entries(value.answers).every(([id, answer]) => id.length <= 80
      && typeof answer === 'string' && answer.length <= ARBITER_LIMITS.humanText);
}

/**
 * Один store принадлежит авторизованному подключению и общей SSE подписке вкладки.
 * Черновики и pending requestId сохраняются отдельно от приходящих snapshots.
 */
export const useArbiterConversationsStore = defineStore('arbiterConversations', () => {
  const documents = ref<Record<string, ConversationSnapshot>>({});
  const currentByTask = ref<Record<string, CurrentArbiterStop>>({});
  const pending = ref<Record<string, PendingIntent>>({});
  const drafts = ref<Record<string, ConversationDraft>>({});
  const errors = ref<Record<string, string>>({});
  const sending = ref<Record<string, boolean>>({});
  const storageError = ref('');
  const watched = new Map<string, Set<string>>();
  const loads = new Map<string, Promise<void>>();
  const currentReads = new Map<string, number>();
  const dirty = new Set<string>();
  const key = (task: string, id: string) => `${task}/${id}`;
  let owner = '';
  let epoch = 0;
  let unsubscribe: (() => void) | null = null;

  const storageKey = () => `grigdesk-arbiter-conversations:${owner}`;

  /**
   * Намерение фиксируется до HTTP; отказ browser storage закрывает отправку.
   * Восстановление после обрыва сверяет прежний requestId без новой операции.
   */
  function persist() {
    if (storageError.value) {
      throw new Error(storageError.value);
    }

    localStorage.setItem(storageKey(), JSON.stringify({ pending: pending.value, drafts: drafts.value }));
  }

  watch(drafts, () => {
    if (owner) {
      try {
        persist();
      } catch {
        // Поле остаётся в памяти; отправка снова проверит долговечную запись.
      }
    }
  }, { deep: true });

  /**
   * Запоздавший HTTP и старая sourceRevision не откатывают уже показанную историю.
   * Страницы объединяются по серверному message id и сортируются по sequence.
   */
  function merge(task: string, snapshot: ConversationSnapshot) {
    if (snapshot.identity.task !== task) {
      return;
    }

    const id = key(task, snapshot.id);
    const previous = documents.value[id];

    if (previous && previous.revision > snapshot.revision) {
      return;
    }

    const messages = new Map((previous?.messages || []).map((message) => [message.id, message]));

    for (const message of snapshot.messages) {
      const old = messages.get(message.id);

      if (!old || message.revision >= old.revision
        && (message.sourceRevision ?? 0) >= (old.sourceRevision ?? 0)) {
        messages.set(message.id, message);
      }
    }

    documents.value[id] = {
      ...snapshot,
      messages: [...messages.values()].sort((a, b) => a.sequence - b.sequence)
    };

    const intent = pending.value[task];

    if (intent && snapshot.operations.some((operation) => operation.requestId === intent.body.requestId)) {
      delete pending.value[task];
      persist();
    }
  }

  /**
   * Пачка SSE сигналов сворачивается в одно чтение с последующей сверкой пропуска.
   * Каждая HTTP-страница ограничена, полное восстановление догружает страницы последовательно.
   */
  function refresh(task: string, id: string, full = false): Promise<void> {
    const lane = key(task, id);

    if (loads.has(lane)) {
      dirty.add(lane);

      return loads.get(lane)!;
    }

    const generation = epoch;
    const promise = Promise.resolve().then(async () => {
      do {
        dirty.delete(lane);

        const previous = full ? null : documents.value[lane];
        let afterSequence = previous?.afterSequence || 0;
        let revision = previous?.revision || 0;
        let firstFullRevision = 0;
        let more = true;

        while (more) {
          const snapshot = await arbiterConversationApi.snapshot(task, id, afterSequence, revision);

          if (epoch !== generation) {
            return;
          }

          if (revision === 0 && !firstFullRevision) {
            firstFullRevision = snapshot.revision;
          }

          merge(task, snapshot);
          more = snapshot.hasMore;

          if (more && revision > 0) {
            afterSequence = 0;
            revision = 0;
            firstFullRevision = 0;

            continue;
          }
          if (more && snapshot.afterSequence <= afterSequence) {
            throw new Error(t('core.arbiterPageFailed'));
          }

          afterSequence = snapshot.afterSequence;

          // Более новая страница не доказывает доставку изменённой ранней реплики.
          // После полного прохода дочитываем изменения от ревизии его первой страницы.
          if (!more && revision === 0 && snapshot.revision > firstFullRevision) {
            revision = firstFullRevision;
            more = true;
          }
        }

        full = false;
      } while (dirty.has(lane));
    }).catch((error: unknown) => {
      if (generation === epoch) {
        errors.value[task] = error instanceof Error ? error.message : t('core.arbiterReadFailed');
      }

      throw error;
    }).finally(() => {
      if (loads.get(lane) === promise) {
        loads.delete(lane);
      }
    });

    loads.set(lane, promise);

    return promise;
  }

  /**
   * Открытие текущего состояния не запускает модель; исторический id читается отдельно.
   * После F5 current находит и потерянное подтверждение создания диалога.
   */
  async function open(task: string, conversationId?: string) {
    const generation = epoch;
    const request = (currentReads.get(task) || 0) + 1;
    const ids = watched.get(task) || new Set<string>();

    currentReads.set(task, request);
    watched.set(task, ids);

    let current: CurrentArbiterStop;

    try {
      current = await arbiterConversationApi.current(task);
    } catch (error) {
      if (!conversationId) {
        throw error;
      }

      current = {
        identity: null,
        conversationId: null,
        capabilities: null
      };
    }

    if (generation !== epoch) {
      return;
    }

    const latest = currentReads.get(task) === request;

    if (latest) {
      currentByTask.value[task] = current;
    } else if (!conversationId) {
      return;
    }

    const cached = Object.values(documents.value).find((doc) => sameStop(doc.identity, current.identity));
    const id = conversationId || current.conversationId || cached?.id;

    if (id) {
      if (latest && !conversationId) {
        currentByTask.value[task]!.conversationId = id;
      }

      ids.add(id);
      await refresh(task, id, true);
    }
  }

  /**
   * Перед отправкой сохраняется весь payload и UUID; повтор берёт тот же документ.
   * Транспортный отказ оставляет pending до snapshot либо явного повтора запроса.
   */
  async function transmit(task: string) {
    const intent = pending.value[task];
    const generation = epoch;

    if (!intent || sending.value[task]) {
      return;
    }

    persist();
    sending.value[task] = true;
    errors.value[task] = '';

    try {
      const result = (await arbiterConversationApi.post(task, intent.id, intent.kind, intent.body)) as {
        conversationId: string;
        operationId: string;
      };

      if (!result || !/^c_[a-f0-9]{32}$/.test(result.conversationId)
        || typeof result.operationId !== 'string' || !result.operationId) {
        throw new Error(t('core.arbiterRequestUnconfirmed'));
      }

      if (generation !== epoch) {
        return;
      }

      delete pending.value[task];
      persist();
      await open(task, result.conversationId);

      return result;
    } catch (error) {
      if (generation === epoch) {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 401) {
          delete pending.value[task];
          persist();
        }

        errors.value[task] = error instanceof Error ? error.message : t('core.arbiterSendFailed');
      }

      throw error;
    } finally {
      if (generation === epoch) {
        sending.value[task] = false;
      }
    }
  }

  /**
   * Новое намерение фиксирует exact stop и текущую ревизию до первого HTTP.
   * Неподтверждённый прежний запрос нельзя вытеснить новым UUID из другой кнопки.
   */
  async function send(task: string, id: string | null, kind: string, payload: Record<string, unknown> = {}) {
    if (pending.value[task]) {
      throw new Error(t('core.arbiterPendingConflict'));
    }

    const doc = id ? documents.value[key(task, id)] : null;
    const identity = doc?.identity || currentByTask.value[task]?.identity;

    if (!identity) {
      throw new Error(t('core.arbiterCurrentUnconfirmed'));
    }

    pending.value[task] = {
      id,
      kind,
      body: {
        requestId: crypto.randomUUID(),
        ...(kind === 'resume' ? {} : { expectedStop: identity }),
        ...(kind === 'start' || kind === 'resume' ? {} : { decisionRevision: doc?.decisionRevision }),
        ...payload,
      },
    };

    return transmit(task);
  }

  const retryPending = (task: string) => transmit(task);
  const document = (task: string, id: string) => documents.value[key(task, id)] || null;

  function draftFor(identity: StopIdentity) {
    const id = canonicalJson(identity);

    return drafts.value[id] ||= {
      text: '',
      instruction: '',
      targetNode: '',
      custom: false,
      answers: {}
    };
  }

  /**
   * Общая шина доставляет только сигнал; переписка дочитывается по revision.
   * Hello сверяет открытые истории и pending после пропущенного события или переподключения.
   */
  function onEvent(name: SseEventName, value: unknown) {
    if (name === 'hello' || name === 'state-change') {
      for (const [task, ids] of watched) {
        for (const id of ids) {
          void refresh(task, id).catch(() => { });
        }

        if (name === 'hello' && !pending.value[task]) {
          void open(task).catch(() => { });
        }
      }

      for (const task of Object.keys(pending.value)) {
        void open(task).catch(() => { });
      }
    } else if (name === 'arbiter-conversation') {
      const signal = value as { task?: string; conversationId?: string };

      if (signal?.task && signal.conversationId && watched.has(signal.task)) {
        const task = signal.task;
        const id = signal.conversationId;

        watched.get(task)!.add(id);
        void refresh(task, id).then(() => {
          const doc = document(task, id);

          if (doc && sameStop(currentByTask.value[task]?.identity, doc.identity)) {
            currentByTask.value[task]!.conversationId = id;
          }
        }).catch(() => { });
      }
    }
  }

  /**
   * Смена подключения снимает подписку и отделяет поздние ответы прежнего сервера.
   * Durable намерения остаются в namespace владельца для следующего входа.
   */
  function stop() {
    epoch += 1;
    unsubscribe?.();
    unsubscribe = null;
    watched.clear();
    loads.clear();
    currentReads.clear();
    dirty.clear();
    documents.value = {};
    currentByTask.value = {};
    pending.value = {};
    drafts.value = {};
    sending.value = {};
    errors.value = {};
    storageError.value = '';
    owner = '';
  }

  /**
   * Scope приходит из текущего авторизованного подключения оболочки.
   * Намерения другой машины не отправляются после переключения сервера.
   */
  function start(scope: string) {
    if (owner === scope && unsubscribe) {
      return;
    }

    stop();
    owner = scope;

    try {
      const saved = localStorage.getItem(storageKey());

      if (saved) {
        if (saved.length > 2 * 1024 * 1024) {
          throw new Error(t('core.pipelineSlishkomBolshoeBrowserStorage'));
        }

        const value = JSON.parse(saved);

        if (!value || typeof value !== 'object' || !value.pending || !value.drafts
          || Array.isArray(value.pending) || Array.isArray(value.drafts)
          || typeof value.pending !== 'object' || typeof value.drafts !== 'object'
          || Object.values(value.pending).some((intent: unknown) => !validPending(intent))
          || Object.values(value.drafts).some((draft: unknown) => !validDraft(draft))) {
          throw new Error(t('core.pipelineNekorrektnoeBrowserStorage'));
        }

        pending.value = value.pending;
        drafts.value = value.drafts;
      }
    } catch {
      storageError.value = t('core.arbiterStorageFailed');
    }

    unsubscribe = sseSubscribe(onEvent);
  }

  return {
    documents,
    currentByTask,
    pending,
    errors,
    sending,
    storageError,
    drafts,
    start,
    stop,
    open,
    refresh,
    merge,
    document,
    send,
    retryPending,
    draftFor
  };
});
