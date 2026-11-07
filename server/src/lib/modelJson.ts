// Разбор JSON-ответа модели. Модель просят ответить голым объектом, но она вправе
// обернуть его в ```json-забор или дописать вежливую фразу до и после — поэтому
// кандидатов несколько и они пробуются по порядку, от самого точного к самому грубому.
//
// Живёт отдельно от Inbox и media: обоим нужен один и тот же разбор, а вторая копия
// разошлась бы с первой на первой же правке.

import { trimmedText } from '../../../shared/lib/text.ts';

/**
 * Кандидаты на JSON внутри ответа модели, от точного к грубому:
 * содержимое markdown-забора → срез от первой `{` до последней `}` → весь ответ.
 */
export function jsonCandidates(reply: unknown): string[] {
    const source = trimmedText(reply);

    if (!source) {
        return [];
    }

    const candidates: string[] = [];
    const fence = source.match(/```(?:json)?\s*([\s\S]*?)```/iu);

    if (fence?.[1]) {
        candidates.push(fence[1]);
    }

    const open = source.indexOf('{');
    const close = source.lastIndexOf('}');

    if (open >= 0 && close > open) {
        candidates.push(source.slice(open, close + 1));
    }
    candidates.push(source);

    return candidates;
}

/**
 * Строка не длиннее лимита. `null` означает «не по контракту» и обязан отвергать
 * запись целиком: молча обрезать ответ модели нельзя — это решение за неё.
 * Байтовый потолок отдельно, иначе строка из эмодзи проходит по длине и раздувает хранение.
 */
export function boundedText(value: unknown, limit: number): string | null {
    const result = trimmedText(value);

    if (result.length > limit || Buffer.byteLength(result, 'utf8') > limit * 4) {
        return null;
    }

    return result;
}

/** Ровно ожидаемый набор ключей: лишнее поле означает ответ не по контракту. */
export function exactKeys(value: unknown, expectedKeys: readonly string[]): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    const keys = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();

    return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

/** Число 0..1; всё остальное (включая NaN и строки) — ноль, а не отказ. */
export function confidenceValue(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
        ? value
        : 0;
}
