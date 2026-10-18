// Гит-хелперы для дифа задачи (приёмка) и панели «Код».
//
// Приёмка (`taskDiff`) смотрит ОДНУ величину — что сделано поверх HEAD: правки фабрики
// до коммита. Ветка vs master зашумлена мёржами, а индекс фабрика не трогает.
// Панель «Код» (`worktreeChanges`) показывает то же, что Source Control в VS Code, и
// потому делит изменения на ДВЕ группы: индекс vs HEAD и рабочее дерево vs индекс.
// Одной величины «diff HEAD» для человека мало — см. комментарий у `worktreeChanges`.
//
// Отдаём по файлу содержимое ДО и ПОСЛЕ — диф строит Monaco на клиенте (тот же виджет,
// что в VS Code: side-by-side, подсветка, сворачивание неизменённого).
import { execFile, spawn } from 'node:child_process';
import type { ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  CodeBlameResponse,
  CodeCommitsDiffResponse,
  CodeCommitResponse,
  CodeFileDiffResponse,
  CodeFileLogResponse,
  CodeFetchResponse,
  CodeGitDiff,
  CodeGitEntry,
  CodeGitFile,
  CodeGitTracking,
  CodePatchResponse,
  CodePushResponse,
  CodeSearchResponse,
  CodeStageResponse,
  CodeStagedContext,
  CodeUndoCommitResponse,
  CodeWorktreeChanges,
} from '../../../shared/plugins/code/codeContracts.ts';

export type StagedCommitContext = CodeStagedContext;

interface FileCounts {
  add: number;
  del: number;
  binary: boolean;
  untracked?: boolean;
}

interface FileCollection {
  statuses: Record<string, string>;
  oldPathOf: Record<string, string>;
  counts: Record<string, FileCounts>;
  group?: 'staged' | 'work' | 'commits';
  withContent: boolean;
  readOld: (file: string, status: string) => string | Promise<string>;
  readNew: (file: string, status: string) => string | Promise<string>;
}

interface GitActionOptions {
  all?: boolean;
  paths?: unknown;
}

interface GitActionSelection {
  paths: string[];
  changed: number;
}

interface CommitStagedOptions {
  amend?: boolean;
}

export interface FileDiffOptions {
  group: 'staged' | 'work' | 'commits';
  path: string;
  base?: string;
  to?: string;
  work?: boolean;
}

// Режим «с текущими изменениями»: правая сторона отрезка — рабочее дерево, а не коммит.
export interface RangeOptions {
  work?: boolean;
}

export interface BranchDiffOptions {
  main: boolean;
  mainBranch: string;
}

interface LimitedGitOutput {
  output: string;
  truncated: boolean;
}

interface LimitedGitOptions {
  limit?: number;
  timeoutMs?: number;
  allowedExitCodes?: number[];
  timeoutMessage?: string;
  failureMessage?: string;
}

export interface PatchTextOptions {
  group: 'staged' | 'work' | 'commits';
  path?: string;
  base?: string;
  to?: string;
  work?: boolean;
}

export interface SearchTreeOptions {
  limit?: number;
  isHidden?: (relPath: string) => boolean;
}

const exec = promisify(execFile);
// Предел на размер стороны файла — не тащить в браузер гигантские блобы.
const MAX_BYTES = 1_500_000;

/**
 * Выполняет Git без shell и возвращает текст: все вызывающие функции разбирают
 * его как UTF-8, независимо от настроек окружающего процесса.
 */
async function git(
  cwd: string,
  args: string[],
  options: Omit<ExecFileOptions, 'encoding'> = {},
): Promise<string> {
  // core.quotePath=false обязателен: с дефолтным `true` git отдаёт не-ASCII путь
  // октальными байтами («"\321\204\320\260\320\271\320\273.txt"»), и такой файл
  // не открыть ни по имени, ни через `git show` — диф выходил пустым.
  const { stdout } = await exec(
    'git',
    ['-C', cwd, '-c', 'core.quotePath=false', ...args],
    {
      maxBuffer: 64 * 1024 * 1024,
      ...options,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        ...(options.env || {}),
      },
    },
  );

  return stdout;
}

export class CodeGitError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = 'CodeGitError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Снимает C-кавычки git с пути. Даже при `core.quotePath=false` git квотирует путь
 * с пробелом, кавычкой или управляющим символом, поэтому кавычки надо снимать всегда.
 * Октальные escape поддержаны на случай чужого конфига: молча испортить имя нельзя.
 */
export function unquotePath(raw: unknown): string {
  const value = String(raw ?? '');

  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }

  const body = value.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = {
    n: 10,
    t: 9,
    r: 13,
    f: 12,
    b: 8,
    v: 11,
    a: 7,
    '\\': 92,
    '"': 34,
  };

  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charAt(i);

    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }

    const next = body[i + 1];

    if (next === undefined) {
      break;
    }

    if (next >= '0' && next <= '7') {
      const octal = body.slice(i + 1, i + 4);

      bytes.push(parseInt(octal, 8) & 0xff);
      i += octal.length;
      continue;
    }

    const byte = simple[next] ?? Buffer.from(next, 'utf8')[0];

    if (byte !== undefined) {
      bytes.push(byte);
    }

    i += 1;
  }

  return Buffer.from(bytes).toString('utf8');
}

/**
 * Путь-цель из `--numstat`: при переименовании git пишет его одной строкой —
 * «old => new» либо с общим префиксом «dir/{sub => }/f.txt». Без раскрытия счётчик
 * не находил файл по его настоящему пути, и правки показывались как 0/0.
 */
function numstatPath(raw: string): string {
  if (!raw.includes(' => ')) {
    return unquotePath(raw);
  }

  const brace = raw.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  const merged = brace
    ? `${brace[1]}${brace[3]}${brace[4]}`
    : raw.slice(raw.lastIndexOf(' => ') + 4);

  return unquotePath(merged.replace(/\/{2,}/g, '/'));
}

// Столько первых символов git просматривает в поисках NUL, решая, бинарный ли файл.
const BINARY_PROBE_CHARS = 8000;

/**
 * Число строк текста по правилу git: строкой считается каждый перевод строки, а
 * незавершённый хвост — ещё одна. Нужно только неотслеживаемым файлам: в diff они
 * не попадают, и без этого счёта новый файл показывался как «+0», а итог группы врал.
 */
function countLines(text: string): number {
  if (!text) {
    return 0;
  }

  let lines = 0;

  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      lines += 1;
    }
  }

  return text.endsWith('\n') ? lines : lines + 1;
}

/** Та же эвристика, что у git: NUL в начале файла — значит бинарный. */
function looksBinary(text: string): boolean {
  return text.slice(0, BINARY_PROBE_CHARS).includes('\0');
}

/**
 * Numstat задаёт добавления, удаления и путь, разделённые табуляцией.
 * Пара «-/-» обозначает бинарный файл: для него текстовые счётчики равны нулю.
 */
