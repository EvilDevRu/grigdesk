import { toRaw } from 'vue';
import {
  decodeHistoryStepReuseAck,
  HISTORY_STEP_REUSE_ROUTE,
} from '../../../shared/chat/chatHistoryStepReuse.ts';
import type {
  HistoryStepRef,
  HistoryStepReuseRequest,
} from '../../../shared/chat/chatHistoryStepReuse.ts';
import { messageKey } from '../../../shared/chat/chatMessageIdentity.ts';
import { projectWebChatHead } from '../../../shared/chat/chatListProjection.ts';
import type { ChatHistorySnapshot } from './chatHistorySnapshot.ts';

interface StepSignature {
  index: number;
  steps: unknown[];
  length: number;
  version: number;
}

interface ConfirmedSteps extends StepSignature {
  sourceIndex: number;
  key: string;
}

interface ConfirmedBase {
  revision: number;
  steps: ConfirmedSteps[];
}

/**
 * Дешёвое сравнение различает замену массива той же длины и не читает тела инструментов.
 * Версия принадлежит raw-массиву, которому история уже передала неизменяемое владение.
 */
function sameSignature(left: StepSignature[] | undefined, right: StepSignature[]): boolean {
  return left?.length === right.length && right.every((entry, index) => {
    const old = left[index]!;

    return old.index === entry.index && old.steps === entry.steps &&
      old.length === entry.length && old.version === entry.version;
  });
}

/**
 * Один владелец на экземпляр стора: отпечатки, версии, поколения и подтверждения не сериализуются.
 * Сервер подтверждает массивы снимка отправки, а не новые данные, появившиеся во время сети.
 */
