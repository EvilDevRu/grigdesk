// Выбор ступени усилия для хода. Лестницу объявляет сама модель, поэтому список
// уровней приходит снаружи: зашитый здесь набор устарел бы на первом же обновлении CLI.

// Итог разбора. Отсутствие ступени — законный ответ «умолчание исполнителя», и
// отличается он от отказа полем `ok`, а не пустой строкой: пустая строка у CLI
// означала бы попытку передать `--effort ""`.
export interface EffortChoice {
    ok: boolean;
    effort: string | undefined;
    levels?: string[];
}

export function resolveRequestedEffort(
    value: unknown,
    supportedLevels: unknown,
): EffortChoice {
    const effort = typeof value === 'string' ? value.trim() : '';

    if (!effort) {
        return { ok: true, effort: undefined };
    }

    const levels = Array.isArray(supportedLevels) ? supportedLevels as string[] : [];

    if (levels.includes(effort)) {
        return { ok: true, effort };
    }

    return {
        ok: false,
        effort: undefined,
        levels,
    };
}