function parseNumstat(text: string): Record<string, FileCounts> {
  const counts: Record<string, FileCounts> = {};

  for (const line of text.split('\n')) {
    const m = line.match(/^(\S+)\t(\S+)\t(.+)$/);

    if (!m) {
      continue;
    }

    const [, add, del, file] = m;

    if (add === undefined || del === undefined || file === undefined) {
      continue;
    }

    const binary = add === '-' && del === '-';

    counts[numstatPath(file)] = {
      add: binary ? 0 : Number(add),
      del: binary ? 0 : Number(del),
      binary,
    };
  }

  return counts;
}

/**
 * Name-status задаёт код и путь через табуляцию. Для переименования есть оба пути:
 * новое имя управляет строкой списка, а старое нужно для чтения прежнего содержимого.
 */
function parseNameStatus(text: string) {
  const statuses: Record<string, string> = {};
  const oldPathOf: Record<string, string> = {};

  for (const line of text.split('\n')) {
    const [status, from, destination] = line.split('\t');

    if (!status || from === undefined) {
      continue;
    }

    const code = status.charAt(0);

    if (code === 'R' && destination !== undefined) {
      const to = unquotePath(destination);

      statuses[to] = 'R';
      oldPathOf[to] = unquotePath(from);
    } else {
      statuses[unquotePath(from)] = code;
    }
  }

  return {
    statuses,
    oldPathOf,
  };
}

/**
 * Неотслеживаемые (новые) файлы — их нет ни в индексе, ни в HEAD, поэтому в diff
 * они не попадают вовсе. `--untracked-files=all`: иначе porcelain схлопывает новый
 * каталог в одну запись «?? dir/», которая попадает в список как «файл» с пустым дифом.
 */
function parseUntracked(porcelain: string): string[] {
  return porcelain.split('\n')
    .filter((l) => l.startsWith('??'))
    .map((l) => unquotePath(l.slice(3).trim()))
    .filter(Boolean);
}

const UNMERGED_STATUSES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/**
 * Porcelain хранит конфликт в двухколоночном XY-коде. Обычные name-status diff
 * раскладывают его иначе, поэтому именно status остаётся источником истины для `U`.
 */
function parseUnmerged(porcelain: string): string[] {
  return porcelain.split('\n')
    .filter((line) => UNMERGED_STATUSES.has(line.slice(0, 2)))
    .map((line) => unquotePath(line.slice(3).trim()))
    .filter(Boolean);
}

/**
 * Читает сторону файла из HEAD. У нового файла либо до первого коммита этой
 * стороны нет, поэтому ошибку чтения представляет пустым содержимым.
 */
export async function showAt(cwd: string, rev: string, relPath: string): Promise<string> {
  try {
    return await git(cwd, ['show', `${rev}:${relPath}`]);
  } catch {
    return '';
  }
}

async function showHead(cwd: string, relPath: string): Promise<string> {
  return showAt(cwd, 'HEAD', relPath);
}

/**
 * Читает именно индекс, чтобы частично проиндексированные правки не сливались.
 * Отсутствие файла в индексе означает пустую сторону дифа.
 */
async function showIndex(cwd: string, relPath: string): Promise<string> {
  try {
    return await git(cwd, ['show', `:${relPath}`]);
  } catch {
    return '';
  }
}

/** Читает заданную стадию unmerged-индекса; отсутствие стороны даёт пустой текст. */
async function showIndexStage(cwd: string, stage: number, relPath: string): Promise<string> {
  try {
    return await git(cwd, ['show', `:${stage}:${relPath}`]);
  } catch {
    return '';
  }
}

/**
 * Читает рабочую сторону дифа с диска. Удалённый или уже исчезнувший файл
 * возвращает пустое содержимое, как и до миграции.
 */
