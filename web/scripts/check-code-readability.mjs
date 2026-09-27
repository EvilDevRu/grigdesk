#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse } from '@vue/compiler-sfc';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const DEFAULT_BASELINE = 'tests/web/fixtures/ui/code-readability-baseline.json';
const MAX_LINE_LENGTH = 110;
// Проверка по списку файлов: правила те же, но для любого слоя кода Кокпита. Сторож по
// базовой линии видит только TypeScript в web/, и нарушения в JS-сторах, сервере,
// скриптах и тестах проходили молча.
const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.vue']);
const CODE_ROOTS = [
  'bin/',
  'deploy/',
  'server/',
  'shared/',
  'tests/',
  'tools/',
  'web/dev/',
  'web/scripts/',
  'web/src/',
];

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function walk(root, extension) {
  if (!fs.existsSync(root)) return [];
  const result = [];

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith(extension)) result.push(file);
    }
  }

  visit(root);
  return result;
}

function fingerprint(node, sourceFile) {
  return node.getText(sourceFile).trim().replace(/\s+/g, ' ').slice(0, 180);
}

/**
 * Находка копится по отпечатку: базовая линия сравнивает их числа. Номер строки нужен
 * только человеку в проверке по списку файлов, поэтому пишется в отдельную карту и в
 * базовую линию не попадает.
 */
function addFinding(report, file, rule, value, line = 0) {
  report.findings[file] ||= {};
  report.findings[file][rule] ||= {};
  report.findings[file][rule][value] = (report.findings[file][rule][value] || 0) + 1;

  if (report.locations && line) {
    report.locations[file] ||= {};
    report.locations[file][rule] ||= {};
    report.locations[file][rule][value] ||= [];
    report.locations[file][rule][value].push(line);
  }
}

function lineOf(sourceFile, position) {
  return sourceFile.getLineAndCharacterOfPosition(position).line;
}

function hasBlankLine(sourceFile, left, right) {
  return lineOf(sourceFile, right.getStart(sourceFile)) - lineOf(sourceFile, left.getEnd()) >= 2;
}

function statementKind(node) {
  if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return 'import';
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
      || ts.isEnumDeclaration(node) || ts.isClassDeclaration(node)) return 'type';
  if (ts.isVariableStatement(node)) return 'declaration';
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return 'exit';
  if (ts.isIfStatement(node) || ts.isSwitchStatement(node)) return 'branch';
  if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)
      || ts.isWhileStatement(node) || ts.isDoStatement(node)) return 'loop';
  if (ts.isTryStatement(node)) return 'try';
  return 'effect';
}

/**
 * Соседние операторы разного рода разделяет пустая строка, функцию — всегда. Так
 * проверки, подготовка, эффект и возврат не слипаются в один абзац.
 */
function checkStatementSpacing(report, file, sourceFile, statements, lineOffset = 0) {
  for (let index = 1; index < statements.length; index += 1) {
    const previous = statements[index - 1];
    const current = statements[index];
    const previousKind = statementKind(previous);
    const currentKind = statementKind(current);
    const separatesFunction = previousKind === 'function' || currentKind === 'function';
    if ((previousKind !== currentKind || separatesFunction)
        && !hasBlankLine(sourceFile, previous, current)) {
      addFinding(
        report,
        file,
        'logical-spacing',
        `${previousKind}->${currentKind}: ${fingerprint(current, sourceFile)}`,
        lineOf(sourceFile, current.getStart(sourceFile)) + 1 + lineOffset,
      );
    }
  }
}

function controlBody(node) {
  if (ts.isIfStatement(node)) return [node.thenStatement, node.elseStatement].filter(Boolean);
  if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)
      || ts.isWhileStatement(node) || ts.isDoStatement(node)) return [node.statement];
  return [];
}

function isFunctionLike(node) {
  return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
    || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}

function functionAnchor(node) {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node;
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node))
      && ts.isVariableDeclaration(node.parent)) {
    return node.parent.parent.parent;
  }
  return null;
}

function branchCount(body) {
  let count = 0;

  function visit(node) {
    if (node !== body && isFunctionLike(node)) return;
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node)
        || ts.isSwitchStatement(node) || ts.isForStatement(node)
        || ts.isForInStatement(node) || ts.isForOfStatement(node)
        || ts.isWhileStatement(node) || ts.isDoStatement(node)
        || ts.isTryStatement(node) || ts.isCatchClause(node)) count += 1;
    ts.forEachChild(node, visit);
  }

  visit(body);
  return count;
}

