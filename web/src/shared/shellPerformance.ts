import { onPerformancePolicy, performanceEnabled, performanceEpoch } from './performanceContext.ts';
import { recordWebDiagnostic } from './webDiagnostics.ts';
import type { WebLogData } from '../../../shared/web-log/webLogContracts.ts';

const active = new Set<() => void>();

// Один подписчик живёт с документом; он не удерживает завершённые команды.
onPerformancePolicy(() => {
  for (const cancel of [...active]) {
    cancel();
  }
});

/**
 * Shell передаёт только закрытое имя команды и длительность.
 * URL, body, строка привязки, результат и сообщения исключений не читаются.
 */
export function startShellPerformance(operation: WebLogData['perf.shell']['operation']) {
  if (!performanceEnabled() || active.size >= 128) {
    return (_success: boolean) => {};
  }

  const start = performance.now();
  const epoch = performanceEpoch();
  let done = false;
  const timer = setTimeout(() => {
    if (!done && epoch === performanceEpoch() && performanceEnabled()) {
      recordWebDiagnostic('perf.shell', {
        operation,
        phase: 'pending',
        ms: Math.max(0, performance.now() - start),
      });
    }
  }, 3000);

  /**
   * Отмена диагностики снимает таймер, не отменяя сам native запрос.
   * Set ограничивает и команды, уже успевшие отправить единственный pending.
   */
  function cancel(): void {
    done = true;
    clearTimeout(timer);
    active.delete(cancel);
  }

  active.add(cancel);

  return (success: boolean): void => {
    if (!done && epoch === performanceEpoch() && performanceEnabled()) {
      recordWebDiagnostic('perf.shell', {
        operation,
        phase: success ? 'success' : 'error',
        ms: Math.max(0, performance.now() - start),
      });
    }

    cancel();
  };
}