async function readWork(cwd: string, relPath: string): Promise<string> {
  try {
    return await fs.readFile(path.join(cwd, relPath), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Собирает метаданные группы и по явному флагу — содержимое сторон. Неотслеживаемый
 * файл всё равно читается ради бинарности и числа строк, но его текст в ленивый список
 * не копируется.
 */
async function collectFiles({
  statuses,
  oldPathOf,
  counts,
  group,
  withContent,
  readOld,
  readNew,
}: FileCollection): Promise<(CodeGitEntry | CodeGitFile)[]> {
  const files: (CodeGitEntry | CodeGitFile)[] = [];

  for (const [p, st] of Object.entries(statuses)) {
    const c = counts[p] || {
      add: 0,
      del: 0,
      binary: false,
    };
    const entry: CodeGitEntry = {
      path: p,
      status: st,
      add: c.add,
      del: c.del,
      binary: c.binary,
      ...(group ? { group } : {}),
      ...(st === 'R' && oldPathOf[p] ? { oldPath: oldPathOf[p] } : {}),
    };

    if (c.binary) {
      files.push(withContent ? {
        ...entry,
        tooBig: false,
        oldContent: '',
        newContent: '',
      } : entry);
      continue;
    }

    let oldContent = '';
    let newContent = '';

    if (withContent || c.untracked) {
      [oldContent, newContent] = await Promise.all([
        withContent ? readOld(p, st) : '',
        readNew(p, st),
      ]);
    }

    // Неотслеживаемого файла нет ни в одном diff, поэтому бинарность и число строк
    // определяются по содержимому: иначе новый файл показывался как «+0».
    if (c.untracked) {
      if (looksBinary(newContent)) {
        entry.binary = true;
        files.push(withContent ? {
          ...entry,
          tooBig: false,
          oldContent: '',
          newContent: '',
        } : entry);
        continue;
      }

      if (Buffer.byteLength(newContent, 'utf8') <= MAX_BYTES) {
        entry.add = countLines(newContent);
      } else {
        entry.add = 0;
        entry.del = 0;
      }
    }

    if (!withContent) {
      files.push(entry);
      continue;
    }

    const tooBig = Buffer.byteLength(oldContent, 'utf8') > MAX_BYTES
      || Buffer.byteLength(newContent, 'utf8') > MAX_BYTES;

    files.push({
      ...entry,
      tooBig,
      oldContent: tooBig ? '' : oldContent,
      newContent: tooBig ? '' : newContent,
    });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  return files;
}

/**
 * Диф воркдира ОТНОСИТЕЛЬНО HEAD: список изменённых файлов с содержимым до/после.
 * Индекс здесь намеренно не отделяется — приёмка задачи спрашивает «что сделано
 * поверх последнего коммита», а не «что уже проиндексировано».
 */
export async function taskDiff(cwd: string): Promise<CodeGitDiff> {
  const [branch, stat, numstat, nameStatus, porcelain] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
    git(cwd, ['diff', '--stat', 'HEAD']).catch(() => ''),
    git(cwd, ['diff', '--numstat', 'HEAD']).catch(() => ''),
    git(cwd, ['diff', '--name-status', 'HEAD']).catch(() => ''),
    git(cwd, ['status', '--porcelain', '--untracked-files=all']).catch(() => ''),
  ]);

  const counts = parseNumstat(numstat);
  const { statuses, oldPathOf } = parseNameStatus(nameStatus);
  const untracked = new Set(parseUntracked(porcelain));

  for (const u of untracked) {
    statuses[u] = 'A';

    if (!counts[u]) {
      counts[u] = {
        add: 0,
        del: 0,
        binary: false,
        untracked: true,
      };
    }
  }

  const files = await collectFiles({
    statuses,
    oldPathOf,
    counts,
    withContent: true,
    // ДО: из HEAD (для новых — пусто); при переименовании — по старому пути.
    readOld: (p, st) => (st === 'A' ? '' : showHead(cwd, st === 'R' ? (oldPathOf[p] || p) : p)),
    // ПОСЛЕ: из воркдира (для удалённых — пусто).
    readNew: (p, st) => (st === 'D' ? '' : readWork(cwd, p)),
  }) as CodeGitFile[];

  return {
    branch: branch.trim(),
    stat: stat.trim(),
    files,
  };
}

/**
 * Изменения рабочей копии ДВУМЯ группами, как Source Control в VS Code:
 *   staged — индекс против HEAD (то, что уедет в коммит прямо сейчас);
 *   files  — рабочее дерево против ИНДЕКСА плюс неотслеживаемые файлы.
 *
 * Одного «diff HEAD» человеку мало по двум причинам, и обе воспроизводимы:
 *   1) файл, проиндексированный и затем возвращённый в рабочем дереве к состоянию
 *      HEAD, из «diff HEAD» пропадает целиком — хотя его изменение лежит в индексе
 *      и уедет в коммит;
 *   2) частично проиндексированный файл выглядит одной записью, и что именно
 *      попадёт в коммит, а что останется — не видно.
 * Один и тот же путь законно присутствует в обеих группах с разными дифами.
 */
export async function worktreeChanges(
  cwd: string,
  { withContent = true }: { withContent?: boolean } = {},
): Promise<CodeWorktreeChanges> {
  const [branch, stat, stagedNumstat, stagedNameStatus, workNumstat, workNameStatus, porcelain]
    = await Promise.all([
      git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
      git(cwd, ['diff', '--stat', 'HEAD']).catch(() => ''),
      // Без явного HEAD Git сам берёт его, а до первого коммита — пустое дерево.
      git(cwd, ['diff', '--cached', '--numstat']).catch(() => ''),
      git(cwd, ['diff', '--cached', '--name-status']).catch(() => ''),
      git(cwd, ['diff', '--numstat']).catch(() => ''),
      git(cwd, ['diff', '--name-status']).catch(() => ''),
      git(cwd, ['status', '--porcelain', '--untracked-files=all']).catch(() => ''),
    ]);

  const unmerged = new Set(parseUnmerged(porcelain));
  const stagedStatus = parseNameStatus(stagedNameStatus);

  for (const relPath of unmerged) {
    delete stagedStatus.statuses[relPath];
    delete stagedStatus.oldPathOf[relPath];
  }

  const staged = await collectFiles({
    statuses: stagedStatus.statuses,
    oldPathOf: stagedStatus.oldPathOf,
    counts: parseNumstat(stagedNumstat),
    group: 'staged',
    withContent,
    // ДО — HEAD (при переименовании по старому пути), ПОСЛЕ — индекс.
    readOld: (p, st) => (st === 'A' ? '' : showHead(cwd, st === 'R' ? (stagedStatus.oldPathOf[p] || p) : p)),
    readNew: (p, st) => (st === 'D' ? '' : showIndex(cwd, p)),
  });

  const workStatus = parseNameStatus(workNameStatus);
  const untracked = new Set(parseUntracked(porcelain));

  for (const u of untracked) {
    workStatus.statuses[u] = 'A';
  }

  for (const relPath of unmerged) {
    workStatus.statuses[relPath] = 'U';
  }

  const workCounts = parseNumstat(workNumstat);

  for (const relPath of unmerged) {
    workCounts[relPath] = {
      add: 0,
      del: 0,
      binary: false,
    };
  }

  for (const u of untracked) {
    if (!workCounts[u]) {
      workCounts[u] = {
        add: 0,
        del: 0,
        binary: false,
        untracked: true,
      };
    }
  }

  const files = await collectFiles({
    statuses: workStatus.statuses,
    oldPathOf: workStatus.oldPathOf,
    counts: workCounts,
    group: 'work',
    withContent,
    // ДО — индекс: у неотслеживаемого файла его там нет по определению.
    readOld: (p, st) => (untracked.has(p)
      ? ''
      : st === 'U'
        ? showIndexStage(cwd, 2, p)
        : showIndex(cwd, st === 'R' ? (workStatus.oldPathOf[p] || p) : p)),
    // ПОСЛЕ — рабочее дерево (для удалённых — пусто).
    readNew: (p, st) => (st === 'D' ? '' : readWork(cwd, p)),
  });

  return {
    branch: branch.trim(),
    stat: stat.trim(),
    files,
    staged,
  };
}

/**
 * Формирует полный ответ одного файла и применяет общий байтовый потолок к обеим
 * сторонам. Бинарный файл намеренно не декодируется в текст для браузера.
 */
function fileDiffResponse(
  entry: CodeGitEntry,
  oldContent: string,
  newContent: string,
): CodeFileDiffResponse {
  const tooBig = Buffer.byteLength(oldContent, 'utf8') > MAX_BYTES
    || Buffer.byteLength(newContent, 'utf8') > MAX_BYTES;

  return {
    path: entry.path,
    status: entry.status,
    binary: entry.binary,
    tooBig,
    oldContent: entry.binary || tooBig ? '' : oldContent,
    newContent: entry.binary || tooBig ? '' : newContent,
  };
}

/** Проверяет object id до передачи в rev-parse и отделяет отсутствие от плохой формы. */
async function resolveCommit(cwd: string, value: string): Promise<string> {
  if (!/^[0-9a-f]{7,64}$/u.test(value)) {
    throw new CodeGitError('bad_commit', 'Некорректный идентификатор коммита.', 400);
  }

  try {
    return (await git(cwd, ['rev-parse', '--verify', '--quiet', `${value}^{commit}`])).trim();
  } catch {
    throw new CodeGitError('no_commit', 'Коммит не найден.', 404);
  }
}

/** Проверяет левую сторону commit-дифа как commit либо tree object. */
async function verifyDiffBase(cwd: string, value: string): Promise<string> {
  if (!/^[0-9a-f]{7,64}$/u.test(value)) {
    throw new CodeGitError('bad_commit', 'Некорректная база коммита.', 400);
  }

  try {
    await git(cwd, ['cat-file', '-e', `${value}^{tree}`]);

    return value;
  } catch {
    throw new CodeGitError('no_commit', 'База коммита не найдена.', 404);
  }
}

/**
 * Список изменений между двумя проверенными объектами без чтения содержимого.
 * Переименования определяются одинаково для списка и последующего file-diff.
 *
 * Пустой `to` — режим «с текущими изменениями»: правая сторона — рабочее дерево
 * (`git diff <база>` без второй ревизии) плюс неотслеживаемые файлы как новые. Так
 * коммиты и несохранённые правки читаются одним дифом, как обычный diff задачи.
 */
export async function rangeDiff(cwd: string, base: string, to: string) {
  const sides = to ? [base, to] : [base];
  const [branch, stat, numstat, nameStatus, porcelain] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
    git(cwd, ['diff', '--find-renames', '--stat', ...sides]),
    git(cwd, ['diff', '--find-renames', '--numstat', ...sides]),
    git(cwd, ['diff', '--find-renames', '--name-status', ...sides]),
    to ? '' : git(cwd, ['status', '--porcelain', '--untracked-files=all']).catch(() => ''),
  ]);
  const parsed = parseNameStatus(nameStatus);
  const counts = parseNumstat(numstat);

  for (const untracked of parseUntracked(porcelain)) {
    parsed.statuses[untracked] = 'A';

    if (!counts[untracked]) {
      counts[untracked] = {
        add: 0,
        del: 0,
        binary: false,
        untracked: true,
      };
    }
  }

  const files = await collectFiles({
    statuses: parsed.statuses,
    oldPathOf: parsed.oldPathOf,
    counts,
    group: 'commits',
    withContent: false,
    readOld: () => '',
    readNew: (relPath) => (to ? '' : readWork(cwd, relPath)),
  }) as CodeGitEntry[];

  return {
    branch: branch.trim(),
    stat: stat.trim(),
    files,
  };
}

