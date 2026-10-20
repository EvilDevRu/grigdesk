import type { ShellState } from '../../../shared/client/clientShell.ts';

/**
 * API оболочки не проходит через журнал прикладного API: строка привязки секретна.
 * Детектор допускает только JSON с числовой ревизией, не SPA-fallback Vite.
 */
export async function readShellState(rev?: number, signal?: AbortSignal): Promise<ShellState | null> {
  const response = await fetch(`/__shell/state${rev === undefined ? '' : `?rev=${rev}`}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });

  if (!response.ok) {
    return null;
  }



  if (!response.headers.get('content-type')?.includes('application/json')) {
    return null;
  }

  const state = await response.json() as ShellState | null;

  return state && typeof state.rev === 'number' && Number.isFinite(state.rev) ? state : null;
}

/**
 * Все действия оболочки используют same-origin и общий секрет cookie.
 * Повтор мутаций не допускается: человек может повторить действие после явной ошибки.
 */
export async function shellAction(method: string, path: string, body?: unknown, signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`/__shell${path}`, {
    method,
    signal,
    credentials: 'same-origin',
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  const result = await response.json() as { message?: string };

  if (!response.ok) {
    throw new Error(result.message ?? 'Не удалось выполнить действие подключения.');
  }

  return result;
}
