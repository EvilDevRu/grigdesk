#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const DEFAULT_BASELINE = 'tests/web/fixtures/ui/file-naming-baseline.json';

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function walk(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && ['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && (entry.name.endsWith('.vue') || entry.name.endsWith('.ts'))) result.push(file);
    }
  };
  visit(root);
  return result;
}

function sourceFiles(repoRoot) {
  return [...walk(path.join(repoRoot, 'web/src')), ...walk(path.join(repoRoot, 'web/dev'))].sort();
}

function vueNameValid(name) {
  return /^[A-Z][A-Za-z0-9]*\.vue$/.test(name);
}

function tsNameValid(name) {
  if (name.endsWith('.d.ts')) return /^[a-z][A-Za-z0-9]*\.d\.ts$/.test(name);
  // Конфиги и тестовые роли состоят из lowerCamel basename + известного role suffix.
  const match = name.match(/^(.+)\.(config|test|spec)\.ts$/);
  if (match) return /^[a-z][A-Za-z0-9]*$/.test(match[1]);
  return /^[a-z][A-Za-z0-9]*\.ts$/.test(name);
}

export function collectUiFileNaming(repoRoot = DEFAULT_REPO_ROOT) {
  const resolvedRoot = path.resolve(repoRoot);
  const invalid = [];
  for (const absoluteFile of sourceFiles(resolvedRoot)) {
    const file = toPosix(path.relative(resolvedRoot, absoluteFile));
    const name = path.posix.basename(file);
    if (name.endsWith('.vue') ? !vueNameValid(name) : !tsNameValid(name)) invalid.push(file);
  }
  return { invalid: invalid.sort() };
}

export function createUiFileNamingBaseline(report) {
  return { version: 1, legacyInvalid: [...report.invalid] };
}

export function compareUiFileNaming(report, baseline) {
  const errors = [];
  if (baseline?.version !== 1) errors.push('baseline: поддерживается только version=1');
  if (!Array.isArray(baseline?.legacyInvalid)) {
    errors.push('baseline: legacyInvalid должен быть массивом');
    return errors;
  }
  if (new Set(baseline.legacyInvalid).size !== baseline.legacyInvalid.length) {
    errors.push('baseline: legacyInvalid содержит дубли');
  }
  const allowed = new Set(baseline.legacyInvalid);
  for (const file of report.invalid) {
    if (!allowed.has(file)) errors.push(`новое имя файла нарушает naming rule: ${file}`);
  }
  return errors;
}

export function loadUiFileNamingBaseline(repoRoot = DEFAULT_REPO_ROOT, baselinePath = DEFAULT_BASELINE) {
  const absolute = path.isAbsolute(baselinePath) ? baselinePath : path.join(repoRoot, baselinePath);
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

export function checkUiFileNaming({ repoRoot = DEFAULT_REPO_ROOT, baselinePath = DEFAULT_BASELINE } = {}) {
  const report = collectUiFileNaming(repoRoot);
  const baseline = loadUiFileNamingBaseline(repoRoot, baselinePath);
  return { report, baseline, errors: compareUiFileNaming(report, baseline) };
}

function main() {
  const report = collectUiFileNaming(DEFAULT_REPO_ROOT);
  if (process.argv.includes('--print-baseline')) {
    process.stdout.write(`${JSON.stringify(createUiFileNamingBaseline(report), null, 2)}\n`);
    return;
  }
  const baseline = loadUiFileNamingBaseline();
  const errors = compareUiFileNaming(report, baseline);
  if (errors.length) {
    process.stderr.write(`UI file naming boundary нарушен:\n- ${errors.join('\n- ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`UI file naming: OK, legacy exceptions: ${report.invalid.length}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