/**
 * Разрешает выбранные короткие хеши, проверяет прямой порядок и возвращает общий
 * диф от родителя старшего выбранного коммита до младшего.
 */
export async function commitRangeDiff(
  cwd: string,
  from: string,
  to: string,
  { work = false }: RangeOptions = {},
): Promise<CodeCommitsDiffResponse> {
  const [fullFrom, fullTo] = await Promise.all([
    resolveCommit(cwd, from),
    resolveCommit(cwd, to),
  ]);

  if (work) {
    await requireHead(cwd, fullTo);
  }

  try {
    await git(cwd, ['merge-base', '--is-ancestor', fullFrom, fullTo]);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? Number(error.code)
      : 0;

    if (code === 1) {
      throw new CodeGitError('bad_range', 'Первый коммит не является предком второго.', 400);
    }

    throw error;
  }

  const parents = (await git(cwd, ['rev-list', '--parents', '-n', '1', fullFrom]))
    .trim()
    .split(/\s+/u);
  const parent = parents[1] || '';
  const base = parent || (await git(cwd, ['hash-object', '-t', 'tree', '/dev/null'])).trim();
  const countText = parent
    ? await git(cwd, ['rev-list', '--count', `${base}..${fullTo}`])
    : await git(cwd, ['rev-list', '--count', fullTo]);
  const diff = await rangeDiff(cwd, base, work ? '' : fullTo);

  return {
    ...diff,
    range: {
      from: fullFrom,
      to: fullTo,
      base,
      commits: Number(countText.trim()) || 0,
      work,
    },
  };
}

/**
 * Режим «с текущими изменениями» имеет смысл только для отрезка до HEAD: рабочее дерево
 * лежит поверх последнего коммита, и для более старого конца в диф въехали бы чужие коммиты.
 */
async function requireHead(cwd: string, fullTo: string): Promise<void> {
  const head = (await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).trim();

  if (head !== fullTo) {
    throw new CodeGitError(
      'work_needs_head',
      'Текущие изменения можно добавить только к отрезку до последнего коммита.',
      400,
    );
  }
}

/** Разрешает ref в полный commit id, сохраняя отдельный понятный отказ для базы ветки. */
async function resolveBranchRef(cwd: string, ref: string): Promise<string> {
  try {
    return (await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim();
  } catch {
    throw new CodeGitError('no_base', 'Не удалось определить базу ветки.', 409);
  }
}

/**
 * Находит левую сторону режима «Вся ветка». Основное дерево сравнивается со своим
 * upstream, а worktree задачи — с общей точкой его HEAD и ветки основного дерева.
 */
export async function branchBase(
  cwd: string,
  { main, mainBranch }: BranchDiffOptions,
): Promise<string> {
  if (main) {
    const tracking = await gitTrackingStatus(cwd);

    if (!tracking.upstream) {
      throw new CodeGitError(
        'no_base',
        'У основной ветки нет upstream — сравнивать всю ветку пока не с чем.',
        409,
      );
    }

    return resolveBranchRef(cwd, '@{upstream}');
  }

  if (!mainBranch || mainBranch === '(detached)') {
    throw new CodeGitError('no_base', 'У основного дерева не определена ветка.', 409);
  }

  const [mainHead, head] = await Promise.all([
    resolveBranchRef(cwd, `refs/heads/${mainBranch}`),
    resolveBranchRef(cwd, 'HEAD'),
  ]);

  try {
    const base = (await git(cwd, ['merge-base', mainHead, head])).trim();

    if (!base) {
      throw new Error('empty merge-base');
    }

    return base;
  } catch {
    throw new CodeGitError('no_base', 'У веток нет общей базы.', 409);
  }
}

/** Возвращает единый diff всех собственных коммитов текущей ветки. */
export async function branchDiff(
  cwd: string,
  options: BranchDiffOptions,
  { work = false }: RangeOptions = {},
): Promise<CodeCommitsDiffResponse> {
  const [base, to] = await Promise.all([
    branchBase(cwd, options),
    resolveBranchRef(cwd, 'HEAD'),
  ]);
  const commitsText = (await git(cwd, ['rev-list', '--reverse', `${base}..${to}`])).trim();
  const commits = commitsText ? commitsText.split('\n') : [];
  const diff = await rangeDiff(cwd, base, work ? '' : to);

  return {
    ...diff,
    range: {
      from: commits[0] || '',
      to,
      base,
      commits: commits.length,
      work,
    },
  };
}

/**
 * Читает стороны только выбранного файла. Путь сначала сверяется со свежим списком,
 * поэтому клиент не превращает endpoint в произвольный `git show`.
 */
export async function fileDiffSides(
  cwd: string,
  { group, path: relPath, base = '', to = '', work = false }: FileDiffOptions,
): Promise<CodeFileDiffResponse> {
  let entry: CodeGitEntry | undefined;
  let oldContent = '';
  let newContent = '';

  if (group === 'commits') {
    const checkedBase = await verifyDiffBase(cwd, base);
    // В режиме «с текущими изменениями» правая сторона — файл на диске, коммит не нужен.
    const checkedTo = work ? '' : await resolveCommit(cwd, to);
    const diff = await rangeDiff(cwd, checkedBase, checkedTo);

    entry = diff.files.find((file) => file.path === relPath);

    if (entry) {
      const oldPath = entry.status === 'R' ? (entry.oldPath || entry.path) : entry.path;

      [oldContent, newContent] = await Promise.all([
        entry.status === 'A' ? '' : showAt(cwd, checkedBase, oldPath),
        entry.status === 'D'
          ? ''
          : (work ? readWork(cwd, entry.path) : showAt(cwd, checkedTo, entry.path)),
      ]);
    }
  } else {
    const changes = await worktreeChanges(cwd, { withContent: false });
    const files = group === 'staged' ? changes.staged : changes.files;

    entry = files.find((file) => file.path === relPath);

    if (entry) {
      const oldPath = entry.status === 'R' ? (entry.oldPath || entry.path) : entry.path;

      if (group === 'staged') {
        [oldContent, newContent] = await Promise.all([
          entry.status === 'A' ? '' : showHead(cwd, oldPath),
          entry.status === 'D' ? '' : showIndex(cwd, entry.path),
        ]);
      } else {
        [oldContent, newContent] = await Promise.all([
          entry.status === 'A'
            ? ''
            : entry.status === 'U' ? showIndexStage(cwd, 2, oldPath) : showIndex(cwd, oldPath),
          entry.status === 'D' ? '' : readWork(cwd, entry.path),
        ]);
      }
    }
  }

  if (!entry) {
    throw new CodeGitError('no_file', 'Изменение файла не найдено. Обнови список.', 404);
  }

  return fileDiffResponse(entry, oldContent, newContent);
}

const ACTION_PATHS_MAX = 500;
// Потолок ручного сообщения коммита; предложение модели меряется им же.
export const COMMIT_MESSAGE_MAX = 5_000;
const COMMIT_PATCH_MAX_BYTES = 120_000;
const REVIEW_PATCH_MAX_BYTES = 2 * 1024 * 1024;
const REVIEW_PATCH_MAX_FILES = 300;

/**
 * Проверяет выбор файла по свежей группе Git и добавляет старый путь переименования.
 * Клиент не может превратить кнопку строки в произвольный pathspec: принимаются только
 * пути, которые прямо сейчас присутствуют в соответствующей группе.
 */
function actionPaths(files: CodeGitEntry[], requested: unknown): GitActionSelection {
  if (!Array.isArray(requested) || !requested.length || requested.length > ACTION_PATHS_MAX) {
    throw new CodeGitError('bad_paths', 'Нужен непустой список изменённых файлов.', 400);
  }

  const byPath = new Map(files.map((file) => [file.path, file]));
  const selected: string[] = [];

  for (const value of requested) {
    if (typeof value !== 'string' || !value || value.includes('\0')) {
      throw new CodeGitError('bad_paths', 'Путь изменённого файла некорректен.', 400);
    }

    const file = byPath.get(value);

    if (!file) {
      throw new CodeGitError(
        'stale_changes',
        `${value}: изменение уже исчезло или перешло в другую группу. Обнови список.`,
      );
    }

    if (file.oldPath) {
      selected.push(file.oldPath);
    }

    selected.push(file.path);
  }

  return {
    paths: [...new Set(selected)],
    changed: requested.length,
  };
}

/**
 * Индексирует все изменения группы либо точные строки из последнего снимка.
 * `git add -A` нужен и для удалений; `--` отделяет pathspec от аргументов команды.
 * Literal-режим не позволяет имени вроде `:(glob)*.txt` выбрать соседние файлы.
 */
export async function stageWorktreeChanges(
  cwd: string,
  { all = false, paths = [] }: GitActionOptions = {},
): Promise<CodeStageResponse> {
  const changes = await worktreeChanges(cwd, { withContent: false });

  if (!changes.files.length) {
    throw new CodeGitError('no_worktree_changes', 'В рабочем дереве нечего индексировать.');
  }

  const selected = all
    ? {
      paths: ['.'],
      changed: changes.files.length,
    }
    : actionPaths(changes.files, paths);

  await git(cwd, ['--literal-pathspecs', 'add', '-A', '--', ...selected.paths]);

  return {
    ok: true,
    changed: selected.changed,
  };
}

/**
 * Проверяет наличие HEAD перед выбором команды снятия с индекса.
 * До первого коммита restore неприменим: вызывающий использует rm --cached.
 */
async function hasHead(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--verify', 'HEAD']);

    return true;
  } catch {
    return false;
  }
}

