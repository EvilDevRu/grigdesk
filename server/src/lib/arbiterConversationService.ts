import { createHash, randomUUID } from 'node:crypto';

import { canonicalJson } from '../../../shared/lib/canonicalJson.ts';
import {
  ArbiterConversationError,
  arbiterRecord,
  arbiterText,
  decodeHumanIntent,
  decodeArbiterAction,
  decodeStopIdentity,
  decodeStageIdentity,
  invalidateDecision,
  sameStop,
} from '../../../shared/pipeline/arbiterConversation.ts';
import type {
  ArbiterCapabilities,
  ArbiterConversation,
  ArbiterOperation,
  IntentKind,
  StopIdentity,
} from '../../../shared/pipeline/arbiterConversation.ts';
import { addRunnerMessage, runArbiterConversation } from './arbiterConversationRunner.ts';
import type { PreparedArbiterInput } from './arbiterConversationRunner.ts';
import type { ArbiterConversationStore } from './arbiterConversationStore.ts';
import type { ArbiterStopContext } from './arbiterStopContext.ts';
import type { ArbiterExecutor } from './factoryArbiter.ts';
import type { FactoryArbiterLive } from './factoryArbiterLive.ts';

export interface ConversationAck {
  conversationId: string;
  operationId: string;
  revision: number;
  operation: ArbiterOperation;
  completion: Promise<void>;
}

export interface ConversationServiceDeps {
  store: ArbiterConversationStore;
  readContext: (task: string) => Promise<ArbiterStopContext | null>;
  capabilities: (context: ArbiterStopContext) => Promise<ArbiterCapabilities>;
  prepareRun: (context: ArbiterStopContext) => Promise<{
    executor: ArbiterExecutor;
    input: PreparedArbiterInput;
  }>;
  live?: FactoryArbiterLive;
  onError?: (error: unknown) => void;
  apply?: (
    doc: ArbiterConversation,
    operation: ArbiterOperation,
    controller: AbortController
  ) => Promise<void>;
  resume?: (
    doc: ArbiterConversation,
    operation: ArbiterOperation,
    payload: Record<string, unknown>
  ) => Promise<void>;
  validateResume?: (doc: ArbiterConversation, payload: Record<string, unknown>) => Promise<void>;
  recoverApply?: (doc: ArbiterConversation) => Promise<void>;
  observe?: (doc: ArbiterConversation) => Promise<void>;
  owner?: (identity: StopIdentity) => Promise<'present' | 'absent' | 'unknown'>;
  turnTimeoutMs?: number;
}

export class ArbiterConversationService {
  readonly store: ArbiterConversationStore;

  private readonly deps: ConversationServiceDeps;

  private readonly admissions = new Map<string, Promise<unknown>>();

  private readonly jobs = new Map<string, { completion: Promise<void>; controller: AbortController }>();

  private closed = false;

  constructor(deps: ConversationServiceDeps) {
    this.deps = deps;
    this.store = deps.store;
  }

  /**
   * Startup завершает потерянные читающие ходы без повторного вызова модели.
   * Незавершённое применение сначала сверяется с immutable receipt.
   */
  async recover() {
    if (this.deps.owner) {
      await this.store.reconcileOwners(this.deps.owner);
    }

    for (const doc of await this.store.list()) {
      if (doc.state === 'applying') {
        await this.deps.recoverApply?.(doc);
      } else if (doc.state === 'analyzing') {
        await this.interruptRead(doc, 'interrupted',
          'Разбор прерван перезапуском сервера. История сохранена; повторите разбор явно.');
      }

      if (doc.operations.some((row) => row.kind === 'resume'
        && ['queued', 'running'].includes(row.outcome))) {
        await this.store.update(doc.identity.task, doc.id, (latest) => {
          for (const row of latest.operations) {
            if (row.kind === 'resume' && ['queued', 'running'].includes(row.outcome)) {
              row.outcome = 'unknown';
              row.error = 'interrupted';
              row.updatedAt = new Date().toISOString();
            }
          }

          addRunnerMessage(latest, 'system',
            'Подтверждение повторного запуска прервано перезапуском. Проверьте состояние; '
            + 'при необходимости повторите только запуск.');
        });
      }
    }
  }

