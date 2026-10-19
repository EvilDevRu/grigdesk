import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import ts from 'typescript';

/**
 * Инвентаризация мест упаковки сервера в SEA.
 *
 * Модуль ничего не собирает и не меняет: он находит в собственном коде конструкции,
 * от которых зависит перенос в комплект (`process.execPath`, fork, import.meta,
 * вычисляемый import, createRequire, require.resolve, ссылки на ресурсы), и сверяет
 * их с таблицей server/build/sea-inventory.json. Отдельно учитываются ссылки на
 * пути server/shared/cli из shell-файлов движка, bin и deploy.
 */

export const CONSTRUCTS = [
  'exec-path',
  'fork',
  'import-meta',
  'dynamic-import',
  'create-require',
  'require-resolve',
  'resource-ref',
  'shell-ref',
] as const;

export const OWNERS = [
  'task-0',
  'task-1',
  'task-2',
  'task-3',
  'task-4',
  'task-5',
  'task-6',
  'task-7',
  'task-8',
  'task-9',
  'task-10',
  'task-11',
  'task-12',
  'task-13',
  'task-14',
  'task-15',
  'task-16',
  'task-17',
  'task-18',
  'task-19',
  'deepseek-plan',
  'unassigned',
] as const;

export const FATES = [
  'server-bundle',
  'helper',
  'package',
  'asset',
  'compat-wrapper',
  'development-only',
  'deferred-deepseek',
  'unassigned',
] as const;

export const RESOURCE_KINDS = ['file', 'dir'] as const;
export const RESOURCE_EXPECT = ['source', 'generated'] as const;

export type Construct = (typeof CONSTRUCTS)[number];
export type Owner = (typeof OWNERS)[number];
export type Fate = (typeof FATES)[number];

export interface InventoryPoint {
  file: string;
  construct: Construct;
  target: string;
  count: number;
  owner: Owner | '';
  fate: Fate | '';
  detail: string;
}

export interface InventoryResource {
  path: string;
  kind: (typeof RESOURCE_KINDS)[number];
  expect: (typeof RESOURCE_EXPECT)[number];
  owner: Owner;
  fate: Fate;
  detail: string;
}

export interface InventoryManifest {
  schema: number;
  points: InventoryPoint[];
  resources: InventoryResource[];
}

export interface ScanSpec {
  codeRoots: readonly string[];
  codeExtensions: readonly string[];
  shellRoots: readonly string[];
  shellExtensions: readonly string[];
}

export const DEFAULT_SCAN: ScanSpec = {
  codeRoots: ['server/src', 'server/scripts', 'shared', 'cli'],
  codeExtensions: ['.ts', '.mts', '.js', '.mjs', '.cjs'],
  shellRoots: ['engine', 'bin', 'deploy'],
  shellExtensions: ['.sh', '.bash', '.mjs', '.js'],
};

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'release']);
const ROOT_REFERENCES = new Set(['.', '']);

/**
 * Ключ точки не зависит от номера строки: файл, конструкция и цель ссылки.
 * Этого достаточно, чтобы заметить и новую точку, и исчезнувшую запись.
 */
function pointKey(point: Pick<InventoryPoint, 'file' | 'construct' | 'target'>): string {
  return `${point.file}\u0000${point.construct}\u0000${point.target}`;
}

/**
 * Приводит путь внутри дерева к posix-виду без начального слэша.
 * Ссылка на каталог сохраняет завершающий слэш: так её видно в таблице.
 */
function normalizeTarget(file: string, literal: string): string {
  const directory = literal.endsWith('/');
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(file), literal))
    .replace(/\/+$/u, '');

  if (joined === '.') {
    return '.';
  }

  return directory ? `${joined}/` : joined;
}

/**
 * Достаёт текст литерала: обычную строку или шаблон без подстановок.
 * Любое вычисляемое выражение возвращает null и учитывается как `<computed>`.
 */
