import { isRecord } from '../lib/objects.ts';

/**
 * Время успешного замера отделено от доставки и попытки: кэш не становится свежим от SSE.
 * Старый контракт не меняется без opt-in metadata; истёкшее окно сохраняет исходные цифры.
 */
export function providerUsageFreshness(entry: unknown, now: number, deliveryStale = false, optIn = false) {
  const value = isRecord(entry) ? entry : {};
  const enabled = optIn || Object.hasOwn(value, 'lastSuccessfulAt');
  const measuredAt = typeof value.lastSuccessfulAt === 'number' && Number.isFinite(value.lastSuccessfulAt)
    && value.lastSuccessfulAt > 0 ? value.lastSuccessfulAt : null;
  const interval = typeof value.pollIntervalMs === 'number' && Number.isFinite(value.pollIntervalMs)
    && value.pollIntervalMs > 0 ? value.pollIntervalMs : 300_000;
  const expiresAt = measuredAt === null ? null : measuredAt + 2 * interval;
  const bars = Array.isArray(value.bars) ? value.bars : [];
  const expiredWindow = bars.some((bar) => isRecord(bar) && typeof bar.resetsAt === 'string'
    && Date.parse(bar.resetsAt) <= now);
  const unknownSample = measuredAt === null && bars.length > 0;

  return {
    enabled,
    measuredAt,
    expiresAt,
    stale: value.stale === true || enabled && (deliveryStale || expiredWindow || unknownSample
      || expiresAt !== null && now > expiresAt),
  };
}
