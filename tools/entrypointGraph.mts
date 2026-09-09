// Граф зависимостей точек входа.
//
// Переименование модуля видит компилятор, но не видит строка: путь subprocess, alias
// песочницы и `new URL` рядом с `import.meta.url` — обычный текст. А ещё сервер
// поднимает часть модулей ДИНАМИЧЕСКИ, обходя каталог: исполнители подключаются
// файлом, и такой файл не упомянут нигде. Оба случая проверяются одинаково — обходом
// от точек входа с разрешением каждого относительного импорта на диске.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

// Всё, что кокпит запускает как самостоятельную программу. Часть — своим процессом
// (MCP-мосты, воркеры, CLI), часть — снаружи shell-лаунчерами.
export const ENTRYPOINTS: readonly string[] = [
    'server/src/app.js',
    'server/scripts/knowledge-search-preflight.mjs',
    'server/src/lib/chat/permission-mcp.js',
    'server/src/lib/executors/work-mcp.js',
    'server/src/lib/executors/_direct-ssh-policy-hook.js',
    'server/src/workers/cockpit-update-worker.js',
    'server/src/lib/media/ingestWorker.ts',
    'server/src/lib/search/worker.ts',
    'server/src/lib/search/cli.ts',
];

// Кто передаёт снятие типов каждой такой точке входа. Список — не украшение:
// программа, чей граф дошёл до TypeScript, обязана запускаться с флагом, иначе на
// минимальной поддерживаемой версии Node она не стартует вовсе. Появилась новая
// строка — значит, у её запуска нужно проверить argv, а у песочницы Kimi ещё и
// монтирование транзитивных модулей.
export const TYPE_STRIPPING_LAUNCHERS: Readonly<Record<string, string>> = Object.freeze({
    'server/src/app.js':
        'server/package.json start/dev, bin/cockpit, bin/restart, deploy/cockpit-server.service',
    'server/scripts/knowledge-search-preflight.mjs':
        'bin/cockpit, bin/restart, deploy/install.sh, deploy/cockpit-server.service',
    'server/src/lib/search/cli.ts': 'bin/knowledge',
    'server/src/lib/search/worker.ts': 'worker_threads наследует execArgv родителя',
    'server/src/lib/media/ingestWorker.ts': 'startIngestJob через nodeTsArgv',
    'server/src/lib/executors/_direct-ssh-policy-hook.js':
        'DIRECT_SSH_HOOK_COMMAND через NODE_TS_ARGS',
});

// Каталоги, которые сервер обходит сам: файл здесь подключается по факту наличия,
// а не по импорту. Пропустить их значило бы не проверить именно ту часть, где
// переименование ломает не сборку, а поведение.
const SCANNED_DIRS: readonly { dir: string; skip: (name: string) => boolean }[] = [
    {
        dir: 'server/src/lib/executors',
        // На `_` — вспомогательные модули исполнителей, index.js — сам загрузчик.
        skip: (name) => name === 'index.js' || name.startsWith('_'),
    },
];

const SPEC_RE = /(?:^|[^\w.])(?:import|export)\s[^'"();]*?from\s*(['"])(\.[^'"]*)\1/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*(['"])(\.[^'"]*)\1/g;
const DYNAMIC_RE = /import\(\s*(['"])(\.[^'"]*)\1\s*\)/g;
const URL_RE = /new URL\(\s*(['"])(\.[^'"]*)\1\s*,\s*import\.meta\.url\s*\)/g;

export interface BrokenReference {
    from: string;
    spec: string;
}

/** Обход графа от одного файла: множество достижимых собственных модулей. */
function reachableFrom(root: string, entry: string, broken: BrokenReference[]): Set<string> {
    const seen = new Set<string>();
    const queue = [join(root, entry)];

    while (queue.length) {
        const current = queue.pop();

        if (!current || seen.has(current) || !isFile(current)) {
            continue;
        }
        seen.add(current);

        for (const spec of referencesOf(readFileSync(current, 'utf8'))) {
            const target = resolve(dirname(current), spec);

            if (isFile(target)) {
                queue.push(target);
            } else {
                broken.push({ from: relative(root, current).split(sep).join('/'), spec });
            }
        }
    }

    return seen;
}

/**
 * Точки входа, чей граф доходит до TypeScript. Такую программу нельзя запускать
 * голым `node`: на минимальной поддерживаемой версии снятие типов ещё не включено,
 * и она не стартует вовсе. Список сверяется с тем, где флаги действительно передают.
 */
export function entrypointsWithTypeScript(root: string = REPO_ROOT): string[] {
    const broken: BrokenReference[] = [];
    const found: string[] = [];

    for (const entry of ENTRYPOINTS) {
        const reachable = reachableFrom(root, entry, broken);
        const hasTs = [...reachable].some((path) => path.endsWith('.ts') || path.endsWith('.mts'));

        if (hasTs) {
            found.push(entry);
        }
    }

    return found.sort();
}

/** Относительные ссылки одного файла: импорты, динамический import и new URL. */
function referencesOf(source: string): string[] {
    const specs: string[] = [];

    for (const pattern of [SPEC_RE, BARE_IMPORT_RE, DYNAMIC_RE, URL_RE]) {
        for (const match of source.matchAll(pattern)) {
            const spec = match[2];

            // Каталог — не модуль: так собирают корень состояния и префикс
            // динамического импорта, и проверять его как файл нечего.
            if (spec && !spec.includes('${') && !spec.endsWith('/')) {
                specs.push(spec);
            }
        }
    }

    return specs;
}

function isFile(path: string): boolean {
    return existsSync(path) && statSync(path).isFile();
}

/**
 * Обходит граф от точек входа и возвращает ссылки, которых нет на диске. Пустой
 * список — единственный допустимый результат: любая такая ссылка означает, что
 * программа упадёт при запуске, а не при сборке.
 */
export function brokenEntrypointReferences(root: string = REPO_ROOT): BrokenReference[] {
    const roots = [...ENTRYPOINTS];

    for (const { dir, skip } of SCANNED_DIRS) {
        const absolute = join(root, dir);

        if (!existsSync(absolute)) {
            continue;
        }
        for (const name of readdirSync(absolute)) {
            if (!skip(name) && (name.endsWith('.js') || name.endsWith('.ts'))) {
                roots.push(`${dir}/${name}`);
            }
        }
    }

    const seen = new Set<string>();
    const queue = roots.map((path) => join(root, path));
    const broken: BrokenReference[] = [];

    while (queue.length) {
        const current = queue.pop();

        if (!current || seen.has(current)) {
            continue;
        }
        seen.add(current);

        if (!isFile(current)) {
            continue;
        }

        const source = readFileSync(current, 'utf8');

        for (const spec of referencesOf(source)) {
            const target = resolve(dirname(current), spec);

            if (!isFile(target)) {
                broken.push({
                    from: relative(root, current).split(sep).join('/'),
                    spec,
                });
                continue;
            }
            // Дальше идут только собственные модули: чужие пакеты сюда не попадают,
            // потому что относительным путём их не импортируют.
            queue.push(target);
        }
    }

    return broken.sort((left, right) => (
        `${left.from}${left.spec}` < `${right.from}${right.spec}` ? -1 : 1
    ));
}

const invokedAsCli = process.argv[1]
    && process.argv[1] === fileURLToPath(import.meta.url);

if (invokedAsCli) {
    const broken = brokenEntrypointReferences();

    if (broken.length) {
        for (const { from, spec } of broken) {
            process.stdout.write(`${from} → ${spec}\n`);
        }
        process.exitCode = 1;
    } else {
        process.stdout.write('граф запуска разрешается целиком\n');
    }
}
