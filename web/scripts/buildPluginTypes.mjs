import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const internalExports = new Set([
  'UiDialogHost', 'UiTooltipHost', 'UiToastHost', 'closeTopLayer',
  'getUiLayerDiagnostics', 'subscribeUiLayerDiagnostics', 'setUiDownloadAdapter', 'setUiLocale',
  'dismissAllToasts', 'dismissToast', 'dismissToastScope', 'listToasts', 'showToast',
  'subscribeToastDismissals', 'subscribeToasts',
]);
const printer = ts.createPrinter();

/**
 * Декларации собираются только во внешнюю папку, которую явно выбрал автор.
 * Непустая папка не перезаписывается: сборщик не владеет чужими файлами.
 */
async function outputDirectory() {
  const args = process.argv.slice(2);

  if (args.length !== 2 || args[0] !== '--out-dir' || !path.isAbsolute(args[1])) {
    throw new Error('Укажите --out-dir <абсолютная внешняя папка>');
  }

  const output = path.resolve(args[1]);
  const relative = path.relative(root, output);

  if (!relative || !relative.startsWith(`..${path.sep}`) && relative !== '..') {
    throw new Error('Папка результата должна находиться вне исходного дерева');
  }

  await mkdir(output, { recursive: true });

  if ((await readdir(output)).length) {
    throw new Error('Папка результата должна быть пустой');
  }

  return output;
}

/**
 * Компиляторы работают последовательно с явным пределом кучи.
 * Ошибка emit прерывает сборку, незавершённый пакет автору не передаётся.
 */
function emitDeclarations(area, compiler, directory) {
  execFileSync(process.execPath, [
    '--max-old-space-size=3072', path.join(root, area, 'node_modules', compiler),
    '-p', path.join(root, area, 'tsconfig.plugin-types.json'), '--outDir', directory,
  ], { cwd: root, stdio: 'inherit' });
}

/**
 * Обход ограничен временной папкой emit и не следует по символическим ссылкам.
 * Список используется для обработки всего достижимого графа деклараций.
 */
async function declarationFiles(directory) {
  const files = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...await declarationFiles(file));
    } else if (entry.isFile() && file.endsWith('.d.ts')) {
      files.push(file);
    }
  }

  return files;
}

/**
 * Vue compiler-global содержит только собственные помощники __VLS_.
 * Смешанный блок нельзя удалять: в нём может оказаться настоящий контракт компонента.
 */
function compilerGlobal(node) {
  if (!ts.isModuleDeclaration(node) || node.name.text !== 'global'
    || !node.body || !ts.isModuleBlock(node.body)) {
    return false;
  }

  const names = node.body.statements.flatMap((statement) => {
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.map((item) => item.name.getText());
    }

    return 'name' in statement && statement.name ? [statement.name.getText()] : [''];
  });

  if (!names.some((name) => name.startsWith('__VLS_'))) {
    return false;
  }

  if (!names.every((name) => name.startsWith('__VLS_'))) {
    throw new Error('Смешанный declare global: требуется проверка новой версии vue-tsc');
  }

  return true;
}

/**
 * Только файловые ссылки меняют расширение для внешнего NodeNext consumer.
 * Строки типов, переводы и сами локальные помощники Vue остаются без изменений.
 */
function moduleLiteral(node) {
  return ts.isStringLiteral(node) && (ts.isImportDeclaration(node.parent)
    || ts.isExportDeclaration(node.parent)
    || ts.isLiteralTypeNode(node.parent) && ts.isImportTypeNode(node.parent.parent));
}

/**
 * Подсказки TypeScript берут JSDoc из исходного объявления, а не строки reexport.
 * Checker находит объявления служебных экспортов; пометки меняют только готовый пакет.
 */
