#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@vue/compiler-sfc';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const DEFAULT_BASELINE = 'tests/web/fixtures/ui/vue-sfc-order-baseline.json';

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function walkVue(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  const visit = (directory) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.vue')) result.push(file);
    }
  };
  visit(root);
  return result;
}

function vueFiles(repoRoot) {
  return [
    ...walkVue(path.join(repoRoot, 'web/src')),
    ...walkVue(path.join(repoRoot, 'web/dev/ui-gallery')),
  ].sort((left, right) => left.localeCompare(right));
}

function parseErrorText(error) {
  if (typeof error === 'string') return error;
  return error?.message || String(error);
}

function blockOffset(block) {
  return block?.loc?.start?.offset;
}

/**
 * Проверяет порядок только по offsets блоков, которые вернул compiler-sfc.
 * Байты и regex исходного файла не участвуют в решении.
 */
export function describeSfcOrder(source, filename = 'Component.vue') {
  const result = parse(source, { filename, sourceMap: false });
  const errors = result.errors.map(parseErrorText);
  const { descriptor } = result;
  const templateOffset = blockOffset(descriptor.template);
  const scriptBlocks = [descriptor.script, descriptor.scriptSetup].filter(Boolean);
  const scriptOffsets = scriptBlocks.map(blockOffset);
  const styleOffsets = descriptor.styles.map(blockOffset);
  const reasons = [];

  if (!descriptor.template) reasons.push('отсутствует <template>');
  if (!descriptor.script && !descriptor.scriptSetup) reasons.push('отсутствует <script>');
  if (descriptor.template && scriptOffsets.some((offset) => templateOffset > offset)) {
    reasons.push('<template> расположен после <script>');
  }
  if (descriptor.template && styleOffsets.some((offset) => templateOffset > offset)) {
    reasons.push('<template> расположен после <style>');
  }
  if (styleOffsets.length && scriptOffsets.some((offset) => styleOffsets.some((style) => offset > style))) {
    reasons.push('<script> расположен после <style>');
  }

  return {
    valid: errors.length === 0 && reasons.length === 0,
    errors,
    reasons,
    offsets: { template: templateOffset, scripts: scriptOffsets, styles: styleOffsets },
    descriptor,
  };
}

function requiresTypedScriptSetup(file) {
  return file.startsWith('web/src/components/') || file.startsWith('web/dev/ui-gallery/');
}

export function collectSfcOrder(repoRoot = DEFAULT_REPO_ROOT) {
  const resolvedRoot = path.resolve(repoRoot);
  const report = { files: {}, parseErrors: [], orderViolations: [], typeViolations: [] };
  for (const absoluteFile of vueFiles(resolvedRoot)) {
    const file = toPosix(path.relative(resolvedRoot, absoluteFile));
    const source = fs.readFileSync(absoluteFile, 'utf8');
    const state = describeSfcOrder(source, absoluteFile);
    report.files[file] = {
      valid: state.valid,
      offsets: state.offsets,
      reasons: state.reasons,
    };
    for (const error of state.errors) report.parseErrors.push(`${file}: ${error}`);
    if (state.errors.length === 0 && state.reasons.length) report.orderViolations.push(file);

    if (requiresTypedScriptSetup(file)) {
      if (!state.descriptor.scriptSetup || state.descriptor.scriptSetup.lang !== 'ts') {
        report.typeViolations.push(`${file}: нужен <script setup lang="ts">`);
      }
      if (state.descriptor.script) {
        report.typeViolations.push(`${file}: обычный <script> рядом с script setup не разрешён`);
      }
    }
  }
  return report;
}

export function createSfcOrderBaseline(report) {
  return {
    version: 1,
    legacyScriptFirst: [...report.orderViolations]
      .filter((file) => file.startsWith('web/src/'))
      .sort(),
  };
}

export function validateSfcOrderBaseline(baseline) {
  const errors = [];
  if (baseline?.version !== 1) errors.push('baseline: поддерживается только version=1');
  if (!Array.isArray(baseline?.legacyScriptFirst)
      || baseline.legacyScriptFirst.some((file) => typeof file !== 'string')) {
    errors.push('baseline: legacyScriptFirst должен быть массивом путей');
    return errors;
  }
  if (new Set(baseline.legacyScriptFirst).size !== baseline.legacyScriptFirst.length) {
    errors.push('baseline: legacyScriptFirst содержит дубли');
  }
  if (baseline.legacyScriptFirst.some((file) => !file.startsWith('web/src/') || !file.endsWith('.vue'))) {
    errors.push('baseline: legacyScriptFirst содержит путь вне web/src/**/*.vue');
  }
  if (baseline.legacyScriptFirst.some((file) => file.startsWith('web/src/components/'))) {
    errors.push('baseline: новые components/ не могут быть legacy-исключением');
  }
  return errors;
}

export function compareSfcOrder(report, baseline) {
  const errors = [...validateSfcOrderBaseline(baseline), ...report.parseErrors, ...report.typeViolations];
  const allowed = new Set(baseline?.legacyScriptFirst || []);
  for (const file of report.orderViolations) {
    if (!allowed.has(file)) errors.push(`новый SFC с неверным порядком блоков: ${file}`);
  }
  return [...new Set(errors)];
}

export function loadSfcOrderBaseline(repoRoot = DEFAULT_REPO_ROOT, baselinePath = DEFAULT_BASELINE) {
  const absolute = path.isAbsolute(baselinePath) ? baselinePath : path.join(repoRoot, baselinePath);
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

export function checkSfcOrder({ repoRoot = DEFAULT_REPO_ROOT, baselinePath = DEFAULT_BASELINE } = {}) {
  const report = collectSfcOrder(repoRoot);
  const baseline = loadSfcOrderBaseline(repoRoot, baselinePath);
  return { report, baseline, errors: compareSfcOrder(report, baseline) };
}

function parseArguments(argv) {
  const options = { repoRoot: DEFAULT_REPO_ROOT, baselinePath: DEFAULT_BASELINE, printBaseline: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--repo-root') options.repoRoot = path.resolve(argv[++index]);
    else if (argument === '--baseline') options.baselinePath = argv[++index];
    else if (argument === '--print-baseline') options.printBaseline = true;
    else throw new Error(`Неизвестный аргумент: ${argument}`);
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = collectSfcOrder(options.repoRoot);
  if (options.printBaseline) {
    process.stdout.write(`${JSON.stringify(createSfcOrderBaseline(report), null, 2)}\n`);
    return;
  }
  const baseline = loadSfcOrderBaseline(options.repoRoot, options.baselinePath);
  const errors = compareSfcOrder(report, baseline);
  if (errors.length) {
    process.stderr.write(`Vue SFC boundary нарушен:\n- ${errors.join('\n- ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Vue SFC order: OK, legacy script-first: ${report.orderViolations.length}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

