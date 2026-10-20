import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { build as esbuildBuild } from 'esbuild';
import ts from 'typescript';

import { createRuntimeContextPlugin } from './context.mts';
import { createModuleUrlsPlugin } from './moduleUrls.mts';

/**
 * Сборка собственных helper-ов с явным входом.
 *
 * Точка входа helper-а — не сам исходный скрипт, а маленький сгенерированный ESM
 * entry: он импортирует нужный export и вызывает его один раз. Библиотечный импорт
 * исходника поэтому не запускает CLI. Manifest фиксирует вид входа, exports,
 * ресурсы и относительные вызовы; абсолютные пути checkout в результат не попадают.
 */

export type HelperEntryKind = 'main' | 'script' | 'library';

export interface HelperDefinition {
  id: string;
  entry: string;
  entryKind: HelperEntryKind;
  exports: string[];
  description: string;
  resources?: string[];
}

export interface HelperManifest {
  schema: number;
  helpers: HelperDefinition[];
}

export interface BuildHelperInput {
  manifestPath?: string;
  manifest?: HelperManifest;
  id: string;
  outDir: string;
  workDir: string;
  root: string;
  esbuild?: typeof esbuildBuild;
}

export interface BuiltHelper {
  id: string;
  file: string;
  size: number;
}

const HELPER_ID = /^[a-z0-9][a-z0-9-]*$/u;
const ENTRY_KINDS = new Set<HelperEntryKind>(['main', 'script', 'library']);

/**
 * Читает и проверяет manifest helper-ов до файловых эффектов сборки.
 * Пути entry остаются относительными: абсолютный checkout в manifest недопустим.
 */
export async function loadHelpers(file: string, root: string): Promise<HelperManifest> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Некорректный manifest helper-ов ${file}: ${(error as Error).message}`);
  }

  const record = parsed as Partial<HelperManifest> | null;

  if (!record || record.schema !== 1 || !Array.isArray(record.helpers) || record.helpers.length === 0) {
    throw new Error(`Некорректный manifest helper-ов ${file}`);
  }

  const seen = new Set<string>();

  for (const helper of record.helpers) {
    const label = `helper ${String(helper?.id)}`;

    if (!helper || typeof helper.id !== 'string' || !HELPER_ID.test(helper.id)) {
      throw new Error(`Некорректный id ${label} в ${file}`);
    }

    if (seen.has(helper.id)) {
      throw new Error(`Повтор ${label} в ${file}`);
    }

    seen.add(helper.id);

    if (typeof helper.entry !== 'string' || helper.entry === ''
      || path.isAbsolute(helper.entry) || helper.entry.startsWith('../')) {
      throw new Error(`Некорректный entry ${label} в ${file}`);
    }

    if (!ENTRY_KINDS.has(helper.entryKind)) {
      throw new Error(`Некорректный вид входа ${label} в ${file}: ${String(helper.entryKind)}`);
    }

    if (!Array.isArray(helper.exports) || helper.exports.some((name) => typeof name !== 'string')) {
      throw new Error(`Некорректные exports ${label} в ${file}`);
    }

    if (helper.entryKind === 'main' && !helper.exports.includes('main')) {
      throw new Error(`Helper ${helper.id} должен экспортировать main`);
    }

    if (typeof helper.description !== 'string' || helper.description.trim() === '') {
      throw new Error(`Пустое описание ${label} в ${file}`);
    }

    if (helper.resources !== undefined && (!Array.isArray(helper.resources)
      || helper.resources.some((item) => typeof item !== 'string'))) {
      throw new Error(`Некорректные resources ${label} в ${file}`);
    }
  }

  if (!path.isAbsolute(root)) {
    throw new Error(`Корень helper-ов должен быть абсолютным: ${root}`);
  }

  return {
    schema: 1,
    helpers: record.helpers,
  };
}

/**
 * Собирает имена, которые модуль экспортирует на верхнем уровне.
 * Модуль не исполняется: проверка идёт по TypeScript AST, до esbuild.
 */
function exportedNames(source: string, file: string): Set<string> {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set<string>();

  for (const statement of parsed.statements) {
    if (ts.isExportAssignment(statement)) {
      names.add('default');
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) {
        names.add('*');
        continue;
      }

      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          names.add(element.name.text);
        }
      }

      continue;
    }

    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;

    if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      continue;
    }

    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name) {
        names.add(statement.name.text);
      }

      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.add(declaration.name.text);
        }
      }
    }
  }

  return names;
}

/**
 * Проверяет, что исходник действительно экспортирует нужные имена.
 * Guard по import.meta.url без main — явная ошибка, а не пустой успешный helper.
 */
async function assertExports(helper: HelperDefinition, entryFile: string): Promise<void> {
  const source = await readFile(entryFile, 'utf8');
  const names = exportedNames(source, entryFile);

  if (names.has('*')) {
    return;
  }

  for (const name of helper.exports) {
    if (!names.has(name)) {
      throw new Error(`Helper ${helper.id}: вход ${helper.entry} не экспортирует ${name}`);
    }
  }
}

/**
 * Строит относительный import-спецификатор от сгенерированного entry к исходнику.
 */
function relativeSpecifier(outputFile: string, targetFile: string): string {
  const relative = path.relative(path.dirname(outputFile), targetFile).split(path.sep).join('/');

  return relative.startsWith('.') ? relative : `./${relative}`;
}

/**
 * Генерирует ESM entry helper-а: импорт нужных exports и ровно один вызов main.
 * Для вида script сохраняется прежнее поведение — импорт ради побочного запуска.
 */
export function renderHelperEntry(helper: HelperDefinition, outputFile: string, root: string): string {
  const entryFile = path.resolve(root, helper.entry);
  const specifier = JSON.stringify(relativeSpecifier(outputFile, entryFile));

  if (helper.entryKind === 'script') {
    return `// Сгенерировано server/scripts/sea/helpers.mts. Не редактировать вручную.\n`
      + `import ${specifier};\n`;
  }

  if (helper.entryKind === 'library') {
    return `export * from ${specifier};\n`;
  }

  const imports = [...new Set(helper.exports)].join(', ');
  const helperEntry = path.resolve(root, 'server/src/lib/helperEntry.ts');
  const marker = JSON.stringify(relativeSpecifier(outputFile, helperEntry));

  return `// Сгенерировано server/scripts/sea/helpers.mts. Не редактировать вручную.\n`
    + `import { markHelperEntry } from ${marker};\n`
    + '\nmarkHelperEntry(' + JSON.stringify(helper.id) + ');\n'
    + `\nconst { ${imports} } = await import(${specifier});\n`
    + `\nexport { ${imports} };\n`
    + '\nconst result = await main(process.argv.slice(2));\n'
    + '\nif (typeof result === \'number\') {\n  process.exitCode = result;\n}\n';
}

