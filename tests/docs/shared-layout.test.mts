import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from '../../server/node_modules/typescript/lib/typescript.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const shared = join(root, 'shared');
const sourceExtensions = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.vue']);

/**
 * Обходит только исходники заданной области, не следуя символическим ссылкам.
 * Собранные файлы и зависимости не участвуют в проверке собственного слоя.
 */
function sourceFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.cache', '.generated'].includes(entry.name)) {
      continue;
    }

    const file = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...sourceFiles(file));
    } else if (entry.isFile() && sourceExtensions.has(extname(file))) {
      files.push(file);
    }
  }

  return files;
}

/**
 * Читает зависимости из синтаксиса, поэтому комментарии не становятся импортами.
 * У SFC разбирает только script; import type и динамические ссылки тоже учитываются.
 */
function references(file: string, source = readFileSync(file, 'utf8')): string[] {
  const scripts = file.endsWith('.vue')
    ? [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? '')
    : [source];
  const found: string[] = [];

  for (const script of scripts) {
    const syntax = ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true);

    // Только узлы зависимостей дают спецификатор: обычные строки не участвуют.
    // Обход детей сохраняет вложенные import() и ссылки внутри типов.
    function visit(node: ts.Node): void {
      let spec: ts.Node | undefined;

      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        spec = node.moduleSpecifier;
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        spec = node.moduleReference.expression;
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        spec = node.argument.literal;
      } else if (ts.isCallExpression(node) && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(syntax) === 'require'
      )) {
        spec = node.arguments[0];
      } else if (ts.isNewExpression(node) && node.expression.getText(syntax) === 'URL'
        && node.arguments?.[1]?.getText(syntax) === 'import.meta.url') {
        spec = node.arguments[0];
      }

      if (spec && (ts.isStringLiteral(spec) || ts.isNoSubstitutionTemplateLiteral(spec))) {
        found.push(spec.text);
      } else if (spec) {
        found.push('<вычисляемая зависимость>');
      }

      ts.forEachChild(node, visit);
    }

    visit(syntax);
  }

  return found;
}

function isInside(directory: string, file: string): boolean {
  const path = relative(directory, file);

  return path !== '..' && !path.startsWith('../') && !path.startsWith('/');
}

/**
 * Разрешает и явный путь Node, и короткий импорт сборщика браузера.
 * Каталог сам по себе не является модулем: в нём нужен индексный исходник.
 */
function moduleFile(target: string): string | undefined {
  return [target, `${target}.ts`, `${target}.js`, `${target}.vue`,
    join(target, 'index.ts'), join(target, 'index.js')]
    .find((file) => existsSync(file) && statSync(file).isFile());
}

function areaOf(file: string): string {
  const parts = relative(shared, file).split('/');

  return parts[0] === 'plugins' && parts.length > 2 && parts[1] !== 'slots'
    ? parts.slice(0, 2).join('/') : parts[0] ?? '';
}

/**
 * Ищет обратное ребро по текущему стеку, а не по всем посещённым узлам.
 * Общая зависимость двух областей допустима; замкнутая цепочка показывает цикл.
 */
function cycles(graph: Map<string, Set<string>>): string[] {
  const done = new Set<string>();
  const found: string[] = [];

  // Серый узел в текущем пути доказывает цикл; законченная ветвь уже проверена.
  // Стек передаётся копией, поэтому соседние ветви не смешивают свои пути.
  function visit(area: string, chain: string[]): void {
    if (chain.includes(area)) {
      found.push([...chain.slice(chain.indexOf(area)), area].join(' → '));

      return;
    }
    if (done.has(area)) {
      return;
    }

    for (const target of graph.get(area) ?? []) {
      visit(target, [...chain, area]);
    }

    done.add(area);
  }

  for (const area of graph.keys()) {
    visit(area, []);
  }

  return found;
}

test('shared: исходники разложены по областям, корневых TS-файлов нет', () => {
  assert.deepEqual(readdirSync(shared).filter((name) => name.endsWith('.ts')), []);
});

