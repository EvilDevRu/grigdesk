import { createHash } from 'node:crypto';
/**
 * Даёт прежний fingerprint снимков factory, включая сортировку localeCompare.
 * Курсор, формы и CLI обязаны использовать одинаковые байты канонизации.
 */
export function factorySnapshotHash(value: unknown): string {
    /**
     * Сортирует вложенные объекты, сохраняя порядок массивов снимка.
     * localeCompare сохраняет отпечатки уже опубликованного API.
     */
    const canonical = (item: unknown): unknown => {
        if (Array.isArray(item)) {
            return item.map(canonical);
        }
        if (item && typeof item === 'object') {
            return Object.fromEntries(Object.entries(item)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, child]) => [key, canonical(child)]));
        }

        return item;
    };

    return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