/**
 * Убирает изменения из индекса, не затрагивая рабочие файлы. В репозитории без
 * первого коммита восстанавливать индекс неоткуда, поэтому записи удаляются из него.
 * Пути, включая старую сторону переименования, передаются буквально.
 */
export async function unstageWorktreeChanges(
  cwd: string,
  { all = false, paths = [] }: GitActionOptions = {},
): Promise<CodeStageResponse> {
  const changes = await worktreeChanges(cwd, { withContent: false });

  if (!changes.staged.length) {
    throw new CodeGitError('no_staged_changes', 'В индексе нечего возвращать.');
  }

  const selected = all
    ? {
      paths: ['.'],
      changed: changes.staged.length,
    }
    : actionPaths(changes.staged, paths);

  if (await hasHead(cwd)) {
    await git(cwd, ['--literal-pathspecs', 'restore', '--staged', '--', ...selected.paths]);
  } else {
    await git(cwd, [
      '--literal-pathspecs',
      'rm',
      '--cached',
      '-r',
      '-f',
      '--ignore-unmatch',
      '--',
      ...selected.paths,
    ]);
  }

  return {
    ok: true,
    changed: selected.changed,
  };
}

/**
 * Возвращает tracked-файлы рабочего дерева к содержимому индекса. Новые untracked
 * файлы намеренно исключены: их удаление — отдельное действие с отдельным текстом.
 */
export async function discardWorktreeChanges(
  cwd: string,
  { all = false, paths = [] }: GitActionOptions = {},
): Promise<CodeStageResponse> {
  const changes = await worktreeChanges(cwd, { withContent: false });
  const tracked = changes.files.filter((file) => file.status !== 'A' && file.status !== 'U');

  if (!tracked.length) {
    throw new CodeGitError('no_worktree_changes', 'Нет tracked-правок для отката.');
  }

  const selected = all
    ? {
      paths: tracked.flatMap((file) => file.oldPath ? [file.oldPath, file.path] : [file.path]),
      changed: tracked.length,
    }
    : actionPaths(tracked, paths);

  await git(cwd, [
    '--literal-pathspecs',
    'restore',
    '--worktree',
    '--',
    ...new Set(selected.paths),
  ]);

  return {
    ok: true,
    changed: selected.changed,
  };
}

/**
 * Удаляет только пути, которые свежий Git-снимок подтверждает как untracked.
 * Смешанный запрос отвергается целиком до `git clean`, чтобы tracked-файл не мог
 * превратить удаление соседнего нового файла в частично выполненную операцию.
 */
export async function cleanUntracked(
  cwd: string,
  { paths = [] }: Pick<GitActionOptions, 'paths'> = {},
): Promise<CodeStageResponse> {
  const changes = await worktreeChanges(cwd, { withContent: false });
  const untracked = changes.files.filter((file) => file.status === 'A');
  let selected: GitActionSelection;

  try {
    selected = actionPaths(untracked, paths);
  } catch (error) {
    if (error instanceof CodeGitError && error.code === 'stale_changes') {
      throw new CodeGitError(
        'bad_paths',
        'Удалять можно только выбранные неотслеживаемые файлы.',
        400,
      );
    }

    throw error;
  }

  await git(cwd, ['--literal-pathspecs', 'clean', '-f', '--', ...selected.paths]);

  return {
    ok: true,
    changed: selected.changed,
  };
}

/**
 * Нормализует пользовательское сообщение, сохраняя возможное тело коммита.
 * NUL и прочие управляющие символы отвергаются до передачи аргументом процессу Git.
 */
