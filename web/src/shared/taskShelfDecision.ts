// Единственное решение полки: нормализует доступные источники, строит новый снимок
// и называет наступившее событие. Панель, чип и оповещение получают уже готовый row.

import { objectOrEmpty } from '../../../shared/lib/objects.ts';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from './uiLocalePort.ts';

const t = localeTranslator(uiLocalePort);

const TERMINAL_ANALYSIS = new Set(['done', 'finished', 'failed', 'interrupted']);
const TERMINAL_TRACKER = new Set(['completed', 'done', 'closed']);

// Наблюдаемый снимок мягче серверного: живой источник может назвать состояние, которого
// контракт не знает, и решателю важно не потерять сам факт наблюдения.
export interface ShelfObservedAnalysis {
  state: string | null;
  queuedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  generatedAt: string | null;
}

export interface ShelfObservedPipeline {
  attempt: string | null;
  daemon: string | null;
  result: string | null;
  stall: string | null;
  gateKnown: boolean;
  gate: string | null;
}

export interface ShelfObservedTracker {
  present: boolean;
  status: string | null;
  statusKind: string | null;
  unread: number;
}

export interface ShelfObservedSnapshot {
  analysis: ShelfObservedAnalysis | null;
  pipeline: ShelfObservedPipeline | null;
  b24: ShelfObservedTracker | null;
}

export type ShelfEventSource = 'analysis' | 'pipeline' | 'b24' | 'comments' | null;

export interface ShelfDecision {
  state: 'lit' | 'neutral';
  source: ShelfEventSource;
  message: string;
  fingerprint: string;
  snapshot: ShelfObservedSnapshot;
  reasonText: string;
}

// Уже замеченное событие приходит обратно из runtime карточки: полей у него больше,
// решателю нужны только эти четыре.
export interface ShelfLatchedEvent {
  state?: string | null;
  source?: unknown;
  message?: unknown;
  fingerprint?: unknown;
}

export interface ShelfDecisionInput {
  snapshot?: unknown;
  observed?: unknown;
  reason?: string;
  latched?: ShelfLatchedEvent | null;
}

/**
 * Узнаёт завершённую B24-задачу по живому статусу или подтверждённому уходу с доски.
 * Недоступный источник сюда не попадает: вызывающая сторона подставляет durable snapshot.
 */
export function isShelfTaskCompleted(value: ShelfObservedTracker | null | undefined): boolean {
  const kind = value?.statusKind;

  return value?.present === false || (typeof kind === 'string' && TERMINAL_TRACKER.has(kind));
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Время триажа — миллисекунды. Читать его строкой нельзя: у двух подряд неудачных
 * оценок отпечаток тогда совпадает, и на вторую карточка уже не загорается. Снимок
 * вкладки переживает обновление, поэтому строки прошлого формата тоже принимаются.
 */
function moment(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;

  return Number.isFinite(parsed) ? parsed : null;
}

function count(value: unknown): number {
  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function analysisSnapshot(value: unknown): ShelfObservedAnalysis | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = objectOrEmpty(value);

  return {
    state: text(source.state),
    queuedAt: moment(source.queuedAt),
    startedAt: moment(source.startedAt),
    finishedAt: moment(source.finishedAt),
    generatedAt: text(source.generatedAt),
  };
}

function pipelineSnapshot(value: unknown): ShelfObservedPipeline | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = objectOrEmpty(value);

  return {
    attempt: text(source.attempt),
    daemon: text(source.daemon),
    result: text(source.result),
    stall: text(source.stall),
    gateKnown: source.gateKnown === true,
    gate: text(source.gate),
  };
}

function trackerSnapshot(value: unknown): ShelfObservedTracker | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = objectOrEmpty(value);

  return {
    present: source.present === true,
    status: text(source.status),
    statusKind: text(source.statusKind),
    unread: count(source.unread),
  };
}

function normalized(value: unknown): ShelfObservedSnapshot {
  const source = objectOrEmpty(value);

  return {
    analysis: analysisSnapshot(source.analysis),
    pipeline: pipelineSnapshot(source.pipeline),
    b24: trackerSnapshot(source.b24),
  };
}

function event(
  state: 'lit' | 'neutral',
  source: ShelfEventSource,
  message: string,
  fingerprint: string,
  snapshot: ShelfObservedSnapshot,
  reasonText: string,
): ShelfDecision {
  return {
    state,
    source,
    message,
    fingerprint,
    snapshot,
    reasonText,
  };
}

/**
 * Называет то, чего карточка ждёт прямо сейчас. Живое наблюдение важнее причины
 * постановки: она лишь запасной текст, когда ни один источник ничего не обещает.
 *
 * Ворота и затык проверяются раньше result, и это не вкусовщина. result и gate
 * приезжают из разных источников — сводки прогона и разобранного графа, — поэтому
 * спокойно сосуществуют: прогон доехал до узла человека и закрылся, а сами ворота
 * остались открытыми. Со старым порядком карточка писала «жду ответ в задаче» ровно
 * там, где конвейер ждал решения, и спорила сама с собой: строка активности конвейера
 * называет ворота первыми. Порядок здесь обязан совпадать с pipelineActivity в сторе.
 */
