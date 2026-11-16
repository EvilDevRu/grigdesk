#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AREAS = ['core', 'settings', 'desktop', 'native'];
const FORMS = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const LABELS = new Set([
  'label', 'title', 'description', 'hint', 'placeholder', 'aria-label', 'loading-label',
  'empty-text', 'emptyText', 'loadingLabel', 'confirmLabel', 'cancelLabel', 'message', 'body', 'text',
  'error', 'question', 'heading', 'confirm-text', 'cancel-text', 'okText', 'cancelText',
  'summary', 'note', 'authHint', 'alt', 'help', 'aria-description', 'clear-label', 'clearLabel',
]);
const MESSAGE_CALL = new Set([
  'showToast', 'toast', 'alertUser', 'confirmDialog', 'promptDialog', 'alertDialog',
  'notify', 'Error', 'showErrorBox',
  'setError', 'setWarning', 'setCancelNotice',
]);

/**
 * Обход ограничен объявленными областями и автоматически видит новые файлы в них.
 * Временные примеры проверяются тем же кодом с явным корнем репозитория.
 */
function filesAt(root) {
  if (!fs.existsSync(root)) {
    return [];
  }

  if (fs.statSync(root).isFile()) {
    return [root];
  }

  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    filesAt(path.join(root, entry.name)));
}

/**
 * Каталог разворачивается по ключам, а plural остаётся одной записью сообщения.
 * Все формы проверяются на other и одинаковые именованные параметры.
 */
