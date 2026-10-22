#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { parse } from '@vue/compiler-sfc';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const DEFAULT_BASELINE = 'tests/web/fixtures/ui/control-styles-baseline.json';
const CONTROL_TAG = /(^|[^-\w])(button|input|textarea|select)(?![-\w])/i;
const CONTROL_PROPERTIES = new Set([
  'height', 'min-height', 'max-height', 'border', 'border-top', 'border-right',
  'border-bottom', 'border-left', 'border-width', 'border-color', 'border-style',
  'border-radius', 'padding', 'padding-block', 'padding-inline', 'padding-top',
  'padding-right', 'padding-bottom', 'padding-left', 'background', 'background-color',
  'color', 'font', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
  'box-shadow', 'outline', 'opacity', 'cursor', 'appearance', 'transition', 'transform',
]);

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function walk(root, extensions) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && extensions.has(path.extname(entry.name))) result.push(file);
    }
  };
  visit(root);
  return result;
}

function vueFiles(repoRoot) {
  return [
    ...walk(path.join(repoRoot, 'web/src'), new Set(['.vue'])),
    ...walk(path.join(repoRoot, 'web/dev/ui-gallery'), new Set(['.vue'])),
  ].sort();
}

function cssFiles(repoRoot) {
  return walk(path.join(repoRoot, 'web/src/styles'), new Set(['.css'])).sort();
}

function staticTokenAttribute(node, name) {
  const prop = node.props.find((item) => item.type === 6 && item.name === name);
  return prop?.value?.content || '';
}

function visitTemplate(node, visitor) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 1) visitor(node);
  for (const child of node.children || []) visitTemplate(child, visitor);
}

function controlTokens(descriptor) {
  const classes = new Set();
  const ids = new Set();
  if (!descriptor.template?.ast) return { classes, ids };
  visitTemplate(descriptor.template.ast, (node) => {
    const tag = node.tag.toLowerCase();
    const isControl = node.tagType === 0 && ['button', 'input', 'textarea', 'select'].includes(tag);
    const isUiControl = node.tagType === 1 && /^ui(?:-|[A-Z])/i.test(node.tag);
    if (!isControl && !isUiControl) return;
    for (const token of staticTokenAttribute(node, 'class').split(/\s+/).filter(Boolean)) classes.add(token);
    const id = staticTokenAttribute(node, 'id');
    if (id) ids.add(id);
  });
  return { classes, ids };
}

function selectorMatchesTokens(selector, tokens) {
  if (CONTROL_TAG.test(selector) || /\.spin(?:\b|-)|:deep\([^)]*\.ui-/.test(selector)) {
    return true;
  }
  for (const token of tokens.classes) {
    if (new RegExp(`\\.${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![-_a-zA-Z0-9])`).test(selector)) return true;
  }
  for (const id of tokens.ids) {
    if (new RegExp(`#${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![-_a-zA-Z0-9])`).test(selector)) return true;
  }
  return false;
}

function addFinding(findings, file, selector, property, value) {
  findings[file] ||= {};
  findings[file][selector] ||= {};
  findings[file][selector][property] ||= {};
  findings[file][selector][property][value] = (findings[file][selector][property][value] || 0) + 1;
}