  /**
   * Оставшийся без job читающий ход не должен навсегда блокировать окно состоянием analyzing.
   * После восстановления диска фиксируется отказ; повтор модели остаётся явным действием.
   */
  private async interruptRead(doc: ArbiterConversation, code: string, message: string) {
    await this.store.update(doc.identity.task, doc.id, (latest) => {
      if (latest.state !== 'analyzing') {
        return;
      }

      latest.state = 'interrupted';
      latest.result = null;

      for (const row of latest.operations.filter((row) => ['queued', 'running'].includes(row.outcome))) {
        row.outcome = 'failed';
        row.error = code;
        row.updatedAt = new Date().toISOString();
      }

      for (const row of latest.messages.filter((row) => row.status === 'partial')) {
        row.status = 'interrupted';
        row.revision = latest.revision + 1;
      }

      addRunnerMessage(latest, 'system', message);
    });
  }

  /**
   * GET сверяет текущую остановку и поддержку выбранного runtime без создания pin или диалога.
   * История и задачи не перезапускаются от открытия окна.
   */
  async current(task: string) {
    const context = await this.deps.readContext(task);

    if (!context) {
      return {
        identity: null,
        conversationId: null,
        capabilities: null
      };
    }

    const capabilities = await this.deps.capabilities(context);
    const doc = (await this.store.list(task)).find((row) => sameStop(row.identity, context.identity));

    return {
      identity: context.identity,
      conversationId: doc?.id || null,
      revision: doc?.revision || 0,
      state: doc?.state || 'idle',
      capabilities,
      summary: doc?.result?.summary || null,
    };
  }

  start(task: string, body: unknown, automatic = false) {
    return this.submit(task, null, 'start', body, automatic);
  }