function flatten(object, prefix, result, report, file) {
  for (const [name, value] of Object.entries(object)) {
    const key = prefix ? `${prefix}.${name}` : name;

    if (typeof value === 'string') {
      result.set(key, value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (Object.entries(value).some(([form, text]) => FORMS.has(form) && typeof text === 'string')) {
        if (typeof value.other !== 'string') {
          report(file, 1, `${key}: plural требует other`);
        }

        result.set(key, value);
      } else {
        flatten(value, key, result, report, file);
      }
    } else {
      report(file, 1, `${key}: ожидается текст или plural`);
    }
  }
}

function parameters(value) {
  return [...new Set(Object.values(typeof value === 'string' ? { other: value } : value)
    .flatMap((form) => [...String(form).matchAll(/\{(\w+)\}/g)].map((match) => match[1])))].sort();
}

/**
 * Покрытие метаданных следует за стабильными ID исходной декларации приложения.
 * Новый системный плагин, поле или слот требует каталожную запись до выпуска UI.
 */
function metadataCoverage(scope, repoRoot, russian, keyUsed, report) {
  for (const rule of scope.metadataCoverage ?? []) {
    const file = path.join(repoRoot, rule.file);
    const source = fs.readFileSync(file, 'utf8');
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const constants = new Map();
    const line = (node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;

    /**
     * Утверждения типов и скобки сохраняют ту же константную декларацию метаданных.
     * Без снятия оболочки массив с as const выпадает из проверки покрытия по ID.
     */
    function expression(node) {
      while (node && (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
          || ts.isParenthesizedExpression(node))) {
        node = node.expression;
      }

      return node;
    }

    function property(node, name) {
      node = expression(node);

      return ts.isObjectLiteralExpression(node)
        ? node.properties.find((item) => ts.isPropertyAssignment(item)
          && item.name.getText(tree).replace(/['"]/g, '') === name)?.initializer : undefined;
    }

    /**
     * Читаются только константные строки и их конкатенация, без исполнения сервера.
     * Неподдерживаемое выражение сохраняется неизвестным и не подменяет проверку ключа.
     */
    function value(node) {
      node = expression(node);

      if (!node) {
        return undefined;
      }

      if (ts.isStringLiteralLike(node)) {
        return node.text;
      }

      if (ts.isIdentifier(node)) {
        return constants.get(node.text);
      }

      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = value(node.left);
        const right = value(node.right);

        return left === undefined || right === undefined ? undefined : left + right;
      }

      return undefined;
    }

    /**
     * Сверка русского источника обнаруживает смену подписи при прежнем ID.
     * Неизвестный внешний текст не исполняется и не сравнивается по содержимому.
     */
    function fields(node, prefix, mapping) {
      for (const [sourcePath, targetPath] of Object.entries(mapping ?? {})) {
        const field = sourcePath.split('.').reduce((parent, name) =>
          parent ? property(parent, name) : undefined, node);

        if (!field) {
          continue;
        }

        const key = `${prefix}.${targetPath}`;
        const original = value(field);

        keyUsed(file, line(field), key);

        if (original !== undefined && russian.has(key) && russian.get(key) !== original) {
          report(file, line(field), `${key}: русский каталог отличается от исходной метаданной`);
        }
      }
    }

    /**
     * Дочерние массивы используют собственные ID: key поля и value варианта.
     * Значения, ограничения и порядок декларации не становятся переводимым содержимым.
     */
    function records(array, prefix, specification) {
      array = expression(array);

      if (!array || !ts.isArrayLiteralExpression(array)) {
        return;
      }

      for (const node of array.elements) {
        const id = value(property(node, specification.id));

        if (id === undefined) {
          continue;
        }

        const key = `${prefix}.${id}`;

        fields(node, key, specification.fields);

        for (const child of specification.children ?? []) {
          records(property(node, child.property), `${key}.${child.target}`, child);
        }
      }
    }

    /**
     * Находятся объявленные таблицы и поля массивов, сохраняя исходные номера строк.
     * Остальные узлы обходятся только для поиска вложенной декларации метаданных.
     */
    function visit(node) {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const constant = value(node.initializer);

        if (constant !== undefined) {
          constants.set(node.name.getText(tree), constant);
        }

        if (node.name.getText(tree) === rule.table) {
          if (rule.dictionary && ts.isObjectLiteralExpression(node.initializer)) {
            for (const entry of node.initializer.properties) {
              if (ts.isPropertyAssignment(entry)) {
                keyUsed(file, line(entry), `${rule.prefix}.${entry.name.getText(tree).replace(/['"]/g, '')}`);
              }
            }
          } else if (rule.object) {
            fields(node.initializer, rule.prefix, rule.fields);
          } else {
            records(node.initializer, rule.prefix, rule);
          }
        }
      }

      if (rule.property && ts.isPropertyAssignment(node)
          && node.name.getText(tree) === rule.property) {
        records(node.initializer, rule.prefix, rule);
      }

      if (rule.recordId && ts.isObjectLiteralExpression(node)) {
        const id = value(property(node, rule.recordId));

        if (id !== undefined && !rule.excludeIds?.includes(id)) {
          fields(node, `${rule.prefix}.${id}`, rule.fields);
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(tree);
  }
}

/**
 * Старый native wire передаёт собственные причины без машинного кода сообщения.
 * Сторож сверяет их точные исходные подписи с зарегистрированной таблицей проекции,
 * не включая в неё внешние schema title/description и сообщения серверных ошибок.
 */
function nativeMetadataCoverage(scope, repoRoot, russian, report) {
  for (const rule of scope.nativeMetadataSources ?? []) {
    const prefixes = rule.catalogPrefixes ?? ['settings.nativeMetadata.'];
    const captions = new Set([...russian].filter(([key]) => prefixes.some((prefix) => key.startsWith(prefix)))
      .map(([, value]) => value));

    for (const token of rule.technicalTokens ?? []) {
      if (token.reason && token.text) {
        captions.add(token.text);
      }
    }

    const file = path.join(repoRoot, rule.file);
    const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

    /**
     * Соседние строковые части объявления образуют одну собственную подпись.
     * Динамическое выражение остаётся неизвестным и обходится по дочерним ветвям.
     */
    function constant(node) {
      if (ts.isStringLiteralLike(node)) {
        return node.text;
      }

      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = constant(node.left);
        const right = constant(node.right);

        return left === undefined || right === undefined ? undefined : left + right;
      }

      return undefined;
    }

    /**
     * Проверяются только явно названные свойства и вызовы владельца метаданных.
     * Технические ID и условия ветвления не становятся новыми надписями.
     */
    function inspect(node) {
      if (ts.isConditionalExpression(node)) {
        inspect(node.whenTrue);
        inspect(node.whenFalse);

        return;
      }

      const value = constant(node);

      if (value !== undefined && value.trim() && !captions.has(value)) {
        const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;

        report(file, line, 'Собственная native-метаданная отсутствует в таблице перевода');
      }

      if (value === undefined) {
        ts.forEachChild(node, inspect);
      }
    }

    /**
     * Шаблонные функции деклараций проходят тот же путь, что статические объекты.
     * Проверка читает AST и не импортирует сервер или установленные CLI.
     */
    function visit(node) {
      const declaration = ts.isPropertyAssignment(node)
        && rule.properties.includes(node.name.getText(tree).replace(/['"]/g, ''))
        || ts.isVariableDeclaration(node) && rule.variables?.includes(node.name.getText(tree));

      if (declaration && node.initializer) {
        inspect(node.initializer);
      } else if (ts.isCallExpression(node) && rule.calls?.includes(node.expression.getText(tree))) {
        for (const argument of node.arguments) {
          inspect(argument);
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(tree);
  }
}

/**
 * Нативные подписи используют те же ключи JSON и проверяются без Android SDK.
 * Лексер пропускает комментарии; технические строки вне UI-вызовов остаются данными.
 */
function nativeCaptions(scope, repoRoot, russian, keyUsed, visible) {
  for (const relative of scope.nativeFiles ?? []) {
    const file = path.join(repoRoot, relative);
    const source = fs.readFileSync(file, 'utf8');
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
    const calls = [];
    let callee = '';

    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      if (token === ts.SyntaxKind.Identifier) {
        callee = callee.endsWith('.') ? callee + scanner.getTokenText() : scanner.getTokenText();
      } else if (token === ts.SyntaxKind.DotToken) {
        callee += '.';
      } else if ([ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.OpenBracketToken,
        ts.SyntaxKind.OpenBraceToken].includes(token)) {
        calls.push({
          name: token === ts.SyntaxKind.OpenParenToken ? callee : '',
          argument: 0,
        });
        callee = '';
      } else if ([ts.SyntaxKind.CloseParenToken, ts.SyntaxKind.CloseBracketToken,
        ts.SyntaxKind.CloseBraceToken].includes(token)) {
        calls.pop();
        callee = '';
      } else {
        if (token === ts.SyntaxKind.CommaToken && calls.length) {
          calls.at(-1).argument += 1;
        }

        callee = '';
      }

      if (token !== ts.SyntaxKind.StringLiteral) {
        continue;
      }

      const position = scanner.getTokenPos();
      const prefix = source.slice(Math.max(0, position - 220), position);
      const value = scanner.getTokenValue();
      const line = source.slice(0, position).split('\n').length;
      const toast = calls.at(-1)?.name === 'Toast.makeText' && calls.at(-1).argument === 1;
      const androidKey = /ClientLocale\.text\(\s*$/.test(prefix);
      const sharedKey = /\.text\(\s*$/.test(prefix) && /^(?:native|core)\./.test(value)
        || /ShellLocale\.text\([^,]*,\s*$/.test(prefix);

      if (androidKey || sharedKey) {
        keyUsed(file, line, androidKey ? `native.${value}` : value);
      } else if (/(?:setTitle|setMessage|setPrompt|setPositiveButton|setNegativeButton)\(\s*$/.test(prefix)
          || toast) {
        visible(file, line, value);
      } else if (/new (?:IllegalArgumentException|IllegalStateException|IOException)\(\s*$/.test(prefix)) {
        visible(file, line, value);
      }
    }
  }
}

/**
 * Верхнеуровневые bindings SFC связывают видимый template с исходным объявлением.
 * Проверка сохраняет AST и строку объявления, не исполняя компонент или его зависимости.
 */
function templateScriptBindings(blocks, file) {
  const bindings = new Map();

  for (const block of blocks) {
    const tree = ts.createSourceFile(file, block.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const offset = block.loc.start.line - 1;

    for (const statement of tree.statements) {
      if (!ts.isVariableStatement(statement)) {
        continue;
      }

      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          bindings.set(declaration.name.text, {
            node: declaration.initializer,
            tree,
            offset,
          });
        }
      }
    }
  }

  return bindings;
}

/**
 * Обычные строки данных не считаются переводами по совпадению содержимого.
 * Сторож проверяет только видимые sinks, статические ключи и объявленные динамические таблицы.
 */
export function checkI18n({ repoRoot = DEFAULT_ROOT } = {}) {
  const errors = [];
  const report = (file, line, message) => {
    errors.push(`${path.relative(repoRoot, file)}:${line}: ${message}`);
  };
  const scopeFile = path.join(repoRoot, 'web/scripts/i18n-scope.json');
  const scope = JSON.parse(fs.readFileSync(scopeFile, 'utf8'));
  const assets = path.join(repoRoot, 'shared/i18n/assets/locales');
  const registry = JSON.parse(fs.readFileSync(path.join(assets, 'catalog.json'), 'utf8'));
  const catalogs = new Map();

  for (const locale of registry) {
    const messages = new Map();

    for (const area of AREAS) {
      const file = path.join(assets, locale.id, `${area}.json`);

      if (!fs.existsSync(file)) {
        report(file, 1, 'Каталог отсутствует');

        continue;
      }

      flatten(JSON.parse(fs.readFileSync(file, 'utf8')), area, messages, report, file);
    }

    catalogs.set(locale.id, messages);
  }

  const russian = catalogs.get('ru') ?? new Map();

  for (const [locale, messages] of catalogs) {
    for (const [key, source] of russian) {
      const translated = messages.get(key);
      const file = path.join(assets, locale, `${key.split('.')[0]}.json`);

      if (translated === undefined) {
        report(file, 1, `${key}: нет перевода`);
      } else if (JSON.stringify(parameters(source)) !== JSON.stringify(parameters(translated))) {
        report(file, 1, `${key}: именованные параметры отличаются`);
      }
    }
  }

  const tokens = new Set((scope.technicalTokens ?? []).filter((token) => !token.file).map((token) =>
    typeof token === 'string' ? token : token.text));
  const sourceTokens = new Set((scope.technicalTokens ?? []).filter((token) => token.file)
    .map((token) => `${token.file}\0${token.text}`));
  const visible = (file, line, value) => {
    const sourceToken = `${path.relative(repoRoot, file)}\0${value.trim()}`;

    if (/[A-Za-zА-Яа-яЁё]/.test(value) && !tokens.has(value.trim()) && !sourceTokens.has(sourceToken)) {
      report(file, line, `Надпись вне каталога: ${value.trim().slice(0, 80)}`);
    }
  };
  const keyUsed = (file, line, key) => {
    if (!russian.has(key)) {
      report(file, line, `${key}: ключ отсутствует`);
    }
  };

  metadataCoverage(scope, repoRoot, russian, keyUsed, report);
  nativeMetadataCoverage(scope, repoRoot, russian, report);
  nativeCaptions(scope, repoRoot, russian, keyUsed, visible);

  /**
   * AST различает ключи, значения полей и вызовы показа сообщений от ID и команд.
   * Комментарии, URL, CSS и переданные человеком данные не являются надписями.
   */
  function script(source, file, offset = 0, fragment = false, visibleExpression = false,
    bindings = new Map(),
  ) {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const line = (node) => offset + tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
    const literal = (node) => ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node);

    /**
     * Сначала читается ближайшее объявление: одноимённый аргумент скрывает внешний binding.
     * Только template без собственного объявления обращается к верхнему уровню SFC.
     */
    function reference(node, origin) {
      for (let scope = node.parent; scope; scope = scope.parent) {
        if (scope.parameters?.some((parameter) => parameter.name.getText(origin.tree) === node.text)) {
          return undefined;
        }

        if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) {
          continue;
        }

        for (const statement of scope.statements) {
          if (!ts.isVariableStatement(statement)) {
            continue;
          }

          const declaration = statement.declarationList.declarations.find((item) =>
            ts.isIdentifier(item.name) && item.name.text === node.text);

          if (declaration?.initializer) {
            return { ...origin, node: declaration.initializer };
          }
        }
      }

      return bindings.get(node.text);
    }

    /**
     * Проверяются именно ветви показываемого текста, а не условия с техническими ID.
     * Вызов перевода владеет шаблоном; его параметры могут содержать исходные данные.
     */
    function caption(node, origin = { tree, offset }, seen = new Set()) {
      if (seen.has(node)) {
        return;
      }

      const visited = new Set([...seen, node]);
      const inspect = (child) => caption(child, origin, visited);
      const at = (child) => origin.offset
        + origin.tree.getLineAndCharacterOfPosition(child.getStart(origin.tree)).line + 1;

      if (literal(node)) {
        visible(file, at(node), node.text);
      } else if (ts.isIdentifier(node)) {
        const binding = reference(node, origin);

        if (binding) {
          caption(binding.node, binding, visited);
        }
      } else if (ts.isTemplateExpression(node)) {
        visible(file, at(node), node.head.text);

        for (const span of node.templateSpans) {
          visible(file, at(span.literal), span.literal.text);
          inspect(span.expression);
        }
      } else if (ts.isConditionalExpression(node)) {
        inspect(node.whenTrue);
        inspect(node.whenFalse);
      } else if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)
          || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
        inspect(node.expression);
      } else if (ts.isPropertyAccessExpression(node) && node.name.text === 'value') {
        inspect(node.expression);
      } else if (ts.isCallExpression(node)
          && ['ref', 'shallowRef', 'computed'].includes(node.expression.getText(origin.tree))) {
        if (node.arguments[0]) {
          inspect(node.arguments[0]);
        }
      } else if (ts.isCallExpression(node)
          && /(?:failureText|errorMessage|FailureText|ErrorMessage)$/.test(
            node.expression.getText(origin.tree),
          )) {
        if (node.arguments[1]) {
          inspect(node.arguments[1]);
        }
      } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        if (ts.isBlock(node.body)) {
          for (const statement of node.body.statements) {
            if (ts.isReturnStatement(statement) && statement.expression) {
              inspect(statement.expression);
            }
          }
        } else {
          inspect(node.body);
        }
      } else if (ts.isBinaryExpression(node)) {
        if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) {
          inspect(node.left);
        }

        inspect(node.right);
      }
    }

    /**
     * Обход ограничивает fragment только аргументами собственных уведомлений.
     * В полной области он также проверяет публичные подписи объектов метаданных.
     */
    function visit(node, inMessage = false) {
      const call = ts.isCallExpression(node) || ts.isNewExpression(node);
      const name = call ? node.expression.getText(tree).split('.').at(-1) : '';
      const binding = call && ts.isIdentifier(node.expression)
        ? reference(node.expression, { tree, offset }) : undefined;
      const factory = binding && ts.isCallExpression(binding.node)
        ? binding.node.expression.getText(binding.tree).split('.').at(-1) : '';
      const isTranslation = ['t', 'translate', 'messageRef', 'desktopText', 'messageText'].includes(name)
        || ['localeTranslator', 'localeMessage'].includes(factory);

      if (call && name === 'messageList' && node.arguments?.[0]
          && ts.isArrayLiteralExpression(node.arguments[0])) {
        for (const key of node.arguments[0].elements) {
          if (literal(key)) {
            keyUsed(file, line(key), key.text);
          } else {
            report(file, line(key), 'Список переводов требует статические ключи');
          }
        }
      }

      if (isTranslation) {
        const args = node.arguments ?? [];
        const index = node.expression.getText(tree).endsWith('translator.t') ? 1 : 0;
        const key = args[index];

        if (key && literal(key)) {
          keyUsed(file, line(key), key.text);
        } else if (key) {
          const expression = key.getText(tree);
          const declared = scope.dynamicExpressions?.[path.relative(repoRoot, file)]?.[expression];

          if (!declared) {
            report(file, line(key), `Вычисляемый ключ требует таблицу: ${expression}`);
          } else {
            for (const pattern of declared) {
              const escaped = pattern.split('*').map((part) =>
                part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+');
              const matcher = new RegExp(`^${escaped}$`);

              if (![...russian.keys()].some((candidate) => matcher.test(candidate))) {
                report(file, line(key), `${pattern}: таблица вычисляемых ключей пуста`);
              }
            }
          }
        }
      }

      const message = inMessage || call && MESSAGE_CALL.has(name) && (!fragment || name !== 'Error');

      if (visibleExpression && ts.isExpressionStatement(node)) {
        caption(node.expression);
      }

      if (ts.isPropertyAssignment(node) && LABELS.has(node.name.getText(tree).replace(/['"]/g, ''))
          && (!fragment || message) && (node.name.getText(tree) !== 'body' || message)
          ) {
        let owner = node.parent;

        while (owner && !ts.isVariableDeclaration(owner)) {
          owner = owner.parent;
        }

        const tables = scope.dynamicKeyTables?.[path.relative(repoRoot, file)] ?? [];

        if (owner && tables.includes(owner.name.getText(tree))) {
          if (literal(node.initializer)) {
            keyUsed(file, line(node), node.initializer.text);
          }
        } else {
          caption(node.initializer);
        }
      }

      if (!fragment && ts.isBinaryExpression(node)
          && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && ts.isPropertyAccessExpression(node.left) && LABELS.has(node.left.name.text)) {
        caption(node.right);
      }

      if (!fragment && ts.isVariableDeclaration(node) && node.initializer
          && LABELS.has(node.name.getText(tree))) {
        caption(node.initializer);
      }

      if (!fragment && ts.isGetAccessor(node) && LABELS.has(node.name.getText(tree))) {
        for (const statement of node.body?.statements ?? []) {
          if (ts.isReturnStatement(statement) && statement.expression) {
            caption(statement.expression);
          }
        }
      }

      if (call && !isTranslation && MESSAGE_CALL.has(name) && (!fragment || name !== 'Error')) {
        const argumentsToCheck = name === 'showErrorBox' ? node.arguments : node.arguments?.slice(0, 1);

        for (const argument of argumentsToCheck ?? []) {
          caption(argument);
        }
      }

      ts.forEachChild(node, (child) => visit(child, message));
    }

    visit(tree);
  }

  /**
   * Template AST видит текст и доступные подписи обоих языков, включая новые SFC.
   * Выражения проверяются как код, технические атрибуты и raw bindings сохраняются.
   */
  function template(source, file, offset, bindings) {
    const tree = baseParse(source);

    /**
     * Каждый узел сохраняет адрес исходного шаблона для сообщения guard.
     * Дочерние элементы проверяются независимо от условного показа страницы.
     */
    function visit(node) {
      const line = offset + node.loc.start.line;

      if (node.type === 2) {
        visible(file, line, node.content);
      } else if (node.type === 5) {
        script(node.content.content, file, line - 1, false, true, bindings);
      } else if (node.type === 1) {
        for (const prop of node.props) {
          if (prop.type === 6 && LABELS.has(prop.name) && prop.value) {
            visible(file, offset + prop.loc.start.line, prop.value.content);
          } else if (prop.type === 7 && prop.exp) {
            script(prop.exp.content, file, offset + prop.loc.start.line - 1, false,
              LABELS.has(prop.arg?.content) || prop.name === 'tooltip', bindings);
          }
        }
      }

      for (const child of node.children ?? []) {
        visit(child);
      }
    }

    visit(tree);
  }

  const selected = new Set((scope.include ?? []).flatMap((entry) => filesAt(path.join(repoRoot, entry))));
  const fragments = new Set((scope.fragments ?? []).map((entry) =>
    path.join(repoRoot, typeof entry === 'string' ? entry : entry.file)));

  for (const file of new Set([...selected, ...fragments])) {
    if (!/\.(?:vue|[cm]?[jt]s)$/.test(file)) {
      continue;
    }

    const source = fs.readFileSync(file, 'utf8');

    if (file.endsWith('.vue')) {
      const { descriptor } = parse(source, { filename: file });
      const blocks = [descriptor.script, descriptor.scriptSetup].filter(Boolean);
      const bindings = templateScriptBindings(blocks, file);

      if (descriptor.template) {
        template(descriptor.template.content, file, descriptor.template.loc.start.line - 1, bindings);
      }

      for (const block of blocks) {
        script(block.content, file, block.loc.start.line - 1);
      }
    } else {
      script(source, file, 0, fragments.has(file));
    }
  }

  for (const keys of Object.values(scope.dynamicKeys ?? {})) {
    for (const key of keys) {
      keyUsed(scopeFile, 1, key);
    }
  }

  return { errors };
}

/**
 * CLI возвращает единицу при нарушении и печатает адрес каждого источника.
 * Импорт проверки из общего UI suite не запускает процесс повторно.
 */
function main() {
  const index = process.argv.indexOf('--repo-root');
  const result = checkI18n({ repoRoot: index < 0 ? DEFAULT_ROOT : process.argv[index + 1] });

  if (result.errors.length) {
    process.stderr.write(result.errors.join('\n') + '\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('I18n: OK\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