function analyzeCss(findings, structuralErrors, file, css, tokens, { centralComponents = false } = {}) {
  let root;
  try {
    root = postcss.parse(css, { from: file });
  } catch (error) {
    structuralErrors.push(`${file}: CSS parse error: ${error.reason || error.message}`);
    return;
  }
  root.walkRules((rule) => {
    const insideKeyframes = rule.parent?.type === 'atrule'
      && /^(?:-\w+-)?keyframes$/i.test(rule.parent.name);
    if (centralComponents && !insideKeyframes
        && !rule.selector.includes('.ui-') && !rule.selector.includes('[data-ui-')) {
      structuralErrors.push(`${file}: reusable selector без .ui-/[data-ui-]: ${rule.selector}`);
    }
    if (centralComponents || !selectorMatchesTokens(rule.selector, tokens)) return;
    rule.walkDecls((decl) => {
      const property = decl.prop.toLowerCase();
      if (CONTROL_PROPERTIES.has(property) || property.startsWith('--ui-')) {
        addFinding(findings, file, rule.selector.replace(/\s+/g, ' ').trim(), property, decl.value.trim());
      }
    });
  });
  root.walkDecls((decl) => {
    if (decl.prop.startsWith('--control-') && file !== 'web/src/styles/tokens.css') {
      structuralErrors.push(`${file}: --control-* объявляется только в styles/tokens.css`);
    }
    if (decl.prop.startsWith('--ui-')
        && !file.startsWith('web/src/styles/components/')
        && !file.startsWith('web/src/components/')) {
      structuralErrors.push(`${file}: consumer не должен объявлять private ${decl.prop}`);
    }
  });
  root.walkAtRules('keyframes', (rule) => {
    if (file.startsWith('web/src/styles/') && !rule.params.startsWith('ui-')) {
      structuralErrors.push(`${file}: global keyframes должен иметь prefix ui-: ${rule.params}`);
    }
  });
}

