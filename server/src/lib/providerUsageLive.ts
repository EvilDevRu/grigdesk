import { usagePercentOrNull } from './providerUsage.ts';
import type { ProviderUsage, UsageBar } from './providerUsage.ts';

export interface LiveUsage {
  generation: number;
  seq: number;
  bars: Map<string, UsageBar & { resetsAt: string | null; seq: number }>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/**
 * Сравнивает окна по эпохе, чтобы формат ISO и точность долей секунды не влияли на ключ.
 * Отсутствующий срок остаётся неизвестным и не превращается в начало Unix-эпохи.
 */
function resetTime(value: unknown): number | null {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;

  return Number.isFinite(time) ? time : null;
}

/**
 * Проверяет полосу на границе процесса: неверный замер не становится нулём.
 * Метаданные нужны только для первого результата без полос опроса.
 */
function normalizedBar(value: unknown): UsageBar | null {
  const raw = record(value);
  const pct = usagePercentOrNull(raw?.pct);
  const key = raw?.key;

  if (typeof key !== 'string' || !key.trim() || pct === null) {
    return null;
  }

  const reset = resetTime(raw?.resetsAt);

  if (raw?.resetsAt != null && reset === null) {
    return null;
  }

  return {
    key,
    pct,
    resetsAt: reset === null ? null : new Date(reset).toISOString(),
    ...(typeof raw?.label === 'string' ? { label: raw.label } : {}),
    ...(typeof raw?.group === 'string' ? { group: raw.group } : {}),
    ...(typeof raw?.windowMinutes === 'number' || raw?.windowMinutes === null
      ? { windowMinutes: raw.windowMinutes } : {}),
  };
}

/**
 * Принимает только продвижение расхода в известном окне или реальный новый сброс.
 * Функция не меняет входное состояние, не читает часы и не обращается к кэшу опроса.
 */
export function acceptPatch(
  state: LiveUsage,
  snapshotBars: readonly unknown[],
  patch: unknown,
  _options: { now: number },
): { state: LiveUsage; changed: boolean } {
  const raw = record(patch);

  if (!Array.isArray(raw?.bars)) {
    return { state, changed: false };
  }

  const snapshot = new Map(snapshotBars.flatMap((value) => {
    const bar = record(value);

    return typeof bar?.key === 'string' ? [[bar.key, bar] as const] : [];
  }));
  const bars = new Map(state.bars);
  const seq = state.seq + 1;
  let changed = false;

  for (const value of raw.bars) {
    const bar = normalizedBar(value);

    if (!bar || (snapshotBars.length > 0 && !snapshot.has(bar.key))) {
      continue;
    }

    const previous = bars.get(bar.key) ?? snapshot.get(bar.key);
    const previousPct = usagePercentOrNull(previous?.pct);
    const previousReset = resetTime(previous?.resetsAt);
    const nextReset = resetTime(bar.resetsAt);
    const resetDifference = previousReset !== null && nextReset !== null
      ? nextReset - previousReset : 0;
    const duplicateReset = nextReset === null
      || previousReset !== null && nextReset !== null && Math.abs(resetDifference) <= 1000;

    if (resetDifference < -60000
      || (resetDifference <= 60000 && previousPct !== null && bar.pct < previousPct)
      || (previousPct === bar.pct && duplicateReset)) {
      continue;
    }

    const reset = nextReset ?? previousReset;

    bars.set(bar.key, {
      ...bar,
      resetsAt: reset === null ? null : new Date(reset).toISOString(),
      seq
    });
    changed = true;
  }

  if (!changed) {
    return { state, changed: false };
  }

  return {
    state: {
      ...state,
      seq,
      bars,
    },
    changed: true,
  };
}

/**
 * Накладывает проценты и сбросы на полосы последнего опроса, сохраняя его метаданные.
 * Новое окно снимка сильнее старого события, в одном окне расход не уменьшается.
 * Возраст, отказы, денежные ресурсы и остальные окна остаются собственностью опроса.
 */
export function projectUsage(snapshot: ProviderUsage, state?: LiveUsage): ProviderUsage {
  if (!state?.bars.size) {
    return snapshot;
  }

  if (!snapshot.bars.length) {
    return {
      ...snapshot,
      bars: [...state.bars.values()].map(({ seq: _seq, ...bar }) => bar),
    };
  }

  return {
    ...snapshot,
    bars: snapshot.bars.map((value) => {
      const bar = record(value);
      const patch = typeof bar?.key === 'string' ? state.bars.get(bar.key) : null;

      if (!patch) {
        return value;
      }

      const snapshotReset = resetTime(bar?.resetsAt);
      const patchReset = resetTime(patch.resetsAt);
      const difference = snapshotReset !== null && patchReset !== null
        ? snapshotReset - patchReset : null;

      if (difference !== null && difference > 60000) {
        return value;
      }

      const sameWindow = difference !== null && Math.abs(difference) <= 60000;
      const snapshotPct = usagePercentOrNull(bar?.pct);

      return {
        ...bar,
        pct: sameWindow && snapshotPct !== null ? Math.max(snapshotPct, patch.pct) : patch.pct,
        resetsAt: patch.resetsAt ?? bar?.resetsAt ?? null,
      };
    }),
  };
}

/**
 * Успешный свежий опрос заменяет события, принятые до его начала.
 * Более поздние события остаются поверх ответа, который мог их ещё не учитывать.
 */
export function settlePoll(state: LiveUsage, startSeq: number): LiveUsage {
  return {
    ...state,
    bars: new Map([...state.bars].filter(([, bar]) => bar.seq > startSeq)),
  };
}
