#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse } from '@vue/compiler-sfc';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const DEFAULT_BASELINE = 'tests/web/fixtures/ui/dependency-boundary-baseline.json';
const SOURCE_EXTENSIONS = new Set(['.vue', '.js', '.ts']);

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) result.push(file);
    }
  };
  visit(root);
  return result;
}

function sourceFiles(repoRoot) {
  return [
    ...walkFiles(path.join(repoRoot, 'web/src')),
    ...walkFiles(path.join(repoRoot, 'web/dev/ui-gallery')),
  ].sort();
}

function uiOwned(file) {
  return file === 'web/src/ui.ts'
    || file.startsWith('web/src/components/')
    || /^web\/src\/types\/ui[A-Z].*\.ts$/.test(file)
    || /^web\/src\/composables\/useUi(?:Field|Layer|Tabs)/.test(file)
    || file === 'web/src/services/dialogs.ts'
    || file === 'web/src/services/toasts.ts'
    || file === 'web/src/services/locale.ts'
    || file === 'web/src/services/tooltips.ts'
    || file === 'web/src/services/tooltipDirective.ts'
    || file === 'web/src/services/tooltipInput.ts'
    || file === 'web/src/services/overlayPlacement.ts'
    || file.startsWith('web/src/services/layers/');
}

function scriptKind(lang, file) {
  if (lang === 'ts') return ts.ScriptKind.TS;
  if (lang === 'tsx') return ts.ScriptKind.TSX;
  if (lang === 'jsx') return ts.ScriptKind.JSX;
  return file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

function importSpecifiers(source, filename, lang = '') {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(lang, filename),
  );
  const result = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      result.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      result.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

function importsFromFile(absoluteFile, relativeFile) {
  const source = fs.readFileSync(absoluteFile, 'utf8');
  if (!relativeFile.endsWith('.vue')) return importSpecifiers(source, relativeFile);
  const result = parse(source, { filename: absoluteFile, sourceMap: false });
  const imports = [];
  if (result.descriptor.script) {
    imports.push(...importSpecifiers(
      result.descriptor.script.content,
      `${relativeFile}?script`,
      result.descriptor.script.lang,
    ));
  }
  if (result.descriptor.scriptSetup) {
    imports.push(...importSpecifiers(
      result.descriptor.scriptSetup.content,
      `${relativeFile}?script-setup`,
      result.descriptor.scriptSetup.lang,
    ));
  }
  return imports;
}

function resolvedTarget(file, specifier) {
  if (!specifier.startsWith('.')) return specifier;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  return joined.replace(/\.(?:vue|[cm]?[jt]sx?)$/, '');
}

function isForbiddenUiDependency(target) {
  return target === 'pinia' || target === 'vue-router'
    || target.startsWith('web/src/stores/')
    || target.startsWith('web/src/views/')
    || target.startsWith('web/src/features/')
    || target.startsWith('web/src/shared/')
    || target === 'web/src/router'
    || target.includes('/api-client');
}

function isPrivateUiTarget(target) {
  return target.startsWith('web/src/components/')
    || /^web\/src\/types\/ui[A-Z]/.test(target)
    || target === 'web/src/services/dialogs'
    || target === 'web/src/services/toasts'
    || target === 'web/src/services/locale'
    || target === 'web/src/services/tooltips'
    || target === 'web/src/services/tooltipDirective'
    || target === 'web/src/services/tooltipInput'
    || target === 'web/src/services/overlayPlacement'
    || target.startsWith('web/src/services/layers/')
    || /^web\/src\/composables\/useUi(?:Field|Layer|Tabs)/.test(target);
}

export function collectUiDependencyBoundary(repoRoot = DEFAULT_REPO_ROOT) {
  const resolvedRoot = path.resolve(repoRoot);
  const imports = [];
  const errors = [];
  for (const absoluteFile of sourceFiles(resolvedRoot)) {
    const file = toPosix(path.relative(resolvedRoot, absoluteFile));
    let specifiers;
    try {
      specifiers = importsFromFile(absoluteFile, file);
    } catch (error) {
      errors.push(`${file}: ${error.message}`);
      continue;
    }
    for (const specifier of specifiers) {
      imports.push({ file, specifier, target: resolvedTarget(file, specifier) });
    }
  }
  return { imports, parseErrors: errors };
}

export function createUiDependencyBoundaryBaseline(report) {
  return {
    version: 1,
    legacyDeepImports: report.imports
      .filter((item) => item.file.startsWith('web/src/') && !uiOwned(item.file)
        && isPrivateUiTarget(item.target))
      .map((item) => `${item.file} -> ${item.specifier}`)
      .sort(),
  };
}

export function compareUiDependencyBoundary(report, baseline = { version: 1, legacyDeepImports: [] }) {
  const errors = [...report.parseErrors];
  if (baseline?.version !== 1 || !Array.isArray(baseline?.legacyDeepImports)) {
    errors.push('baseline: нужен version=1 и legacyDeepImports[]');
  }
  const legacyAllowed = new Set(baseline?.legacyDeepImports || []);
  for (const item of report.imports) {
    if (uiOwned(item.file) && isForbiddenUiDependency(item.target)) {
      errors.push(`UI-owned модуль импортирует product dependency: ${item.file} -> ${item.specifier}`);
    }
    if (item.file.startsWith('web/src/') && !uiOwned(item.file)
        && isPrivateUiTarget(item.target)
        && !legacyAllowed.has(`${item.file} -> ${item.specifier}`)) {
      errors.push(`production consumer обходит web/src/ui.ts: ${item.file} -> ${item.specifier}`);
    }
    if (item.target === 'web/src/components/primitives/UiFileInput'
        && item.file !== 'web/src/components/composites/UiFilePicker.vue') {
      errors.push(`private UiFileInput импортирован вне UiFilePicker: ${item.file}`);
    }
  }

  const facadeImports = report.imports.filter((item) => item.file === 'web/src/ui.ts');
  if (facadeImports.some((item) => item.target === 'web/src/components/primitives/UiFileInput')) {
    errors.push('web/src/ui.ts не должен экспортировать private UiFileInput');
  }
  return [...new Set(errors)];
}

export function loadUiDependencyBoundaryBaseline(repoRoot = DEFAULT_REPO_ROOT, baselinePath = DEFAULT_BASELINE) {
  const absolute = path.isAbsolute(baselinePath) ? baselinePath : path.join(repoRoot, baselinePath);
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

export function checkUiDependencyBoundary({ repoRoot = DEFAULT_REPO_ROOT, baselinePath = DEFAULT_BASELINE } = {}) {
  const report = collectUiDependencyBoundary(repoRoot);
  const baseline = loadUiDependencyBoundaryBaseline(repoRoot, baselinePath);
  return { report, baseline, errors: compareUiDependencyBoundary(report, baseline) };
}

function main() {
  const report = collectUiDependencyBoundary(DEFAULT_REPO_ROOT);
  if (process.argv.includes('--print-baseline')) {
    process.stdout.write(`${JSON.stringify(createUiDependencyBoundaryBaseline(report), null, 2)}\n`);
    return;
  }
  const baseline = loadUiDependencyBoundaryBaseline();
  const errors = compareUiDependencyBoundary(report, baseline);
  if (errors.length) {
    process.stderr.write(`UI dependency boundary нарушен:\n- ${errors.join('\n- ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('UI dependency boundary: OK\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
