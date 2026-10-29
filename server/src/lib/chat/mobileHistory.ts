import { promises as fs } from 'node:fs';
import path from 'node:path';

import { normalizeContextUsage } from '../../../../shared/chat/chatContextUsage.ts';
import type { ChatHead, ChatHistoryStore, StoredChat } from './historyStore.ts';
import type { InTurnHistory } from './inTurnHistory.ts';
import { messageKey } from './messageIdentity.ts';
import type { ChatTurnLedger, MobileTurnOwner, TurnEntry } from './turnLedger.ts';
import { EMPTY_WORKDIR_MEMORY } from './workdirTransition.ts';
import type { MobileChatControls } from './mobileControls.ts';

export type MobileChatInput = {
  chatKey: string;
  turnId: string;
  message: string;
  sentAt?: number;
  owner: MobileTurnOwner;
};

export type MobileChatPort = {
  controls?: MobileChatControls;
  compactWindow?: () => number;
  defaults?: () => Promise<unknown>;
  send: (input: MobileChatInput) => Promise<{
    status: number;
    body: Record<string, unknown>;
  }>;
  reconcile: (chatKey?: string) => Promise<void>;
  read: (chatKey: string) => Promise<StoredChat | null>;
  heads: () => Promise<ChatHead[]>;
  recover: (input: {
    deviceId: string;
    chatId: string;
    clientId: string;
    turnId: string;
    contentHash: string;
  }) => Promise<{ state: 'queued' | 'running' | 'done' } | null>;
  deliveries: (
    deviceId: string,
    chatKey: string,
    clientIds: string[],
  ) => Promise<
    Array<{
      clientId: string;
      turnId: string | null;
      state: 'unknown' | 'queued' | 'running' | 'done';
      outcome: string | null;
    }>
  >;
};

declare module 'fastify' {
  interface FastifyInstance {
    mobileChat?: MobileChatPort;
  }
}

type Options = {
  history: ChatHistoryStore;
  ledger: ChatTurnLedger;
  projection: InTurnHistory;
  readPending: () => Promise<Array<Record<string, unknown>>>;
  pendingDir: string;
  changed: (chatKey: string) => void;
  activeRunId: (chatKey: string) => string | null;
};

/**
 * Материализует общую историю принятых мобильных ходов под существующим chat lock.
 * Pending подтверждается лишь после durable записи всей проекции и метаданных.
 */
export class MobileHistory {
  private options: Options;
  private running: Promise<void> = Promise.resolve();

  constructor(options: Options) {
    this.options = options;
  }

  /**
   * Принятая реплика видна на диске до запуска исполнителя, включая очередь.
   * Устойчивый turnId совпадает с ключом веба; повтор не создаёт вторую реплику.
   */
  async accepted(entry: TurnEntry) {
    if (!entry.mobileOwner) {
      return;
    }

    await this.options.history.patchExecution(
      entry.chatKey,
      (current) => {
        if (
          entry.historySuppressed ||
          Number(entry.mobileHistoryEpoch || 0) !== Number(current.mobileHistoryEpoch || 0)
        ) {
          return {};
        }

        const messages = (current.messages ?? []).map((message) => ({ ...message }));
        const found = messages.find(
          (message) => message.role === 'user' && message.turnId === entry.turnId,
        );
        const user = {
          role: 'user',
          text: entry.userText ?? '',
          turnId: entry.turnId,
          clientId: entry.mobileOwner!.clientId,
          sentAt: entry.userSentAt ?? entry.acceptedAt,
          serverCanonical: true,
        };

        if (found) {
          Object.assign(found, user);
        } else {
          messages.push(user);
        }

        return {
          messages,
          updatedAt: Math.max(Number(current.updatedAt || 0), entry.acceptedAt),
        };
      },
      {
        durable: true,
        skipUnchanged: true,
      },
    );
  }

