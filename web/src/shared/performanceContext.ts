let enabled = false;
let surface: number | undefined;
let policyEpoch = 0;
const policyListeners = new Set<() => void>();

/**
 * Уровень хранится только в памяти текущего документа и следует общему журналу.
 * Выключение сбрасывает контекст, чтобы новый период не захватил старое открытие.
 */
export function setPerformancePolicy(value: boolean): void {
  policyEpoch += 1;
  enabled = value;

  if (!value) {
    surface = undefined;
  }

  for (const listener of policyListeners) {
    try {
      listener();
    } catch {
      /* диагностический слушатель не меняет общую политику */
    }
  }
}

/**
 * Возвращает поколение общей политики документа.
 * Старые callbacks сравнивают его перед записью результата.
 */
export function performanceEpoch(): number {
  return policyEpoch;
}

/**
 * Документные наблюдатели освобождают ожидания при смене поколения политики.
 * Подписчик не получает конфигурацию или доступ к данным приложения.
 */
export function onPerformancePolicy(listener: () => void): () => void {
  policyListeners.add(listener);

  return () => policyListeners.delete(listener);
}

/**
 * Возвращает действующее разрешение подробных замеров.
 * До подтверждения политики оно остаётся выключенным.
 */
export function performanceEnabled(): boolean {
  return enabled;
}

/**
 * Это контекст вызова запроса, а не доказательство причинности операции.
 * Число никогда не заменяет session/auth или реальный идентификатор данных.
 */
export function setPerformanceSurface(value?: number): void {
  surface = value;
}

/**
 * Возвращает номер текущего незавершённого открытия.
 * После завершения всех поверхностей запросы учитываются в фоне.
 */
export function performanceSurface(): number | undefined {
  return surface;
}
