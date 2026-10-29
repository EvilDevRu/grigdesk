import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ts from '../../../web/node_modules/typescript/lib/typescript.js';

export const sourceRoot = path.resolve(import.meta.dirname, '../../..');
const execute = promisify(execFile);
const identity = createHash('sha256').update(sourceRoot).digest('hex').slice(0, 12);
const cacheRoot = path.join(os.tmpdir(), `grigdesk-types-${identity}-${process.ppid}`);
const packageDirectory = path.join(cacheRoot, 'package');
const heapOption = '--max-old-space-size=3072';

/**
 * Все тяжёлые дочерние процессы двух файлов делят одну очередь и снимок пакета.
 * Каталог привязан к родительскому node:test, поэтому следующий прогон не берёт старую сборку.
 */
export async function compilerLease(action) {
  await mkdir(cacheRoot, { recursive: true });

  const lock = path.join(cacheRoot, 'compiler.lock');
  const deadline = Date.now() + 300_000;

  while (true) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() > deadline) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  try {
    return await action();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/**
 * Ограничение кучи дочернего компилятора явно перекрывает 1024 МБ сторожа.
 * OOM всегда ошибка окружения проверки и никогда не подтверждение отрицательного типа.
 */
async function executeCommand(executable, args, cwd) {
  let result;

  try {
    const output = await execute(executable, args, {
      cwd,
      env: { ...process.env, NODE_OPTIONS: heapOption },
      timeout: 240_000,
      maxBuffer: 16 * 1024 * 1024,
    });

    result = { code: 0, output: output.stdout + output.stderr };
  } catch (error) {
    assert.equal(typeof error.code, 'number', `Процесс не запущен: ${error.message}`);
    result = { code: error.code, output: String(error.stdout) + String(error.stderr) };
  }

  assert.doesNotMatch(result.output, /heap out of memory|allocation failed|FATAL ERROR/i);

  return result;
}

/**
 * Отдельная очередь удерживает только один компилятор двух тестовых файлов.
 * Сам запуск общий со сборкой пакета, чтобы повторно не брать тот же lock.
 */
export async function command(executable, args, cwd) {
  return compilerLease(() => executeCommand(executable, args, cwd));
}

/**
 * Новый пакет собирается репозиторной командой из чужого cwd с явным out-dir.
 * Два тестовых файла используют готовую папку, не удваивая тяжёлый emit.
 */
export async function builtPackage() {
  return compilerLease(async () => {
    const ready = path.join(cacheRoot, 'ready');
    const exists = await access(ready).then(() => true, () => false);

    if (!exists) {
      const result = await executeCommand('npm', [
        '--prefix', path.join(sourceRoot, 'web'), 'run', 'build:plugin-types',
        '--', '--out-dir', packageDirectory,
      ], cacheRoot);

      assert.equal(result.code, 0,
        `TSDK-PACKAGE: команда сборки пакета отсутствует или не работает:\n${result.output}`);
      await writeFile(ready, 'ready');
    }

    return packageDirectory;
  });
}

/**
 * Каждый consumer независим от исходников ядра и от других отрицательных примеров.
 * Разрешены только готовый SDK и установленные peer/tool зависимости, без сетевой установки.
 */
export async function consumer(t, { example = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-types-consumer-'));

  t.after(() => rm(directory, { recursive: true, force: true }));

  if (example) {
    const exampleRoot = path.join(sourceRoot, 'packages/plugin-types/example');
    const exists = await access(path.join(exampleRoot, 'package.json')).then(() => true, () => false);

    assert.ok(exists, 'TSDK-EXAMPLE: отсутствует версионируемый пример TS/Vue');
    await cp(exampleRoot, directory, { recursive: true });
  } else {
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  }

  const sdk = await builtPackage();
  const modules = path.join(directory, 'node_modules');

  await mkdir(path.join(modules, '@grigdesk'), { recursive: true });
  await cp(sdk, path.join(modules, '@grigdesk/plugin-types'), { recursive: true });

  for (const [name, owner] of [
    ['vue', 'web'], ['@vue', 'web'], ['fastify', 'server'], ['@types/node', 'server'],
    ['typescript', 'web'], ['vue-tsc', 'web'], ['vite', 'web'], ['@vitejs', 'web'], ['esbuild', 'web'],
  ]) {
    const target = path.join(modules, name);

    await mkdir(path.dirname(target), { recursive: true });
    await symlink(path.join(sourceRoot, owner, 'node_modules', name), target, 'dir');
  }

  await mkdir(path.join(modules, '.bin'), { recursive: true });

  for (const [name, relative] of [
    ['tsc', 'typescript/bin/tsc'], ['vue-tsc', 'vue-tsc/bin/vue-tsc.js'], ['vite', 'vite/bin/vite.js'],
  ]) {
    await symlink(path.join(modules, relative), path.join(modules, '.bin', name));
  }

  return directory;
}

/**
 * Настройки внешнего проекта преднамеренно строже внутренних emit-конфигураций.
 * Единственный paths связывает bare UI с типами; исходников ядра здесь нет.
 */
export async function compileConsumer(directory, source, { web = false } = {}) {
  const filename = web ? 'consumer.ts' : 'consumer.mts';

  await writeFile(path.join(directory, filename), source);
  await writeFile(path.join(directory, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      target: 'ES2023',
      module: web ? 'ESNext' : 'NodeNext',
      moduleResolution: web ? 'Bundler' : 'NodeNext',
      resolveJsonModule: true,
      types: ['node'],
      paths: { '@grigdesk/ui': ['./node_modules/@grigdesk/plugin-types/ui.d.ts'] },
    },
    include: [filename],
  }, null, 2));

  const compiler = web ? 'vue-tsc/bin/vue-tsc.js' : 'typescript/bin/tsc';

  return command(process.execPath, [
    path.join(sourceRoot, 'web/node_modules', compiler), '-p', 'tsconfig.json', '--pretty', 'false',
  ], directory);
}

