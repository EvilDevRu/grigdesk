// Инвентарь миграции на TypeScript: что из СОБСТВЕННОГО исполняемого кода ещё
// осталось на JavaScript.
//
// Список нужен не для отчёта, а как рубеж: пока миграция идёт, новый файл легко
// заводится «как соседний», и остаток тогда не уменьшается, а растёт незаметно.
// Поэтому список хранится снимком и сверяется тестом: убыль требует обновить
// снимок в том же заходе, а новая запись в нём — сознательное решение человека.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

// Чужое, собранное и приватное. `web/dist` и Workbox — выпуск сборки, `profiles`
// и `.state` — состояние машины: ни то, ни другое не переносится руками.
const SKIP_DIRS = new Set([
    '.git',
    '.generated',
    '.state',
    '.vite',
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
    { id: 'bin', prefix: 'bin/' },
    { id: 'deploy', prefix: 'deploy/' },
    { id: 'server', prefix: 'server/src/' },
    { id: 'serverScripts', prefix: 'server/scripts/' },
    { id: 'relay', prefix: 'relay/' },
    { id: 'mobile', prefix: 'mobile/src/' },
    { id: 'mobileConfig', prefix: 'mobile/vite.config.' },
    { id: 'mobileConfig', prefix: 'mobile/capacitor.config.' },
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

// Собственный исполняемый JavaScript во всех формах, которые вообще может встретить
// этот проект. JSX здесь пока не встречается, но его отсутствие должно быть фактом
// проверки, а не следствием того, что расширение забыли перечислить.
// Единственный разрешённый JavaScript вне остатка миграции. У каждой строки своя
// причина и своё условие снятия: «оставили как было» причиной не считается.
export interface CompatibilityEntry {
    path: string;
    reason: string;
    removeWhen: string;
    // Файл выпускается сборкой и в репозитории отсутствует: проверять его наличие
    // нечем, но и остатком миграции он не является.
    generated?: boolean;
}

export const COMPATIBILITY: readonly CompatibilityEntry[] = Object.freeze([
    {
        path: 'server/src/app.js',
        reason: 'Установленный юнит запускает именно это имя; лаунчер до перерендера юнита.',
        removeWhen: 'Человек перерисовал юнит из шаблона и подтвердил удачный перезапуск.',
    },
    {
        path: 'server/src/lib/chat/permission-mcp.js',
        reason: 'Живой сервер запускает файл по пути из дерева на каждый ход агента.',
        removeWhen: 'Сервер перезапущен на новом коде, и всплывашка разрешений проверена.',
    },
    {
        path: 'server/src/lib/executors/work-mcp.js',
        reason: 'Живой сервер запускает файл на каждую сессию; он же монтируется в песочницу.',
        removeWhen: 'Сервер перезапущен, инструменты cockpit-work доступны в чате.',
    },
    {
        path: 'server/src/lib/executors/_direct-ssh-policy-hook.js',
        reason: 'Хук запускается на каждый Bash-вызов агента; его отсутствие тихо снимает запрет.',
        removeWhen: 'Сервер перезапущен, прямой SSH в чате по-прежнему блокируется.',
    },
    {
        path: 'server/src/workers/cockpit-update-worker.js',
        reason: 'Обновлятель прошлой версии запускает воркер по этому имени.',
        removeWhen: 'Обновление прошло хотя бы один релиз с новым именем воркера.',
    },
    {
        path: 'tests/server/cockpit-release.test.js',
        reason: 'Старый воркер обновления прогоняет этот файл в НОВОМ дереве без флагов.',
        removeWhen: 'Обновлятель на TypeScript установлен минимум один релиз.',
    },
    {
        path: 'web/public/notification-sw.js',
        reason: 'Workbox подключает его importScripts по литеральному имени; выпуск сборки.',
        removeWhen: 'Никогда: это выход сборки, а не исходник. Источник — web/src/sw/.',
        generated: true,
    },
]);

const CODE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx'];

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
 *
 * Отказ САМОЙ проверки не имеет права выглядеть нулевым долгом. Отсутствие компилятора,
 * убитый сигналом процесс, ошибка конфигурации и незнакомая диагностика — это провал
 * измерения, и он бросается, а не превращается в пустой словарь.
 */
export function collectTypecheckDebt(root: string = REPO_ROOT): Record<string, number> {
    const compiler = join(root, 'web', 'node_modules', '.bin', 'vue-tsc');
    const project = join(root, 'web', 'tsconfig.json');
    const run = spawnSync(compiler, ['-p', project, '--noEmit'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });

    if (run.error) {
        throw new Error(`Не удалось запустить ${compiler}: ${run.error.message}`);
    }
    if (run.signal) {
        throw new Error(`Проверка типов убита сигналом ${run.signal}; долг не измерен.`);
    }

    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    const diagnostics = output.split('\n').filter((line) => /error TS\d+/.test(line));
    const debt: Record<string, number> = {};
    const unparsed: string[] = [];

    for (const line of diagnostics) {
        const match = /^(\S+?)\((\d+),(\d+)\): error TS/.exec(line);

        if (!match?.[1]) {
            // Ошибка конфигурации или незнакомый формат: у неё нет файла, и молча
            // отбросить её значило бы объявить сломанный проект чистым.
            unparsed.push(line.trim());
            continue;
        }
        // Компилятор печатает путь относительно СВОЕГО рабочего каталога, а его
        // выбирает вызывающая команда: из корня и из web/ строки разные.
        const path = relative(root, resolve(process.cwd(), match[1])).split(sep).join('/');

        debt[path] = (debt[path] ?? 0) + 1;
    }

    if (unparsed.length) {
        throw new Error(`Проверка типов вернула диагностику без файла:\n${unparsed.join('\n')}`);
    }

    const total = Object.values(debt).reduce((sum, count) => sum + count, 0);

    if (run.status !== 0 && total === 0) {
        throw new Error(
            `Проверка типов завершилась кодом ${run.status}, но ни одной ошибки не разобрано:`
            + `\n${output.trim().slice(0, 2000)}`,
        );
    }
    // Итоговая строка компилятора — независимый счёт: расхождение означает, что разбор
    // потерял часть диагностики, а не что долг уменьшился.
    const summary = /Found (\d+) errors?/.exec(output);

    if (summary?.[1] && Number(summary[1]) !== total) {
        throw new Error(`Компилятор насчитал ${summary[1]} ошибок, разобрано ${total}.`);
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
    { config: 'relay/tsconfig.json', compiler: 'server/node_modules/.bin/tsc' },
    { config: 'mobile/tsconfig.json', compiler: 'mobile/node_modules/.bin/vue-tsc' },
    // Тесты проверяются той же базой, что и проверяемый ими код: до этих проектов
    // перенесённый на TypeScript тест компилятор не открывал вовсе.
    { config: 'server/tsconfig.tests.json', compiler: 'server/node_modules/.bin/tsc' },
    { config: 'web/tsconfig.tests.json', compiler: 'web/node_modules/.bin/vue-tsc' },
];

// Образцы для guard-ов интерфейса. Исключение поимённое, а не по каталогу: три SFC
// намеренно нарушают порядок блоков, один — границу примитивов, и объявить их
// TypeScript значило бы лишить соответствующие проверки предмета. Остальные файлы
// каталога — обычные компоненты-стенды и обязаны проверяться как весь интерфейс.
const COVERAGE_EXCEPTIONS: readonly string[] = [
    'tests/web/fixtures/ui/boundary/LegacyControl.vue',
    'tests/web/fixtures/ui/sfc/ScriptAfterStyle.vue',
    'tests/web/fixtures/ui/sfc/ScriptFirst.vue',
    'tests/web/fixtures/ui/sfc/ScriptFirstWithTemplateLiteral.vue',
    'tests/web/fixtures/ui/sfc/Valid.vue',
];

const TS_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx', '.vue'];

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
        if (COVERAGE_EXCEPTIONS.includes(path)) {
            continue;
        }
        unchecked.push(path);
    }

    return unchecked.sort();
}

/**
 * Остаток, который ещё нужно перенести: весь собственный JavaScript за вычетом
 * списка совместимости. Именно это число обязано дойти до нуля — «сколько всего
 * .js в дереве» им не является, потому что часть файлов остаётся по контракту.
 */
export function remainingBeyondCompatibility(root: string = REPO_ROOT): string[] {
    const allowed = new Set(COMPATIBILITY.map((entry) => entry.path));

    return Object.values(collectMigrationInventory(root).legacy)
        .flat()
        .filter((path) => !allowed.has(path))
        .sort();
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
        process.stdout.write(
            `${'--- осталось'.padEnd(14)} ${String(remainingBeyondCompatibility().length).padStart(4)}`
            + ` (без списка совместимости)\n`,
        );
    }
}
