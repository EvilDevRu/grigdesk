// Минимальная версия Node для GrigDesk.
//
// Сервер исполняет собственный TypeScript снятием типов, и с 22.18 оно включено по
// умолчанию. Ниже этой версии запуск невозможен физически: импорт `.ts` падает на
// разрешении модуля ещё до первой строки кода, поэтому читаемый отказ дают лаунчеры
// (`deploy/lib/runtime-env.sh`, `deploy/install.sh`), а эта проверка закрывает пути, где
// программа уже стартовала: `npm start`, прямой запуск и будущие минимумы.

import { MIN_NODE_VERSION, isNodeVersionSupported } from '../../../shared/runtime/nodeVersion.ts';

export { MIN_NODE_VERSION, isNodeVersionSupported };

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
        `GrigDesk требует Node ^${MIN_NODE_VERSION} || >=24.0.0, запущен ${actual}. `
        + `Обнови Node (nvm install ${MIN_NODE_VERSION}) и повтори запуск.`,
    );
}
