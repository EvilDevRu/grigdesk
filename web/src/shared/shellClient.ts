import { startShellPerformance } from './shellPerformance.ts';
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
 * Срок включает чтение тела и оставляет запас после штатного long-poll в 25 секунд.
 */
async function readShellStateCore(rev?: number, signal?: AbortSignal): Promise<ShellState | null> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 35_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  const cancelTimeout = () => clearTimeout(timer);

  requestSignal.addEventListener('abort', cancelTimeout, { once: true });

  try {
    const response = await fetch(`/__shell/state${rev === undefined ? '' : `?rev=${rev}`}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: requestSignal,
    });

    if (response.status >= 500 || response.status === 429) {
      throw new Error(localeTranslator(uiLocalePort)('core.shellTemporarilyUnavailable'));
    }

    if (!response.ok) {
      return null;
    }

    if (!response.headers.get('content-type')?.includes('application/json')) {
      return null;
    }

    const state: unknown = await response.json();

    return isShellState(state) ? state : null;
  } finally {
    clearTimeout(timer);
    requestSignal.removeEventListener('abort', cancelTimeout);
  }
}

/**
 * Все действия оболочки используют same-origin и общий секрет cookie.
 * Повтор мутаций не допускается: человек может повторить действие после явной ошибки.
 */
async function shellActionCore(method: string, path: string, body?: unknown, signal?: AbortSignal,
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

/**
 * Замер оборачивает действующий detector, включая deadline заголовков и JSON body.
 * Штатный long-poll не получает диагностического pending, но сохраняет свой 35s срок.
 */
export async function readShellState(rev?: number, signal?: AbortSignal): Promise<ShellState | null> {
  const finish = rev === undefined ? startShellPerformance('detect') : (_success: boolean) => {};

  try {
    const result = await readShellStateCore(rev, signal);

    finish(true);

    return result;
  } catch (error) {
    finish(false);

    throw error;
  }
}

/**
 * Действующая команда сохраняет тело, decoder, ошибки и правила сети без копирования.
 * Диагностический wrapper передаёт только закрытое имя и не читает результат/аргументы.
 */
export async function shellAction(method: string, path: string, body?: unknown, signal?: AbortSignal,
): Promise<unknown> {
  const operation = path === '/connect' ? 'connect' : path === '/disconnect' ? 'disconnect'
    : path === '/unlock' ? 'unlock' : 'action';
  const finish = startShellPerformance(operation);

  try {
    const result = await shellActionCore(method, path, body, signal);

    finish(true);

    return result;
  } catch (error) {
    finish(false);

    throw error;
  }
}
