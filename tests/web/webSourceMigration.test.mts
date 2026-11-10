import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from '../../web/node_modules/typescript/lib/typescript.js';

const { parse }: typeof import('../../web/node_modules/@vue/compiler-sfc') = await import(
  new URL('../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js', import.meta.url).href
);

import { loadMigrationModule } from './helpers/compile-vue.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scope: { pairs: Record<string, string>; vue: string[] } = JSON.parse(readFileSync(
  path.join(root, 'tests/fixtures/webMigrationScope.json'), 'utf8',
));
const baseline: {
  exports: Record<string, string[]>;
  routes: Array<{ component?: string }>;
} = JSON.parse(readFileSync(
  path.join(root, 'tests/fixtures/webRuntimeBaseline.json'), 'utf8',
));
const lazyViewStubs = Object.fromEntries(baseline.routes.flatMap((route) => (
  route.component?.endsWith('.vue') ? [[route.component, 'export default {};']] : []
)));

const moduleGroups = {
  'small-stores': ['auth', 'system', 'grigdeskUpdate', 'taskFavorites', 'taskSeen'],
  'provider-stores': ['providers', 'plugins', 'notifyWatch'],
  b24: ['board', 'tasks', 'ui'],
  chat: ['chat', 'chatApprovals'],
  speech: ['controller', 'provider', 'speechStream', 'speechPcmWorklet'],
  bootstrap: ['main', 'router'],
};

/**
 * Обходит независимый каталог, включая новые файлы, которых нет в таблице переноса.
 * node_modules и сборочные каталоги сюда не попадают: вход всегда product src или docs/tests.
 */
function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && ['plans', 'local'].includes(entry.name)
      && directory === path.join(root, 'docs')) {
      return [];
    }

    const filename = path.join(directory, entry.name);

    return entry.isDirectory() ? filesBelow(filename) : [filename];
  });
}

for (const [group, names] of Object.entries(moduleGroups)) {
  test(`MIG-${group}`, async () => {
    for (const [oldPath, newPath] of Object.entries(scope.pairs)) {
      if (!names.includes(path.basename(newPath, '.ts'))) {
        continue;
      }

      assert.ok(existsSync(path.join(root, newPath)), `нет TypeScript: ${newPath}`);
      assert.equal(existsSync(path.join(root, oldPath)), false, `остался JS: ${oldPath}`);

      const expected = baseline.exports[newPath];

      if (newPath.endsWith('/main.ts') || newPath.endsWith('/speechPcmWorklet.ts')) {
        const source = ts.createSourceFile(newPath, readFileSync(path.join(root, newPath), 'utf8'),
          ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const runtime = source.statements.filter((statement) => (
          ts.isExportAssignment(statement)
          || (ts.isExportDeclaration(statement) && !statement.isTypeOnly
            && Boolean(statement.moduleSpecifier || statement.exportClause?.getText() !== '{}'))
          || (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((modifier) => (
            modifier.kind === ts.SyntaxKind.ExportKeyword
            && !ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)
          )))
        ));

        assert.deepEqual(runtime.map((statement) => statement.getText()), expected);
      } else {
        const module = await loadMigrationModule(oldPath.slice(4), newPath.slice(4), {
          'vue-router': `export const createWebHashHistory = () => ({});
            export const createRouter = (options) => options;`,
          './views/settings/settingsRouteStub.ts': 'export default {};',
          ...lazyViewStubs,
        });

        assert.deepEqual(Object.keys(module).sort(), expected, newPath);
      }
    }
  });
}

const viewGroups = {
  A: (file: string) => file === 'web/src/App.vue' || file.includes('/shared/'),
  B: (file: string) => file.includes('/features/') && !file.includes('/documents/'),
  C: (file: string) => /\/(BoardView|TaskModal|MiniChart|TaskFavoriteButton)\.vue$/.test(file),
  D: (file: string) => file.includes('/chat/') || file.endsWith('/ChatsView.vue'),
};

for (const group of ['A', 'B', 'C', 'D', 'E']) {
  test(`MIG-views-${group}`, () => {
    const groups = Object.entries(viewGroups);

    for (const file of scope.vue) {
      const assigned = groups.find(([, accepts]) => accepts(file))?.[0] || 'E';

      if (assigned !== group) {
        continue;
      }

      const { descriptor, errors } = parse(readFileSync(path.join(root, file), 'utf8'));

      assert.deepEqual(errors, [], file);
      assert.ok(descriptor.script || descriptor.scriptSetup, file);

      for (const script of [descriptor.script, descriptor.scriptSetup].filter(Boolean)) {
        assert.equal(script?.lang, 'ts', `не типизирован script: ${file}`);
      }
    }
  });
}

