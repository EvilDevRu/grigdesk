import {
  ArbiterConversationError,
  decodeStageIdentity,
} from '../../../shared/pipeline/arbiterConversation.ts';
import type {
  ArbiterAction,
  ArbiterConversation,
  ArbiterOperation,
  ApplyReceipt,
  StageIdentity,
  StopIdentity,
} from '../../../shared/pipeline/arbiterConversation.ts';
import { readFactoryStageEvents } from './factoryAttemptLedger.ts';
import type { readFactoryAttemptLedger, FactoryStageEvent } from './factoryAttemptLedger.ts';
import { addRunnerMessage } from './arbiterConversationRunner.ts';
import type { ArbiterConversationStore } from './arbiterConversationStore.ts';

type Trusted = Awaited<ReturnType<typeof readFactoryAttemptLedger>>;

const VISIT_RESULTS = new Set(['commit', 'no-progress', 'rewind-limit', 'loop-ceiling']);

function isVisitResult(event: FactoryStageEvent, target: string) {
  return event.node === target && VISIT_RESULTS.has(event.kind);
}

interface ApplyDeps {
  store: ArbiterConversationStore;
  controlDir: string;
  readTrusted: (task: string) => Promise<Trusted>;
  goto: (
    identity: StopIdentity,
    action: ArbiterAction,
    reason: string,
    expected: StageIdentity
  ) => Promise<unknown>;
  resume: (trusted: Trusted) => Promise<{ ok: boolean; message?: string }>;
  running: (trusted: Trusted, receipt: ApplyReceipt) => Promise<boolean>;
  handoff?: (task: string) => () => void;
}

/**
 * Доказательством служит точный соседний human-rewind, а не сходство текущего курсора.
 * Одна проверка применяется при потере ответа goto и перед повтором запуска по receipt.
 */
function matchesApplyEvent(event: FactoryStageEvent | undefined, operation: ArbiterOperation) {
  return Boolean(event?.kind === 'human-rewind'
    && event.sequence === operation.originalStage!.sequence + 1
    && event.previousEventHash === operation.originalStage!.headEventHash
    && event.node === operation.action?.targetNode
    && event.action.rewind === operation.action.targetNode
    && event.reason === operation.reason
    && (event.actor ?? 'human') === 'human');
}

export class ArbiterConversationApply {
  private readonly deps: ApplyDeps;

  constructor(deps: ApplyDeps) {
    this.deps = deps;
  }

  /**
   * Durable intent уже сохранён сервисом; команда всегда несёт исходный expected head.
   * Любой ответ процесса, включая timeout, проверяется по exact immutable событию.
   */
  async apply(doc: ArbiterConversation, operation: ArbiterOperation) {
    const doneHandoff = this.deps.handoff?.(doc.identity.task);

    try {
      try {
        await this.deps.goto(doc.identity, operation.action!, operation.reason!, operation.originalStage!);
      } catch {
        // Потерянный ответ не доказывает отсутствия записи: ниже обязательная сверка.
      }

      const receipt = await this.reconcile(doc, operation);

      if (receipt) {
        await this.resumeAccepted(doc, operation.id);
      }
    } finally {
      doneHandoff?.();
    }
  }

  /**
   * После сбоя незавершённое применение только сверяется, без второго goto или автозапуска.
   * Неизвестный результат закрывает повтор движения до получения доказательства.
   */
  async recover(doc: ArbiterConversation) {
    const operation = [...doc.operations].reverse().find((row) => row.kind === 'apply'
      && ['running', 'queued', 'unknown', 'accepted'].includes(row.outcome));

    if (operation) {
      await this.reconcile(doc, operation);
    }
  }

