#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse } from '@vue/compiler-sfc';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');

const CONTROL_TAGS = new Set(['button', 'input', 'textarea', 'select', 'dialog']);
const FORM_CONTROL_TAGS = new Set(['button', 'input', 'textarea', 'select']);
const SEMANTIC_ACTIVATION_TAGS = new Set([
  'a', 'button', 'input', 'label', 'select', 'summary', 'textarea',
]);
const SCRIPT_EXTENSIONS = new Set(['.js', '.ts']);
const SOURCE_EXTENSIONS = new Set(['.vue', '.js', '.ts']);

// UiPressable остаётся skinless-исключением, поэтому его consumers перечислены явно.
const PRESSABLE_CONSUMERS = new Set([
  'web/dev/ui-gallery/UiGallery.vue',
  'web/src/components/composites/UiChoiceList.vue',
  'web/src/components/composites/UiSelectableRow.vue',
  'web/src/components/composites/UiTab.vue',
  // Плитка версии — пункт рейки, вынесенный из AppShell: тот же skinless-контрол.
  'web/src/features/cockpit-update/CockpitVersionTile.vue',
  'web/src/shared/layout/AppShell.vue',
  'web/src/views/BoardView.vue',
  'web/src/views/chat/ChatList.vue',
  'web/src/views/code/CodePanel.vue',
  'web/src/views/code/PatchReview.vue',
  'web/src/views/diff/DiffPanel.vue',
  'web/src/views/settings/PluginsCatalog.vue',
  'web/src/views/VideoView.vue',
]);
const SVG_PRESSABLE_CONSUMERS = new Set([
  'web/dev/ui-gallery/UiGallery.vue',
  'web/src/views/pipeline/FactoryGraph.vue',
]);

const NON_ACTIVATION_HANDLERS = new Set([
  // Делегирование кликов по настоящим ссылкам внутри v-html/markdown.
  'web/src/views/DocumentModal.vue|section|click|onDocumentClick',
  'web/src/views/chat/ChatSession.vue|div|click|onMarkdownClick',
  // Доступные split-resizer: pointer drag дополняют keyboard и exact dblclick reset.
  'web/src/views/ChatsView.vue|div|dblclick|resetListWidth',
  'web/src/views/chat/ChatSession.vue|div|dblclick|resetComposerHeight',
]);

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function relativeFile(repoRoot, file) {
  return toPosix(path.relative(repoRoot, file));
}

function walkFiles(root, extensions = null) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  const visit = (directory) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && (!extensions || extensions.has(path.extname(entry.name)))) result.push(file);
    }
  };
  visit(root);
  return result;
}

function sourceFiles(repoRoot) {
  return [
    ...walkFiles(path.join(repoRoot, 'web/src'), SOURCE_EXTENSIONS),
    ...walkFiles(path.join(repoRoot, 'web/dev/ui-gallery'), SOURCE_EXTENSIONS),
  ].sort((left, right) => left.localeCompare(right));
}

