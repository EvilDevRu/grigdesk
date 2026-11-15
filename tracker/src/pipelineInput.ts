import { B24Error } from './errors.ts';
/**
 * Закрывает набор полей JSON до HTTP и не теряет исходные значения строк.
 * Собственные декодеры runner/arbiter дополнительно проверяют свой полный контракт.
 */
export function inputRecord(
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = [],
): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new B24Error(2, 'Нужен JSON-объект.');
    }

    const row = value as Record<string, unknown>;
    const allowed = new Set([...required, ...optional]);

    if (required.some((key) => !Object.hasOwn(row, key))
        || Object.keys(row).some((key) => !allowed.has(key))) {
        throw new B24Error(2, 'Набор полей JSON не соответствует команде pipeline.');
    }

    return row;
}
/**
 * Проверяет обязательный текст без нормализации и усечения.
 * Переводы строк разрешены; управляющие знаки, кроме LF, не принимаются.
 */
export function inputText(value: unknown, limit = 20000): string {
    if (typeof value !== 'string' || !value.trim() || value.length > limit
        || /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(value)) {
        throw new B24Error(2, 'Текст пуст, слишком длинный или повреждён.');
    }

    return value;
}
