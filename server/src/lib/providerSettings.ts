// Свои настройки исполнителей — склейка ДЕКЛАРАЦИИ и ВЫБОРА.
// Схему объявляет сам executor (поле `settings`, контракт в lib/executors/index.js):
// у Claude одни ручки, у Codex другие, а завтра у третьего ИИ — третьи. Ядро про смысл
// ключей не знает и служит почтальоном: принимает только объявленные id, приводит
// значение к типу `kind` и складывает выбор в prefs (`providerSettings`).
// Отдельным файлом — чтобы правило «чужой ключ в настройки не попадёт» проверялось
// тестом без поднятия сервера (как у providerUsage.ts).
import type { ExecutorAdapter } from './executors/index.ts';

/**
 * Декларация настроек исполнителя: статичный массив (claude/codex/kimi) либо
 * async-функция (config) → массив (ollama: потолок ползунка numCtx зависит от живого
 * железа и демона). Оба вида приводим к массиву здесь, дальше код единый.
 */
// Одна объявленная ручка исполнителя. Смысл ключей знает сам адаптер: ядро
// только принимает объявленный id и приводит значение к его `kind`.
export interface ProviderSetting {
  id: string;
  kind?: string;
  label?: string;
  hint?: string;
  value?: unknown;
  disabled?: boolean;
  note?: string;
  min?: number;
  max?: number;
  step?: number;
  confirm?: { on?: { text?: string }; off?: { text?: string } };
}

// Итог применения выбора: либо новый срез настроек всех исполнителей, либо отказ.
export type ProviderSettingResult =
  | { ok: true; providerSettings: Record<string, unknown>; settings: ProviderSetting[] }
  | { ok: false; error: string; message: string };

async function declaredSettings(
  executor: ExecutorAdapter | null | undefined,
  config: unknown,
): Promise<ProviderSetting[]> {
  const decl = executor?.settings;
  const list = typeof decl === 'function' ? await decl(config) : decl;
  return Array.isArray(list) ? list : [];
}

/**
 * Объявленные исполнителем настройки со значениями из prefs.
 * `kind: 'info'` — не ручка, а строка-справка (что сейчас в памяти, во что обходится
 * выбранный размер контекста): её значение вычисляет сам исполнитель, и prefs его
 * не подменяют, даже если ключ туда когда-то попал.
 */
export async function resolveProviderSettings(
  executor: ExecutorAdapter | null | undefined,
  savedForProvider: Record<string, unknown> | null | undefined,
  config: unknown,
): Promise<ProviderSetting[]> {
  const saved = savedForProvider || {};
  return (await declaredSettings(executor, config)).map((s) => ({
    ...s,
    value: s.kind !== 'info' && s.id in saved ? saved[s.id] : s.value,
  }));
}

/** Значение по типу настройки. Неизвестный kind передаём как есть — тип задаёт исполнитель. */
function coerce(kind: string | undefined, value: unknown): unknown {
  if (kind === 'toggle') return !!value;
  if (kind === 'number' || kind === 'range') return Number(value);
  return value;
}

/** Применить выбор человека к сохранённым настройкам ВСЕХ исполнителей. */
export async function applyProviderSetting(
  executor: ExecutorAdapter,
  allSaved: Record<string, unknown> | null | undefined,
  { settingId, value, confirmed }: {
    settingId?: unknown;
    value?: unknown;
    confirmed?: unknown;
  } = {},
  config?: unknown,
): Promise<ProviderSettingResult> {
  const decl = (await declaredSettings(executor, config)).find((s) => s.id === String(settingId || ''));
  if (!decl) {
    return {
      ok: false,
      error: 'unknown_setting',
      message: `исполнитель ${executor?.name || '?'} не объявлял настройку ${settingId}`,
    };
  }
  if (decl.kind === 'info') {
    return {
      ok: false,
      error: 'readonly_setting',
      message: `${settingId} — справка исполнителя ${executor?.name || '?'}, а не настройка`,
    };
  }
  const coerced = coerce(decl.kind, value);
  const confirmation = decl.confirm?.[coerced ? 'on' : 'off'];
  if (confirmation && confirmed !== true) {
    return {
      ok: false,
      error: 'confirmation_required',
      message: String(confirmation.text || 'Изменение требует подтверждения.'),
    };
  }

  const all = allSaved || {};
  const mine = (all[executor.id] || {}) as Record<string, unknown>;
  const providerSettings = {
    ...all,
    [executor.id]: { ...mine, [decl.id]: coerced },
  };
  return {
    ok: true,
    providerSettings,
    settings: await resolveProviderSettings(
      executor,
      providerSettings[executor.id] as Record<string, unknown>,
      config,
    ),
  };
}
