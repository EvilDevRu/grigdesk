export type GrigDeskProbe = 'grigdesk' | 'refused' | 'other' | 'no_answer';

export interface GrigDeskProbeOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Готовность подтверждает только схема auth/state; чужой HTTP отличается от закрытого порта.
 * Таймаут и внешняя отмена действуют до конца чтения JSON и очищаются при любом исходе.
 */
export async function probeGrigDesk(
  origin: string,
  options: GrigDeskProbeOptions = {},
): Promise<GrigDeskProbe> {
  if (options.signal?.aborted) {
    return 'no_answer';
  }

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? 2000);
  const signal = options.signal
    ? AbortSignal.any([timeout.signal, options.signal])
    : timeout.signal;

  try {
    const response = await (options.fetchImpl ?? fetch)(origin + '/api/auth/state', {
      method: 'GET',
      redirect: 'error',
      signal,
    });

    if (signal.aborted) {
      return 'no_answer';
    }

    if (response.status !== 200) {
      return 'other';
    }

    let state: unknown;

    try {
      state = await response.json();
    } catch {
      return signal.aborted ? 'no_answer' : 'other';
    }

    if (signal.aborted) {
      return 'no_answer';
    }

    const valid = Boolean(state) && typeof state === 'object' && !Array.isArray(state) &&
      state !== null && 'configured' in state && typeof state.configured === 'boolean' &&
      'authenticated' in state && typeof state.authenticated === 'boolean';

    return valid ? 'grigdesk' : 'other';
  } catch (error) {
    if (signal.aborted) {
      return 'no_answer';
    }

    const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : null;
    const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null;

    if (code === 'ECONNREFUSED') {
      return 'refused';
    }

    return 'no_answer';
  } finally {
    clearTimeout(timer);
  }
}