export function createChatHistoryStepReuseState() {
  const sentChats = new Map<string, string>();
  const sentReplies = new Map<string, string>();
  const sentSteps = new Map<string, StepSignature[]>();
  const bases = new Map<string, ConfirmedBase>();
  const generations = new Map<string, object>();
  const versions = new WeakMap<unknown[], number>();
  let nextVersion = 0;

  const signature = (chat: ChatHistorySnapshot): StepSignature[] => (
    (chat.messages || []).flatMap((message, index) => {
      if (!Array.isArray(message.steps)) {
        return [];
      }

      const steps = toRaw(message.steps);
      let version = versions.get(steps);

      if (version === undefined) {
        version = ++nextVersion;
        versions.set(steps, version);
      }

      return [{
        index,
        steps,
        length: steps.length,
        version
      }];
    })
  );

  /**
   * Удаление освобождает и подтверждение, и dirty-отпечаток истории.
   * Следующий чат с тем же id получает другое поколение для защиты от позднего ACK.
   */
  const forget = (id: string): void => {
    bases.delete(id);
    generations.delete(id);
    sentChats.delete(id);
    sentReplies.delete(id);
    sentSteps.delete(id);
  };

  return {
    sentChats,
    signature,
    forget,
    replyKey(id: string): string | undefined {
      return sentReplies.get(id);
    },
    generation(id: string): object {
      let generation = generations.get(id);

      if (!generation) {
        generation = {};
        generations.set(id, generation);
      }

      return generation;
    },
    markSent(chat: ChatHistorySnapshot, fingerprint: string, steps = signature(chat)): void {
      sentChats.set(chat.id!, fingerprint);
      sentReplies.set(chat.id!, projectWebChatHead(chat, '').lastReply?.key || '');
      sentSteps.set(chat.id!, steps);
    },
    isSent(chat: ChatHistorySnapshot, fingerprint: string): boolean {
      return sentChats.get(chat.id!) === fingerprint &&
        sameSignature(sentSteps.get(chat.id!), signature(chat));
    },
    /**
     * Полная загрузка и dispose освобождают прежние серверные основания.
     * WeakMap версий не удерживает тяжёлые массивы после удаления остальных ссылок.
     */
    clear(): void {
      sentChats.clear();
      sentReplies.clear();
      sentSteps.clear();
      bases.clear();
      generations.clear();
    },
    clearBases(): void {
      bases.clear();
    },
    resetBase(id: string): void {
      bases.delete(id);
    },
    /**
     * Только применённая серверная история разрешает начальные ссылки на шаги.
     * Новое поколение исключает подтверждение старого PUT после более свежего GET.
     */
    acceptLoaded(chat: ChatHistorySnapshot): void {
      generations.set(chat.id!, {});
      bases.delete(chat.id!);

      if (!Number.isSafeInteger(chat.revision) || !chat.revision || chat.revision < 1) {
        return;
      }

      bases.set(chat.id!, {
        revision: chat.revision,
        steps: signature(chat).map((entry) => ({
          ...entry,
          sourceIndex: entry.index,
          key: messageKey(chat.messages![entry.index]),
        }))
      });
    },
    hasBase(chat: ChatHistorySnapshot): boolean {
      const base = bases.get(chat.id!);

      return !!base && base.revision === chat.revision && signature(chat).every((entry) => (
        base.steps.some((confirmed) => confirmed.steps === entry.steps && confirmed.length === entry.length)
      ));
    },
    /**
     * Сетевая проекция удаляет steps только у подтверждённых неизменённых массивов.
     * CAS чата и revision основания независимы: сервер проверяет refs под lock свежего файла.
     */
    request(snapshot: ChatHistorySnapshot, capability: number, activeSteps: unknown) {
      const base = bases.get(snapshot.id!);
      const refs: HistoryStepRef[] = [];
      const sources = new Set<number>();

      if (capability === 1 && base) {
        for (const entry of signature(snapshot)) {
          const key = messageKey(snapshot.messages![entry.index]);
          const confirmed = base.steps.find((item) => item.steps === entry.steps && item.key === key &&
            item.length === entry.length && item.version === entry.version &&
            !sources.has(item.sourceIndex));

          if (confirmed && entry.steps !== toRaw(activeSteps)) {
            sources.add(confirmed.sourceIndex);
            refs.push({
              messageIndex: entry.index,
              sourceIndex: confirmed.sourceIndex,
              expectedKey: key,
              expectedLength: entry.length,
            });
          }
        }
      }

      if (!refs.length) {
        return {
          route: '/api/chat/store/chat',
          chat: snapshot,
          reuseSteps: undefined
        };
      }

      const referenced = new Set(refs.map((ref) => ref.messageIndex));
      const chat = {
        ...snapshot,
        messages: snapshot.messages!.map((message, index) => {
          if (!referenced.has(index)) {
            return message;
          }

          const {
            steps,
            ...metadata
          } = message;

          return metadata;
        })
      };
      const reuseSteps: HistoryStepReuseRequest = {
        protocol: 1,
        baseRevision: base!.revision,
        refs
      };

      return {
        route: HISTORY_STEP_REUSE_ROUTE,
        chat,
        reuseSteps
      };
    },
    /**
     * Проверяем каждую позицию ACK относительно захваченного снимка, не живого стора.
     * Даже при stale/слиянии точные confirmed доказывают сохранность отдельных массивов.
     */
    acceptAck(
      snapshot: ChatHistorySnapshot,
      response: Record<string, unknown>,
      steps: StepSignature[],
    ): void {
      bases.delete(snapshot.id!);

      const ack = decodeHistoryStepReuseAck(response.stepReuseAck);

      if (!ack || ack.revision !== response.revision ||
        ack.confirmed.length > (snapshot.messages?.length || 0)) {
        return;
      }

      const confirmed: ConfirmedSteps[] = [];

      for (const ref of ack.confirmed) {
        const entry = steps.find((item) => item.index === ref.messageIndex);

        if (!entry || ref.sourceIndex !== ref.messageIndex || entry.length !== ref.expectedLength ||
          messageKey(snapshot.messages?.[ref.messageIndex]) !== ref.expectedKey) {
          return;
        }

        confirmed.push({
          ...entry,
          sourceIndex: ref.sourceIndex,
          key: ref.expectedKey
        });
      }

      bases.set(snapshot.id!, {
        revision: ack.revision,
        steps: confirmed
      });
    },
  };
}

/**
 * Отказ refs требует лёгкой сверки головы и повторной проверки под серверным lock.
 * Generic CAS, сеть, auth и лимит тела сохраняют обычный путь ошибки и штатного retry.
 */
export function isHistoryStepsChanged(error: unknown): boolean {
  const failure = error as {
    status?: number;
    data?: {
      error?: unknown
    }
  } | null;

  return failure?.status === 409 && failure.data?.error === 'chat_steps_changed';
}
