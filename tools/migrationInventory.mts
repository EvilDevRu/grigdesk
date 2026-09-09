// Инвентарь миграции на TypeScript: что из СОБСТВЕННОГО исполняемого кода ещё
// осталось на JavaScript.
//
// Список нужен не для отчёта, а как рубеж: пока миграция идёт, новый файл легко
// заводится «как соседний», и остаток тогда не уменьшается, а растёт незаметно.
// Поэтому список хранится снимком и сверяется тестом: убыль требует обновить
// снимок в том же заходе, а новая запись в нём — сознательное решение человека.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

// Чужое, собранное и приватное. `web/dist` и Workbox — выпуск сборки, `profiles`
// и `.state` — состояние машины: ни то, ни другое не переносится руками.
const SKIP_DIRS = new Set([
    '.git',
    '.state',
    'node_modules',
    'dist',
    'profiles',
    'chats',
    'venv',
    '__pycache__',
]);

// Область плана: у каждой свой владелец правок и свой этап. Порядок важен —
// файл относится к ПЕРВОЙ подошедшей области, поэтому вложенные пути идут выше.
const AREAS: readonly { id: string; prefix: string }[] = [
    { id: 'server', prefix: 'server/src/' },
    { id: 'serverScripts', prefix: 'server/scripts/' },
    { id: 'web', prefix: 'web/src/' },
    { id: 'webDev', prefix: 'web/dev/' },
    { id: 'webScripts', prefix: 'web/scripts/' },
    { id: 'webPublic', prefix: 'web/public/' },
    { id: 'webConfig', prefix: 'web/' },
    { id: 'shared', prefix: 'shared/' },
    { id: 'tools', prefix: 'tools/' },
    { id: 'engine', prefix: 'engine/' },
    { id: 'tests', prefix: 'tests/' },
];

const CODE_EXTENSIONS = ['.js', '.mjs', '.cjs'];

export interface MigrationInventory {
    // Собственный исполняемый JavaScript по областям плана.
    legacy: Record<string, string[]>;
    // Компоненты Vue, у которых есть script, но он ещё не объявлен TypeScript.
    vue: string[];
    // Долг общей проверки интерфейса: сколько ошибок ещё даёт каждый файл. Общая
    // проверка web не может быть зелёной, пока крупные разделы на JavaScript —
    // их РАЗМЕТКУ компилятор читает, а типов у их же script нет. Долг записан
    // пофайлово, чтобы он мог только уменьшаться, а не разъезжаться незаметно.
    typecheckDebt: Record<string, number>;
}

/** Все файлы дерева, кроме чужого, собранного и приватного. */
function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) {
                continue;
            }
            walk(join(dir, entry.name), out);
        } else if (entry.isFile()) {
            out.push(join(dir, entry.name));
        }
    }

    return out;
}

function areaOf(path: string): string | null {
    for (const area of AREAS) {
        if (path.startsWith(area.prefix)) {
            return area.id;
        }
    }

    return null;
}

/**
 * Есть ли у компонента исполняемый блок, не объявленный TypeScript. Пустой SFC
 * без script искусственного блока не требует, и его в остаток не записывают.
 */
