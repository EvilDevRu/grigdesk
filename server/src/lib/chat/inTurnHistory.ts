// Проекция разговора для следующего хода: уточнения и ответы прошлых запусков.
//
// Ответ в pending и видимые блоки переносит в историю окно, а оно может быть закрыто.
// Поэтому модель получает проекцию из durable-журналов: подтверждённые уточнения и
// законченные блоки прошлых запусков плюс ответы, всё ещё лежащие в pending. Ключи
// сообщений (pid, messageId, assistantMessageId) не дают одной записи появиться дважды.
import type { ChatAssistantMessages } from './assistantMessages.ts';
import type { ChatInTurnLedger } from './inTurnLedger.ts';
import { messageKey } from './messageIdentity.ts';

// Сообщение ленты в том виде, в каком его понимают mergeChat, store и модель.
export interface ProjectedMessage {
  role: string;
  text: string;
  [field: string]: unknown;
}

// Запись pending в объёме, нужном проекции: id, чат, роль, текст и связь с ходом.
export interface PendingLike {
  id?: unknown;
  chatKey?: unknown;
  role?: unknown;
  reply?: unknown;
  userText?: unknown;
  turnId?: unknown;
  assistantMessageId?: unknown;
  runId?: unknown;
  userSentAt?: unknown;
  at?: unknown;
}

export class InTurnHistory {
  private readonly ledger: ChatInTurnLedger;

  private readonly assistant: ChatAssistantMessages;

  constructor({ ledger, assistant }: {
    ledger: ChatInTurnLedger;
    assistant: ChatAssistantMessages;
  }) {
    this.ledger = ledger;
    this.assistant = assistant;
  }

  /**
   * Сообщения одного запуска в порядке общего sequence: подтверждённые уточнения и
   * видимые блоки. Недоставленное и неопределённое сюда не попадает — оно остаётся
   * видимым в окне, но не становится инструкцией следующему агенту.
   */
  runMessages(runId: string, options: { includeIncomplete?: boolean } = {}): ProjectedMessage[] {
    const messages: Array<ProjectedMessage & { sequence: number }> = [];
    const receipts = this.ledger.byRun(runId);
    const parentTurnId = receipts[0]?.parentTurnId;

    for (const entry of receipts) {
      if (entry.state !== 'forwarded' && entry.state !== 'consumed') {
        continue;
      }

      messages.push({
        role: 'user',
        kind: 'in-turn',
        text: entry.text,
        messageId: entry.messageId,
        runId: entry.runId,
        ...(parentTurnId ? { parentTurnId } : {}),
        sequence: entry.sequence,
        at: entry.acceptedAt,
        receipt: entry,
        serverCanonical: true,
      });
    }

    for (const block of this.assistant.byRun(runId)) {
      if (!String(block.text || '').trim()) {
        continue;
      }
      if (!block.complete && options.includeIncomplete !== true) {
        continue;
      }

      messages.push({
        role: 'assistant',
        kind: 'assistant-block',
        text: block.text,
        assistantMessageId: block.assistantMessageId,
        runId: block.runId,
        ...(parentTurnId ? { parentTurnId } : {}),
        sequence: block.sequence,
        revision: block.revision,
        serverCanonical: true,
        ...(block.complete ? {} : { complete: false }),
      });
    }

    return messages.sort((left, right) => left.sequence - right.sequence);
  }

  /**
   * Проекция для модели и истории: база окна, затем группы прошлых запусков и ответы из
   * pending. Одинаковые тексты с разными id остаются разными записями, а уже известное
   * по ключу не дублируется — окно могло сохранить часть данных само.
   */
  project({ chatKey, base = [], pending = [] }: {
    chatKey: string;
    base?: unknown;
    pending?: readonly PendingLike[];
  }): ProjectedMessage[] {
    const messages: ProjectedMessage[] = Array.isArray(base) ? [...base as ProjectedMessage[]] : [];
    const known = new Map<string, number>();

    for (const [index, message] of messages.entries()) {
      known.set(messageKey(message), index);
    }

    /**
     * Добавить запись, если такой ещё нет. Ключ считается один раз: идентификаторы
     * приходят и от окна, и из журналов, и повтор не должен создавать вторую копию.
     */
    const append = (message: ProjectedMessage, canonical = false, position?: number) => {
      const key = messageKey(message);
      const index = known.get(key);

      if (index !== undefined) {
        if (canonical) {
          messages[index] = { ...messages[index], ...message };
        }

        return;
      }

      if (position === undefined || position >= messages.length) {
        known.set(key, messages.length);
        messages.push(message);
      } else {
        messages.splice(position, 0, message);
        known.clear();

        for (const [current, item] of messages.entries()) {
          known.set(messageKey(item), current);
        }
      }
    };

    const ownPending = pending.filter((entry) => String(entry?.chatKey || '') === chatKey);

    // У закрытого окна исходный user-текст есть только в pending. Он обязан стоять
    // перед уточнениями своего запуска, даже если окно уже сохранило следующий ход.
    for (const entry of ownPending) {
      const id = String(entry?.id || '');
      const turnId = String(entry?.turnId || '');
      const userText = String(entry?.userText || '');
      const userKnown = known.has(`pid\u0000${id}:u`)
        || (!!turnId && known.has(`turn\u0000${turnId}\u0000user`));

      if (!userText || userKnown) {
        continue;
      }

      const sentAt = Number(entry.userSentAt || entry.at || 0);
      const nextUser = messages.findIndex((message) => message.role === 'user'
        && Number(message.sentAt || message.at || 0) > sentAt);

      append({
        role: 'user',
        text: userText,
        ...(id ? { pid: `${id}:u` } : {}),
        ...(turnId ? { turnId } : {}),
        kind: 'pending-user',
      }, false, nextUser < 0 ? undefined : nextUser);
    }

    if (chatKey) {
      for (const runId of this.ledger.byChat(chatKey)) {
        for (const message of this.runMessages(runId)) {
          const anchor = messages.findLastIndex((candidate) => candidate.runId === runId
            || (!!message.parentTurnId && candidate.role === 'user'
              && candidate.turnId === message.parentTurnId));

          append(message, true, anchor < 0 ? undefined : anchor + 1);
        }
      }
    }

    for (const entry of ownPending) {
      const id = String(entry?.id || '');
      const turnId = String(entry?.turnId || '');
      const runId = String(entry.runId || '');
      const anchor = messages.findLastIndex((message) => (!!runId && message.runId === runId)
        || (!!turnId && message.role === 'user' && message.turnId === turnId));

      append({
        role: String(entry?.role || 'assistant'),
        text: String(entry?.reply || ''),
        ...(id ? { pid: id } : {}),
        ...(turnId ? { turnId } : {}),
        ...(entry.assistantMessageId ? { assistantMessageId: entry.assistantMessageId } : {}),
        ...(entry.runId ? { runId: entry.runId } : {}),
        kind: 'pending-answer',
      }, false, anchor < 0 ? undefined : anchor + 1);
    }

    return messages;
  }
}
