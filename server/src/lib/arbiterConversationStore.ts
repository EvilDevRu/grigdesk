import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from '../../../shared/lib/canonicalJson.ts';
import { syncDirectory } from '../../../shared/node/files.ts';
import {
  ARBITER_LIMITS,
  ArbiterConversationError,
  arbiterRecord,
  arbiterText,
  decodeArbiterResult,
  decodeArbiterAction,
  decodeStopIdentity,
  decodeStageIdentity,
  sameStop,
} from '../../../shared/pipeline/arbiterConversation.ts';
import type {
  ArbiterCapabilities,
  ArbiterConversation,
  ArbiterMessage,
  ConversationSnapshot,
  StopIdentity,
  ArbiterConversationSummary,
} from '../../../shared/pipeline/arbiterConversation.ts';

const MAX_BYTES = 32 * 1024 * 1024;
const ID_RE = /^c_[a-f0-9]{32}$/;
const TASK_RE = /^[1-9][0-9]{0,18}$/;

/**
 * Проверяет ограниченный документ до выдачи в API и перед записью.
 * Повреждённая история отклоняется целиком и никогда не становится пустым диалогом.
 */
function decodeDocument(value: unknown): ArbiterConversation {
  const raw = arbiterRecord(value, [
    'schemaVersion', 'id', 'identity', 'revision', 'decisionRevision', 'state', 'automatic',
    'createdAt', 'messages', 'operations', 'result', 'capabilities',
  ]);
  const doc = raw as unknown as ArbiterConversation;

  decodeStopIdentity(doc.identity);

  if (doc.schemaVersion !== 1 || !ID_RE.test(doc.id)
    || !Number.isSafeInteger(doc.revision) || doc.revision < 1
    || !Number.isSafeInteger(doc.decisionRevision) || doc.decisionRevision < 0
    || !['idle', 'analyzing', 'awaiting_user', 'applying', 'resolved', 'interrupted', 'stale']
      .includes(doc.state)
    || typeof doc.automatic !== 'boolean' || !Number.isFinite(Date.parse(doc.createdAt))
    || !Array.isArray(doc.messages) || doc.messages.length > 20_000
    || !Array.isArray(doc.operations) || doc.operations.length > 5_000) {
    throw new Error('Повреждена схема диалога.');
  }

  const caps = arbiterRecord(doc.capabilities, ['status', 'message', 'targets']);

  if (!['supported', 'unsupported', 'unknown', 'unavailable'].includes(String(caps.status))
    || !Array.isArray(caps.targets) || caps.targets.length > 1000) {
    throw new Error('Повреждены возможности диалога.');
  }

  arbiterText(caps.message, ARBITER_LIMITS.summary, true);

  for (const target of doc.capabilities.targets) {
    arbiterRecord(target, ['node', 'label', 'executorKind', 'acceptsInstruction',
      'canRetryUnchanged', 'resetNodes'], ['resetLabels']);
    arbiterText(target.node, 64);
    arbiterText(target.label, 500);

    if (!['agent', 'command'].includes(target.executorKind)
      || typeof target.acceptsInstruction !== 'boolean' || typeof target.canRetryUnchanged !== 'boolean'
      || !Array.isArray(target.resetNodes) || target.resetNodes.length > 1000
      || target.resetNodes.some((node) => typeof node !== 'string' || node.length > 64)
      || target.resetLabels && (!Array.isArray(target.resetLabels)
        || target.resetLabels.length !== target.resetNodes.length
        || target.resetLabels.some((label) => typeof label !== 'string' || label.length > 500))) {
      throw new Error('Повреждена цель действия.');
    }
  }

  let sequence = 0;
  const ids = new Set<string>();

  for (const message of doc.messages) {
    arbiterRecord(message, ['id', 'sequence', 'author', 'text', 'status', 'createdAt', 'revision'],
      ['turnId', 'sourceId', 'sourceRevision', 'sourceKind']);
    arbiterText(message.id, 500);
    arbiterText(message.text, ARBITER_LIMITS.message, true);

    if (message.sequence !== sequence + 1 || ids.has(message.id)
      || !['node', 'arbiter', 'human', 'system'].includes(message.author)
      || !['partial', 'complete', 'interrupted'].includes(message.status)
      || !Number.isSafeInteger(message.revision) || message.revision < 1 || message.revision > doc.revision
      || message.sourceRevision !== undefined
      && (!Number.isSafeInteger(message.sourceRevision) || message.sourceRevision < 0)
      || message.sourceKind !== undefined && !['agent', 'command'].includes(message.sourceKind)
      || !Number.isFinite(Date.parse(message.createdAt))) {
      throw new Error('Повреждена последовательность сообщений.');
    }

    sequence = message.sequence;
    ids.add(message.id);
  }

  const requestIds = new Set<string>();
  const operationIds = new Set<string>();

  for (const operation of doc.operations) {
    arbiterRecord(operation, ['id', 'requestId', 'fingerprint', 'kind', 'outcome', 'createdAt', 'updatedAt'],
      ['error', 'message', 'action', 'originalProposal', 'receipt', 'reason', 'originalStage',
        'observedSequence', 'observation', 'nextStop', 'result', 'answeredQuestion',
        'applyOperationId', 'acceptedEvent', 'expectedCurrentStage']);
    arbiterText(operation.id, 500);
    arbiterText(operation.requestId, 500);

    if (!['start', 'discuss', 'diagnose', 'apply', 'resume'].includes(operation.kind)
      || !['queued', 'running', 'completed', 'accepted', 'resumed', 'resume_failed', 'failed', 'unknown']
        .includes(operation.outcome)
      || requestIds.has(operation.requestId) || operationIds.has(operation.id)
      || !Number.isFinite(Date.parse(operation.createdAt))
      || !Number.isFinite(Date.parse(operation.updatedAt))
      || !/^[a-f0-9]{64}$/.test(operation.fingerprint)) {
      throw new Error('Повреждена операция диалога.');
    }

    requestIds.add(operation.requestId);
    operationIds.add(operation.id);

    if (operation.answeredQuestion !== undefined) {
      const answer = arbiterRecord(operation.answeredQuestion,
        ['questionId', 'question', 'answer'], ['optionId']);

      if (operation.kind !== 'discuss') {
        throw new Error('Ответ на вопрос принадлежит обсуждению.');
      }

      arbiterText(answer.questionId, 80);
      arbiterText(answer.question, ARBITER_LIMITS.summary);
      arbiterText(answer.answer, ARBITER_LIMITS.humanText);

      if (answer.optionId !== undefined) {
        arbiterText(answer.optionId, 80);
      }
    }

    if (operation.message !== undefined) {
      arbiterText(operation.message, ARBITER_LIMITS.summary, true);
    }

    if (operation.action) {
      decodeArbiterAction(operation.action, doc.capabilities.targets, doc.identity.node);
    }

    if (operation.originalStage) {
      decodeStageIdentity(operation.originalStage);
    }

    if (operation.reason !== undefined) {
      arbiterText(operation.reason, ARBITER_LIMITS.instruction);
    }

    if (operation.receipt) {
      const receipt = operation.receipt;

      arbiterRecord(receipt, ['stage', 'originalStage', 'targetNode', 'reason']);
      decodeStageIdentity(receipt.stage);
      decodeStageIdentity(receipt.originalStage);
      arbiterText(receipt.reason, ARBITER_LIMITS.instruction);

      if (!operation.action || receipt.targetNode !== operation.action.targetNode
        || receipt.reason !== operation.reason
        || receipt.originalStage.sequence !== operation.originalStage?.sequence
        || receipt.originalStage.headEventHash !== operation.originalStage.headEventHash
        || receipt.stage.sequence !== receipt.originalStage.sequence + 1) {
        throw new Error('Повреждена связь принятого решения с операцией.');
      }
    }

    if (operation.result) {
      decodeArbiterResult(operation.result, doc.capabilities.targets, doc.identity.node);
    }

    if (operation.originalProposal) {
      decodeArbiterResult({
        summary: 'Исходный вариант',
        questions: [],
        proposals: [operation.originalProposal],
        technicalDetails: '',
      }, doc.capabilities.targets, doc.identity.node);
    }

    if (operation.nextStop) {
      decodeStopIdentity(operation.nextStop);
    }

    if (operation.applyOperationId !== undefined || operation.acceptedEvent !== undefined
      || operation.expectedCurrentStage !== undefined) {
      arbiterText(operation.applyOperationId, 500);
      decodeStageIdentity(operation.acceptedEvent);
      decodeStageIdentity(operation.expectedCurrentStage);
    }

    if (operation.observation && !['waiting', 'running', 'completed', 'stopped', 'superseded']
      .includes(operation.observation)) {
      throw new Error('Повреждён исход повторённого этапа.');
    }
  }

  if (doc.result !== null) {
    decodeArbiterResult(doc.result, doc.capabilities.targets, doc.identity.node);
  }

  return doc;
}