function commitMessage(value: unknown): string {
  const message = typeof value === 'string'
    ? value.replace(/\r\n?/gu, '\n').trim()
    : '';

  if (!message) {
    throw new CodeGitError('empty_commit_message', 'Введи сообщение коммита.', 400);
  }
  if (message.length > COMMIT_MESSAGE_MAX) {
    throw new CodeGitError(
      'commit_message_too_long',
      `Сообщение коммита длиннее ${COMMIT_MESSAGE_MAX} символов.`,
      400,
    );
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(message)) {
    throw new CodeGitError(
      'bad_commit_message',
      'Сообщение коммита содержит недопустимые управляющие символы.',
      400,
    );
  }

  return message;
}

/**
 * Создаёт один коммит строго из текущего индекса. Рабочее дерево не индексируется
 * автоматически: кнопки `+/-` остаются единственным владельцем состава коммита.
 */
export async function commitStagedChanges(
  cwd: string,
  value: unknown,
  { amend = false }: CommitStagedOptions = {},
): Promise<CodeCommitResponse> {
  if (amend) {
    const hasHead = Boolean((await git(cwd, ['rev-parse', '--verify', 'HEAD'])
      .catch(() => '')).trim());

    if (!hasHead) {
      throw new CodeGitError('no_head', 'В репозитории ещё нет коммита для дополнения.');
    }

    const tracking = await gitTrackingStatus(cwd);

    if (tracking.detached) {
      throw new CodeGitError('amend_detached', 'Нельзя дополнять коммит в detached HEAD.');
    }
    if (tracking.upstream && tracking.ahead === 0) {
      throw new CodeGitError(
        'amend_published',
        'Коммит уже отправлен — push без force невозможен.',
      );
    }
  } else {
    const changes = await worktreeChanges(cwd, { withContent: false });

    if (!changes.staged.length) {
      throw new CodeGitError('no_staged_changes', 'Сначала добавь изменения в индекс.');
    }
  }

  const message = commitMessage(value);

  await git(cwd, ['commit', ...(amend ? ['--amend'] : []), '-m', message], {
    timeout: 120_000,
    env: { GIT_TERMINAL_PROMPT: '0' },
  });

  const [hash, subject] = await Promise.all([
    git(cwd, ['rev-parse', '--short', 'HEAD']),
    git(cwd, ['log', '-1', '--pretty=%s']),
  ]);

  return {
    ok: true,
    hash: hash.trim(),
    subject: subject.trim(),
  };
}

/**
 * Сдвигает только HEAD к родителю. Индекс и рабочее дерево остаются нетронутыми,
 * поэтому содержимое отменённого коммита сразу становится staged-изменениями.
 */
export async function undoLastCommit(cwd: string): Promise<CodeUndoCommitResponse> {
  const head = (await git(cwd, ['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim();

  if (!head) {
    throw new CodeGitError('no_head', 'В репозитории ещё нет коммита для отмены.');
  }

  const parent = (await git(cwd, ['rev-parse', '--verify', 'HEAD^'])
    .catch(() => '')).trim();

  if (!parent) {
    throw new CodeGitError('no_parent', 'Первый коммит нельзя отменить этим действием.');
  }

  const tracking = await gitTrackingStatus(cwd);

  if (tracking.detached) {
    throw new CodeGitError('undo_detached', 'Нельзя отменять коммит в detached HEAD.');
  }
  if (tracking.upstream && tracking.ahead === 0) {
    throw new CodeGitError(
      'commit_published',
      'Коммит уже отправлен — push без force невозможен.',
    );
  }

  const message = (await git(cwd, ['log', '-1', '--pretty=%B'])).trim();

  await git(cwd, ['reset', '--soft', parent]);

  return {
    ok: true,
    message,
  };
}

/**
 * Состояние upstream для кнопки push. Счётчики основаны на локальной remote-ref:
 * это навигационная подсказка, а не неявный fetch с сетевым побочным эффектом.
 */
export async function gitTrackingStatus(cwd: string): Promise<CodeGitTracking> {
  const branch = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    .catch(() => '')).trim();
  const upstream = branch
    ? (await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
      .catch(() => '')).trim()
    : '';
  let ahead = 0;
  let behind = 0;

  if (upstream) {
    const counts = (await git(cwd, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])
      .catch(() => '')).trim().split(/\s+/u);

    behind = Number(counts[0]) || 0;
    ahead = Number(counts[1]) || 0;
  }

  return {
    detached: !branch,
    upstream,
    ahead,
    behind,
    remote: branch ? await fetchRemoteName(cwd, branch) : '',
  };
}

/** Возвращает первое непустое значение git-config без интерпретации shell. */
async function gitConfig(cwd: string, key: string): Promise<string> {
  return (await git(cwd, ['config', '--get', key]).catch(() => '')).trim();
}

/** Выбирает remote текущей upstream-связи, а без неё — только привычный origin. */
async function fetchRemoteName(cwd: string, branch: string): Promise<string> {
  const remotes = (await git(cwd, ['remote']).catch(() => ''))
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  const configured = await gitConfig(cwd, `branch.${branch}.remote`);

  if (configured && configured !== '.' && remotes.includes(configured)) {
    return configured;
  }

  return remotes.includes('origin') ? 'origin' : '';
}

/**
 * Обновляет remote refs без merge/rebase и возвращает заново посчитанное расхождение.
 * Ошибка сети не включает stderr с URL: credentials не должны попасть в HTTP-ответ.
 */
export async function fetchRemote(cwd: string): Promise<CodeFetchResponse> {
  const tracking = await gitTrackingStatus(cwd);
  const remote = tracking.remote || '';

  if (!remote) {
    throw new CodeGitError(
      'no_remote',
      'Для ветки не настроен upstream или remote origin.',
    );
  }

  try {
    await git(cwd, ['fetch', '--prune', remote], {
      timeout: 60_000,
      env: { GIT_TERMINAL_PROMPT: '0' },
    });
  } catch {
    throw new CodeGitError(
      'fetch_failed',
      'Нужен доступ к remote: ключ или credential helper на машине GrigDesk.',
    );
  }

  return {
    ok: true,
    remote,
    tracking: await gitTrackingStatus(cwd),
  };
}

/**
 * Выбирает remote для первой публикации ветки тем же порядком, что ожидает человек:
 * branch pushRemote → remote.pushDefault → branch remote → origin → единственный remote.
 */
async function publishRemote(cwd: string, branch: string): Promise<string> {
  const remotes = (await git(cwd, ['remote']).catch(() => ''))
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  const candidates = [
    await gitConfig(cwd, `branch.${branch}.pushRemote`),
    await gitConfig(cwd, 'remote.pushDefault'),
    await gitConfig(cwd, `branch.${branch}.remote`),
    remotes.includes('origin') ? 'origin' : '',
    remotes.length === 1 ? remotes[0] ?? '' : '',
  ];

  return candidates.find((candidate) => candidate && candidate !== '.'
    && remotes.includes(candidate)) || '';
}

/**
 * Пушит текущую ветку. Если upstream ещё нет, публикует HEAD в выбранный remote
 * и закрепляет связь, чтобы следующие нажатия работали обычным `git push`.
 */
export async function pushCurrentBranch(cwd: string): Promise<CodePushResponse> {
  const branch = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    .catch(() => '')).trim();

  if (!branch) {
    throw new CodeGitError('detached_head', 'Detached HEAD нельзя пушить этой кнопкой.');
  }

  const tracking = await gitTrackingStatus(cwd);
  let published = false;
  let remote = '';

  if (tracking.upstream) {
    await git(cwd, ['push'], {
      timeout: 120_000,
      env: { GIT_TERMINAL_PROMPT: '0' },
    });
  } else {
    remote = await publishRemote(cwd, branch);

    if (!remote) {
      throw new CodeGitError(
        'no_push_remote',
        'Для ветки не настроен remote. Добавь его в терминале и повтори push.',
      );
    }

    await git(cwd, ['push', '--set-upstream', remote, 'HEAD'], {
      timeout: 120_000,
      env: { GIT_TERMINAL_PROMPT: '0' },
    });
    published = true;
  }

  return {
    ok: true,
    branch,
    remote,
    published,
    tracking: await gitTrackingStatus(cwd),
  };
}

