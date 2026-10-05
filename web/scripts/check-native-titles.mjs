#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '@vue/compiler-sfc';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// option рисует ОС, iframe получает доступное имя; компоненты принимают заголовок или имя.
// Эти title не являются справками, которые должна показывать поверхность UiTooltipHost.
export const ALLOWED_TITLE_TAGS = [
  'option',
  'iframe',
  'UiDialog',
  'UiFloatingDialog',
  'MiniChart',
  'ProjectAvatar',
];

/**
 * Разбор SFC отличает атрибуты шаблона от текста script, комментариев и data-title.
 * Ошибка синтаксиса не маскируется пустой описью: вызывающий сторож должен её показать.
 */
export function findNativeTitles(source, filename) {
  const result = parse(source, { filename });

  if (result.errors.length > 0) {
    throw new Error(result.errors.map((error) => String(error)).join('\n'));
  }

  const findings = [];

  /**
   * Обходим обычных детей и ветки условных узлов одним способом.
   * Строка принадлежит конкретному атрибуту или самому SVG-элементу title.
   */
  function visit(node) {
    if (node.type === 1) {
      if (node.tag === 'title') {
        findings.push({
          file: filename,
          line: node.loc.start.line,
          tag: node.tag,
        });
      }
      if (!ALLOWED_TITLE_TAGS.includes(node.tag)) {
        for (const prop of node.props ?? []) {
          const native = prop.type === 6 && prop.name === 'title';
          const bound = prop.type === 7 && prop.name === 'bind'
            && prop.arg?.isStatic && prop.arg.content === 'title';

          if (native || bound) {
            findings.push({
              file: filename,
              line: prop.loc.start.line,
              tag: node.tag,
            });
          }
        }
      }
    }

    for (const child of node.children ?? []) {
      visit(child);
    }
    for (const branch of node.branches ?? []) {
      visit(branch);
    }
  }

  if (result.descriptor.template?.ast) {
    visit(result.descriptor.template.ast);
  }

  return findings;
}

/**
 * Обычный запуск проверяет production и gallery, без ignored-артефактов тестовых стендов.
 * Отсутствующая область допускается в изолированной фикстуре репозитория.
 */
function collectFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const files = [];

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectFiles(file));
    } else if (entry.isFile() && file.endsWith('.vue')) {
      files.push(file);
    }
  }

  return files;
}

/**
 * Общий UI-сторож читает errors, поэтому в них включены и находки, и ошибки разбора/чтения.
 * Явный список файлов разрешается относительно repoRoot и не подменяет ошибку отсутствия пути.
 */
export function checkNativeTitles({ repoRoot = DEFAULT_ROOT, files } = {}) {
  const selected = files ?? [
    ...collectFiles(path.join(repoRoot, 'web/src')),
    ...collectFiles(path.join(repoRoot, 'web/dev/ui-gallery')),
  ];
  const findings = [];
  const errors = [];

  if (files && files.length === 0) {
    errors.push('--files требует хотя бы один путь');
  }

  for (const file of selected) {
    const absolute = path.resolve(repoRoot, file);
    const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');

    try {
      findings.push(...findNativeTitles(fs.readFileSync(absolute, 'utf8'), relative));
    } catch (error) {
      errors.push(`${relative}: ${String(error)}`);
    }
  }

  errors.push(...findings.map(({
    file,
    line,
    tag,
  }) => `${file}:${line} <${tag}>`));

  return { findings, errors };
}

/**
 * Импорт предоставляет чистый API без побочного запуска по текущему дереву.
 * CLI возвращает ненулевой код при любой находке или неисправном входе.
 */
function main() {
  const args = process.argv.slice(2);

  if (args.length && args[0] !== '--files') {
    process.stderr.write('Допустимо: --files <пути>\n');
    process.exitCode = 1;

    return;
  }

  const result = checkNativeTitles({ files: args.length ? args.slice(1) : undefined });

  if (result.errors.length > 0) {
    process.stderr.write(`Системные title запрещены:\n- ${result.errors.join('\n- ')}\n`);
    process.exitCode = 1;

    return;
  }

  process.stdout.write('Native titles: OK\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
