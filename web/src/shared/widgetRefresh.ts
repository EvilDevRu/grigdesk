import { getActivePinia } from 'pinia';
import { useShellStore } from '../stores/shell.ts';

const MIN_INTERVAL_MS = 10000;
let lastSent = Number.NEGATIVE_INFINITY;
let pending: ReturnType<typeof setTimeout> | null = null;

/**
 * Канал принадлежит обнаруженной оболочке текущего документа.
 * В обычном браузере и до Pinia собственных запросов не возникает.
 */
export function pipelineWidgetSupported(): boolean {
  const pinia = getActivePinia();

  return Boolean(pinia && useShellStore(pinia).capabilities.includes('widget'));
}

/**
 * Первый сигнал отправляется сразу, остальные объединяются в один обязательный trailing.
 * Нативный requestId сохраняет сигнал и во время выполнения предыдущего запроса.
 */
export function refreshPipelineWidget(): void {
  if (!pipelineWidgetSupported()) {
    return;
  }

  const now = Date.now();
  const remaining = MIN_INTERVAL_MS - (now - lastSent);

  if (remaining > 0 && remaining <= MIN_INTERVAL_MS) {
    if (pending === null) {
      pending = setTimeout(() => {
        pending = null;
        refreshPipelineWidget();
      }, remaining);
    }

    return;
  }

  if (pending !== null) {
    clearTimeout(pending);
    pending = null;
  }

  lastSent = now;

  void fetch('/__shell/widget-refresh', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).catch(() => {});
}

/**
 * Таймер принадлежит AppShell: после размонтирования старый документ не шлёт сигналов.
 * Следующее монтирование снова допускает первое немедленное обновление.
 */
export function disposePipelineWidgetRefresh(): void {
  if (pending !== null) {
    clearTimeout(pending);
    pending = null;
  }

  lastSent = Number.NEGATIVE_INFINITY;
}
