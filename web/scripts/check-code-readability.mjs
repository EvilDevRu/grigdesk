#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse } from '@vue/compiler-sfc';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const DEFAULT_BASELINE = 'tests/web/fixtures/ui/code-readability-baseline.json';
const MAX_LINE_LENGTH = 110;

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

function addFinding(report, file, rule, value) {
  report.findings[file] ||= {};
  report.findings[file][rule] ||= {};
  report.findings[file][rule][value] = (report.findings[file][rule][value] || 0) + 1;
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

function checkStatementSpacing(report, file, sourceFile, statements) {
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

function checkFunction(report, file, sourceFile, node) {
  if (!node.body || !ts.isBlock(node.body)) return;
  const startLine = lineOf(sourceFile, node.body.getStart(sourceFile));
  const endLine = lineOf(sourceFile, node.body.getEnd());
  if (startLine === endLine && node.body.statements.length) {
    addFinding(report, file, 'one-line-function', fingerprint(node, sourceFile));
  }

  const anchor = functionAnchor(node);
  if (!anchor) return;
  const nonTrivial = isExported(anchor)
    || node.body.statements.length >= 4
    || branchCount(node.body) >= 2;
  if (nonTrivial && !hasMultilineExplanation(anchor, sourceFile)) {
    addFinding(report, file, 'function-explanation', fingerprint(anchor, sourceFile));
  }
}

function checkMembers(report, file, sourceFile, node) {
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
  if (packed) addFinding(report, file, 'packed-members', fingerprint(node, sourceFile));
}

function analyzeScript(report, file, source, kind) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  for (const diagnostic of sourceFile.parseDiagnostics) {
    report.parseErrors.push(`${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
  }

  source.split('\n').forEach((line, index) => {
    if (line.length > MAX_LINE_LENGTH) {
      addFinding(report, file, 'line-length', `${index + 1}:${line.trim().slice(0, 180)}`);
    }
  });

  checkStatementSpacing(report, file, sourceFile, sourceFile.statements);

  function visit(node) {
    if (ts.isBlock(node)) checkStatementSpacing(report, file, sourceFile, node.statements);
    if (isFunctionLike(node)) checkFunction(report, file, sourceFile, node);
    checkMembers(report, file, sourceFile, node);

    for (const body of controlBody(node)) {
      if (!ts.isBlock(body) && !ts.isIfStatement(body)) {
        addFinding(report, file, 'unbraced-control', fingerprint(node, sourceFile));
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

function main() {
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