  /**
   * Все входы используют одну per-task admission, включая watcher и две вкладки.
   * Повтор requestId сверяется раньше stale check и не создаёт второго эффекта.
   */
  submit(task: string, conversationId: string | null, kind: IntentKind, body: unknown, automatic = false) {
    return this.admit(task, async (): Promise<ConversationAck> => {
      if (this.closed) {
        throw new ArbiterConversationError('server_restarting', 'Сервер завершает работу.', 503);
      }

      const fields = kind === 'start' ? [] : kind === 'resume'
        ? ['applyOperationId', 'acceptedEvent', 'expectedCurrentStage'] : ['decisionRevision'];
      const raw = arbiterRecord(
        body,
        ['requestId', ...(kind === 'resume' ? [] : ['expectedStop']), ...fields],

        kind === 'discuss' ? ['text', 'questionId', 'optionId', 'customAnswer']
          : kind === 'apply' ? ['proposalId', 'customAction', 'originalProposalId']
            : kind === 'diagnose' ? ['proposalId'] : []
      );

      const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

      if (typeof raw.requestId !== 'string' || !uuid.test(raw.requestId)) {
        throw new ArbiterConversationError('invalid_request', 'Нужен UUID запроса.');
      }

      const fingerprint = createHash('sha256').update(canonicalJson({
        kind,
        conversationId,
        body: raw
      }))
        .digest('hex');
      const documents = await this.store.list(task);

      for (const existing of documents) {
        const operation = existing.operations.find((row) => row.requestId === raw.requestId);

        if (operation) {
          if (operation.fingerprint !== fingerprint) {
            throw new ArbiterConversationError(
              'request_conflict',
              'Этот запрос уже принят с другим содержимым.',
              409
            );
          }

          return this.ack(existing, operation);
        }
      }

      if (this.jobs.has(task)) {
        throw new ArbiterConversationError('conversation_busy', 'Разбор или действие уже выполняется.', 409);
      }

      let doc = conversationId ? await this.store.read(task, conversationId) : null;

      if (conversationId && !doc) {
        throw new ArbiterConversationError('not_found', 'Разбор не найден.', 404);
      }

      if (kind === 'resume') {
        if (!doc || !this.deps.resume) {
          throw new ArbiterConversationError('not_available', 'Повтор запуска недоступен.', 409);
        }

        return this.launchResume(doc, raw, fingerprint);
      }

      const expected = decodeStopIdentity(raw.expectedStop);
      const context = await this.deps.readContext(task);

      if (expected.task !== task || !context || !sameStop(expected, context.identity)
        || (doc && !sameStop(doc.identity, expected))) {
        throw new ArbiterConversationError('stale_stop', 'Остановка уже изменилась. Откройте текущую.', 409);
      }

      if (automatic && !doc) {
        doc = documents.find((row) => sameStop(row.identity, context.identity)) || null;
      }

      if (automatic && doc?.operations.length) {
        return this.ack(doc, doc.operations.at(-1)!);
      }

      const capabilities = await this.deps.capabilities(context);

      doc ||= await this.store.create(context.identity, capabilities, automatic);

      if (kind !== 'start' && (raw.decisionRevision !== doc.decisionRevision
        || !Number.isSafeInteger(raw.decisionRevision))) {
        throw new ArbiterConversationError('stale_decision', 'Варианты решения уже изменились.', 409);
      }

      const payload = Object.fromEntries(Object.entries(raw).filter(([key]) =>
        !['requestId', 'expectedStop', 'decisionRevision', 'originalProposalId'].includes(key)));
      const intent = kind === 'start' ? {} : decodeHumanIntent(kind, payload);
      let humanText = '';
      let answeredQuestion: ArbiterOperation['answeredQuestion'];

      if (kind === 'discuss') {
        const discussion = this.discussion(doc, intent);

        humanText = discussion.text;
        answeredQuestion = discussion.answeredQuestion;
      } else if (kind === 'diagnose') {
        const proposal = doc.result?.proposals.find((row) => row.id === intent.proposalId);

        if (!proposal || proposal.kind !== 'diagnose') {
          throw new ArbiterConversationError('proposal_unknown', 'Вариант диагностики уже недоступен.', 409);
        }

        humanText = `Дополнительная диагностика: ${proposal.diagnosticInstruction}`;
      }

      if (kind === 'apply') {
        return this.launchApply(doc, raw, fingerprint, capabilities);
      }

      const prepared = await this.deps.prepareRun(context);

      if (this.closed) {
        throw new ArbiterConversationError('server_restarting', 'Сервер завершает работу.', 503);
      }

      const operation = this.operation(kind, String(raw.requestId), fingerprint);
      const previous = doc.result;

      if (answeredQuestion) {
        operation.answeredQuestion = answeredQuestion;
      }

      doc = await this.store.update(task, doc.id, (latest) => {
        Object.assign(latest, invalidateDecision(latest));
        latest.state = 'analyzing';
        latest.automatic ||= automatic;
        latest.capabilities = capabilities;
        latest.operations.push(operation);

        if (!latest.messages.length) {
          addRunnerMessage(latest, 'node', context.sourceText);
          latest.messages.at(-1)!.sourceKind = context.targets
            .find((row) => row.node === context.identity.node)
            ?.executorKind;
        }

        if (humanText) {
          addRunnerMessage(latest, 'human', humanText, operation.id);
        }
      });

      const controller = new AbortController();

      if (this.closed) {
        controller.abort(new Error('Сервер завершает работу.'));
      }

      const doneLive = this.deps.live?.begin(
        task,
        {
          actor: automatic ? 'auto' : 'human',
          runId: operation.id
        }
      );
      const runDoc = { ...doc, result: previous };

      const completion = Promise.resolve().then(() => runArbiterConversation({
        store: this.store,
        doc: runDoc,
        context,
        operationId: operation.id,
        ...prepared,
        intent: kind,
        controller,
        timeoutMs: this.deps.turnTimeoutMs,
        readCurrent: () => this.deps.readContext(task),
      })).finally(() => {
        doneLive?.();
        this.jobs.delete(task);
      });

      this.track(task, controller, completion);

      return this.ack(doc, operation);
    });
  }