  /**
   * Сверяет reason, actor, target и previousEventHash события sequence+1.
   * Более поздние корректные события сохраняют доказательство уже принятого решения.
   */
  private async reconcile(doc: ArbiterConversation, operation: ArbiterOperation) {
    let receipt: ApplyReceipt | null = null;
    let superseded = false;

    try {
      const trusted = await this.deps.readTrusted(doc.identity.task);

      if (trusted.attempt !== doc.identity.attempt || trusted.profile !== doc.identity.profile) {
        superseded = true;
      } else {
        const events = await readFactoryStageEvents(this.deps.controlDir, trusted);
        const event = events.find((row) => row.sequence === operation.originalStage!.sequence + 1);

        if (event && matchesApplyEvent(event, operation)) {
          receipt = {
            stage: { sequence: event.sequence, headEventHash: event.eventHash },
            originalStage: operation.originalStage!,
            targetNode: event.node,
            reason: event.reason!,
          };
        } else if (event) {
          superseded = true;
        }
      }
    } catch {
      // Отказ trusted-чтения оставляет unknown; автоматического повтора команды нет.
    }

    const latestDoc = await this.deps.store.read(doc.identity.task, doc.id);
    const previous = latestDoc?.operations.find((row) => row.id === operation.id);
    const outcome = receipt ? 'accepted' : superseded ? 'failed' : 'unknown';

    if (previous?.outcome === outcome && (outcome !== 'accepted' || previous.receipt)) {
      return receipt;
    }

    await this.deps.store.update(doc.identity.task, doc.id, (latest) => {
      const saved = latest.operations.find((row) => row.id === operation.id)!;

      saved.updatedAt = new Date().toISOString();

      if (receipt) {
        saved.receipt = receipt;
        saved.outcome = 'accepted';
        saved.observation = 'waiting';
        latest.state = 'resolved';
        addRunnerMessage(latest, 'system',
          'Указание принято и записано. Результат этапа ещё ожидается; можно продолжить запуск.', saved.id);
      } else {
        saved.outcome = superseded ? 'failed' : 'unknown';
        saved.error = superseded ? 'stale_stop' : 'acceptance_unknown';
        latest.state = superseded ? 'stale' : 'interrupted';
        addRunnerMessage(latest, 'system', superseded
          ? 'Конвейер уже изменился; это указание не подтверждено. Откройте текущую остановку.'
          : ("Не удалось подтвердить, принято ли решение. Проверьте состояние; применение " +
            "и запуск пока закрыты."),
          saved.id);
      }
    });

    return receipt;
  }

  /**
   * Повтор запуска адресует принятое событие и ready cursor, а не прежнюю остановку.
   * Уже работающий или завершившийся визит никогда не запускается повторно.
   */
  async validateResume(doc: ArbiterConversation, payload: Record<string, unknown>) {
    const apply = doc.operations.find((row) => row.id === payload.applyOperationId && row.kind === 'apply');
    const accepted = decodeStageIdentity(payload.acceptedEvent);
    const expected = decodeStageIdentity(payload.expectedCurrentStage);

    if (!apply?.receipt || !['accepted', 'resume_failed', 'resumed'].includes(apply.outcome)
      || accepted.sequence !== apply.receipt.stage.sequence
      || accepted.headEventHash !== apply.receipt.stage.headEventHash) {
      throw new ArbiterConversationError('receipt_unknown', 'Принятие этого решения не подтверждено.', 409);
    }

    const trusted = await this.deps.readTrusted(doc.identity.task);

    if (trusted.attempt !== doc.identity.attempt || trusted.profile !== doc.identity.profile) {
      throw new ArbiterConversationError('stale_resume', 'Текущая попытка уже изменилась.', 409);
    }

    const events = await readFactoryStageEvents(this.deps.controlDir, trusted);
    const acceptedEvent = events.find((event) => event.sequence === apply.receipt!.stage.sequence);
    const after = events.filter((row) => row.sequence > apply.receipt!.stage.sequence);

    if (!matchesApplyEvent(acceptedEvent, apply)
      || acceptedEvent?.eventHash !== apply.receipt.stage.headEventHash) {
      throw new ArbiterConversationError(
        'receipt_unknown',
        'Принятое событие не подтверждено журналом.',
        409
      );
    }

    if (after.some((row) => row.kind === 'human-rewind')) {
      throw new ArbiterConversationError('stale_resume', 'Конвейер уже изменён другим действием.', 409);
    }

    if (after.some((row) => isVisitResult(row, apply.receipt!.targetNode))) {
      return;
    }

    if (!trusted.stageIdentity
      || trusted.stageIdentity.sequence !== expected.sequence
      || trusted.stageIdentity.headEventHash !== expected.headEventHash) {
      await this.observe(doc);

      throw new ArbiterConversationError(
        'stale_resume',
        'Состояние запуска уже изменилось. Обновите историю.',
        409
      );
    }

  }

  /**
   * Новый запрос resume повторяет только запуск доказанного принятого действия.
   * Сверка сохранённого receipt выполняется и до ack, и перед эффектом job.
   */
  async resume(doc: ArbiterConversation, operation: ArbiterOperation, payload: Record<string, unknown>) {
    await this.validateResume(doc, payload);
    await this.resumeAccepted(doc, String(payload.applyOperationId), operation.id);
  }