function vueScriptIsJs(source: string): boolean {
    const blocks = source.match(/<script\b[^>]*>/g) || [];

    return blocks.some((block) => !/\blang\s*=\s*["']ts["']/.test(block));
}

/**
 * Сколько ошибок общей проверки интерфейса приходится на каждый файл. Запускается
 * настоящий компилятор: считать долг по своему разбору значило бы верить не тому,
 * что проверяет прогон.
 */
export function collectTypecheckDebt(root: string = REPO_ROOT): Record<string, number> {
    const compiler = join(root, 'web', 'node_modules', '.bin', 'vue-tsc');
    let output = '';

    try {
        execFileSync(compiler, ['-p', join(root, 'web', 'tsconfig.json'), '--noEmit'], {
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
        });
    } catch (failure) {
        output = String((failure as { stdout?: unknown }).stdout ?? '');
    }

    const debt: Record<string, number> = {};

    for (const line of output.split('\n')) {
        const match = /^(\S+?)\(\d+,\d+\): error TS/.exec(line);

        if (match?.[1]) {
            // Компилятор печатает путь относительно СВОЕГО рабочего каталога, а его
            // выбирает вызывающая команда: из корня и из web/ строки разные.
            const path = relative(root, resolve(process.cwd(), match[1])).split(sep).join('/');

            debt[path] = (debt[path] ?? 0) + 1;
        }
    }

    return Object.fromEntries(Object.entries(debt).sort(([left], [right]) => (
        left < right ? -1 : 1
    )));
}

/** Снимок остатка: пути относительно корня репозитория, всегда отсортированы. */
export function collectMigrationInventory(root: string = REPO_ROOT): MigrationInventory {
    const legacy: Record<string, string[]> = {};
    const vue: string[] = [];

    for (const absolute of walk(root)) {
        const path = relative(root, absolute).split(sep).join('/');
        const area = areaOf(path);

        if (!area) {
            continue;
        }
        if (path.endsWith('.vue')) {
            // Компоненты считаются только у продукта: SFC в тестах — намеренно
            // неверные образцы для guard-ов, и «чинить» их типами нельзя.
            if (area.startsWith('web') && vueScriptIsJs(readFileSync(absolute, 'utf8'))) {
                vue.push(path);
            }
            continue;
        }
        if (!CODE_EXTENSIONS.some((extension) => path.endsWith(extension))) {
            continue;
        }
        (legacy[area] ??= []).push(path);
    }

    for (const files of Object.values(legacy)) {
        files.sort();
    }
    vue.sort();

    return { legacy, vue, typecheckDebt: collectTypecheckDebt(root) };
}

// Общие проверки сред: каждая называет свой набор файлов, и вместе они обязаны
// накрыть весь собственный TypeScript. Область без своего проекта проверяется
// «на глаз» — компилятор о ней просто не знает.
const GENERAL_PROJECTS: readonly { config: string; compiler: string }[] = [
    { config: 'server/tsconfig.json', compiler: 'server/node_modules/.bin/tsc' },
    // Обычный tsc не знает про .vue и молча не раскрывает их в списке файлов —
    // проверять покрытие интерфейса им значило бы «не вижу, значит нет».
    { config: 'web/tsconfig.json', compiler: 'web/node_modules/.bin/vue-tsc' },
    { config: 'web/tsconfig.scripts.json', compiler: 'web/node_modules/.bin/tsc' },
];

// Образцы для guard-ов интерфейса: часть из них намеренно неверна, и объявлять их
// TypeScript нельзя — тогда проверять было бы нечего.
const COVERAGE_EXCEPTIONS = new Set(['tests/web/fixtures/']);

const TS_EXTENSIONS = ['.ts', '.mts', '.cts', '.vue'];

/** Файлы, которые проект берёт по своим include/exclude — без обхода импортов. */
function projectFiles(root: string, project: { config: string; compiler: string }): string[] {
    const { config, compiler } = project;
    const shown = execFileSync(join(root, compiler), ['-p', join(root, config), '--showConfig'], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
    });
    const parsed: unknown = JSON.parse(shown);
    const files = (parsed as { files?: unknown }).files;
    const base = join(root, config, '..');

    return (Array.isArray(files) ? files : [])
        .map((file) => relative(root, join(base, String(file))).split(sep).join('/'));
}

/**
 * Собственный TypeScript, которого не видит ни одна общая проверка. Пустой список —
 * условие миграции: файл вне проекта компилятором не читается вовсе, и «зелёный
 * typecheck» о нём ничего не говорит.
 */
export function uncheckedTypeScript(root: string = REPO_ROOT): string[] {
    const covered = new Set(GENERAL_PROJECTS.flatMap((project) => projectFiles(root, project)));
    const legacyVue = new Set(collectMigrationInventory(root).vue);
    const unchecked: string[] = [];

    for (const absolute of walk(root)) {
        const path = relative(root, absolute).split(sep).join('/');

        if (!areaOf(path) || !TS_EXTENSIONS.some((extension) => path.endsWith(extension))) {
            continue;
        }
        // SFC из остатка миграции проверять нечем: типов у его же script ещё нет.
        if (covered.has(path) || legacyVue.has(path)) {
            continue;
        }
        if ([...COVERAGE_EXCEPTIONS].some((prefix) => path.startsWith(prefix))) {
            continue;
        }
        unchecked.push(path);
    }

    return unchecked.sort();
}

export const MIGRATION_BASELINE_PATH = fileURLToPath(
    new URL('../tests/fixtures/migration-inventory-baseline.json', import.meta.url),
);

/** Снимок остатка с диска: по нему тест узнаёт о новом файле вне проверки типов. */
export function readMigrationBaseline(): MigrationInventory {
    return JSON.parse(readFileSync(MIGRATION_BASELINE_PATH, 'utf8')) as MigrationInventory;
}

const invokedAsCli = process.argv[1]
    && process.argv[1] === fileURLToPath(import.meta.url);

if (invokedAsCli) {
    const inventory = collectMigrationInventory();

    if (process.argv.includes('--write')) {
        writeFileSync(MIGRATION_BASELINE_PATH, `${JSON.stringify(inventory, null, 2)}\n`);
        process.stdout.write(`снимок остатка обновлён: ${MIGRATION_BASELINE_PATH}\n`);
    } else if (process.argv.includes('--json')) {
        process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
    } else {
        for (const area of AREAS) {
            const files = inventory.legacy[area.id] || [];

            process.stdout.write(`${area.id.padEnd(14)} ${String(files.length).padStart(4)}\n`);
        }
        const debt = Object.values(inventory.typecheckDebt).reduce((sum, count) => sum + count, 0);

        process.stdout.write(`${'vue'.padEnd(14)} ${String(inventory.vue.length).padStart(4)}\n`);
        process.stdout.write(`${'долг типов'.padEnd(14)} ${String(debt).padStart(4)}\n`);
    }
}