/**
 * Читает ограниченный объём stdout дочернего Git. После достижения потолка процесс
 * останавливается: гигантский diff не должен целиком проходить через память сервера.
 */
async function limitedGit(
  cwd: string,
  args: string[],
  {
    limit = COMMIT_PATCH_MAX_BYTES,
    timeoutMs = 30_000,
    allowedExitCodes = [],
    timeoutMessage = 'Git слишком долго собирал diff.',
    failureMessage = 'Не удалось прочитать diff.',
  }: LimitedGitOptions = {},
): Promise<LimitedGitOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'git',
      ['-C', cwd, '-c', 'core.quotePath=false', ...args],
      {
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let errorSize = 0;
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      const remaining = Math.max(0, limit - size);

      if (remaining > 0) {
        chunks.push(chunk.subarray(0, remaining));
        size += Math.min(chunk.length, remaining);
      }
      if (chunk.length > remaining && !truncated) {
        truncated = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const remaining = Math.max(0, 32_000 - errorSize);

      if (remaining > 0) {
        errors.push(chunk.subarray(0, remaining));
        errorSize += Math.min(chunk.length, remaining);
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);

      const output = Buffer.concat(chunks).toString('utf8');

      if (timedOut) {
        reject(new CodeGitError('git_diff_timeout', timeoutMessage));

        return;
      }
      if (code !== 0 && !truncated && !allowedExitCodes.includes(Number(code))) {
        const detail = Buffer.concat(errors).toString('utf8').trim();

        reject(new CodeGitError('git_diff_failed', detail || failureMessage));

        return;
      }

      resolve({
        output,
        truncated,
      });
    });
  });
}

const SEARCH_OUTPUT_MAX_BYTES = 512 * 1024;
const SEARCH_MATCH_MAX = 500;
const SEARCH_FILE_MAX = 50;

/**
 * Ищет буквальную строку в tracked и untracked-файлах без shell и регулярных выражений.
 * Файлы фильтруются отдельно по имени, а внешний guard исключает служебные каталоги.
 */
export async function searchTree(
  cwd: string,
  query: string,
  {
    limit = SEARCH_OUTPUT_MAX_BYTES,
    isHidden = () => false,
  }: SearchTreeOptions = {},
): Promise<CodeSearchResponse> {
  if (typeof query !== 'string' || query.length < 2 || query.length > 200 || query.includes('\0')) {
    throw new CodeGitError('bad_query', 'Поисковый запрос должен содержать от 2 до 200 символов.', 400);
  }

  const [listed, grepResult] = await Promise.all([
    git(cwd, [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
    ]),
    limitedGit(cwd, [
      'grep',
      '-n',
      '-I',
      '--untracked',
      '--no-color',
      '-F',
      '-e',
      query,
      '--',
      '.',
    ], {
      limit: Math.max(1, Math.floor(limit)),
      timeoutMs: 10_000,
      allowedExitCodes: [1],
      timeoutMessage: 'Поиск по коду занял больше 10 секунд.',
      failureMessage: 'Не удалось выполнить поиск по коду.',
    }),
  ]);
  const normalizedQuery = query.toLocaleLowerCase();
  const matchingFiles = listed.split('\0')
    .filter(Boolean)
    .filter((relPath) => !isHidden(relPath))
    .filter((relPath) => relPath.toLocaleLowerCase().includes(normalizedQuery));
  const completeOutput = grepResult.truncated
    ? grepResult.output.slice(0, Math.max(0, grepResult.output.lastIndexOf('\n') + 1))
    : grepResult.output;
  const parsedMatches: CodeSearchResponse['matches'] = [];

  for (const line of completeOutput.split('\n')) {
    const match = /^(.+?):(\d+):(.*)$/u.exec(line);

    if (!match) {
      continue;
    }

    const relPath = match[1] || '';

    if (!relPath || isHidden(relPath)) {
      continue;
    }

    parsedMatches.push({
      path: relPath,
      line: Number(match[2]),
      text: match[3] || '',
    });
  }

  return {
    files: matchingFiles.slice(0, SEARCH_FILE_MAX).map((relPath) => ({ path: relPath })),
    matches: parsedMatches.slice(0, SEARCH_MATCH_MAX),
    truncated: grepResult.truncated
      || matchingFiles.length > SEARCH_FILE_MAX
      || parsedMatches.length > SEARCH_MATCH_MAX,
  };
}

/** Возвращает проверенный файл или ограниченный список файлов выбранной группы. */
function reviewFiles(files: CodeGitEntry[], relPath?: string) {
  if (relPath !== undefined) {
    const selected = files.find((file) => file.path === relPath);

    if (!selected) {
      throw new CodeGitError('no_file', 'Изменение файла не найдено. Обнови список.', 404);
    }

    return { files: [selected], truncated: false };
  }

  return {
    files: files.slice(0, REVIEW_PATCH_MAX_FILES),
    truncated: files.length > REVIEW_PATCH_MAX_FILES,
  };
}

/**
 * Единый patch для обзора. Список путей сначала берётся из свежей Git-группы, поэтому
 * query не превращает endpoint в произвольное чтение файла или pathspec-инъекцию.
 */