test('shared: Node разрешён только в node, сторонние пакеты и выход наружу запрещены', () => {
  const errors: string[] = [];

  for (const file of sourceFiles(shared)) {
    const name = relative(root, file);

    for (const spec of references(file)) {
      if (spec.startsWith('node:') && isInside(join(shared, 'node'), file)) {
        continue;
      }
      if (!spec.startsWith('.') || !isInside(shared, resolve(dirname(file), spec))) {
        errors.push(`${name} → ${spec}`);

        continue;
      }

      const target = resolve(dirname(file), spec);

      if (!existsSync(target)) {
        errors.push(`${name} → отсутствует ${spec}`);
      }
      if (isInside(join(shared, 'node'), target) && !isInside(join(shared, 'node'), file)) {
        errors.push(`${name} → Node-зависимость ${spec}`);
      }
    }
  }

  assert.deepEqual(errors, []);
});

test('shared: граф областей не содержит циклов', () => {
  const graph = new Map<string, Set<string>>();

  for (const file of sourceFiles(shared)) {
    const area = areaOf(file);
    const edges = graph.get(area) ?? new Set<string>();

    graph.set(area, edges);

    for (const spec of references(file).filter((value) => value.startsWith('.'))) {
      const target = areaOf(resolve(dirname(file), spec));

      if (area !== target) {
        edges.add(target);
      }
    }
  }

  assert.deepEqual(cycles(graph), []);
});

test('web: прямые и транзитивные зависимости не достигают shared/node', () => {
  const queue = sourceFiles(join(root, 'web/src'));
  const visited = new Set<string>();
  const errors: string[] = [];

  while (queue.length) {
    const file = queue.pop()!;

    if (visited.has(file)) {
      continue;
    }

    visited.add(file);

    for (const spec of references(file)) {
      const target = spec.startsWith('.') ? resolve(dirname(file), spec) : resolve(root, spec);

      if (isInside(join(shared, 'node'), target)) {
        errors.push(`${relative(root, file)} → ${spec}`);
      } else if (spec.startsWith('.')) {
        const resolved = moduleFile(target);

        if (resolved && sourceExtensions.has(extname(resolved))) {
          queue.push(resolved);
        }
      }
    }
  }

  assert.deepEqual(errors, []);
});

test('web: относительные ссылки на оба shared разрешаются на диске', () => {
  const errors: string[] = [];
  const webShared = join(root, 'web/src/shared');

  for (const file of sourceFiles(join(root, 'web/src'))) {
    for (const spec of references(file).filter((value) => value.startsWith('.'))) {
      const target = resolve(dirname(file), spec);

      if ((isInside(shared, target) || isInside(webShared, target)) && !moduleFile(target)) {
        errors.push(`${relative(root, file)} → ${spec}`);
      }
    }
  }

  assert.deepEqual(errors, []);
});

test('сторож видит import, export, динамический import, require, тип и URL', () => {
  const source = [
    "import './a.ts';",
    "export { value } from './b.ts';",
    "const module = import('./c.ts');",
    "const common = require('./d.ts');",
    "type Value = import('./e.ts').Value;",
    "new URL('./f.ts', import.meta.url);",
    "import commonJs = require('./g.ts');",
    'const computed = import(modulePath);',
    "// import './ignored.ts';",
  ].join('\n');

  assert.deepEqual(references('fixture.ts', source), [
    './a.ts', './b.ts', './c.ts', './d.ts', './e.ts', './f.ts', './g.ts',
    '<вычисляемая зависимость>',
  ]);
  assert.deepEqual(references('fixture.vue', `<template>import './ignored.ts'</template>
<script setup lang="ts">import './a.ts';</script>`), ['./a.ts']);
});

test('сторож отличает цикл от общего зависимого узла', () => {
  const graph = new Map([
    ['a', new Set(['b', 'lib'])],
    ['b', new Set(['lib'])],
  ]);

  assert.deepEqual(cycles(graph), []);
  graph.set('lib', new Set(['a']));
  assert.deepEqual(cycles(graph), ['a → b → lib → a']);
});

test('web: типовая программа не включает Node-модули по шаблону shared', () => {
  const configFile = join(root, 'web/tsconfig.json');
  const source = ts.readConfigFile(configFile, ts.sys.readFile);
  const config = ts.parseJsonConfigFileContent(source.config, ts.sys, dirname(configFile));

  assert.equal(source.error, undefined);
  assert.deepEqual(config.fileNames.filter((file) => isInside(join(shared, 'node'), file)), []);
});