  /**
   * Сверки сериализованы, а семантический патч всегда применён к свежему chat JSON.
   * Ошибка history/ACK остаётся ошибкой чтения; pending сохраняется для следующего прохода.
   */
  reconcile(chatKey?: string): Promise<void> {
    const job = this.running.catch(() => {}).then(() => this.apply(chatKey));

    this.running = job;

    return job;
  }

  /**
   * Удаление истории и её mobile pending согласовано с текущей материализацией.
   * Durable tombstone в прежнем ledger запрещает оживление при повторном id чата.
   */
  remove(chatKey: string, remove: () => Promise<boolean>): Promise<boolean> {
    const job = this.running
      .catch(() => {})
      .then(async () => {
        const entries = this.options.ledger.mobileTurns(chatKey);
        let removed = false;

        try {
          for (const entry of entries) {
            await this.options.ledger.update(entry.turnId, { historySuppressed: true });
          }

          removed = await remove();

          if (removed) {
            await this.discard(chatKey);
          }

          return removed;
        } finally {
          // Если удаление не совершилось, прежние итоги остаются частью разговора.
          // Ошибка tombstone возникает до remove; rollback тоже проходит durable ledger.
          if (!removed) {
            for (const entry of entries) {
              await this.options.ledger.update(entry.turnId, {
                historySuppressed: entry.historySuppressed === true,
              });
            }
          }
        }
      });

    this.running = job.then(
      () => {},
      () => {},
    );

    return job;
  }

  /**
   * Забытому пользователем чату больше не нужен pending, но turnId остаётся известным.
   * Запись подавления предшествует ACK и сохраняется в уже существующем ledger.
   */
  private async discard(chatKey: string) {
    for (const entry of this.options.ledger.mobileTurns(chatKey)) {
      await this.options.ledger.update(entry.turnId, { historySuppressed: true });
    }
    for (const pending of await this.options.readPending()) {
      const entry = this.options.ledger.get(String(pending.turnId || pending.id || ''));

      if (entry?.mobileOwner && entry.chatKey === chatKey) {
        await this.ack(pending);
      }
    }
  }

  /**
   * ACK принимает только безопасное имя файла, созданное общим pending-владельцем.
   * Ошибка удаления остаётся повторяемой: история уже устойчиво записана.
   */
  private async ack(pending: Record<string, unknown>) {
    const id = String(pending.id || '');

    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(id)) {
      throw new Error('mobile_history_bad_pending_id');
    }