function literalText(expression: ts.Expression | undefined): string | null {
  if (!expression) {
    return null;
  }

  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }

  return null;
}

/**
 * Проверяет, что узел — обращение вида import.meta.<name>.
 * Для самого import.meta без свойства возвращает пустую строку.
 */
function importMetaProperty(node: ts.MetaProperty): string {
  if (!ts.isPropertyAccessExpression(node.parent) || node.parent.expression !== node) {
    return '';
  }

  return node.parent.name.text;
}

/**
 * Вычисляет цель ссылки на ресурс для new URL('./x', import.meta.url)
 * и path.resolve(import.meta.dirname, '../x').
 */
function resourceTarget(node: ts.CallExpression | ts.NewExpression): string | null {
  const args = node.arguments;

  if (!args || args.length < 2) {
    return null;
  }

  const literal = literalText(args[0]);

  if (literal === null) {
    return null;
  }

  const second = args[1];

  if (!second || !ts.isPropertyAccessExpression(second)) {
    return null;
  }

  const holder = second.expression;

  if (!ts.isMetaProperty(holder) || holder.keywordToken !== ts.SyntaxKind.ImportKeyword) {
    return null;
  }

  return second.name.text === 'url' ? literal : null;
}

/**
 * Проверяет импорт dirname-пути: path.resolve(import.meta.dirname, '<литерал>').
 * Другие формы вычисления каталога не угадываются и остаются без resource-ref.
 */
function dirnameTarget(node: ts.CallExpression): string | null {
  const callee = node.expression;

  if (!ts.isPropertyAccessExpression(callee)
    || !ts.isIdentifier(callee.expression) || callee.expression.text !== 'path'
    || (callee.name.text !== 'resolve' && callee.name.text !== 'join')) {
    return null;
  }

  const first = node.arguments[0];

  if (!first || !ts.isPropertyAccessExpression(first)) {
    return null;
  }

  const holder = first.expression;

  if (!ts.isMetaProperty(holder) || holder.keywordToken !== ts.SyntaxKind.ImportKeyword
    || first.name.text !== 'dirname') {
    return null;
  }

  return node.arguments.length === 2 ? literalText(node.arguments[1]) : null;
}

class Collector {
  private readonly points = new Map<string, InventoryPoint>();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /**
   * Увеличивает счётчик точки или заводит новую запись.
   * Одинаковые file/construct/target складываются в одну строку таблицы,
   * поэтому изменение числа вызовов видно без привязки к номерам строк.
   */
  add(construct: Construct, target = '', count = 1): void {
    const key = pointKey({
      file: this.file,
      construct,
      target
    });
    const existing = this.points.get(key);

    if (existing) {
      existing.count += count;

      return;
    }

    this.points.set(key, {
      file: this.file,
      construct,
      target,
      count,
      owner: '',
      fate: '',
      detail: '',
    });
  }

  /**
   * Разбирает один узел TypeScript AST и передаёт найденную конструкцию в накопитель.
   * Числовые литералы и обычные строки не считаются упаковочными точками.
   */
  visit(node: ts.Node): void {
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      this.add('import-meta', importMetaProperty(node));
    }

