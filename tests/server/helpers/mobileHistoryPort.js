import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ChatAssistantMessages } from '../../../server/src/lib/chat/assistantMessages.ts';
import { ChatHistoryStore } from '../../../server/src/lib/chat/historyStore.ts';
import { InTurnHistory } from '../../../server/src/lib/chat/inTurnHistory.ts';
import { ChatInTurnLedger } from '../../../server/src/lib/chat/inTurnLedger.ts';
import { MobileHistory } from '../../../server/src/lib/chat/mobileHistory.ts';
import { ChatTurnLedger } from '../../../server/src/lib/chat/turnLedger.ts';

/**
 * Собирает общую историю из настоящих журналов в отдельном каталоге.
 * Каждый тест управляет данными на диске, без Fastify и фоновой сверки при старте.
 */
export function mobileHistoryPort({ chatsDir, root }) {
  const history = new ChatHistoryStore({
    chatsDir,
    legacyPath: path.join(root, 'legacy.json'),
  });
  const ledger = new ChatTurnLedger({ dir: path.join(chatsDir, 'turns') });
  const inTurn = new ChatInTurnLedger({ dir: path.join(chatsDir, 'in-turn') });
  const assistant = new ChatAssistantMessages({ dir: path.join(chatsDir, 'in-turn-assistant') });
  const projection = new InTurnHistory({ ledger: inTurn, assistant });
  const pendingDir = path.join(chatsDir, 'pending');

  /**
   * Воссоздаёт чтение записей pending из модуля чата.
   * Отсутствующий каталог и повреждённая запись не блокируют проекцию остальных итогов.
   */
  const readPending = async () => {
    const pending = [];
    const files = await fs.readdir(pendingDir).catch(() => []);

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }

      try {
        pending.push(JSON.parse(await fs.readFile(path.join(pendingDir, file), 'utf8')));
      } catch {
        // Повреждённая запись остаётся на диске для восстановления.
      }
    }

    return pending;
  };
  const mobileHistory = new MobileHistory({
    history,
    ledger,
    projection,
    readPending,
    pendingDir,
    activeRunId: () => null,
    changed: () => {},
  });

  return {
    history,
    ledger,
    mobileHistory,
    pendingDir,
    inTurn,
    assistant,
  };
}

/**
 * Записывает принятый ход прежнего клиента и его durable pending-итог.
 * Тест может заранее сохранить реплику из снимка окна или задать метаданные финала.
 */
export async function seedMobileTurn(port, input) {
  const {
    chatKey,
    turnId,
    text,
    owner,
    reply,
    messages = [],
    extra = {},
  } = input;
  const now = Date.now();

  await port.history.saveOne({
    id: chatKey,
    title: chatKey,
    modelRef: { provider: 'test-provider', model: 'test-model' },
    effort: '',
    speed: 'standard',
    taskId: null,
    workdir: { kind: 'grigdesk' },
    messages,
    createdAt: now,
    updatedAt: input.updatedAt ?? now,
  });

  const entry = await port.ledger.put({
    turnId,
    chatKey,
    state: 'queued',
    acceptedAt: now,
    userText: text,
    mobileOwner: owner,
    mobileHistoryEpoch: 0,
  });

  await port.mobileHistory.accepted(entry);
  await fs.mkdir(port.pendingDir, { recursive: true });
  await fs.writeFile(path.join(port.pendingDir, `${turnId}.json`), JSON.stringify({
    id: turnId,
    turnId,
    chatKey,
    role: 'assistant',
    reply,
    sessionId: `sess-${chatKey}`,
    steps: [{
      k: 'text',
      text: 'работаю',
      at: now,
    }],
    cost: 0.2,
    at: now,
    assistantMessageId: `m-${turnId}`,
    ...extra,
  }));

  return entry;
}

/**
 * Добавляет завершённый промежуточный блок через рабочий журнал исполнителя.
 * begin/complete обновляют и снимок в памяти, и запись, читаемую после рестарта.
 */
export async function seedAssistantBlock(port, { runId, chatKey, assistantMessageId, text, sequence }) {
  await port.assistant.begin({
    runId,
    chatKey,
    assistantMessageId,
    sequence,
  });
  await port.assistant.complete(runId, assistantMessageId, { text });
}

/**
 * Записывает identity текущего хода серверной мутацией под блокировкой чата.
 * Обычный saveOne не даёт клиенту назначить маркер исполнения.
 */
export function setExecutionRunId(port, chatKey, runId) {
  return port.history.patchExecution(chatKey, () => ({ executionRunId: runId }), { durable: true });
}