    await fs.rm(path.join(this.options.pendingDir, `${id}.json`), { force: true });
  }

  /**
   * Подбирает принятых пользователей и только принадлежащие mobile итоги общего pending.
   * Проекция читает все durable страницы уточнений, а не ограниченную страницу HTTP.
   */
  private async apply(chatKey?: string) {
    await this.options.ledger.load();

    for (const entry of this.options.ledger.mobileTurns(chatKey)) {
      if (entry.historySuppressed) {
        continue;
      }
      if (await this.options.history.readOne(entry.chatKey)) {
        await this.accepted(entry);
      } else {
        await this.discard(entry.chatKey);
      }
    }

    for (const pending of await this.options.readPending()) {
      const entry = this.options.ledger.get(String(pending.turnId || pending.id || ''));

      if (
        !entry?.mobileOwner ||
        entry.chatKey !== pending.chatKey ||
        (chatKey && entry.chatKey !== chatKey)
      ) {
        continue;
      }

      const canonical = {
        ...pending,
        id: entry.turnId,
        assistantMessageId: pending.finalAssistantMessageId || pending.assistantMessageId,
      };

      // Устойчивый pending доказывает итог даже при сбое предыдущей записи ledger.
      // До ACK завершаем ту же запись хода, чтобы recovery не заменил ответ interrupted.
      await this.options.ledger.update(entry.turnId, {
        state: 'done',
        finishedAt: Number(pending.at || Date.now()),
        outcome: pending.interruptedBy
          ? 'interrupted'
          : pending.stopped
            ? 'stopped'
            : pending.role === 'error'
              ? 'error'
              : 'reply',
      });

      const current = await this.options.history.readOne(entry.chatKey);

      if (!current || entry.historySuppressed) {
        await this.discard(entry.chatKey);

        continue;
      }

      await this.options.history.patchExecution(
        entry.chatKey,
        (current) => {
          if (Number(entry.mobileHistoryEpoch || 0) !== Number(current.mobileHistoryEpoch || 0)) {
            return {};
          }

          const excludedRuns = this.options.ledger
            .mobileTurns(entry.chatKey)
            .filter(
              (turn) =>
                turn.historySuppressed ||
                Number(turn.mobileHistoryEpoch || 0) !== Number(current.mobileHistoryEpoch || 0),
            )
            .map((turn) => turn.runId || '')
            .filter(Boolean);
          const messages = this.options.projection.project({
            chatKey: entry.chatKey,
            base: current.messages?.map((message) => ({ ...message })),
            pending: [canonical],
            excludedRuns,
          });
          const key = messageKey({
            role: pending.role ?? 'assistant',
            pid: entry.turnId,
            runId: pending.runId,
            assistantMessageId: canonical.assistantMessageId,
          });
          const final = messages.find((message) => messageKey(message) === key);

          if (!final) {
            throw new Error('mobile_history_missing_final');
          }

          Object.assign(final, {
            role: pending.role ?? 'assistant',
            text: pending.reply || '(пусто)',
            turnId: entry.turnId,
            clientId: entry.mobileOwner!.clientId,
            cost: pending.cost ?? null,
            steps: Array.isArray(final.steps) ? final.steps
              : Array.isArray(pending.steps) ? pending.steps : [],
            model: pending.model || '',
            actualModel: pending.actualModel || '',
            effort: pending.effort || '',
            at: pending.at ?? entry.finishedAt ?? Date.now(),
            serverCanonical: true,
            stopped: pending.stopped === true,
            interruptedBy: pending.interruptedBy || null,
          });

          return {
            messages,
            ...this.metadata(current, canonical, entry),
            unread: current.messages?.some((message) => messageKey(message) === key)
              ? current.unread : true,
            updatedAt: Math.max(
              Number(current.updatedAt || 0),
              Number(pending.at || entry.acceptedAt),
            ),
          };
        },
        {
          durable: true,
          skipUnchanged: true,
        },
      );

      await this.ack(pending);
      this.options.changed(entry.chatKey);
    }
  }

  /**
   * Метаданные финала применяются лишь к тому запуску, которым ещё владеет история.
   * Старый pending никогда не откатывает session/context нового веб- или мобильного хода.
   */
  private metadata(current: StoredChat, result: Record<string, unknown>, entry: TurnEntry) {
    const active = this.options.activeRunId(entry.chatKey);
    const belongs = result.runId
      ? (!active || active === result.runId) && current.executionRunId === result.runId
      : !active && !current.executionRunId;

    if (!belongs || Number(current.mobileHistoryAppliedAt || 0) > entry.acceptedAt) {
      return {};
    }

    const fields: Record<string, unknown> = {
      mobileHistoryAppliedAt: entry.acceptedAt,
      ...(result.sessionReset ? EMPTY_WORKDIR_MEMORY : normalizeContextUsage(result)),
      ...(result.sessionId && !result.sessionReset ? { sessionId: result.sessionId } : {}),
      ...(result.effort ? { effort: result.effort } : {}),
    };

    for (const key of ['totalInputTokens', 'cachedInputTokens', 'contextCache']) {
      if (Object.hasOwn(result, key)) {
        fields[key] = result[key];
      }
    }

    if (result.sessionResetFailed) {
      fields.sessionResetFailed = true;
    }
    if (result.title && !String(current.title || '').trim()) {
      fields.title = String(result.title).trim();
    }

    return fields;
  }
}