    if (ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression) && node.expression.text === 'process'
      && node.name.text === 'execPath') {
      this.add('exec-path');
    }

    if (ts.isCallExpression(node)) {
      this.visitCall(node);
    }

    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'URL') {
      const target = resourceTarget(node);

      if (target !== null) {
        this.add('resource-ref', normalizeTarget(this.file, target));
      }
    }

    ts.forEachChild(node, (child) => this.visit(child));
  }

  /**
   * Разбирает вызовы: fork, createRequire, require.resolve, import() и ссылки на ресурсы.
   * Целью import() считается литерал, а вычисляемое выражение помечается `<computed>`.
   */
  private visitCall(node: ts.CallExpression): void {
    const callee = node.expression;

    if (callee.kind === ts.SyntaxKind.ImportKeyword) {
      this.add('dynamic-import', literalText(node.arguments[0]) ?? '<computed>');

      return;
    }

    if (ts.isIdentifier(callee)) {
      if (callee.text === 'fork') {
        this.add('fork');
      }

      if (callee.text === 'createRequire') {
        this.add('create-require');
      }
    }

    if (ts.isPropertyAccessExpression(callee)
      && ts.isIdentifier(callee.expression) && callee.expression.text === 'require'
      && callee.name.text === 'resolve') {
      this.add('require-resolve', literalText(node.arguments[0]) ?? '<computed>');
    }

    if (ts.isIdentifier(callee) && callee.text === 'URL') {
      const target = resourceTarget(node);

      if (target !== null) {
        this.add('resource-ref', normalizeTarget(this.file, target));
      }
    }

    const dirname = dirnameTarget(node);

    if (dirname !== null) {
      this.add('resource-ref', normalizeTarget(this.file, dirname));
    }
  }

  finish(): InventoryPoint[] {
    return [...this.points.values()];
  }
}

/**
 * Рекурсивно обходит каталог и возвращает относительные posix-пути файлов.
 * Символические ссылки и служебные каталоги не раскрываются.
 */
async function listFiles(root: string, directory: string, extensions: readonly string[]):
  Promise<string[]> {
  const absolute = path.join(root, directory);
  let entries;

  try {
    entries = await readdir(absolute, {
      withFileTypes: true
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  const files: string[] = [];

  for (const entry of entries) {
    const relative = path.posix.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) {
        files.push(...await listFiles(root, relative, extensions));
      }

      continue;
    }

    if (entry.isFile() && extensions.includes(path.posix.extname(entry.name))) {
      files.push(relative);
    }
  }

  return files.sort();
}

/**
 * Разбирает собственный JS/TS файл и собирает его упаковочные точки.
 * Ошибки разбора не подавляются: файл, который не удалось прочитать, — ошибка.
 */
async function scanCodeFile(root: string, file: string): Promise<InventoryPoint[]> {
  const source = await readFile(path.join(root, file), 'utf8');
  const kind = path.posix.extname(file) === '.js' || path.posix.extname(file) === '.mjs'
    || path.posix.extname(file) === '.cjs'
    ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const collector = new Collector(file);

  collector.visit(parsed);

  return collector.finish();
}

const SHELL_REFERENCE =
  /(?<![\w.-])((?:server|shared|cli)\/[A-Za-z0-9_@%+./-]*[A-Za-z0-9_@%+/-])/gu;

/**
 * Ищет в shell/JS-файле ссылки на пути server/shared/cli.
 * Полные строки комментариев пропускаются: упоминание в тексте не является
 * исполняемой зависимостью от пути.
 */
async function scanShellFile(root: string, file: string): Promise<InventoryPoint[]> {
  const source = await readFile(path.join(root, file), 'utf8');
  const collector = new Collector(file);

  for (const line of source.split('\n')) {
    const trimmed = line.trim();

    if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
      continue;
    }

    for (const match of line.matchAll(SHELL_REFERENCE)) {
      const target = (match[1] ?? '').replace(/\.+$/u, '');

      if (target) {
        collector.add('shell-ref', target);
      }
    }
  }

  return collector.finish();
}

/**
 * Сканирует дерево по явному списку корней и расширений.
 * Результат отсортирован: сравнение таблицы не зависит от порядка чтения каталогов.
 */
export async function scanProject(root: string, spec: ScanSpec = DEFAULT_SCAN):
  Promise<InventoryPoint[]> {
  const points: InventoryPoint[] = [];

  for (const codeRoot of spec.codeRoots) {
    for (const file of await listFiles(root, codeRoot, spec.codeExtensions)) {
      points.push(...await scanCodeFile(root, file));
    }
  }

  for (const shellRoot of spec.shellRoots) {
    for (const file of await listFiles(root, shellRoot, spec.shellExtensions)) {
      points.push(...await scanShellFile(root, file));
    }
  }

  return points.sort((left, right) => pointKey(left).localeCompare(pointKey(right)));
}

