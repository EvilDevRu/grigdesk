#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse } from '@vue/compiler-sfc';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const DEFAULT_BASELINE = 'tests/web/fixtures/ui/style-injection-baseline.json';

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function walk(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /\.(?:vue|js|ts)$/.test(entry.name)) result.push(file);
    }
  };
  visit(root);
  return result;
}

function sourceFiles(repoRoot) {
  return [...walk(path.join(repoRoot, 'web/src')), ...walk(path.join(repoRoot, 'web/dev/ui-gallery'))].sort();
}

function normalize(value) {
  return value.trim().replace(/\s+/g, ' ');
}

function staticString(node) {
  return ts.isStringLiteralLike(node) ? node.text.toLowerCase() : null;
}

function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression) return staticString(node.argumentExpression);
  return null;
}

function increment(findings, file, kind, fingerprint) {
  findings[file] ||= {};
  findings[file][kind] ||= { count: 0, fingerprints: {} };
  findings[file][kind].count += 1;
  findings[file][kind].fingerprints[fingerprint] = (findings[file][kind].fingerprints[fingerprint] || 0) + 1;
}

function analyzeScript(findings, file, source, lang = '') {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    lang === 'ts' || file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const styleVariables = new Set();
  const styleSheetVariables = new Set();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && node.initializer && ts.isCallExpression(node.initializer)
        && memberName(node.initializer.expression) === 'createElement'
        && staticString(node.initializer.arguments[0]) === 'style') {
      styleVariables.add(node.name.text);
      increment(findings, file, 'createElement:style', normalize(node.initializer.getText(sourceFile)));
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && node.initializer && ts.isNewExpression(node.initializer)
        && ts.isIdentifier(node.initializer.expression)
        && node.initializer.expression.text === 'CSSStyleSheet') {
      styleSheetVariables.add(node.name.text);
    }
    if (ts.isCallExpression(node)) {
      const name = memberName(node.expression);
      if (name === 'createElement' && staticString(node.arguments[0]) === 'style') {
        const declared = ts.isVariableDeclaration(node.parent) && node.parent.initializer === node;
        if (!declared) increment(findings, file, 'createElement:style', normalize(node.getText(sourceFile)));
      }
      const receiver = (ts.isPropertyAccessExpression(node.expression)
        || ts.isElementAccessExpression(node.expression)) ? node.expression.expression : null;
      if (name === 'insertRule'
          || (['replace', 'replaceSync'].includes(name)
            && ts.isIdentifier(receiver) && styleSheetVariables.has(receiver.text))) {
        increment(findings, file, `runtime-style:${name}`, normalize(node.getText(sourceFile)));
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) {
      const name = memberName(node.left);
      const receiver = node.left.expression;
      if ((name === 'textContent' || name === 'innerHTML')
          && ts.isIdentifier(receiver) && styleVariables.has(receiver.text)) {
        increment(findings, file, `style:${name}`, `${receiver.text}.${name}=<css>`);
      }
      if (name === 'adoptedStyleSheets') {
        increment(findings, file, 'runtime-style:adoptedStyleSheets', normalize(node.getText(sourceFile)));
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === 'CSSStyleSheet') {
      increment(findings, file, 'runtime-style:CSSStyleSheet', 'new CSSStyleSheet()');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

export function collectUiStyleInjection(repoRoot = DEFAULT_REPO_ROOT) {
  const resolvedRoot = path.resolve(repoRoot);
  const findings = {};
  const parseErrors = [];
  for (const absoluteFile of sourceFiles(resolvedRoot)) {
    const file = toPosix(path.relative(resolvedRoot, absoluteFile));
    const source = fs.readFileSync(absoluteFile, 'utf8');
    if (!file.endsWith('.vue')) {
      analyzeScript(findings, file, source);
      continue;
    }
    const result = parse(source, { filename: absoluteFile, sourceMap: false });
    for (const error of result.errors) parseErrors.push(`${file}: ${error.message || error}`);
    if (result.descriptor.script) {
      analyzeScript(findings, `${file}?script`, result.descriptor.script.content, result.descriptor.script.lang);
    }
    if (result.descriptor.scriptSetup) {
      analyzeScript(findings, `${file}?script-setup`, result.descriptor.scriptSetup.content, result.descriptor.scriptSetup.lang);
    }
  }
  return { findings, parseErrors };
}

export function createUiStyleInjectionBaseline(report) {
  return { version: 1, findings: report.findings };
}

function validateBaseline(baseline) {
  const errors = [];
  if (baseline?.version !== 1) errors.push('baseline: поддерживается только version=1');
  if (!baseline?.findings || typeof baseline.findings !== 'object' || Array.isArray(baseline.findings)) {
    errors.push('baseline: findings должен быть object');
  }
  return errors;
}

export function compareUiStyleInjection(report, baseline) {
  const errors = [...validateBaseline(baseline), ...report.parseErrors];
  for (const [file, kinds] of Object.entries(report.findings)) {
    for (const [kind, finding] of Object.entries(kinds)) {
      const allowed = baseline?.findings?.[file]?.[kind];
      if (!allowed) {
        errors.push(`новая runtime style injection: ${file} ${kind}`);
        continue;
      }
      if (finding.count > allowed.count) errors.push(`рост style injection: ${file} ${kind}`);
      for (const [fingerprint, count] of Object.entries(finding.fingerprints)) {
        if (count > (allowed.fingerprints?.[fingerprint] || 0)) {
          errors.push(`новый style injection fingerprint: ${file} ${kind}: ${fingerprint}`);
        }
      }
    }
  }
  return [...new Set(errors)];
}

export function loadUiStyleInjectionBaseline(repoRoot = DEFAULT_REPO_ROOT, baselinePath = DEFAULT_BASELINE) {
  const absolute = path.isAbsolute(baselinePath) ? baselinePath : path.join(repoRoot, baselinePath);
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

export function checkUiStyleInjection({ repoRoot = DEFAULT_REPO_ROOT, baselinePath = DEFAULT_BASELINE } = {}) {
  const report = collectUiStyleInjection(repoRoot);
  const baseline = loadUiStyleInjectionBaseline(repoRoot, baselinePath);
  return { report, baseline, errors: compareUiStyleInjection(report, baseline) };
}

function main() {
  const report = collectUiStyleInjection(DEFAULT_REPO_ROOT);
  if (process.argv.includes('--print-baseline')) {
    process.stdout.write(`${JSON.stringify(createUiStyleInjectionBaseline(report), null, 2)}\n`);
    return;
  }
  const baseline = loadUiStyleInjectionBaseline();
  const errors = compareUiStyleInjection(report, baseline);
  if (errors.length) {
    process.stderr.write(`UI style injection boundary нарушен:\n- ${errors.join('\n- ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('UI style injection boundary: OK\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
