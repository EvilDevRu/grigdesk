#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse } from '@vue/compiler-sfc';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function walk(root, predicate = () => true) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && predicate(entry.name)) result.push(file);
    }
  };
  visit(root);
  return result;
}

function scriptImports(source, filename, lang = '') {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    lang === 'ts' || filename.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const imports = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

function importsOf(file, source) {
  if (!file.endsWith('.vue')) return scriptImports(source, file);
  const result = parse(source, { filename: file, sourceMap: false });
  return [result.descriptor.script, result.descriptor.scriptSetup]
    .filter(Boolean)
    .flatMap((block) => scriptImports(block.content, file, block.lang));
}

function galleryImportAllowed(file, specifier) {
  if (specifier === 'vue') return true;
  if (specifier.startsWith('./')) return true;
  if (file === 'web/dev/ui-gallery/UiGallery.vue' && specifier === '../../src/ui') return true;
  if (file === 'web/dev/ui-gallery/main.ts'
      && (specifier === '../../src/styles/index.css'
        || specifier === '../../src/styles/dev/ui-gallery.css')) return true;
  return false;
}

export function collectUiGalleryBoundary(repoRoot = DEFAULT_REPO_ROOT) {
  const resolvedRoot = path.resolve(repoRoot);
  const errors = [];
  const galleryRoot = path.join(resolvedRoot, 'web/dev/ui-gallery');
  for (const absoluteFile of walk(galleryRoot, (name) => /\.(?:vue|js|ts)$/.test(name))) {
    const file = toPosix(path.relative(resolvedRoot, absoluteFile));
    const source = fs.readFileSync(absoluteFile, 'utf8');
    for (const specifier of importsOf(file, source)) {
      if (!galleryImportAllowed(file, specifier)) {
        errors.push(`gallery import вне public/dev boundary: ${file} -> ${specifier}`);
      }
      if (/stores|api-client|router|views|features|shared|components|services|types\/ui|composables\/useUi/.test(specifier)) {
        errors.push(`gallery импортирует production/private dependency: ${file} -> ${specifier}`);
      }
    }
  }

  for (const absoluteFile of walk(path.join(resolvedRoot, 'web/src'), (name) => /\.(?:vue|js|ts|css)$/.test(name))) {
    const file = toPosix(path.relative(resolvedRoot, absoluteFile));
    const source = fs.readFileSync(absoluteFile, 'utf8');
    if (/dev\/ui-gallery|ui-gallery\.(?:css|html)/i.test(source)) {
      errors.push(`production source подключает gallery: ${file}`);
    }
  }

  const viteConfig = path.join(resolvedRoot, 'web/vite.config.js');
  if (fs.existsSync(viteConfig) && /ui-gallery/i.test(fs.readFileSync(viteConfig, 'utf8'))) {
    errors.push('vite.config.js включает gallery в production build');
  }

  const galleryHtml = path.join(resolvedRoot, 'web/ui-gallery.html');
  if (fs.existsSync(galleryHtml)) {
    const source = fs.readFileSync(galleryHtml, 'utf8');
    if (!/src=["']\/dev\/ui-gallery\/main\.ts["']/.test(source)) {
      errors.push('ui-gallery.html должен иметь отдельный entry /dev/ui-gallery/main.ts');
    }
  }

  const distRoot = path.join(resolvedRoot, 'web/dist');
  for (const absoluteFile of walk(distRoot)) {
    const file = toPosix(path.relative(distRoot, absoluteFile));
    if (/ui-?gallery/i.test(file)) errors.push(`gallery artifact попал в dist: ${file}`);
    const stat = fs.statSync(absoluteFile);
    if (stat.size > 2_000_000) continue;
    const source = fs.readFileSync(absoluteFile, 'utf8');
    if (/dev\/ui-gallery|GrigDesk UI Gallery/.test(source)) {
      errors.push(`gallery marker попал в dist: ${file}`);
    }
  }
  return { errors: [...new Set(errors)] };
}

export function checkUiGalleryBoundary({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  return collectUiGalleryBoundary(repoRoot);
}

function main() {
  const { errors } = checkUiGalleryBoundary();
  if (errors.length) {
    process.stderr.write(`UI gallery boundary нарушен:\n- ${errors.join('\n- ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('UI gallery boundary: OK\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