/**
 * Сравнивает ожидаемую таблицу с найденными точками.
 * Возвращает тексты отказов; пустой массив означает полное совпадение.
 */
export function compareInventory(expected: readonly InventoryPoint[],
  scanned: readonly InventoryPoint[]): string[] {
  const errors: string[] = [];
  const expectedMap = new Map<string, InventoryPoint>();

  for (const point of expected) {
    const key = pointKey(point);

    if (expectedMap.has(key)) {
      errors.push(`Дубликат записи inventory: ${point.file} ${point.construct} ${point.target}`);
    }

    expectedMap.set(key, point);
  }

  const scannedMap = new Map(scanned.map((point) => [pointKey(point), point]));

  for (const point of scanned) {
    const known = expectedMap.get(pointKey(point));

    if (!known) {
      errors.push(`Не учтена точка упаковки: ${point.file} ${point.construct} `
        + `${point.target || '(без цели)'} ×${point.count}; добавьте её в server/build/sea-inventory.json`);
      continue;
    }

    if (known.count !== point.count) {
      errors.push(`Число точек изменилось: ${point.file} ${point.construct} `
        + `${point.target || '(без цели)'}: в inventory ${known.count}, в дереве ${point.count}`);
    }
  }

  for (const point of expected) {
    if (!scannedMap.has(pointKey(point))) {
      errors.push(`Запись inventory устарела: ${point.file} ${point.construct} `
        + `${point.target || '(без цели)'}; в дереве точка больше не найдена`);
    }
  }

  return errors;
}

/**
 * Проверяет владельца и судьбу точки или ресурса.
 * `unassigned` — рабочее значение генератора: проверка обязана его отклонить.
 */
function validateAssignment(label: string, owner: string, fate: string): string[] {
  const errors: string[] = [];

  if (owner === 'unassigned') {
    errors.push(`${label}: владелец не назначен`);
  } else if (!(OWNERS as readonly string[]).includes(owner)) {
    errors.push(`${label}: неизвестный владелец ${owner}`);
  }

  if (fate === 'unassigned') {
    errors.push(`${label}: судьба не назначена`);
  } else if (!(FATES as readonly string[]).includes(fate)) {
    errors.push(`${label}: неизвестная судьба ${fate}`);
  }

  return errors;
}

/**
 * Проверяет форму записей таблицы до сверки с деревом.
 * Ошибки называют запись целиком, чтобы её можно было исправить без гаданий.
 */
function validateManifest(manifest: InventoryManifest): string[] {
  const errors: string[] = [];

  if (!manifest || manifest.schema !== 1) {
    return ['Некорректная схема inventory: ожидается schema=1'];
  }

  if (!Array.isArray(manifest.points) || !Array.isArray(manifest.resources)) {
    return ['Некорректная схема inventory: нужны массивы points и resources'];
  }

  for (const point of manifest.points) {
    const label = `${point.file} ${point.construct} ${point.target || '(без цели)'}`;
    const numericCount = Number.isInteger(point.count) && point.count > 0;

    if (!point.file || path.posix.isAbsolute(point.file) || point.file.startsWith('../')) {
      errors.push(`${label}: путь записи должен быть относительным`);
    }

    if (!(CONSTRUCTS as readonly string[]).includes(point.construct)) {
      errors.push(`${label}: неизвестная конструкция ${point.construct}`);
    }

    if (!numericCount) {
      errors.push(`${label}: count должен быть положительным целым`);
    }

    if (typeof point.detail !== 'string' || point.detail.trim() === '') {
      errors.push(`${label}: пустое пояснение`);
    }

    errors.push(...validateAssignment(label, point.owner, point.fate));
  }

  const resourcePaths = new Set<string>();

  for (const resource of manifest.resources) {
    const label = `Ресурс ${resource.path}`;

    if (!resource.path || path.posix.isAbsolute(resource.path) || resource.path.startsWith('../')) {
      errors.push(`${label}: путь должен быть относительным`);
    }

    if (resourcePaths.has(resource.path)) {
      errors.push(`${label}: повтор записи`);
    }

    resourcePaths.add(resource.path);

    if (!(RESOURCE_KINDS as readonly string[]).includes(resource.kind)) {
      errors.push(`${label}: неизвестный вид ${resource.kind}`);
    }

    if (!(RESOURCE_EXPECT as readonly string[]).includes(resource.expect)) {
      errors.push(`${label}: неизвестное ожидание ${resource.expect}`);
    }

    if (typeof resource.detail !== 'string' || resource.detail.trim() === '') {
      errors.push(`${label}: пустое пояснение`);
    }

    errors.push(...validateAssignment(label, resource.owner, resource.fate));
  }

  return errors;
}

