// Единственное решение полки: нормализует доступные источники, строит новый снимок
// и называет наступившее событие. Панель, чип и оповещение получают уже готовый row.
const TERMINAL_ANALYSIS = new Set(['finished', 'failed', 'interrupted']);
const TERMINAL_B24 = new Set(['completed', 'done', 'closed']);

function text(value) {
  return typeof value === 'string' && value ? value : null;
}

function count(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function analysisSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    state: text(value.state),
    queuedAt: text(value.queuedAt),
    startedAt: text(value.startedAt),
    finishedAt: text(value.finishedAt),
    generatedAt: text(value.generatedAt),
  };
}

function pipelineSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    attempt: text(value.attempt),
    daemon: text(value.daemon),
    result: text(value.result),
    stall: text(value.stall),
    gateKnown: value.gateKnown === true,
    gate: text(value.gate),
  };
}

function b24Snapshot(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    present: value.present === true,
    status: text(value.status),
    statusKind: text(value.statusKind),
    unread: count(value.unread),
  };
}

function normalized(value) {
  return {
    analysis: analysisSnapshot(value?.analysis),
    pipeline: pipelineSnapshot(value?.pipeline),
    b24: b24Snapshot(value?.b24),
  };
}

function event(state, source, message, fingerprint, snapshot, reasonText) {
  return { state, source, message, fingerprint, snapshot, reasonText };
}

function waitingText(reason, current) {
  if (['queued', 'running'].includes(current.analysis?.state)) return 'Жду оценку';
  if (current.pipeline?.attempt && !current.pipeline.result
    && (current.pipeline.daemon === 'running'
      || current.pipeline.gate
      || current.pipeline.stall)) {
    return 'Жду конвейер';
  }
  if (current.pipeline?.attempt && current.pipeline.result && current.b24?.present) {
    return 'Жду ответ в задаче';
  }
  return {
    manual: 'Просто веду',
    analysis: 'Жду оценку',
    pipeline: 'Жду конвейер',
    comments: 'Жду ответ в задаче',
  }[reason] || 'Просто веду';
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
}) {
  const before = normalized(snapshot);
  const current = normalized(observed);
  const candidate = {
    analysis: current.analysis || before.analysis,
    pipeline: current.pipeline || before.pipeline,
    b24: current.b24 || before.b24,
  };
  const reasonText = waitingText(reason, current);

  if (before.analysis && current.analysis
    && TERMINAL_ANALYSIS.has(current.analysis.state)
    && JSON.stringify(before.analysis) !== JSON.stringify(current.analysis)) {
    const messages = {
      finished: 'Оценка готова',
      failed: 'Оценка завершилась с ошибкой',
      interrupted: 'Оценка была прервана',
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
      messages[current.analysis.state],
      fingerprint,
      candidate,
      reasonText,
    );
  }

  const sameAttempt = before.pipeline && current.pipeline
    && before.pipeline.attempt === current.pipeline.attempt;
  if (sameAttempt && before.pipeline.gateKnown && current.pipeline.gateKnown
    && current.pipeline.gate && current.pipeline.gate !== before.pipeline.gate) {
    return event(
      'lit',
      'pipeline',
      `Конвейер ждёт решения: ${current.pipeline.gate}`,
      `pipeline:gate:${current.pipeline.attempt}:${current.pipeline.gate}`,
      candidate,
      reasonText,
    );
  }
  if (sameAttempt && current.pipeline.stall
    && current.pipeline.stall !== before.pipeline.stall) {
    return event(
      'lit',
      'pipeline',
      `Конвейер остановился: ${current.pipeline.stall}`,
      `pipeline:stall:${current.pipeline.attempt}:${current.pipeline.stall}`,
      candidate,
      reasonText,
    );
  }
  if (sameAttempt && current.pipeline.result
    && current.pipeline.result !== before.pipeline.result) {
    const message = current.pipeline.result === 'completed'
      ? 'Прогон конвейера завершён'
      : `Прогон конвейера завершён: ${current.pipeline.result}`;
    return event(
      'lit',
      'pipeline',
      message,
      `pipeline:result:${current.pipeline.attempt}:${current.pipeline.result}`,
      candidate,
      reasonText,
    );
  }

  if (before.b24 && current.b24 && current.b24.unread > before.b24.unread) {
    const growth = current.b24.unread - before.b24.unread;
    return event(
      'lit',
      'comments',
      `Новые комментарии: ${growth}`,
      `comments:${current.b24.unread}`,
      candidate,
      reasonText,
    );
  }
  const closed = before.b24 && current.b24
    && ((before.b24.present && !current.b24.present)
      || (current.b24.present
        && !TERMINAL_B24.has(before.b24.statusKind)
        && TERMINAL_B24.has(current.b24.statusKind)));
  if (closed) {
    return event(
      'lit',
      'b24',
      'Задача завершена или закрыта',
      `b24:closed:${current.b24.status || 'absent'}`,
      candidate,
      reasonText,
    );
  }

  // Огонёк снимает только acknowledge карточки. Временная недоступность источника
  // не превращает уже замеченное событие обратно в нейтральное состояние.
  if (latched?.state === 'lit') {
    return event(
      'lit',
      text(latched.source),
      text(latched.message) || '',
      text(latched.fingerprint) || '',
      candidate,
      reasonText,
    );
  }

  return event('neutral', null, '', '', candidate, reasonText);
}
