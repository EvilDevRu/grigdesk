// Свои настройки исполнителей — склейка ДЕКЛАРАЦИИ и ВЫБОРА.
// Схему объявляет сам executor (поле `settings`, контракт в lib/executors/index.js):
// у Claude одни ручки, у Codex другие, а завтра у третьего ИИ — третьи. Ядро про смысл
// ключей не знает и служит почтальоном: принимает только объявленные id, приводит
// значение к типу `kind` и складывает выбор в prefs (`providerSettings`).
// Отдельным файлом — чтобы правило «чужой ключ в настройки не попадёт» проверялось
// тестом без поднятия сервера (как у provider-usage.js).

/**
 * Декларация настроек исполнителя: статичный массив (claude/codex/kimi) либо
 * async-функция (config) → массив (ollama: потолок ползунка numCtx зависит от живого
 * железа и демона). Оба вида приводим к массиву здесь, дальше код единый.
 */
async function declaredSettings(executor, config) {
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
export async function resolveProviderSettings(executor, savedForProvider, config) {
  const saved = savedForProvider || {};
  return (await declaredSettings(executor, config)).map((s) => ({
    ...s,
    value: s.kind !== 'info' && s.id in saved ? saved[s.id] : s.value,
  }));
}

/** Значение по типу настройки. Неизвестный kind передаём как есть — тип задаёт исполнитель. */
function coerce(kind, value) {
  if (kind === 'toggle') return !!value;
  if (kind === 'number' || kind === 'range') return Number(value);
  return value;
}

/**
 * Применить выбор человека к сохранённым настройкам ВСЕХ исполнителей.
 * @returns {{ ok: true, providerSettings: object, settings: object[] }
 *          | { ok: false, error: string, message: string }}
 */
export async function applyProviderSetting(
  executor,
  allSaved,
  { settingId, value, confirmed } = {},
  config,
) {
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
  const providerSettings = {
    ...all,
    [executor.id]: { ...(all[executor.id] || {}), [decl.id]: coerced },
  };
  return {
    ok: true,
    providerSettings,
    settings: await resolveProviderSettings(executor, providerSettings[executor.id], config),
  };
}