  /**
   * Исторический GET сохраняет read-only при изменении остановки.
   * Наблюдение принятого действия читает факты и не вызывает новую модель.
   */
  async snapshot(task: string, id: string, query: { afterSequence?: number; knownRevision?: number } = {}) {
    const doc = await this.store.read(task, id);

    if (!doc) {
      throw new ArbiterConversationError('not_found', 'Разбор не найден.', 404);
    }

    if (doc.state === 'analyzing' && !this.jobs.has(task) && !this.admissions.has(task)) {
      await this.interruptRead(doc, 'storage_failed',
        'Разбор прерван при сохранении. История доступна; повторите разбор явно.');
    }

    await this.deps.observe?.(doc);

    const current = await this.deps.readContext(task).catch(() => null);
    const snapshot = await this.store.snapshot(task, id, query);

    return snapshot ? {
      ...snapshot, readOnly: !sameStop(current?.identity, doc.identity)
        || ['resolved', 'stale'].includes(snapshot.state)
    } : null;
  }

  wait(task: string) {
    return this.jobs.get(task)?.completion || Promise.resolve();
  }

  /**
   * Закрытие процесса прерывает принадлежащие ему чтения, сохраняя историю.
   * Закрытие клиентского окна этот метод не вызывает.
   */
  async close() {
    this.closed = true;

    for (const job of this.jobs.values()) {
      job.controller.abort(new Error('Сервер завершает работу.'));
    }

    await Promise.allSettled([...this.jobs.values()].map((job) => job.completion));
  }

  /**
   * Вопрос и подпись выбранного ответа сохраняются вместе с ответом человека.
   * Старый id не может выбрать вариант из другого цикла решения.
   */
  private discussion(doc: ArbiterConversation, intent: Record<string, unknown>): {
    text: string;
    answeredQuestion?: ArbiterOperation['answeredQuestion'];
  } {
    if (typeof intent.text === 'string') {
      return { text: intent.text };
    }

    const question = doc.result?.questions.find((row) => row.id === intent.questionId);
    const answer = intent.customAnswer || question?.options.find((row) => row.id === intent.optionId)?.label;

    if (!question || typeof answer !== 'string') {
      throw new ArbiterConversationError('question_unknown', 'Вопрос или ответ уже недоступен.', 409);
    }

    return {
      text: `${question.text}\n\n${answer}`,
      answeredQuestion: {
        questionId: question.id,
        ...(typeof intent.optionId === 'string' ? { optionId: intent.optionId } : {}),
        question: question.text,
        answer,
      },
    };
  }

  private operation(kind: IntentKind, requestId: string, fingerprint: string): ArbiterOperation {
    const now = new Date().toISOString();

    return {
      id: randomUUID(),
      requestId,
      fingerprint,
      kind,
      outcome: 'running',
      createdAt: now,
      updatedAt: now
    };
  }

  private ack(doc: ArbiterConversation, operation: ArbiterOperation): ConversationAck {
    return {
      conversationId: doc.id,
      operationId: operation.id,
      revision: doc.revision,
      operation,
      completion: this.wait(doc.identity.task)
    };
  }

  private track(task: string, controller: AbortController, completion: Promise<void>) {
    this.jobs.set(task, { controller, completion });
    void completion.catch((error) => this.deps.onError?.(error));
  }

  /**
   * Сериализует проверку и приём запросов одной задачи, не удерживая очередь весь ход модели.
   * Завершение прежней admission не снимает более новый хвост.
   */
  private admit<T>(task: string, action: () => Promise<T>) {
    const previous = this.admissions.get(task) || Promise.resolve();
    const next = previous.then(action, action);

    this.admissions.set(task, next);
    void next.finally(() => {
      if (this.admissions.get(task) === next) {
        this.admissions.delete(task);
      }
    }).catch(() => { });

    return next;
  }

