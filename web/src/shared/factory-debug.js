export const FACTORY_DEBUG_LEVELS = Object.freeze([
  { value: 'off', label: 'Выключено' },
  { value: 'errors', label: 'Только ошибки' },
  { value: 'decisions', label: 'Решения маршрутизации' },
  { value: 'verbose', label: 'Подробно' },
]);

const VALUES = new Set(FACTORY_DEBUG_LEVELS.map((item) => item.value));

export function factoryDebugPayload(level) {
  if (!VALUES.has(level)) throw new Error('Неизвестный уровень диагностического логирования.');
  return { scope: 'global', level };
}
