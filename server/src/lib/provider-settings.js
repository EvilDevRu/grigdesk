// Свои настройки исполнителей — склейка ДЕКЛАРАЦИИ и ВЫБОРА.
// Схему объявляет сам executor (поле `settings`, контракт в lib/executors/index.js):
// у Claude одни ручки, у Codex другие, а завтра у третьего ИИ — третьи. Ядро про смысл
// ключей не знает и служит почтальоном: принимает только объявленные id, приводит
// значение к типу `kind` и складывает выбор в prefs (`providerSettings`).
// Отдельным файлом — чтобы правило «чужой ключ в настройки не попадёт» проверялось
// тестом без поднятия сервера (как у provider-usage.js).

/** Объявленные исполнителем настройки со значениями из prefs. */
export function resolveProviderSettings(executor, savedForProvider) {
  const saved = savedForProvider || {};
  return (executor?.settings || []).map((s) => ({
    ...s,
    value: s.id in saved ? saved[s.id] : s.value,
  }));
}

/** Значение по типу настройки. Неизвестный kind передаём как есть — тип задаёт исполнитель. */
function coerce(kind, value) {
  if (kind === 'toggle') return !!value;
  if (kind === 'number') return Number(value);
  return value;
}

/**
 * Применить выбор человека к сохранённым настройкам ВСЕХ исполнителей.
 * @returns {{ ok: true, providerSettings: object, settings: object[] }
 *          | { ok: false, error: string, message: string }}
 */
export function applyProviderSetting(executor, allSaved, { settingId, value } = {}) {
  const decl = (executor?.settings || []).find((s) => s.id === String(settingId || ''));
  if (!decl) {
    return {
      ok: false,
      error: 'unknown_setting',
      message: `исполнитель ${executor?.name || '?'} не объявлял настройку ${settingId}`,
    };
  }
  const all = allSaved || {};
  const providerSettings = {
    ...all,
    [executor.id]: { ...(all[executor.id] || {}), [decl.id]: coerce(decl.kind, value) },
  };
  return { ok: true, providerSettings, settings: resolveProviderSettings(executor, providerSettings[executor.id]) };
}