/**
 * Проверяет, что исходные ресурсы таблицы действительно есть в дереве.
 * Сгенерированные сборкой пути проверяются отдельной командой упаковки.
 */
async function validateResources(root: string, manifest: InventoryManifest): Promise<string[]> {
  const errors: string[] = [];

  for (const resource of manifest.resources) {
    if (resource.expect !== 'source') {
      continue;
    }

    const absolute = path.join(root, resource.path.replace(/\/$/u, ''));
    let info;

    try {
      info = await stat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        errors.push(`Ресурс не существует: ${resource.path}`);
        continue;
      }

      throw error;
    }

    if (resource.kind === 'dir' && !info.isDirectory()) {
      errors.push(`Ресурс должен быть каталогом: ${resource.path}`);
    }

    if (resource.kind === 'file' && !info.isFile()) {
      errors.push(`Ресурс должен быть файлом: ${resource.path}`);
    }
  }

  return errors;
}

/**
 * Проверяет, что каждая ссылка на ресурс с судьбой asset/helper покрыта
 * записью payload. Иначе файл-ресурс мог бы исчезнуть при упаковке незаметно.
 */
function validateCoverage(manifest: InventoryManifest, scanned: readonly InventoryPoint[]):
  string[] {
  const errors: string[] = [];
  const expected = new Map(manifest.points.map((point) => [pointKey(point), point]));

  for (const point of scanned) {
    if (point.construct !== 'resource-ref' || ROOT_REFERENCES.has(point.target)) {
      continue;
    }

    const known = expected.get(pointKey(point));

    if (!known || (known.fate !== 'asset' && known.fate !== 'helper')) {
      continue;
    }

    const covered = manifest.resources.some((resource) => {
      if (resource.path === point.target) {
        return true;
      }

      const directory = resource.path.endsWith('/') ? resource.path : `${resource.path}/`;

      return point.target.startsWith(directory);
    });

    if (!covered) {
      errors.push(`Ссылка на ресурс не покрыта payload: ${point.file} → ${point.target}`);
    }
  }

  return errors;
}

/**
 * Полная проверка таблицы: схема, точное совпадение с деревом, ресурсы и покрытие.
 * Функция не меняет ни таблицу, ни рабочее дерево.
 */
export async function checkInventory(root: string, manifest: InventoryManifest,
  spec: ScanSpec = DEFAULT_SCAN): Promise<string[]> {
  const schemaErrors = validateManifest(manifest);

  if (schemaErrors.length > 0) {
    return schemaErrors;
  }

  const scanned = await scanProject(root, spec);

  return [
    ...schemaErrors,
    ...compareInventory(manifest.points, scanned),
    ...await validateResources(root, manifest),
    ...validateCoverage(manifest, scanned),
  ];
}