  /**
   * Проверяет явный выбор и сохраняет окончательное указание до запуска движка.
   * Неизвестный предыдущий исход закрывает повторное применение даже с новым UUID.
   */
  private async launchApply(
    doc: ArbiterConversation,
    raw: Record<string, unknown>,
    fingerprint: string,
    capabilities: ArbiterCapabilities,
  ): Promise<ConversationAck> {
    if (capabilities.status !== 'supported' || !this.deps.apply) {
      throw new ArbiterConversationError('runtime_unsupported', capabilities.message, 409);
    }

    if (doc.operations.some((row) => row.kind === 'apply'
      && ['unknown', 'accepted', 'resumed', 'resume_failed', 'running'].includes(row.outcome))) {
      throw new ArbiterConversationError(
        'apply_pending',
        'Предыдущее применение требует сверки, а не повтора.',
        409
      );
    }

    const proposalId = raw.originalProposalId || raw.proposalId;
    const proposal = doc.result?.proposals.find((row) => row.id === proposalId);

    if ((!raw.customAction || proposalId) && proposal?.kind !== 'apply') {
      throw new ArbiterConversationError('proposal_unknown', 'Предложение уже недоступно.', 409);
    }

    const action = decodeArbiterAction(
      raw.customAction
      || (proposal?.kind === 'apply' ? proposal.action : null),

      capabilities.targets,
      doc.identity.node
    );
    const operation = this.operation('apply', String(raw.requestId), fingerprint);

    operation.action = action;
    operation.reason = action.kind === 'retry_command'
      ? 'По выбору человека: повторить прежнюю проверку с теми же параметрами.'
      : action.instruction;
    operation.originalStage = {
      sequence: doc.identity.stageSequence,
      headEventHash: doc.identity.stageHeadHash
    };

    if (proposal) {
      operation.originalProposal = proposal;
    }

    doc = await this.store.update(doc.identity.task, doc.id, (latest) => {
      Object.assign(latest, invalidateDecision(latest));
      latest.capabilities = capabilities;
      latest.state = 'applying';
      latest.operations.push(operation);
      addRunnerMessage(latest, 'human', action.kind === 'retry_command'
        ? operation.reason! : action.instruction, operation.id);
    });

    return this.mutation(doc, operation, (controller) => this.deps.apply!(doc, operation, controller));
  }

  /**
   * Повтор запуска имеет собственную операцию, связанную с уже принятым решением.
   * Источник stop здесь не проверяется: его уже заменил готовый к запуску target.
   */
  private async launchResume(
    doc: ArbiterConversation,
    raw: Record<string, unknown>,
    fingerprint: string,
  ): Promise<ConversationAck> {
    await this.deps.validateResume?.(doc, raw);

    const operation = this.operation('resume', String(raw.requestId), fingerprint);

    operation.applyOperationId = arbiterText(raw.applyOperationId, 500);
    operation.acceptedEvent = decodeStageIdentity(raw.acceptedEvent);
    operation.expectedCurrentStage = decodeStageIdentity(raw.expectedCurrentStage);

    doc = await this.store.update(doc.identity.task, doc.id, (latest) => {
      latest.operations.push(operation);
    });

    return this.mutation(doc, operation, () => this.deps.resume!(doc, operation, raw));
  }

  /**
   * Мутация принадлежит сервису после durable ack и завершается сохранённым исходом.
   * Ошибка запуска не оживляет кнопку применения уже принятого решения.
   */
  private mutation(
    doc: ArbiterConversation,
    operation: ArbiterOperation,
    action: (controller: AbortController) => Promise<void>,
  ) {
    const task = doc.identity.task;
    const controller = new AbortController();
    let invoked = false;
    const completion = Promise.resolve().then(() => {
      if (this.closed || controller.signal.aborted) {
        throw new ArbiterConversationError('server_restarting', 'Сервер завершает работу.', 503);
      }

      invoked = true;

      return action(controller);
    }).catch(async (error: unknown) => {
      await this.store.update(task, doc.id, (latest) => {
        const saved = latest.operations.find((row) => row.id === operation.id)!;

        if (saved.outcome === 'running') {
          saved.outcome = operation.kind === 'apply' && invoked ? 'unknown' : 'failed';
          saved.error = error instanceof ArbiterConversationError ? error.code : 'operation_failed';

          if (operation.kind === 'apply' && !invoked) {
            latest.state = 'interrupted';
          }

          addRunnerMessage(
            latest,
            'system',
            'Не удалось подтвердить действие. Обновите состояние перед повтором.'
          );
        }
      });
    }).finally(() => this.jobs.delete(task));

    this.track(task, controller, completion);

    return this.ack(doc, operation);
  }
}