  /**
   * Только доказанный receipt разрешает resume, его отказ сохраняет само решение.
   * Ready без live/lifecycle подтверждения остаётся ожиданием, а не успешным запуском.
   */
  private async resumeAccepted(doc: ArbiterConversation, applyId: string, resumeId?: string) {
    const latest = await this.deps.store.read(doc.identity.task, doc.id);
    const apply = latest?.operations.find((row) => row.id === applyId);

    if (!apply?.receipt) {
      throw new ArbiterConversationError('receipt_unknown', 'Принятие решения не подтверждено.', 409);
    }

    const trusted = await this.deps.readTrusted(doc.identity.task);
    const events = await readFactoryStageEvents(this.deps.controlDir, trusted);
    const after = events.filter((row) => row.sequence > apply.receipt!.stage.sequence);

    if (trusted.attempt !== doc.identity.attempt || after.some((row) => row.kind === 'human-rewind')
      || after.some((row) => isVisitResult(row, apply.receipt!.targetNode))
      || trusted.terminal) {
      await this.observe(latest!);

      if (resumeId) {
        await this.deps.store.update(doc.identity.task, doc.id, (current) => {
          const saved = current.operations.find((row) => row.id === resumeId)!;

          saved.outcome = 'completed';
          saved.updatedAt = new Date().toISOString();
        });
      }

      return;
    }

    let launched = await this.deps.running(trusted, apply.receipt);
    let reason = '';

    if (!launched) {
      if (trusted.cursor?.state !== 'ready' || trusted.cursor.node !== apply.receipt.targetNode
        || trusted.stageIdentity?.sequence !== apply.receipt.stage.sequence
        || trusted.stageIdentity.headEventHash !== apply.receipt.stage.headEventHash) {
        throw new ArbiterConversationError(
          'stale_resume',
          'Курсор уже не ожидает запуска выбранного этапа.',
          409
        );
      }

      const result = await this.deps.resume(trusted).catch((error: unknown) => ({
        ok: false, message: error instanceof Error ? error.message : 'Запуск не подтверждён.',
      }));
      const fresh = await this.deps.readTrusted(doc.identity.task);

      launched = result.ok && await this.deps.running(fresh, apply.receipt);
      reason = result.message || 'Запуск выбранного этапа пока не подтверждён.';
    }

    await this.deps.store.update(doc.identity.task, doc.id, (current) => {
      const saved = current.operations.find((row) => row.id === applyId)!;

      saved.outcome = launched ? 'resumed' : 'resume_failed';
      saved.observation = launched ? 'running' : 'waiting';
      saved.updatedAt = new Date().toISOString();

      if (resumeId) {
        const resume = current.operations.find((row) => row.id === resumeId)!;

        resume.outcome = saved.outcome;
        resume.updatedAt = saved.updatedAt;
      }

      addRunnerMessage(current, 'system', launched
        ? 'Этап запущен повторно; результат ещё ожидается. Результаты следующих этапов будут пересчитаны.'
        : `Указание принято, но этап пока не запущен: ${reason} Можно повторить только запуск.`, resumeId
      || applyId);
    });
    await this.observe((await this.deps.store.read(doc.identity.task, doc.id))!);
  }

  /**
   * Первый результат выбранного узла, включая остановку сторожа, доказывает исход визита.
   * Чужой последующий rewind закрывает наблюдение и не приписывается этому решению.
   */
  async observe(doc: ArbiterConversation) {
    const apply = [...doc.operations].reverse().find((row) => row.kind === 'apply' && row.receipt);

    if (!apply?.receipt || ['completed', 'stopped', 'superseded'].includes(apply.observation || '')) {
      return;
    }

    const trusted = await this.deps.readTrusted(doc.identity.task);
    const events = await readFactoryStageEvents(this.deps.controlDir, trusted);
    const after = events.filter((row) => row.sequence > apply.receipt!.stage.sequence);
    const event = after.find((row) => row.kind === 'human-rewind'
      || isVisitResult(row, apply.receipt!.targetNode));

    if (!event && trusted.attempt === doc.identity.attempt) {
      return;
    }

    const superseded = trusted.attempt !== doc.identity.attempt || event?.kind === 'human-rewind';
    const stop = event?.kind && ['no-progress', 'rewind-limit', 'loop-ceiling'].includes(event.kind)
      ? event.kind : event?.action.stop;
    const stopped = Boolean(stop && stop !== 'done');

    await this.deps.store.update(doc.identity.task, doc.id, (latest) => {
      const saved = latest.operations.find((row) => row.id === apply.id)!;

      saved.observation = superseded ? 'superseded' : stopped ? 'stopped' : 'completed';
      saved.observedSequence = event?.sequence;

      if (stopped && event) {
        saved.nextStop = {
          ...doc.identity,
          node: event.node,
          stop: stop!,
          stageSequence: event.sequence,
          stageHeadHash: event.eventHash
        };
      }

      addRunnerMessage(latest, 'system', superseded
        ? 'После этого решения конвейер изменён другим действием; наблюдение этого запуска завершено.'
        : stopped ? 'Повторённый этап снова остановился. Откройте разбор новой остановки.'
          : 'Этап завершён, конвейер продолжает работу. Итог всей задачи ещё не подтверждён.', apply.id);
    });
  }
}