function normalizeExpression(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function directiveFingerprint(prop) {
  const name = prop.rawName || `v-${prop.name}`;
  const expression = normalizeExpression(prop.exp?.content);
  return expression ? `${name}=${JSON.stringify(expression)}` : name;
}

/** Нормализованный opening tag: порядок и пробелы атрибутов не создают новый долг. */
export function openingTagFingerprint(node) {
  const attributes = node.props.map((prop) => {
    if (prop.type === 6) {
      return prop.value ? `${prop.name}=${JSON.stringify(prop.value.content)}` : prop.name;
    }
    if (prop.type === 7) return directiveFingerprint(prop);
    return normalizeExpression(prop.loc?.source);
  }).sort((left, right) => left.localeCompare(right));
  return `<${node.tag}${attributes.length ? ` ${attributes.join(' ')}` : ''}>`;
}

function incrementFinding(collection, file, kind, fingerprint) {
  collection[file] ||= {};
  collection[file][kind] ||= { count: 0, fingerprints: {} };
  const finding = collection[file][kind];
  finding.count += 1;
  finding.fingerprints[fingerprint] = (finding.fingerprints[fingerprint] || 0) + 1;
}

function staticAttribute(node, name) {
  const attribute = node.props.find((prop) => prop.type === 6 && prop.name === name);
  return attribute?.value?.content;
}

function eventName(prop) {
  if (prop.type !== 7 || prop.name !== 'on' || prop.arg?.type !== 4 || !prop.arg.isStatic) return null;
  const name = prop.arg.content.toLowerCase();
  return name === 'click' || name === 'dblclick' ? name : null;
}

function dynamicComponentControl(node) {
  if (node.tag.toLowerCase() !== 'component') return null;
  for (const prop of node.props) {
    if (prop.type === 6 && prop.name === 'is') {
      const tag = prop.value?.content?.toLowerCase();
      if (CONTROL_TAGS.has(tag)) return tag;
    }
    if (prop.type === 7 && prop.name === 'bind' && prop.arg?.type === 4
        && prop.arg.isStatic && prop.arg.content === 'is') {
      const expression = normalizeExpression(prop.exp?.content);
      const match = expression.match(/^(['"])(button|input|textarea|select|dialog)\1$/i);
      if (match) return match[2].toLowerCase();
    }
  }
  return null;
}

function isAllowedNativeTemplateControl(file, tag) {
  if (tag === 'dialog') return false;
  return FORM_CONTROL_TAGS.has(tag) && file.startsWith('web/src/components/primitives/');
}

function isAllowedNonSemanticActivation(file, node, prop, event) {
  if (file === 'web/src/components/primitives/UiSvgPressable.vue'
      && node.tag === 'g' && event === 'click') return true;

  const handler = normalizeExpression(prop.exp?.content);
  if (NON_ACTIVATION_HANDLERS.has(`${file}|${node.tag}|${event}|${handler}`)) return true;

  // Backdrop — инфраструктурный close-handler, но только внутри канонического dialog shell.
  const modifiers = prop.modifiers || [];
  const hasSelfModifier = modifiers.some((modifier) => (
    typeof modifier === 'string' ? modifier === 'self' : modifier.content === 'self'
  ));
  if (file === 'web/src/components/overlays/UiDialog.vue'
      && node.tag === 'div'
      && staticAttribute(node, 'class') === 'ui-dialog-overlay'
      && event === 'click'
      && normalizeExpression(prop.exp?.content) === 'onBackdropClick'
      && hasSelfModifier) return true;
  return false;
}

function visitTemplate(node, visitor) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 1) visitor(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) visitTemplate(child, visitor);
  }
  // v-if/v-for находятся в children после compiler-sfc parse; branches нужны для
  // синтетических AST, которые может вернуть будущая версия compiler-dom.
  if (Array.isArray(node.branches)) {
    for (const branch of node.branches) visitTemplate(branch, visitor);
  }
}

function parseErrorText(error) {
  if (typeof error === 'string') return error;
  return error?.message || String(error);
}

function scriptKind(file) {
  if (file.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function staticString(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text.toLowerCase();
  return null;
}

function propertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression) return staticString(node.argumentExpression);
  return null;
}

function callTargetName(node) {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  return propertyName(node.expression);
}

function isNativeDialogCall(node) {
  const name = callTargetName(node);
  if (!['confirm', 'prompt', 'alert'].includes(name)) return null;
  if (ts.isIdentifier(node.expression)) return name;
  if (!ts.isPropertyAccessExpression(node.expression) && !ts.isElementAccessExpression(node.expression)) return null;
  const receiver = node.expression.expression;
  if (ts.isIdentifier(receiver) && (receiver.text === 'window' || receiver.text === 'globalThis')) return name;
  return null;
}

function isCreateElementCall(node) {
  return propertyName(node.expression) === 'createElement';
}

function isRenderControlCall(node) {
  const target = callTargetName(node);
  if (target !== 'h' && target !== 'createVNode') return null;
  const tag = node.arguments[0] ? staticString(node.arguments[0]) : null;
  return CONTROL_TAGS.has(tag) ? { target, tag } : null;
}

function normalizedCall(node, sourceFile) {
  return normalizeExpression(node.getText(sourceFile));
}

function analyzeScript(report, file, source, suffix = '', language = '') {
  const virtualFile = `${file}${suffix}`;
  const sourceFile = ts.createSourceFile(
    virtualFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    language === 'tsx'
      ? ts.ScriptKind.TSX
      : language === 'jsx'
        ? ts.ScriptKind.JSX
        : language === 'ts'
          ? ts.ScriptKind.TS
          : scriptKind(virtualFile),
  );
  for (const diagnostic of sourceFile.parseDiagnostics) {
    report.parseErrors.push(
      `${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
    );
  }
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const dialog = isNativeDialogCall(node);
      if (dialog) {
        incrementFinding(report.scriptControls, file, `system:${dialog}`, normalizedCall(node, sourceFile));
      }

      if (isCreateElementCall(node)) {
        const tag = node.arguments[0] ? staticString(node.arguments[0]) : null;
        if (CONTROL_TAGS.has(tag)) {
          if (file === 'web/src/shared/clipboard.ts' && tag === 'textarea') {
            report.clipboardTextareaCount += 1;
          } else {
            incrementFinding(
              report.scriptControls,
              file,
              `createElement:${tag}`,
              normalizedCall(node, sourceFile),
            );
          }
        }
      }

      const render = isRenderControlCall(node);
      if (render) {
        incrementFinding(
          report.scriptControls,
          file,
          `${render.target}:${render.tag}`,
          normalizedCall(node, sourceFile),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function analyzeVue(report, repoRoot, absoluteFile, file, source) {
  const result = parse(source, { filename: absoluteFile, sourceMap: false });
  for (const error of result.errors) report.parseErrors.push(`${file}: ${parseErrorText(error)}`);
  const { descriptor } = result;
  if (descriptor.template?.ast) {
    visitTemplate(descriptor.template.ast, (node) => {
      const tag = node.tag.toLowerCase();
      const nativeTag = node.tagType === 0 && CONTROL_TAGS.has(tag)
        ? tag
        : dynamicComponentControl(node);
      if (nativeTag && !isAllowedNativeTemplateControl(file, nativeTag)) {
        incrementFinding(report.nativeTemplateControls, file, nativeTag, openingTagFingerprint(node));
      }

      const componentTag = node.tag.toLowerCase();
      if ((componentTag === 'uipressable' || componentTag === 'ui-pressable')
          && !PRESSABLE_CONSUMERS.has(file)) {
        report.invalidPressableConsumers.push(`${file}: UiPressable`);
      }
      if ((componentTag === 'uisvgpressable' || componentTag === 'ui-svg-pressable')
          && !SVG_PRESSABLE_CONSUMERS.has(file)) {
        report.invalidPressableConsumers.push(`${file}: UiSvgPressable`);
      }

      if (node.tagType !== 0 || SEMANTIC_ACTIVATION_TAGS.has(tag)) return;
      for (const prop of node.props) {
        const event = eventName(prop);
        if (!event || isAllowedNonSemanticActivation(file, node, prop, event)) continue;
        incrementFinding(
          report.nonSemanticActivations,
          file,
          `${event}:${tag}`,
          openingTagFingerprint(node),
        );
      }
    });
  }

  if (descriptor.script) {
    analyzeScript(report, file, descriptor.script.content, '?script', descriptor.script.lang);
  }
  if (descriptor.scriptSetup) {
    analyzeScript(report, file, descriptor.scriptSetup.content, '?script-setup', descriptor.scriptSetup.lang);
  }
}

function structuralState(repoRoot) {
  const componentRoot = path.join(repoRoot, 'web/src/components');
  const componentFiles = walkFiles(componentRoot);
  const misplacedUiVue = sourceFiles(repoRoot)
    .map((file) => relativeFile(repoRoot, file))
    .filter((file) => file.endsWith('.vue') && /^Ui[A-Z].*\.vue$/.test(path.posix.basename(file)))
    .filter((file) => !file.startsWith('web/src/components/'))
    .filter((file) => file !== 'web/dev/ui-gallery/UiGallery.vue');
  const invalidComponentFiles = componentFiles
    .map((file) => relativeFile(repoRoot, file))
    .filter((file) => path.posix.basename(file) !== 'README.md')
    .filter((file) => !/^Ui[A-Z].*\.vue$/.test(path.posix.basename(file)));
  const componentsUi = componentFiles
    .map((file) => relativeFile(repoRoot, file))
    .filter((file) => file.startsWith('web/src/components/ui/'));
  const legacySharedUiFiles = walkFiles(path.join(repoRoot, 'web/src/shared/ui'))
    .map((file) => relativeFile(repoRoot, file));
  const forbiddenGlobalCss = [
    ...walkFiles(path.join(repoRoot, 'web/src'), new Set(['.css'])),
    ...walkFiles(path.join(repoRoot, 'web/dev/ui-gallery'), new Set(['.css'])),
  ]
    .map((file) => relativeFile(repoRoot, file))
    .filter((file) => !file.startsWith('web/src/styles/'));
  return {
    misplacedUiVue,
    invalidComponentFiles,
    componentsUi,
    legacySharedUiFiles,
    forbiddenGlobalCss,
  };
}

export function collectUiBoundary(repoRoot = DEFAULT_REPO_ROOT) {
  const resolvedRoot = path.resolve(repoRoot);
  const report = {
    nativeTemplateControls: {},
    scriptControls: {},
    nonSemanticActivations: {},
    clipboardTextareaCount: 0,
    clipboardFilePresent: false,
    invalidPressableConsumers: [],
    parseErrors: [],
    structural: structuralState(resolvedRoot),
  };

  for (const absoluteFile of sourceFiles(resolvedRoot)) {
    const file = relativeFile(resolvedRoot, absoluteFile);
    if (file === 'web/src/shared/clipboard.ts') report.clipboardFilePresent = true;
    const source = fs.readFileSync(absoluteFile, 'utf8');
    if (absoluteFile.endsWith('.vue')) analyzeVue(report, resolvedRoot, absoluteFile, file, source);
    else if (SCRIPT_EXTENSIONS.has(path.extname(absoluteFile))) analyzeScript(report, file, source);
  }
  return report;
}

function appendFindingErrors(label, findings, errors) {
  for (const [file, kinds] of Object.entries(findings)) {
    for (const [kind, finding] of Object.entries(kinds)) {
      const fingerprints = Object.entries(finding.fingerprints)
        .map(([fingerprint, count]) => `${count}× ${fingerprint}`)
        .join('; ');
      errors.push(`${label}: запрещено ${file} ${kind}: ${fingerprints}`);
    }
  }
}

export function compareUiBoundary(report) {
  const errors = [...report.parseErrors];
  appendFindingErrors('нативные template-контролы', report.nativeTemplateControls, errors);
  appendFindingErrors('script-контролы', report.scriptControls, errors);
  appendFindingErrors('несемантическая активация', report.nonSemanticActivations, errors);

  if (report.clipboardFilePresent && report.clipboardTextareaCount !== 1) {
    errors.push(
      `clipboard: существующий web/src/shared/clipboard.ts обязан содержать ровно один `
      + `createElement("textarea"), найдено ${report.clipboardTextareaCount}`,
    );
  }
  errors.push(...report.invalidPressableConsumers.map((item) => `pressable allowlist: ${item}`));
  errors.push(...report.structural.misplacedUiVue.map((file) => `Ui*.vue вне components/: ${file}`));
  errors.push(...report.structural.invalidComponentFiles.map((file) => `не-SFC файл в components/: ${file}`));
  errors.push(...report.structural.componentsUi.map((file) => `запрещён components/ui/: ${file}`));
  errors.push(...report.structural.forbiddenGlobalCss.map((file) => `global CSS вне styles/: ${file}`));
  errors.push(...report.structural.legacySharedUiFiles.map((file) => `запрещён shared/ui: ${file}`));
  return [...new Set(errors)];
}

export function checkUiBoundary({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const report = collectUiBoundary(repoRoot);
  return { report, errors: compareUiBoundary(report) };
}

function parseArguments(argv) {
  const options = { repoRoot: DEFAULT_REPO_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--repo-root') options.repoRoot = path.resolve(argv[++index]);
    else throw new Error(`Неизвестный аргумент: ${argument}`);
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = collectUiBoundary(options.repoRoot);
  const errors = compareUiBoundary(report);
  if (errors.length) {
    process.stderr.write(`UI boundary нарушен:\n- ${errors.join('\n- ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('UI boundary: OK\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