export async function patchText(
  cwd: string,
  options: PatchTextOptions,
  limit = REVIEW_PATCH_MAX_BYTES,
): Promise<CodePatchResponse> {
  let base = '';
  let to = '';
  let sourceFiles: CodeGitEntry[];

  // Правая сторона на диске: у группы рабочего дерева всегда, у отрезка — по флагу work.
  const diskSide = options.group === 'work' || (options.group === 'commits' && !!options.work);

  if (options.group === 'commits') {
    base = await verifyDiffBase(cwd, options.base || '');
    to = options.work ? '' : await resolveCommit(cwd, options.to || '');
    sourceFiles = (await rangeDiff(cwd, base, to)).files;
  } else {
    const changes = await worktreeChanges(cwd, { withContent: false });

    sourceFiles = options.group === 'staged' ? changes.staged : changes.files;
  }

  const selected = reviewFiles(sourceFiles, options.path);
  // Неотслеживаемый файл в `git diff` не попадает: его патч собирается через --no-index.
  // У отрезка с диском статус A имеют и файлы, добавленные коммитами, поэтому отделяем
  // именно неотслеживаемые — те, которых нет в индексе.
  const untrackedSet = diskSide
    ? new Set(parseUntracked(
      await git(cwd, ['status', '--porcelain', '--untracked-files=all']).catch(() => ''),
    ))
    : new Set<string>();
  const tracked = selected.files.filter((file) => !untrackedSet.has(file.path));
  const untracked = selected.files.filter((file) => untrackedSet.has(file.path));
  const paths = tracked.flatMap((file) => file.oldPath ? [file.oldPath, file.path] : [file.path]);
  const maxBytes = Math.max(1, Math.floor(limit));
  let output = '';
  let truncated = selected.truncated;

  const append = async (args: string[], allowedExitCodes: number[] = []) => {
    const remaining = maxBytes - Buffer.byteLength(output, 'utf8');

    if (remaining <= 0) {
      truncated = true;

      return false;
    }

    const result = await limitedGit(cwd, args, {
      limit: remaining,
      allowedExitCodes,
    });

    output += result.output;
    truncated ||= result.truncated;

    return !result.truncated;
  };

  if (paths.length) {
    const references = options.group === 'commits' ? [base, ...(to ? [to] : [])] : [];
    const cached = options.group === 'staged' ? ['--cached'] : [];

    await append([
      '--literal-pathspecs',
      'diff',
      '--no-color',
      '--find-renames',
      '--no-ext-diff',
      '--no-textconv',
      ...cached,
      ...references,
      '--',
      ...paths,
    ]);
  }

  for (const file of untracked) {
    if (!(await append([
      '--literal-pathspecs',
      'diff',
      '--no-index',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--',
      '/dev/null',
      file.path,
    ], [1]))) {
      break;
    }
  }

  return { patch: output, truncated };
}

/**
 * Читает до 50 изменений одного пути и следует через rename. Формат с NUL-полями
 * отделяет subject/when от имени файла; имя каждой записи берётся из `--name-only`.
 */
export async function fileLog(cwd: string, relPath: string): Promise<CodeFileLogResponse> {
  if (!relPath || relPath.includes('\0') || path.isAbsolute(relPath)) {
    throw new CodeGitError('bad_path', 'Некорректный путь файла.', 400);
  }

  const output = await git(cwd, [
    '--literal-pathspecs',
    'log',
    '-50',
    '--follow',
    '--format=%x1e%H%x00%P%x00%s%x00%cr%x00',
    '--name-only',
    '--',
    relPath,
  ]);
  const emptyTree = (await git(cwd, ['hash-object', '-t', 'tree', '/dev/null'])).trim();
  const entries: CodeFileLogResponse['entries'] = [];

  for (const rawRecord of output.split('\x1e')) {
    const fields = rawRecord.split('\0');
    const hash = (fields[0] || '').trim();

    if (!hash) {
      continue;
    }

    const parent = (fields[1] || '').trim().split(/\s+/u)[0] || '';
    const names = fields.slice(4).join('\0').split('\n').filter(Boolean);
    const entryPath = names.length ? unquotePath(names[names.length - 1] || '') : '';

    if (!entryPath) {
      continue;
    }

    entries.push({
      hash,
      base: parent || emptyTree,
      subject: fields[2] || '',
      when: fields[3] || '',
      path: entryPath,
    });
  }

  return { entries };
}

interface BlameCommitMeta {
  base: string;
  when: string;
}

/**
 * Возвращает blame рабочей копии. Метаданные родителей читаются отдельным `log`:
 * porcelain blame знает автора и subject, но не даёт базу для исторического diff.
 */
export async function blameFile(cwd: string, relPath: string): Promise<CodeBlameResponse> {
  if (!relPath || relPath.includes('\0') || path.isAbsolute(relPath)) {
    throw new CodeGitError('bad_path', 'Некорректный путь файла.', 400);
  }

  let output = '';

  try {
    output = await git(cwd, [
      '--literal-pathspecs',
      'blame',
      '--line-porcelain',
      '--',
      relPath,
    ]);
  } catch {
    throw new CodeGitError('no_file', 'Файл не найден.', 404);
  }

  const lines: CodeBlameResponse['lines'] = [];
  const sourceLines = output.split('\n');

  for (let index = 0; index < sourceLines.length;) {
    const header = /^([0-9a-f]{40,64})\s+\d+\s+(\d+)(?:\s+\d+)?$/u.exec(sourceLines[index] || '');

    if (!header) {
      index += 1;
      continue;
    }

    const rawHash = header[1] || '';
    let author = '';
    let subject = '';

    index += 1;
    while (index < sourceLines.length && !(sourceLines[index] || '').startsWith('\t')) {
      const metadata = sourceLines[index] || '';

      if (metadata.startsWith('author ')) {
        author = metadata.slice('author '.length);
      } else if (metadata.startsWith('summary ')) {
        subject = metadata.slice('summary '.length);
      }
      index += 1;
    }

    const uncommitted = /^0+$/u.test(rawHash);

    lines.push({
      line: Number(header[2]),
      hash: uncommitted ? '' : rawHash,
      base: '',
      author,
      when: '',
      subject,
    });
    index += 1;

    if (lines.length > 20_000) {
      throw new CodeGitError('too_big', 'Blame доступен для файлов до 20 000 строк.', 413);
    }
  }

  const hashes = [...new Set(lines.map((line) => line.hash).filter(Boolean))];
  const emptyTree = hashes.length
    ? (await git(cwd, ['hash-object', '-t', 'tree', '/dev/null'])).trim()
    : '';
  const metadata = new Map<string, BlameCommitMeta>();

  for (let offset = 0; offset < hashes.length; offset += 200) {
    const chunk = hashes.slice(offset, offset + 200);
    const records = await git(cwd, [
      'log',
      '--no-walk',
      '--format=%x1e%H%x00%P%x00%cr',
      ...chunk,
    ]);

    for (const record of records.split('\x1e')) {
      const [hash = '', parents = '', relative = ''] = record.trim().split('\0');

      if (hash) {
        metadata.set(hash, {
          base: parents.trim().split(/\s+/u)[0] || emptyTree,
          when: relative.trim(),
        });
      }
    }
  }

  for (const line of lines) {
    const commit = metadata.get(line.hash);

    if (commit) {
      line.base = commit.base;
      line.when = commit.when;
    }
  }

  return { lines };
}

/**
 * Снимок staged diff для генератора названия: список, статистика, ограниченный patch
 * и несколько свежих тем коммитов для сохранения принятого в репозитории стиля.
 */
export async function stagedCommitContext(cwd: string): Promise<CodeStagedContext> {
  const nameStatus = (await git(cwd, ['diff', '--cached', '--name-status'])).trim();

  if (!nameStatus) {
    throw new CodeGitError('no_staged_changes', 'Сначала добавь изменения в индекс.');
  }

  const [stat, patch, recent] = await Promise.all([
    git(cwd, ['diff', '--cached', '--stat']),
    limitedGit(cwd, [
      'diff',
      '--cached',
      '--no-ext-diff',
      '--no-textconv',
      '--unified=2',
      '--',
    ]),
    git(cwd, ['log', '-8', '--pretty=%s']).catch(() => ''),
  ]);

  return {
    files: nameStatus,
    stat: stat.trim(),
    patch: patch.output,
    truncated: patch.truncated,
    recentSubjects: recent.trim(),
  };
}
