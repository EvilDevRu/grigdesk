export const MIN_NODE_VERSION = '22.19.0';

/** Разбирает `major.minor.patch`; предрелизные хвосты вида `-nightly` отбрасываются. */
function parseVersion(value: string): [number, number, number] {
    const [major = '0', minor = '0', patch = '0'] = value.replace(/^v/, '').split('-')[0]
        ?.split('.') ?? [];

    return [Number(major) || 0, Number(minor) || 0, Number(patch) || 0];
}

/**
 * Общий host соблюдает также engines закреплённого DeepSeek: Node 23 исключён.
 * Сравнение по частям сохраняет правильный порядок минорных версий Node 22.
 */
export function isNodeVersionSupported(
    actual: string,
    minimum: string = MIN_NODE_VERSION,
): boolean {
    const current = parseVersion(actual);
    const required = parseVersion(minimum);

    if (current[0] < 22 || current[0] === 23) {
        return false;
    }

    for (let index = 0; index < 3; index += 1) {
        const left = current[index] ?? 0;
        const right = required[index] ?? 0;

        if (left !== right) {
            return left > right;
        }
    }

    return true;
}

