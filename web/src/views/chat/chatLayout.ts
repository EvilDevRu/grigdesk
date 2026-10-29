export const COMPOSER_KEY = 'grigdesk-chat-composer-h';
// Минимум совпадает с CSS (`[data-role='chat-composer'] { min-height: 48px }`): иначе
// нижняя часть хода разделителя мертва — тянешь, число меняется, поле стоит.
export const COMPOSER_MIN = 48;
// Потолок тот же, что в CSS (`max-height: 46vh`) — вторая цифра рядом с первой
// разъезжается, и разделитель снова получает мёртвый ход.
export const COMPOSER_MAX_VH = 0.46;
/**
 * Читает сохранённую положительную высоту поля ввода.
 * Отказ storage и неверное число оставляют управление размером CSS.
 */
export function storedComposerHeight() {
  try {
    const raw = Number(localStorage.getItem(COMPOSER_KEY));

    return Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch {
    return null;
  }
}