/**
 * Подсказка редактора читается у импортированного имени во внешнем проекте автора.
 * Комментарий на reexport сам по себе не доказывает, что TypeScript покажет тег пользователю.
 */
export async function uiQuickInfo(directory, names) {
  const filename = path.join(directory, 'hints.ts');
  const source = `import { ${names.join(', ')} } from '@grigdesk/ui';\n`
    + names.map((name) => `void ${name};`).join('\n');

  await writeFile(filename, source);

  return compilerLease(async () => {
    const host = {
      getScriptFileNames: () => [filename],
      getScriptVersion: () => '1',
      getScriptSnapshot: (file) => {
        const content = ts.sys.readFile(file);

        return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
      },
      getCurrentDirectory: () => directory,
      getCompilationSettings: () => ({
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        resolveJsonModule: true,
        paths: { '@grigdesk/ui': [path.join(directory, 'node_modules/@grigdesk/plugin-types/ui.d.ts')] },
      }),
      getDefaultLibFileName: ts.getDefaultLibFilePath,
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
    };
    const service = ts.createLanguageService(host);

    try {
      const diagnostics = [
        ...service.getCompilerOptionsDiagnostics(),
        ...service.getSyntacticDiagnostics(filename),
        ...service.getSemanticDiagnostics(filename),
      ].map((item) => `TS${item.code}: ${ts.flattenDiagnosticMessageText(item.messageText, '\n')}`);

      assert.deepEqual(diagnostics, [], 'Подсказки проверяются только у корректного внешнего проекта');

      return names.map((name) => {
        const position = source.indexOf(`void ${name};`) + 'void '.length;
        const info = service.getQuickInfoAtPosition(filename, position);

        assert.ok(info?.displayParts?.length, `QuickInfo не найден для ${name}`);

        return { name, tags: (info.tags ?? []).map((tag) => tag.name) };
      });
    } finally {
      service.dispose();
    }
  });
}

/**
 * Source-level контракт проверяется с настройками обычного проекта и его импортами.
 * Узкий include исключает чужие экраны: старый дефект main.ts не подменяет RED нового контракта.
 */