/**
 * Собирает один helper: генерирует entry, проверяет exports и бандлит ESM.
 * `packages: external` сохраняет npm-пакеты внешними; sourcemap не создаётся.
 */
export async function buildHelper(input: BuildHelperInput): Promise<BuiltHelper> {
  const manifestFile = input.manifestPath;

  if (!manifestFile && !input.manifest) {
    throw new Error('Helper: нужен manifestPath или manifest');
  }

  const manifest = input.manifest ?? await loadHelpers(manifestFile!, input.root);
  const helper = manifest.helpers.find((entry) => entry.id === input.id);

  if (!helper) {
    throw new Error(`Неизвестный helper: ${input.id}`);
  }

  const entryFile = path.resolve(input.root, helper.entry);

  await stat(entryFile).catch((error: NodeJS.ErrnoException) => {
    throw new Error(`Helper ${helper.id}: нет входа ${helper.entry}: ${error.message}`);
  });

  if (helper.entryKind !== 'script') {
    await assertExports(helper, entryFile);
  }

  await mkdir(input.workDir, {
    recursive: true
  });
  await mkdir(input.outDir, {
    recursive: true
  });

  const generated = path.join(input.workDir, `${helper.id}.mjs`);
  const outfile = path.join(input.outDir, `${helper.id}.mjs`);
  const esbuild = input.esbuild ?? esbuildBuild;
  const moduleUrls = createModuleUrlsPlugin({
    root: input.root,
    runtimeModule: path.join(input.root, 'server/src/lib/runtimePaths.ts'),
    // Supervisor повторно запускает свой реальный ESM entry, а не URL исходника.
    skip: [generated, path.join(input.root, 'server/src/lib/pluginInstall/commandSupervisor.mjs')],
  });

  await writeFile(generated, renderHelperEntry(helper, generated, input.root));

  const result = await esbuild({
    entryPoints: [generated],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'external',
    sourcemap: false,
    logLevel: 'silent',
    plugins: [createRuntimeContextPlugin(input.root, 'helper'), moduleUrls.plugin],
  });

  if (result.warnings.length > 0) {
    throw new Error(result.warnings.map((warning) => warning.text).join('\n'));
  }

  return {
    id: helper.id,
    file: outfile,
    size: (await stat(outfile)).size,
  };
}