function waitingText(reason: string, current: ShelfObservedSnapshot): string {
  const analysisState = current.analysis?.state;
  const pipeline = current.pipeline;

  if (pipeline?.attempt && pipeline.gate) {
    return t('core.coreZhduMoegoResheniya');
  }
  if (pipeline?.attempt && pipeline.stall) {
    return t('core.pipelineKonveyerVstal');
  }
  if (analysisState === 'queued' || analysisState === 'running') {
    return t('core.taskZhduOtsenku');
  }
  if (pipeline?.attempt && !pipeline.result && pipeline.daemon === 'running') {
    return t('core.taskZhduKonveyer');
  }
  if (pipeline?.attempt && pipeline.result && current.b24?.present) {
    return t('core.taskZhduOtvetVZadache');
  }

  const byReason: Record<string, string> = {
    manual: t('core.taskNablyudayuVruchnuyu'),
    analysis: t('core.taskZhduOtsenku'),
    pipeline: t('core.taskZhduKonveyer'),
    comments: t('core.taskZhduOtvetVZadache'),
  };

  return byReason[reason] || t('core.taskNablyudayuVruchnuyu');
}

/**
 * Сравнивает только известные обеим сторонам данные. Первое появление источника
 * обновляет candidate snapshot, но не изображает событие; недоступность сохраняет базу.
 */
export default function taskShelfDecision({
  snapshot,
  observed,
  reason = 'manual',
  latched = null,
}: ShelfDecisionInput): ShelfDecision {
  const before = normalized(snapshot);
  const current = normalized(observed);
  const candidate: ShelfObservedSnapshot = {
    analysis: current.analysis || before.analysis,
    pipeline: current.pipeline || before.pipeline,
    b24: current.b24 || before.b24,
  };
  const reasonText = waitingText(reason, current);

  if (before.analysis && current.analysis
    && current.analysis.state && TERMINAL_ANALYSIS.has(current.analysis.state)
    && JSON.stringify(before.analysis) !== JSON.stringify(current.analysis)) {
    const messages: Record<string, string> = {
      done: t('core.taskOtsenkaGotova'),
      finished: t('core.taskOtsenkaGotova'),
      failed: t('core.taskOtsenkaZavershilasSOshibkoy'),
      interrupted: t('core.taskOtsenkaBylaPrervana'),
    };
    const fingerprint = [
      'analysis',
      current.analysis.state,
      current.analysis.finishedAt,
      current.analysis.generatedAt,
    ].join(':');

    return event(
      'lit',
      'analysis',
      messages[current.analysis.state] ?? '',
      fingerprint,
      candidate,
      reasonText,
    );
  }

  const beforePipeline = before.pipeline;
  const currentPipeline = current.pipeline;
  const sameAttempt = Boolean(beforePipeline && currentPipeline
    && beforePipeline.attempt === currentPipeline.attempt);

  if (sameAttempt && beforePipeline && currentPipeline) {
    if (beforePipeline.gateKnown && currentPipeline.gateKnown
      && currentPipeline.gate && currentPipeline.gate !== beforePipeline.gate) {
      return event(
        'lit',
        'pipeline',
        t('core.coreKonveyerZhdetResheniyaGate', { gate: currentPipeline.gate }),
        `pipeline:gate:${currentPipeline.attempt}:${currentPipeline.gate}`,
        candidate,
        reasonText,
      );
    }
    if (currentPipeline.stall && currentPipeline.stall !== beforePipeline.stall) {
      return event(
        'lit',
        'pipeline',
        t('core.coreKonveyerOstanovilsyaStall', { stall: currentPipeline.stall }),
        `pipeline:stall:${currentPipeline.attempt}:${currentPipeline.stall}`,
        candidate,
        reasonText,
      );
    }
    if (currentPipeline.result && currentPipeline.result !== beforePipeline.result) {
      const message = currentPipeline.result === 'completed'
        ? t('core.taskProgonKonveyeraZavershen')
        : t('core.taskProgonKonveyeraZavershenResult', { result: currentPipeline.result });

      return event(
        'lit',
        'pipeline',
        message,
        `pipeline:result:${currentPipeline.attempt}:${currentPipeline.result}`,
        candidate,
        reasonText,
      );
    }
  }

  if (before.b24 && current.b24 && current.b24.unread > before.b24.unread) {
    const growth = current.b24.unread - before.b24.unread;

    return event(
      'lit',
      'comments',
      t('core.coreNovyeKommentariiGrowth', { growth: growth }),
      `comments:${current.b24.unread}`,
      candidate,
      reasonText,
    );
  }

  const closed = before.b24 && current.b24
    && ((before.b24.present && !current.b24.present)
      || (current.b24.present
        && !TERMINAL_TRACKER.has(String(before.b24.statusKind))
        && TERMINAL_TRACKER.has(String(current.b24.statusKind))));

  if (closed) {
    return event(
      'lit',
      'b24',
      t('core.coreZadachaZavershenaIliZakryta'),
      `b24:closed:${current.b24?.status || 'absent'}`,
      candidate,
      reasonText,
    );
  }

  // Огонёк снимает только acknowledge карточки. Временная недоступность источника
  // не превращает уже замеченное событие обратно в нейтральное состояние.
  if (latched?.state === 'lit') {
    return event(
      'lit',
      latchedSource(latched.source),
      text(latched.message) || '',
      text(latched.fingerprint) || '',
      candidate,
      reasonText,
    );
  }

  return event('neutral', null, '', '', candidate, reasonText);
}

function latchedSource(value: unknown): ShelfEventSource {
  return value === 'analysis' || value === 'pipeline' || value === 'b24' || value === 'comments'
    ? value
    : null;
}
