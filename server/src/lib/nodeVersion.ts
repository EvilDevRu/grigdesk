// Минимальная версия Node для Cockpit.
//
// Сервер исполняет собственный TypeScript снятием типов, и с 22.18 оно включено по
// умолчанию. Ниже этой версии запуск невозможен физически: импорт `.ts` падает на
// разрешении модуля ещё до первой строки кода, поэтому читаемый отказ дают лаунчеры
// (`bin/lib/runtime-env.sh`, `deploy/install.sh`), а эта проверка закрывает пути, где
// программа уже стартовала: `npm start`, прямой запуск и будущие минимумы.

export const MIN_NODE_VERSION = '22.18.0';

/** Разбирает `major.minor.patch`; предрелизные хвосты вида `-nightly` отбрасываются. */
function parseVersion(value: string): [number, number, number] {
    const [major = '0', minor = '0', patch = '0'] = value.replace(/^v/, '').split('-')[0]
        ?.split('.') ?? [];

    return [Number(major) || 0, Number(minor) || 0, Number(patch) || 0];
}

/** Сравнение версий по частям: `22.9.0` не должен считаться новее `22.18.0`. */
export function isNodeVersionSupported(
    actual: string,
    minimum: string = MIN_NODE_VERSION,
): boolean {
    const current = parseVersion(actual);
    const required = parseVersion(minimum);

    for (let index = 0; index < 3; index += 1) {
        const left = current[index] ?? 0;
        const right = required[index] ?? 0;

        if (left !== right) {
            return left > right;
        }
    }

    return true;
}

/**
 * Останавливает старт на неподдерживаемой версии. Сообщение называет обе версии и
 * способ починки: молчаливое продолжение здесь означало бы падение где-то дальше,
 * в месте, по которому причину уже не восстановить.
 */
export function assertSupportedNode(actual: string = process.versions.node): void {
    if (isNodeVersionSupported(actual)) {
        return;
    }

    throw new Error(
        `Cockpit требует Node ${MIN_NODE_VERSION} или новее, запущен ${actual}. `
        + 'С 22.18 Node исполняет TypeScript сам, без флагов; на более старой версии '
        + 'сервер не стартует. Обнови Node (nvm install 22.18.0) и повтори запуск.',
    );
}