export class ArbiterConversationStore {
  readonly directory: string;

  private queue: Promise<unknown> = Promise.resolve();

  private readonly deleted = new Set<string>();

  private readonly summaries = new Map<string, ArbiterConversationSummary>();

  private readonly onChange: (doc: ArbiterConversation) => void;

  constructor(directory: string, onChange: (doc: ArbiterConversation) => void = () => { }) {
    this.directory = directory;
    this.onChange = onChange;
  }

  /**
   * Путь строится только из проверенных серверных идентификаторов.
   * Ни поля модели, ни пользовательский текст не выбирают файл хранения.
   */
  file(task: string, id: string): string {
    if (!TASK_RE.test(task) || !ID_RE.test(id)) {
      throw new ArbiterConversationError('invalid_request', 'Некорректный адрес диалога.');
    }

    return path.join(this.directory, task, `${id}.json`);
  }

  /**
   * Один exact stop получает детерминированный серверный id и одну запись.
   * Очередь охватывает чтение и создание, исключая гонку двух открывающих вкладок.
   */
  create(identity: StopIdentity, capabilities: ArbiterCapabilities, automatic = false) {
    decodeStopIdentity(identity);

    const id = `c_${createHash('sha256').update(canonicalJson(identity)).digest('hex').slice(0, 32)}`;

    return this.serial(async () => {
      this.assertOpen(identity.task, id, identity.attempt);

      const existing = await this.read(identity.task, id);

      if (existing) {
        return existing;
      }

      const doc: ArbiterConversation = {
        schemaVersion: 1,
        id,
        identity,
        revision: 1,
        decisionRevision: 0,
        state: 'idle',
        automatic,
        createdAt: new Date().toISOString(),
        messages: [],
        operations: [],
        result: null,
        capabilities,
      };

      await this.write(doc);

      return structuredClone(doc);
    });
  }

