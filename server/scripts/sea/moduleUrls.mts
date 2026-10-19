import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Loader, Plugin } from 'esbuild';
import ts from 'typescript';

/**
 * Плагин esbuild для сохранения смысла import.meta после объединения файлов.
 *
 * Каждый собственный модуль получает URL своего прежнего места в комплекте, а не
 * один общий define. Строки, комментарии и похожие идентификаторы не меняются:
 * переписываются только реальные узлы TypeScript AST.
 */

export interface ModuleUrlsOptions {
  root: string;
  runtimeModule: string;
  skip?: readonly string[];
  skipBasenames?: readonly string[];
}

export interface ModuleUrlsHandle {
  plugin: Plugin;
  transformed: string[];
}

export interface RewriteResult {
  changed: boolean;
  code: string;
}

const DEFAULT_SKIP_BASENAMES = ['runtimeBuildContext.ts'];
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

/**
 * Возвращает имя помощника, которого нет в исходнике.
 * Суффикс из подчёркиваний не даёт столкнуться с локальной переменной файла.
 */
function helperNames(source: string): {
  url: string;
  dirname: string;
  filename: string;
} {
  let suffix = '';

  while (source.includes(`__seaModuleUrl${suffix}`)
    || source.includes(`__seaModuleDirname${suffix}`)
    || source.includes(`__seaModuleFilename${suffix}`)) {
    suffix += '_';
  }

  return {
    url: `__seaModuleUrl${suffix}`,
    dirname: `__seaModuleDirname${suffix}`,
    filename: `__seaModuleFilename${suffix}`,
  };
}

/**
 * Определяет разбор файла по расширению, чтобы AST не принял TS за JS.
 * Неизвестные расширения из фильтра сюда не попадают.
 */
function scriptKind(file: string): ts.ScriptKind {
  const extension = path.extname(file);

  if (extension === '.tsx') {
    return ts.ScriptKind.TSX;
  }

  if (extension === '.jsx') {
    return ts.ScriptKind.JSX;
  }

  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    return ts.ScriptKind.JS;
  }

  return ts.ScriptKind.TS;
}

/**
 * Возвращает загрузчик esbuild для уже разобранного файла.
 * TypeScript-расширения остаются ts, JavaScript-расширения — js.
 */
function loaderFor(file: string): Loader {
  const extension = path.extname(file);

  if (extension === '.tsx') {
    return 'tsx';
  }

  if (extension === '.jsx') {
    return 'jsx';
  }

  if (extension === '.ts' || extension === '.mts' || extension === '.cts') {
    return 'ts';
  }

  return 'js';
}

/**
 * Переписывает import.meta.url/dirname/filename в вызовы контракта путей.
 *
 * Файл вне корня и неподдержанная форма import.meta — явная ошибка сборки:
 * молчаливая замена сломала бы ресурс или запуск helper-а позже.
 */
export function rewriteModuleImportMeta(source: string, file: string,
  options: ModuleUrlsOptions): RewriteResult {
  const relative = path.relative(options.root, file);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`moduleUrl: файл ${file} вне корня ${options.root}`);
  }

  const modulePath = relative.split(path.sep).join('/');
  const names = helperNames(source);
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const replacements: Array<{
    start: number;
    end: number;
    text: string;
  }> = [];

  /**
   * Обходит AST и собирает замены только для свойств import.meta.
   * Вложенный вызов visit не заходит в имя свойства повторно.
   */
  function visit(node: ts.Node): void {
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      const parent = node.parent;
      const position = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
      const place = `${file}:${position.line + 1}`;

      if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node) {
        throw new Error(`import.meta в ${place}: неподдержанная форма; `
          + 'используйте import.meta.url, .dirname или .filename');
      }

      const property = parent.name.text;
      const helper = property === 'url'
        ? names.url
        : property === 'dirname'
          ? names.dirname
          : property === 'filename'
            ? names.filename
            : '';

      if (!helper) {
        throw new Error(`import.meta.${property} в ${place}: неподдержанная форма; `
          + 'используйте import.meta.url, .dirname или .filename');
      }

      replacements.push({
        start: parent.getStart(parsed),
        end: parent.end,
        text: `${helper}(${JSON.stringify(modulePath)})`,
      });

      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(parsed);

  if (replacements.length === 0) {
    return {
      changed: false,
      code: source,
    };
  }

  let code = source;

  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    code = code.slice(0, replacement.start) + replacement.text + code.slice(replacement.end);
  }

  const importLine = `import { moduleUrl as ${names.url}, moduleDirname as ${names.dirname}, `
    + `moduleFilename as ${names.filename} } from ${JSON.stringify(options.runtimeModule)};\n`;
  const insertAt = code.startsWith('#!') ? code.indexOf('\n') + 1 : 0;

  return {
    changed: true,
    code: code.slice(0, insertAt) + importLine + code.slice(insertAt),
  };
}

/**
 * Создаёт плагин onLoad для собственных файлов.
 * node_modules, виртуальные входы, файл контекста и явный skip остаются нетронутыми,
 * чтобы сгенерированный контекст и helper entry не зациклились на своём URL.
 */
export function createModuleUrlsPlugin(options: ModuleUrlsOptions): ModuleUrlsHandle {
  const transformed: string[] = [];
  const skip = new Set((options.skip ?? []).map((file) => path.resolve(file)));
  const skipBasenames = new Set([...DEFAULT_SKIP_BASENAMES, ...(options.skipBasenames ?? [])]);
  const plugin: Plugin = {
    name: 'sea-module-urls',
    setup(build) {
      build.onLoad({ filter: SOURCE_FILE }, async (args) => {
        const file = path.resolve(args.path);
        const basename = path.basename(file);

        if (args.namespace !== 'file'
          || file.split(path.sep).includes('node_modules')
          || skip.has(file)
          || skipBasenames.has(basename)) {
          return null;
        }

        const source = await readFile(file, 'utf8');
        const result = rewriteModuleImportMeta(source, file, options);

        if (!result.changed) {
          return null;
        }

        transformed.push(file);

        return {
          contents: result.code,
          loader: loaderFor(file),
          resolveDir: path.dirname(file),
        };
      });
    },
  };

  return {
    plugin,
    transformed,
  };
}