function cssImports(file, css) {
  const root = postcss.parse(css, { from: file });
  const imports = [];
  root.walkAtRules('import', (rule) => {
    const match = rule.params.match(/^(?:url\(\s*)?['"]([^'"]+)['"]/);
    if (match) imports.push(match[1]);
  });
  return imports;
}

function validateImportGraph(repoRoot, structuralErrors) {
  const expected = new Map([
    ['web/src/styles/index.css', [
      './tokens.css', './vendor.css', './base.css', './components/index.css',
      './utilities.css', './runtime.css',
    ]],
    ['web/src/styles/components/index.css', [
      './foundation.css', './actions.css', './fields.css', './selection.css',
      './patterns.css', './feedback.css', './overlays.css',
    ]],
    ['web/src/styles/vendor.css', ['@xterm/xterm/css/xterm.css']],
  ]);
  for (const absoluteFile of cssFiles(repoRoot)) {
    const file = toPosix(path.relative(repoRoot, absoluteFile));
    const imports = cssImports(file, fs.readFileSync(absoluteFile, 'utf8'));
    const wanted = expected.get(file) || [];
    if (JSON.stringify(imports) !== JSON.stringify(wanted)) {
      structuralErrors.push(`${file}: неожиданный CSS import graph: ${JSON.stringify(imports)}`);
    }
  }

  const mainFile = path.join(repoRoot, 'web/src/main.ts');
  if (fs.existsSync(mainFile)) {
    const main = fs.readFileSync(mainFile, 'utf8');
    const count = (main.match(/import\s+['"]\.\/styles\/index\.css['"]/g) || []).length;

    if (count !== 1) {
      structuralErrors.push(`web/src/main.ts: нужен ровно один import './styles/index.css'`);
    }
  }
  for (const absoluteFile of [
    ...walk(path.join(repoRoot, 'web/src'), new Set(['.js', '.ts', '.vue'])),
    ...walk(path.join(repoRoot, 'web/dev/ui-gallery'), new Set(['.js', '.ts', '.vue'])),
  ]) {
    const file = toPosix(path.relative(repoRoot, absoluteFile));
    const source = fs.readFileSync(absoluteFile, 'utf8');
    const cssRefs = [...source.matchAll(/(?:import\s*(?:\([^)]*)?|from\s*)['"]([^'"]+\.css)['"]/g)]
      .map((match) => match[1]);
    const allowed = file === 'web/src/main.ts'
      ? ['./styles/index.css']
      : file === 'web/dev/ui-gallery/main.ts'
        ? ['../../src/styles/index.css', '../../src/styles/dev/ui-gallery.css']
        : [];
    if (JSON.stringify(cssRefs) !== JSON.stringify(allowed)) {
      structuralErrors.push(`${file}: прямые CSS imports запрещены: ${JSON.stringify(cssRefs)}`);
    }
  }
}

export function collectUiControlStyles(repoRoot = DEFAULT_REPO_ROOT) {
  const resolvedRoot = path.resolve(repoRoot);
  const findings = {};
  const structuralErrors = [];
  const legacyStyles = path.join(resolvedRoot, 'web/src/styles.css');

  if (fs.existsSync(legacyStyles)) {
    structuralErrors.push('web/src/styles.css: legacy CSS entry запрещён');
  }

  const allTokens = { classes: new Set(), ids: new Set() };
  const parsedVue = [];
  for (const absoluteFile of vueFiles(resolvedRoot)) {
    const file = toPosix(path.relative(resolvedRoot, absoluteFile));
    const source = fs.readFileSync(absoluteFile, 'utf8');
    const result = parse(source, { filename: absoluteFile, sourceMap: false });
    const tokens = controlTokens(result.descriptor);
    for (const token of tokens.classes) allTokens.classes.add(token);
    for (const token of tokens.ids) allTokens.ids.add(token);
    parsedVue.push({ file, descriptor: result.descriptor, tokens });
  }

  for (const { file, descriptor, tokens } of parsedVue) {
    if ((file.startsWith('web/src/components/') || file.startsWith('web/dev/ui-gallery/'))
        && descriptor.styles.length) {
      structuralErrors.push(`${file}: UI SFC/gallery не должен содержать <style>`);
    }
    if (file.startsWith('web/src/components/') || file.startsWith('web/dev/ui-gallery/')) continue;
    for (const style of descriptor.styles) {
      if (style.src) structuralErrors.push(`${file}: <style src> запрещён`);
      analyzeCss(findings, structuralErrors, file, style.content, tokens);
    }
  }
  for (const absoluteFile of cssFiles(resolvedRoot)) {
    const file = toPosix(path.relative(resolvedRoot, absoluteFile));
    analyzeCss(findings, structuralErrors, file, fs.readFileSync(absoluteFile, 'utf8'), allTokens, {
      centralComponents: file.startsWith('web/src/styles/components/'),
    });
  }
  validateImportGraph(resolvedRoot, structuralErrors);
  return { findings, structuralErrors: [...new Set(structuralErrors)] };
}

export function createUiControlStylesBaseline(report) {
  return { version: 1, findings: report.findings };
}

export function compareUiControlStyles(report, baseline) {
  const errors = [...report.structuralErrors];
  if (baseline?.version !== 1 || !baseline?.findings) errors.push('baseline: нужен version=1 и findings');
  for (const [file, selectors] of Object.entries(report.findings)) {
    for (const [selector, properties] of Object.entries(selectors)) {
      for (const [property, values] of Object.entries(properties)) {
        for (const [value, count] of Object.entries(values)) {
          const allowed = baseline?.findings?.[file]?.[selector]?.[property]?.[value] || 0;
          if (count > allowed) {
            errors.push(`новый control style: ${file} | ${selector} | ${property}: ${value}`);
          }
        }
      }
    }
  }
  return [...new Set(errors)];
}

export function loadUiControlStylesBaseline(repoRoot = DEFAULT_REPO_ROOT, baselinePath = DEFAULT_BASELINE) {
  const absolute = path.isAbsolute(baselinePath) ? baselinePath : path.join(repoRoot, baselinePath);
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

export function checkUiControlStyles({ repoRoot = DEFAULT_REPO_ROOT, baselinePath = DEFAULT_BASELINE } = {}) {
  const report = collectUiControlStyles(repoRoot);
  const baseline = loadUiControlStylesBaseline(repoRoot, baselinePath);
  return { report, baseline, errors: compareUiControlStyles(report, baseline) };
}

function main() {
  const report = collectUiControlStyles(DEFAULT_REPO_ROOT);
  if (process.argv.includes('--print-baseline')) {
    process.stdout.write(`${JSON.stringify(createUiControlStylesBaseline(report), null, 2)}\n`);
    return;
  }
  const baseline = loadUiControlStylesBaseline();
  const errors = compareUiControlStyles(report, baseline);
  if (errors.length) {
    process.stderr.write(`UI control styles boundary нарушен:\n- ${errors.join('\n- ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('UI control styles boundary: OK\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
