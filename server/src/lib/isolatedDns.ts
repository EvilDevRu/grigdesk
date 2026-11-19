import { getDefaultResultOrder } from 'node:dns';
import type { LookupAddress, LookupAllOptions, LookupOneOptions, LookupOptions } from 'node:dns';

import { runIsolatedNetworkWorker } from './isolatedNetworkWorker.ts';

const LOOKUP = `async ({ hostname, options }) => {
  const { lookup } = await import('node:dns/promises');

  return lookup(hostname, options);
}`;

interface LookupLimits {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function isolatedLookup(
  hostname: string, options: LookupAllOptions, limits?: LookupLimits,
): Promise<LookupAddress[]>;

export function isolatedLookup(
  hostname: string, options?: LookupOneOptions, limits?: LookupLimits,
): Promise<LookupAddress>;

/**
 * Системный lookup сохраняет NSS, hosts, настройки DNS и порядок адресов.
 * Зависший getaddrinfo принадлежит дочернему процессу и освобождается по сроку.
 */
export function isolatedLookup(
  hostname: string,
  options: LookupOptions = {},
  { timeoutMs = 8_000, signal }: LookupLimits = {},
): Promise<LookupAddress | LookupAddress[]> {
  const order = options.order ?? (options.verbatim === undefined ? getDefaultResultOrder() : undefined);

  return runIsolatedNetworkWorker({
    operation: LOOKUP,
    request: { hostname, options: { ...options, order } },
    timeoutMs,
    signal,
    maxOutputBytes: 64 * 1024,
    timeoutMessage: 'DNS не ответил.',
  });
}
