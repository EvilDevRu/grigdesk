export const COMPOSER_KEY = 'grigdesk-chat-composer-h';
// Минимум совпадает с CSS (`[data-role='chat-composer'] { min-height: 36px }`): иначе
// нижняя часть хода разделителя мертва — тянешь, число меняется, поле стоит.
export const COMPOSER_MIN = 36;
// Две иконки в левой колонке требуют тот же минимум, что selector индикатора в fields.css.
// Он включается только при видимом значке раскладки; мобильный минимум остаётся прежним.
export const COMPOSER_KEYBOARD_MIN = 64;
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