async function markInternalDeclarations(directory) {
  const entry = path.join(directory, 'web/src/ui.d.ts');
  const program = ts.createProgram([entry], {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowArbitraryExtensions: true,
    resolveJsonModule: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const symbol = source && checker.getSymbolAtLocation(source);

  if (!symbol) {
    throw new Error('Не найден модуль деклараций UI');
  }

  const exports = new Map(checker.getExportsOfModule(symbol).map((item) => [item.name, item]));
  const declarations = new Set();
  const sources = new Set();

  for (const name of internalExports) {
    const exported = exports.get(name);

    if (!exported) {
      throw new Error(`Не найден служебный экспорт ${name}`);
    }

    const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;

    if (!target.declarations?.length) {
      throw new Error(`Не найдено объявление служебного экспорта ${name}`);
    }

    for (const declaration of target.declarations) {
      const statement = ts.isVariableDeclaration(declaration) ? declaration.parent.parent : declaration;
      const source = statement.getSourceFile();

      if (path.relative(directory, source.fileName).startsWith('..')) {
        throw new Error(`Объявление ${name} находится за пределами пакета`);
      }

      declarations.add(statement);
      sources.add(source);
    }
  }

  for (const declaration of declarations) {
    ts.addSyntheticLeadingComment(declaration, ts.SyntaxKind.MultiLineCommentTrivia,
      '* @internal Служебная возможность общего окна. ', true);
  }

  for (const source of sources) {
    await writeFile(source.fileName, printer.printFile(source));
  }
}

/**
 * AST отбрасывает только compiler-global и проверяет границу внутренних типов.
 * Все остальные сигнатуры props, событий, слотов и переводчика сохраняются из emit.
 */
async function prepareDeclaration(file, directory) {
  const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const json = [];
  const transformed = ts.transform(source, [(context) => {
    /**
     * Посетитель проверяет границу пакета до записи файла и сохраняет локальные типы.
     * Файловые импорты обрабатываются независимо от бизнес-строк и локальных имён типов.
     */
    const visit = (node) => {
      if (ts.isIdentifier(node) && ['DocumentReader', 'PrefsStore'].includes(node.text)) {
        throw new Error(`Внутренний тип ${node.text} в ${file}`);
      }

      if (compilerGlobal(node)) {
        return undefined;
      }

      if (moduleLiteral(node)) {
        const specifier = node.text;

        if (path.isAbsolute(specifier) || specifier.includes('server/src')) {
          throw new Error(`Внутренняя ссылка ${specifier} в ${file}`);
        }

        if (specifier.startsWith('.')) {
          const target = path.resolve(path.dirname(file), specifier);
          const relative = path.relative(directory, target);

          if (relative.startsWith('..')) {
            throw new Error(`Ссылка за пределы пакета: ${specifier}`);
          }

          if (specifier.endsWith('.json')) {
            json.push(relative);
          } else {
            const rewritten = specifier.replace(/\.ts$/u, '.js');

            return ts.factory.createStringLiteral(path.extname(rewritten) ? rewritten : `${rewritten}.js`);
          }
        }
      }

      return ts.visitEachChild(node, visit, context);
    };

    return (node) => ts.visitNode(node, visit);
  }]);

  try {
    await writeFile(file, printer.printFile(transformed.transformed[0]));
  } finally {
    transformed.dispose();
  }

  for (const relative of json) {
    const target = path.join(directory, relative);

    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(root, relative), target);
  }
}

/**
 * Четыре входа пакета используют один снимок типов и текущие peer-версии.
 * Содержимое пакета не включает серверные реализации или инструменты разработки.
 */
async function buildPackage() {
  const output = await outputDirectory();
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-plugin-types-'));
  const directory = path.join(temporary, 'declarations');

  try {
    emitDeclarations('server', 'typescript/bin/tsc', directory);
    emitDeclarations('web', 'vue-tsc/bin/vue-tsc.js', directory);

    for (const file of await declarationFiles(directory)) {
      await prepareDeclaration(file, directory);
    }

    await markInternalDeclarations(directory);

    const metadataFile = path.join(root, 'packages/plugin-types/package.json');
    const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
    const lock = JSON.parse(await readFile(path.join(root, 'web/package-lock.json'), 'utf8'));
    const version = (await readFile(path.join(root, 'VERSION'), 'utf8')).trim();
    const entries = {
      index: 'packages/plugin-types/src/index.js',
      server: 'packages/plugin-types/src/server.js',
      web: 'packages/plugin-types/src/web.js',
      ui: 'web/src/pluginRuntime/ui.js',
    };

    metadata.version = `${version}-api2.1`;
    metadata.grigDeskVersion = version;
    metadata.exports = {};
    metadata.peerDependencies = { vue: `~${lock.packages['node_modules/vue'].version}`, fastify: '^5.2.0' };
    metadata.peerDependenciesMeta = { fastify: { optional: true } };

    for (const [name, entry] of Object.entries(entries)) {
      metadata.exports[name === 'index' ? '.' : `./${name}`] = { types: `./${name}.d.ts` };
      await writeFile(path.join(temporary, `${name}.d.ts`), `export * from './declarations/${entry}';\n`);
    }

    await writeFile(path.join(temporary, 'package.json'), `${JSON.stringify(metadata, null, 2)}\n`);

    for (const entry of await readdir(temporary)) {
      await cp(path.join(temporary, entry), path.join(output, entry), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    }

    console.log(`Пакет типов собран: ${output}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await buildPackage();
