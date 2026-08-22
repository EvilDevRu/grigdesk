/**
 * Чем уходит быстрый ход компаньона: серверная настройка «Настройки → Приложение →
 * Голосовой компаньон» (`prefs.companion`, нормализуется на сервере в
 * `server/src/lib/companion-settings.js`).
 *
 * Отдельный модуль, а не место в сторе чата: одну и ту же форму читают и стор (перед
 * ходом), и страница настроек (в селектах). Две копии правила разъехались бы на первой
 * же правке, а вью не должно ради чистой функции зависеть от pinia-стора.
 *
 * Форму сервер уже проверил; здесь — защита от старого сервера и битого ответа: без
 * обеих половин ссылки ход обязан уйти дефолтом реестра, а не полупустой парой.
 */
export function normalizeCompanionRun(payload) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const ref = raw.modelRef && typeof raw.modelRef === 'object' ? raw.modelRef : {};
  const provider = String(ref.provider || '').trim();
  const model = String(ref.model || '').trim();
  const modelRef = provider && model ? { provider, model } : null;
  return {
    modelRef,
    // Усилие принадлежит конкретной модели: без неё уровень применять не к чему.
    effort: modelRef ? String(raw.effort || '').trim() : '',
  };
}