function hasMultilineExplanation(anchor, sourceFile) {
  const trivia = sourceFile.text.slice(anchor.getFullStart(), anchor.getStart(sourceFile)).trimEnd();
  const block = trivia.match(/\/\*\*?([\s\S]*?)\*\/\s*$/);
  if (block) {
    return block[1].split('\n')
      .map((line) => line.replace(/^\s*\*?\s?/, '').trim())
      .filter(Boolean).length >= 2;
  }

  const lines = trivia.split('\n');
  let explanationLines = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!/^\s*\/\//.test(lines[index])) break;
    if (lines[index].replace(/^\s*\/\/\s?/, '').trim()) explanationLines += 1;
  }
  return explanationLines >= 2;
}

function isExported(anchor) {
  return Boolean(anchor.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

/**
 * Тело функции не ужимается в строку, а нетривиальная именованная функция (экспорт,
 * от четырёх операторов или от двух ветвлений) начинается с пояснения минимум в две
 * строки: однострочный комментарий правилу не удовлетворяет.
 */
function checkFunction(report, file, sourceFile, node, lineOffset = 0) {
  if (!node.body || !ts.isBlock(node.body)) return;
  const startLine = lineOf(sourceFile, node.body.getStart(sourceFile));
  const endLine = lineOf(sourceFile, node.body.getEnd());

  if (startLine === endLine && node.body.statements.length) {
    addFinding(report, file, 'one-line-function', fingerprint(node, sourceFile), startLine + 1 + lineOffset);
  }

  const anchor = functionAnchor(node);
  if (!anchor) return;
  const nonTrivial = isExported(anchor)
    || node.body.statements.length >= 4
    || branchCount(node.body) >= 2;

  if (nonTrivial && !hasMultilineExplanation(anchor, sourceFile)) {
    addFinding(
      report,
      file,
      'function-explanation',
      fingerprint(anchor, sourceFile),
      lineOf(sourceFile, anchor.getStart(sourceFile)) + 1 + lineOffset,
    );
  }
}

/**
 * От трёх полей объекта или типа каждое стоит на своей строке, а первая и последняя —
 * не на строках скобок: плотный литерал читается хуже списка.
 */
function checkMembers(report, file, sourceFile, node, lineOffset = 0) {
  let members = null;
  if (ts.isObjectLiteralExpression(node)) members = node.properties;
  else if (ts.isTypeLiteralNode(node) || ts.isInterfaceDeclaration(node)) members = node.members;
  if (!members || members.length < 3) return;

  const memberLines = members.map((member) => lineOf(sourceFile, member.getStart(sourceFile)));
  const openingLine = lineOf(sourceFile, node.getStart(sourceFile));
  const closingLine = lineOf(sourceFile, node.getEnd() - 1);
  const packed = new Set(memberLines).size !== memberLines.length
    || memberLines[0] === openingLine
    || lineOf(sourceFile, members.at(-1).getEnd()) === closingLine;

  if (packed) {
    addFinding(
      report,
      file,
      'packed-members',
      fingerprint(node, sourceFile),
      lineOf(sourceFile, node.getStart(sourceFile)) + 1 + lineOffset,
    );
  }
}

/**
 * Все правила читаемости для одного исходника. lineOffset — сдвиг блока script внутри
 * SFC: номера строк в находках должны указывать в файл, а не в вырезанный блок.
 */
function analyzeScript(report, file, source, kind, lineOffset = 0) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const lineAt = (node) => lineOf(sourceFile, node.getStart(sourceFile)) + 1 + lineOffset;

  for (const diagnostic of sourceFile.parseDiagnostics) {
    report.parseErrors.push(`${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
  }

  source.split('\n').forEach((line, index) => {
    if (line.length > MAX_LINE_LENGTH) {
      const value = `${index + 1}:${line.trim().slice(0, 180)}`;

      addFinding(report, file, 'line-length', value, index + 1 + lineOffset);
    }
  });

  checkStatementSpacing(report, file, sourceFile, sourceFile.statements, lineOffset);

  // Обход всего дерева: пустые строки в каждом блоке, функции, плотные литералы и
  // тела if/for/while без фигурных скобок.
  function visit(node) {
    if (ts.isBlock(node)) {
      checkStatementSpacing(report, file, sourceFile, node.statements, lineOffset);
    }
    if (isFunctionLike(node)) {
      checkFunction(report, file, sourceFile, node, lineOffset);
    }

    checkMembers(report, file, sourceFile, node, lineOffset);

    for (const body of controlBody(node)) {
      if (!ts.isBlock(body) && !ts.isIfStatement(body)) {
        addFinding(report, file, 'unbraced-control', fingerprint(node, sourceFile), lineAt(node));
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

function sourceFiles(repoRoot) {
  return [
    ...walk(path.join(repoRoot, 'web/src'), '.ts'),
    ...walk(path.join(repoRoot, 'web/dev'), '.ts'),
    ...walk(path.join(repoRoot, 'web/src'), '.vue'),
    ...walk(path.join(repoRoot, 'web/dev'), '.vue'),
  ].sort();
}

export function collectCodeReadability(repoRoot = DEFAULT_REPO_ROOT) {
  const resolvedRoot = path.resolve(repoRoot);
  const report = { findings: {}, parseErrors: [] };

  for (const absoluteFile of sourceFiles(resolvedRoot)) {
    const file = toPosix(path.relative(resolvedRoot, absoluteFile));
    const source = fs.readFileSync(absoluteFile, 'utf8');
    if (file.endsWith('.ts')) {
      analyzeScript(report, file, source, ts.ScriptKind.TS);
      continue;
    }

    const result = parse(source, { filename: absoluteFile, sourceMap: false });
    for (const error of result.errors) report.parseErrors.push(`${file}: ${error.message || error}`);
    for (const block of [result.descriptor.script, result.descriptor.scriptSetup]) {
      if (block?.lang === 'ts') analyzeScript(report, file, block.content, ts.ScriptKind.TS);
    }
  }
  return report;
}

/**
 * Любой исходник Кокпита: JS и TS по расширению, у SFC — оба блока script на любом
 * языке. Базовая линия так не делает (она держит только TypeScript), поэтому этот путь
 * живёт отдельно и её числа не меняет.
 */
function analyzeAnyFile(report, file, source) {
  if (file.endsWith('.vue')) {
    const result = parse(source, { filename: file, sourceMap: false });

    for (const error of result.errors) {
      report.parseErrors.push(`${file}: ${error.message || error}`);
    }
    for (const block of [result.descriptor.script, result.descriptor.scriptSetup]) {
      if (!block) {
        continue;
      }

      const kind = block.lang === 'ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS;

      analyzeScript(report, file, block.content, kind, block.loc.start.line - 1);
    }

    return;
  }

  const kind = /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;

  analyzeScript(report, file, source, kind);
}

/**
 * Отчёт по заданным исходникам `{ file, source }` любого слоя — с номерами строк
 * находок в `locations`. Исходники передаёт вызывающий: так сравнивается и версия HEAD.
 */
export function collectFilesReadability(entries) {
  const report = {
    findings: {},
    parseErrors: [],
    locations: {},
  };

  for (const { file, source } of entries) {
    analyzeAnyFile(report, file, source);
  }

  return report;
}

/**
 * Отпечаток для сравнения версий одного файла. Только у длинной строки в нём номер
 * строки: вставка выше сдвинула бы старую длинную строку в «новое» нарушение.
 */
function comparableValue(rule, value) {
  return rule === 'line-length' ? value.replace(/^\d+:/, '') : value;
}

/**
 * Нарушения, которых не было в прежней версии тех же файлов. Прежний долг изменённого
 * файла не мешает, а новая или переписанная функция обязана соблюдать правила.
 */
export function introducedFindings(current, previous) {
  const before = new Map();

  for (const [file, rules] of Object.entries(previous?.findings || {})) {
    for (const [rule, values] of Object.entries(rules)) {
      for (const [value, count] of Object.entries(values)) {
        const key = `${file}\0${rule}\0${comparableValue(rule, value)}`;

        before.set(key, (before.get(key) || 0) + count);
      }
    }
  }

  const introduced = [];

  for (const [file, rules] of Object.entries(current.findings)) {
    for (const [rule, values] of Object.entries(rules)) {
      for (const [value, count] of Object.entries(values)) {
        const key = `${file}\0${rule}\0${comparableValue(rule, value)}`;
        const allowed = before.get(key) || 0;

        before.set(key, Math.max(0, allowed - count));

        if (count > allowed) {
          introduced.push({
            file,
            rule,
            value,
            lines: current.locations?.[file]?.[rule]?.[value] || [],
          });
        }
      }
    }
  }

  return introduced.sort((left, right) => left.file.localeCompare(right.file)
    || (left.lines[0] || 0) - (right.lines[0] || 0));
}

function git(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Исходник Кокпита: код по расширению в известных корнях, без зависимостей и сборки.
 * Чужие каталоги в дереве (временные лаборатории, артефакты) проверку не засоряют.
 */
function isCockpitCode(file) {
  return CODE_EXTENSIONS.has(path.extname(file))
    && CODE_ROOTS.some((root) => file.startsWith(root))
    && !/(^|\/)(node_modules|dist)\//.test(file);
}

/**
 * Изменённые относительно HEAD и новые неотслеживаемые файлы кода. В общем дереве сюда
 * попадают и чужие правки — свой набор надёжнее передать явно через `--files`.
 */
export function changedCodeFiles(repoRoot = DEFAULT_REPO_ROOT) {
  const listed = [
    ...git(repoRoot, ['diff', '--name-only', 'HEAD']).split('\n'),
    ...git(repoRoot, ['ls-files', '--others', '--exclude-standard']).split('\n'),
  ];

  return [...new Set(listed.map((file) => file.trim()).filter(Boolean))]
    .filter((file) => isCockpitCode(file) && fs.existsSync(path.join(repoRoot, file)))
    .sort();
}

// Версия файла в HEAD; у нового файла её нет — пустой исходник без находок.
// Так «внесённые нарушения» нового файла — это все его нарушения.
function headSource(repoRoot, file) {
  try {
    return git(repoRoot, ['show', `HEAD:${file}`]);
  } catch {
    return '';
  }
}

/**
 * Проверка перед сдачей: нарушения, внесённые в заданные файлы относительно HEAD
 * (`--all` — все нарушения этих файлов). Базовую линию не трогает и не читает.
 */
export function checkFilesReadability(files, { repoRoot = DEFAULT_REPO_ROOT, all = false } = {}) {
  const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');
  const current = collectFilesReadability(files.map((file) => ({ file, source: read(file) })));
  const previous = all
    ? { findings: {} }
    : collectFilesReadability(files.map((file) => ({ file, source: headSource(repoRoot, file) })));

  return {
    parseErrors: current.parseErrors,
    findings: introducedFindings(current, previous),
  };
}

export function createCodeReadabilityBaseline(report) {
  return { version: 1, findings: report.findings };
}

export function compareCodeReadability(report, baseline) {
  const errors = [...report.parseErrors];
  if (baseline?.version !== 1 || !baseline?.findings) {
    errors.push('baseline: нужен version=1 и findings');
    return errors;
  }
  for (const [file, rules] of Object.entries(report.findings)) {
    for (const [rule, fingerprints] of Object.entries(rules)) {
      for (const [value, count] of Object.entries(fingerprints)) {
        const allowed = baseline.findings?.[file]?.[rule]?.[value] || 0;
        if (count > allowed) errors.push(`${file}: ${rule}: ${value}`);
      }
    }
  }
  return errors;
}

export function loadCodeReadabilityBaseline(repoRoot = DEFAULT_REPO_ROOT, baselinePath = DEFAULT_BASELINE) {
  const absolute = path.isAbsolute(baselinePath) ? baselinePath : path.join(repoRoot, baselinePath);
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

export function checkCodeReadability({ repoRoot = DEFAULT_REPO_ROOT, baselinePath = DEFAULT_BASELINE } = {}) {
  const report = collectCodeReadability(repoRoot);
  const baseline = loadCodeReadabilityBaseline(repoRoot, baselinePath);
  return { report, baseline, errors: compareCodeReadability(report, baseline) };
}

/**
 * Режимы `--files <пути>` и `--changed`: те же правила для любого слоя, но только
 * новые нарушения относительно HEAD, с файлом и строкой. Код выхода 1 — есть что чинить.
 */
function mainFiles(argv) {
  const all = argv.includes('--all');
  const start = argv.indexOf('--files');
  const files = start >= 0
    ? argv.slice(start + 1).filter((arg) => !arg.startsWith('--'))
    : changedCodeFiles(DEFAULT_REPO_ROOT);
  const { parseErrors, findings } = checkFilesReadability(files, { all });
  const place = ({ file, lines: at }) => `${file}:${at.join(',') || '?'}`;
  const lines = [
    ...parseErrors,
    ...findings.map((finding) => `${place(finding)}: ${finding.rule}: ${finding.value}`),
  ];

  if (lines.length) {
    process.stderr.write(`Code readability (${files.length} файлов) нарушена:\n- ${lines.join('\n- ')}\n`);
    process.exitCode = 1;

    return;
  }

  process.stdout.write(`Code readability (${files.length} файлов): OK\n`);
}

/**
 * Без ключей — сверка TypeScript web/ с базовой линией (её держит тест), с
 * `--print-baseline` — новая базовая линия, с `--files`/`--changed` — проверка файлов.
 */
function main() {
  if (process.argv.includes('--files') || process.argv.includes('--changed')) {
    mainFiles(process.argv.slice(2));

    return;
  }

  const report = collectCodeReadability(DEFAULT_REPO_ROOT);
  if (process.argv.includes('--print-baseline')) {
    process.stdout.write(`${JSON.stringify(createCodeReadabilityBaseline(report), null, 2)}\n`);
    return;
  }
  const baseline = loadCodeReadabilityBaseline();
  const errors = compareCodeReadability(report, baseline);
  if (errors.length) {
    process.stderr.write(`Code readability нарушена:\n- ${errors.join('\n- ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('Code readability: OK\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