export async function compileSourceContract(t, area, filename) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-types-source-'));
  const config = path.join(directory, 'tsconfig.json');
  const nodeTypes = path.join(sourceRoot, 'server/node_modules/@types/node');
  const types = area === 'web'
    ? [nodeTypes, path.join(sourceRoot, 'web/node_modules/vite/client')]
    : [nodeTypes];
  const compiler = area === 'web' ? 'vue-tsc/bin/vue-tsc.js' : 'typescript/bin/tsc';

  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(config, JSON.stringify({
    extends: path.join(sourceRoot, area, 'tsconfig.json'),
    compilerOptions: { types },
    include: [
      path.join(sourceRoot, 'tests/types', filename),
      ...(area === 'server' ? [path.join(sourceRoot, 'server/src/lib/fastifyDecorations.ts')] : []),
    ],
    exclude: [],
  }));

  return command(process.execPath, [
    path.join(sourceRoot, 'web/node_modules', compiler), '-p', config, '--pretty', 'false',
  ], sourceRoot);
}

/**
 * Отрицательный пример обязан сломаться на нужной операции в нужном файле.
 * Ошибки импорта, сервиса или исчерпания памяти не принимаются за RED типов.
 */
export function expectTypeFailure(result, filename, code) {
  assert.notEqual(result.code, 0, 'Преднамеренная ошибка типов осталась незамеченной');
  assert.match(result.output, new RegExp(`${filename.replaceAll('.', '\\.')}[^\\n]*${code}`));
  assert.doesNotMatch(result.output, /TS2307|TS2688|Cannot find module|heap out of memory/i);
}

/**
 * Список файлов нужен для проверки переносимости и состава готового payload.
 * Обход ограничен созданной тестом папкой, ссылки на исходное дерево не разыменовываются.
 */
export async function filesUnder(directory) {
  const result = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      result.push(...await filesUnder(name));
    } else {
      assert.equal(entry.isSymbolicLink(), false, `Ссылка в переносимом пакете: ${name}`);
      result.push(name);
    }
  }

  return result;
}

/**
 * Checker определяет значения, а AST сохраняет границы type-only на каждом reexport.
 * Звёздочка раскрывается только по путям значений: export type * не даёт runtime-имён.
 */
function moduleValues(checker, symbol, visited = new Set()) {
  if (visited.has(symbol)) {
    return new Set();
  }

  const branch = new Set([...visited, symbol]);
  const source = symbol.declarations?.find(ts.isSourceFile);
  const names = new Set();

  for (const item of checker.getExportsOfModule(symbol)) {
    const target = item.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(item) : item;

    if (!(target.flags & ts.SymbolFlags.Value)) {
      continue;
    }

    for (const node of item.declarations ?? []) {
      if (node.getSourceFile() !== source) {
        continue;
      }
      if (ts.isExportSpecifier(node)) {
        const declaration = node.parent.parent;

        if (node.isTypeOnly || declaration.isTypeOnly) {
          continue;
        }
        if (declaration.moduleSpecifier) {
          const origin = checker.getSymbolAtLocation(declaration.moduleSpecifier);
          const originalName = node.propertyName?.text ?? node.name.text;

          if (!origin || !moduleValues(checker, origin, branch).has(originalName)) {
            continue;
          }
        }
      }

      names.add(item.name);
    }
  }

  for (const node of source?.statements ?? []) {
    if (!ts.isExportDeclaration(node) || node.isTypeOnly || node.exportClause || !node.moduleSpecifier) {
      continue;
    }

    const origin = checker.getSymbolAtLocation(node.moduleSpecifier);

    if (origin) {
      for (const name of moduleValues(checker, origin, branch)) {
        if (name !== 'default') {
          names.add(name);
        }
      }
    }
  }

  return names;
}

/**
 * Сверяется только собственный UI entry пакета и его достижимые reexport.
 * Транзитивные экспорты peer Vue не объявляются частью фасада GrigDesk.
 */
export function declarationValues(entry) {
  const program = ts.createProgram([entry], {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    resolveJsonModule: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const symbol = source && checker.getSymbolAtLocation(source);

  assert.ok(symbol, 'UI entry должен быть модулем деклараций');

  return [...moduleValues(checker, symbol)].sort();
}

/**
 * Один алгоритм используется для настоящего chunk и для его повреждённой копии.
 * Имя потерянного значения выводится в ошибке, чтобы отрицательный случай был адресным.
 */
export function assertFacadeSubset(declarations, runtimeExports) {
  const available = new Set(runtimeExports);
  const missing = declarations.filter((name) => !available.has(name));

  assert.deepEqual(missing, [], `В runtime-фасаде отсутствуют значения: ${missing.join(', ')}`);
}

export { ts };
