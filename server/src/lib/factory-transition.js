export class ManualStageTransitionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ManualStageTransitionError';
    this.code = code;
  }
}

/**
 * Формирует атомарную команду ручного перехода.
 *
 * `KEY=running` сам по себе не будит gate_wait и создаёт ложный активный узел.
 * Поэтому возврат разрешён только от реально ожидающих ворот и передаётся движку
 * через REWIND_STAGE: уже движок знает маршрут и сбрасывает весь хвост.
 */
export function manualStageTransitionPairs({ registry, stages, key, status }) {
  if (status !== 'running') return [key, status];

  const stageIndex = stages.indexOf(key);
  if (stageIndex < 0) {
    throw new ManualStageTransitionError('stage_outside_route', `Этап ${key} не входит в активный маршрут`);
  }

  const gateIndex = stages.findIndex((stage) => (
    stage.startsWith('GATE_') && registry[stage] === 'waiting'
  ));
  if (gateIndex < 0) {
    throw new ManualStageTransitionError(
      'pipeline_not_waiting',
      'Ручной возврат безопасен только когда конвейер ждёт решения на воротах',
    );
  }
  if (stageIndex >= gateIndex) {
    throw new ManualStageTransitionError(
      'stage_after_gate',
      `Вернуться можно только на этап перед ожидающими воротами ${stages[gateIndex]}`,
    );
  }

  return [key, 'running', 'REWIND_STAGE', key];
}
