export const BROWSER_TAB_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Границы эмуляции размеров страницы для action=resize: покрывают телефонные
 * и планшетные вьюпорты, но не дают агенту ломать окно экстремальными числами.
 */
export const BROWSER_RESIZE_MIN = 200;
export const BROWSER_RESIZE_MAX = 4000;
