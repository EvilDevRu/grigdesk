import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from './uiLocalePort.ts';
import { isRecord } from '../../../shared/lib/objects.ts';

import type { ShellState } from '../../../shared/client/clientShell.ts';

/**
 * Подтверждение действия с ok не является снимком и не может стирать выбранную машину.
 * Проверка общей формы применяется и к чтению, и к ответам нативных действий.
 */
export function isShellState(value: unknown): value is ShellState {
  return isRecord(value) && typeof value.rev === 'number' && Number.isFinite(value.rev)
    && typeof value.status === 'string' && Object.hasOwn(value, 'profile')
    && (value.profile === null || isRecord(value.profile)) && Array.isArray(value.profiles)
    && Array.isArray(value.capabilities) && typeof value.localAvailable === 'boolean';
}

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

  if (response.status >= 500 || response.status === 429) {
    throw new Error('Оболочка временно недоступна');
  }

  if (!response.ok) {
    return null;
  }



  if (!response.headers.get('content-type')?.includes('application/json')) {
    return null;
  }

  const state: unknown = await response.json();

  return isShellState(state) ? state : null;
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
    throw new Error(result.message ?? localeTranslator(uiLocalePort)('settings.connectionActionFailed'));
  }

  return result;
}
