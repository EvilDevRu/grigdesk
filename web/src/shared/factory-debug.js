import { DIAGNOSTIC_LEVELS } from '../../../shared/diagnosticLogging.ts';

const LABELS = {
  off: 'Выключено',
  errors: 'Только ошибки',
  decisions: 'Ошибки и контекст',
  verbose: 'Подробно',
};

export const FACTORY_DEBUG_LEVELS = Object.freeze(DIAGNOSTIC_LEVELS.map((value) => ({
  value,
  label: LABELS[value],
})));

const VALUES = new Set(FACTORY_DEBUG_LEVELS.map((item) => item.value));

export function factoryDebugPayload(level) {
  if (!VALUES.has(level)) throw new Error('Неизвестный уровень диагностического логирования.');
  return { scope: 'global', level };
}