  /**
   * Чтение отличает отсутствие от повреждения и ограничивает размер до JSON.parse.
   * Файлы чужой задачи не выдаются даже при совпадении имени.
   */
  async read(task: string, id: string): Promise<ArbiterConversation | null> {
    const file = this.file(task, id);

    try {
      const stat = await fs.lstat(file);

      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) {
        throw new Error('Файл диалога повреждён или слишком велик.');
      }

      const doc = decodeDocument(JSON.parse(await fs.readFile(file, 'utf8')));

      if (doc.id !== id || doc.identity.task !== task) {
        throw new Error('Идентичность файла диалога не совпала.');
      }

      this.remember(doc);

      return doc;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }

      throw new ArbiterConversationError('storage_failed', 'Не удалось прочитать сохранённый разбор.', 503);
    }
  }

  /**
   * Все read-modify-write и удаления проходят одной очередью владельца.
   * Изменение identity запрещено даже внутреннему callback.
   */
  update(task: string, id: string, change: (doc: ArbiterConversation) => void | Promise<void>) {
    return this.serial(async () => {
      this.assertOpen(task, id);

      const doc = await this.read(task, id);

      if (!doc) {
        throw new ArbiterConversationError('conversation_deleted', 'История разбора уже удалена.', 410);
      }

      this.assertOpen(task, id, doc.identity.attempt);

      const identity = structuredClone(doc.identity);

      await change(doc);

      if (!sameStop(identity, doc.identity) || doc.id !== id) {
        throw new ArbiterConversationError('storage_failed', 'Идентичность истории нельзя менять.', 500);
      }

      doc.revision += 1;
      await this.write(doc);

      return structuredClone(doc);
    });
  }

  /**
   * Cumulative snapshots обновляют прежнее сообщение только с большей sourceRevision.
   * Терминальный ход не принимает запоздавшие дельты исполнителя.
   */
  append(task: string, id: string, input: Omit<ArbiterMessage, 'id' | 'sequence' | 'revision' | 'createdAt'>
    & Partial<Pick<ArbiterMessage, 'id' | 'createdAt'>>) {
    return this.update(task, id, (doc) => {
      const operation = doc.operations.find((row) => row.id === input.turnId);

      if (operation && !['queued', 'running'].includes(operation.outcome)) {
        return;
      }

      const existing = input.id ? doc.messages.find((row) => row.id === input.id) : null;

      if (existing) {
        if (existing.turnId !== input.turnId
          || (input.sourceRevision ?? 0) <= (existing.sourceRevision ?? 0)) {
          return;
        }

        Object.assign(existing, input, { revision: doc.revision + 1 });
      } else {
        doc.messages.push({
          ...input,
          id: input.id || randomUUID(),
          sequence: doc.messages.length + 1,
          revision: doc.revision + 1,
          createdAt: input.createdAt || new Date().toISOString(),
        });
      }
    });
  }

  /**
   * Пагинация возвращает новые записи и исправленные partial snapshots.
   * knownRevision позволяет дочитать замену уже полученного сообщения.
   */
  async snapshot(task: string, id: string, { afterSequence = 0, knownRevision = 0 } = {}) {
    const doc = await this.read(task, id);

    if (!doc) {
      return null;
    }

    const changed = doc.messages.filter((row) => row.sequence > afterSequence
      || knownRevision > 0 && row.revision > knownRevision);
    const messages = changed.slice(0, ARBITER_LIMITS.page);

    return {
      ...doc,
      messages,
      afterSequence: Math.max(afterSequence, ...messages.map((row) => row.sequence)),
      hasMore: changed.length > messages.length,
      readOnly: doc.state === 'stale' || doc.state === 'resolved',
    } satisfies ConversationSnapshot;
  }

  /**
   * Перечисляет только собственные JSON-документы, не обходя symlink-каталоги.
   * Ошибка каталога сохраняется как отказ, а не доказательство отсутствия владельцев.
   */
  async list(task?: string): Promise<ArbiterConversation[]> {
    let entries;

    try {
      entries = await fs.readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }

      throw new ArbiterConversationError('storage_failed', 'Каталог разборов недоступен.', 503);
    }

    const documents: ArbiterConversation[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || !TASK_RE.test(entry.name) || (task && entry.name !== task)) {
        continue;
      }

      for (const name of await fs.readdir(path.join(this.directory, entry.name))) {
        const id = name.replace(/\.json$/, '');

        if (ID_RE.test(id)) {
          const doc = await this.read(entry.name, id);

          if (doc) {
            documents.push(doc);
          }
        }
      }
    }

    return documents;
  }

  /**
   * Окончательное удаление данных попытки закрывает её поздние callbacks.
   * Архивирование и снос стенда этот метод не вызывают.
   */
  removeAttempt(task: string, attempt: string) {
    return this.serial(async () => {
      this.deleted.add(`${task}/${attempt}`);

      for (const doc of await this.list(task)) {
        if (doc.identity.attempt === attempt) {
          this.deleted.add(`${task}/${doc.id}`);
          await fs.rm(this.file(task, doc.id), { force: true });
          this.summaries.delete(doc.id);
        }
      }
    });
  }

  /**
   * Удаляет историю задачи в той же очереди, что и запись.
   * Закрытый task остаётся tombstone до конца жизни процесса.
   */
  removeTask(task: string) {
    return this.serial(async () => {
      if (!TASK_RE.test(task)) {
        throw new ArbiterConversationError('invalid_request', 'Некорректная задача.');
      }

      this.deleted.add(task);
      await fs.rm(path.join(this.directory, task), { recursive: true, force: true });

      for (const [id, summary] of this.summaries) {
        if (summary.identity.task === task) {
          this.summaries.delete(id);
        }
      }
    });
  }

  /**
   * После сбоя удаляет только подтверждённых сирот активных и архивных данных.
   * Ошибка чтения owner означает отложенную очистку, история сохраняется.
   */
  async reconcileOwners(probe: (identity: StopIdentity) => Promise<'present' | 'absent' | 'unknown'>) {
    for (const doc of await this.list()) {
      let owner = 'unknown';

      try {
        owner = await probe(doc.identity);
      } catch {
        continue;
      }

      if (owner === 'absent') {
        await this.removeAttempt(doc.identity.task, doc.identity.attempt);
      }
    }
  }

  /**
   * Дешёвая проекция для списка задач содержит только exact identity и статус.
   * Полная переписка читается лишь при открытии самого разбора.
   */
  readSummary(task: string, attempt: string, stage?: { sequence: number; headEventHash: string } | null) {
    return this.history(task, attempt).find((row) => !stage
      || row.identity.stageSequence === stage.sequence
      && row.identity.stageHeadHash === stage.headEventHash) || null;
  }

  history(task: string, attempt: string) {
    return [...this.summaries.values()]
      .filter((row) => row.identity.task === task && row.identity.attempt === attempt)
      .sort((left, right) => right.identity.stageSequence - left.identity.stageSequence);
  }

  private remember(doc: ArbiterConversation) {
    this.summaries.set(doc.id, {
      conversationId: doc.id,
      identity: doc.identity,
      revision: doc.revision,
      state: doc.state,
      automatic: doc.automatic,
      started: doc.operations.length > 0,
    });
  }

  private assertOpen(task: string, id: string, attempt?: string) {
    if (this.deleted.has(task) || this.deleted.has(`${task}/${id}`)
      || (attempt && this.deleted.has(`${task}/${attempt}`))) {
      throw new ArbiterConversationError('conversation_deleted', 'История разбора уже удалена.', 410);
    }
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action, action);

    this.queue = result.catch(() => { });

    return result;
  }

  /**
   * Сначала fsync файла и atomic rename, затем fsync каталога и уведомление.
   * Подтверждение и SSE никогда не опережают сохранённую историю.
   */
  private async write(doc: ArbiterConversation) {
    const file = this.file(doc.identity.task, doc.id);
    const directory = path.dirname(file);
    const temporary = `${file}.${randomUUID()}.tmp`;

    try {
      decodeDocument(doc);

      const bytes = JSON.stringify(doc);

      if (Buffer.byteLength(bytes) > MAX_BYTES) {
        throw new Error('История превысила допустимый размер.');
      }

      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(this.directory, 0o700);
      await fs.chmod(directory, 0o700);

      const handle = await fs.open(temporary, 'wx', 0o600);

      try {
        await handle.writeFile(bytes, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }

      await fs.rename(temporary, file);
      await syncDirectory(directory);
    } catch {
      await fs.rm(temporary, { force: true }).catch(() => { });

      throw new ArbiterConversationError(
        'storage_failed',
        'Не удалось сохранить разбор. Действие не подтверждено.',
        503
      );
    }

    this.remember(doc);
    this.onChange(structuredClone(doc));
  }
}