test('MIG-zero-js', () => {
  const files = filesBelow(path.join(root, 'web/src'));

  assert.deepEqual(files.filter((file) => /\.(?:js|mjs|cjs)$/.test(file)), []);
  assert.equal(existsSync(path.join(root, 'web/src/shared/chatApprovals.d.ts')), false);

  for (const file of files.filter((entry) => entry.endsWith('.vue'))) {
    const { descriptor } = parse(readFileSync(file, 'utf8'));

    for (const script of [descriptor.script, descriptor.scriptSetup].filter(Boolean)) {
      assert.equal(script?.lang, 'ts', file);
    }
  }
});

test('MIG-config', () => {
  const config = JSON.parse(execFileSync(process.execPath, [
    path.join(root, 'web/node_modules/typescript/bin/tsc'),
    '-p', path.join(root, 'web/tsconfig.json'), '--showConfig',
  ], { encoding: 'utf8' }));

  assert.equal(config.compilerOptions.allowJs, false);
  assert.equal(config.compilerOptions.strict, true);
  assert.equal(config.compilerOptions.noUncheckedIndexedAccess, true);
  assert.equal(config.compilerOptions.target, 'es2022');
  assert.deepEqual(config.exclude, ['../shared/node/**']);

  for (const file of scope.vue) {
    assert.ok(config.include.includes('src/**/*.vue'), `root должен видеть ${file}`);
  }

  for (const filename of [...Object.values(scope.pairs), ...scope.vue]) {
    if (!existsSync(path.join(root, filename))) {
      continue;
    }

    const source = readFileSync(path.join(root, filename), 'utf8');
    const script = filename.endsWith('.vue')
      ? parse(source).descriptor.scriptSetup?.content || parse(source).descriptor.script?.content || ''
      : source;
    const ast = ts.createSourceFile(filename, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const forbidden: string[] = [];

    /**
     * Проверяются синтаксические типы, а не строка с именем поля или текст пользователя.
     * Отдельно запрещён мост unknown между двумя утверждениями типа.
     */
    function visit(node: ts.Node) {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        forbidden.push('any');
      }

      if (ts.isAsExpression(node) && ts.isAsExpression(node.expression)
        && node.expression.type.kind === ts.SyntaxKind.UnknownKeyword) {
        forbidden.push('double cast');
      }

      ts.forEachChild(node, visit);
    }

    visit(ast);
    assert.deepEqual(forbidden, [], filename);
    assert.doesNotMatch(script, /@ts-(?:ignore|nocheck)/, filename);
  }

  const pkg = JSON.parse(readFileSync(path.join(root, 'web/package.json'), 'utf8'));

  for (const name of ['webRuntimePreservation', 'webSourceMigration', 'webNetworkBoundaries',
    'webViewBoundaries.component', 'speechWorkletBuild']) {
    assert.ok(pkg.scripts['test:components'].includes(`${name}.test.mts`), name);
  }

  const worklet: { files: string[]; compilerOptions: { types: string[]; lib: string[] } } = JSON.parse(
    execFileSync(process.execPath, [path.join(root, 'web/node_modules/typescript/bin/tsc'),
      '-p', path.join(root, 'web/tsconfig.audioWorklet.json'), '--showConfig'], { encoding: 'utf8' }),
  );

  assert.deepEqual(worklet.compilerOptions.types, []);
  assert.deepEqual(worklet.compilerOptions.lib, ['es2022', 'es2023.array']);
  assert.ok(worklet.files.some((file) => file.endsWith('/speechPcmWorklet.ts')));
  assert.ok(config.files.some((file: string) => file.endsWith('/speechPcmWorklet.ts')));
});

test('MIG-consumers', () => {
  const files = ['web/src', 'tests/web', 'web/scripts', 'docs'].flatMap((directory) => (
    filesBelow(path.join(root, directory))
  ));
  const stale: string[] = [];

  for (const filename of files.filter((file) => /\.(?:vue|ts|mts|js|mjs|md)$/.test(file))) {
    if (/webSourceMigration|webRuntimePreservation|webNetworkBoundaries|speechWorkletBuild/.test(filename)
      || filename.endsWith('/helpers/web-migration.js')) {
      continue;
    }

    const source = readFileSync(filename, 'utf8');

    for (const oldPath of Object.keys(scope.pairs)) {
      const suffix = oldPath.slice('web/src/'.length);
      const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(suffix.includes('/')
        ? `(?:[./]|web/src/)${escaped}`
        : `(?:web/src/|['"](?:\\.\\.?/)+)${escaped}['"\x60]`);

      const specifiers = [...source.matchAll(/['"]([^'"\n]+\.js)['"]/g)]
        .map((match) => match[1])
        .filter((specifier): specifier is string => Boolean(specifier));
      const sameDirectory = filename.includes(`${path.sep}web${path.sep}src${path.sep}`)
        && specifiers.some((specifier) => path.resolve(path.dirname(filename), specifier)
          === path.join(root, oldPath));

      if (pattern.test(source) || sameDirectory) {
        stale.push(`${path.relative(root, filename)} → ${oldPath}`);
      }
    }
  }

  const html = readFileSync(path.join(root, 'web/index.html'), 'utf8');

  assert.match(html, /src=["']\/src\/main\.ts["']/);
  assert.deepEqual(stale, []);
});
