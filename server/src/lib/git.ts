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
  CodeCommitResponse,
  CodeGitDiff,
  CodeGitFile,
  CodeGitTracking,
  CodePushResponse,
  CodeStageResponse,
  CodeStagedContext,
  CodeWorktreeChanges,
} from '../../../shared/codeContracts.ts';

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
  group?: 'staged' | 'work';
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

interface LimitedGitOutput {
  output: string;
  truncated: boolean;
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

/**
 * Читает сторону файла из HEAD. У нового файла либо до первого коммита этой
 * стороны нет, поэтому ошибку чтения представляет пустым содержимым.
 */
async function showHead(cwd: string, relPath: string): Promise<string> {
  try {
    return await git(cwd, ['show', `HEAD:${relPath}`]);
  } catch {
    return '';
  }
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
 * Собирает список файлов группы: статус, счётчики и содержимое сторон.
 * Стороны читает вызывающий (`readOld`/`readNew`) — они и отличают группы друг от друга.
 */
async function collectFiles({
  statuses,
  oldPathOf,
  counts,
  group,
  readOld,
  readNew,
}: FileCollection): Promise<CodeGitFile[]> {
  const files: CodeGitFile[] = [];

  for (const [p, st] of Object.entries(statuses)) {
    const c = counts[p] || {
      add: 0,
      del: 0,
      binary: false,
    };
    const file: CodeGitFile = {
      path: p,
      status: st,
      add: c.add,
      del: c.del,
      binary: c.binary,
      tooBig: false,
      oldContent: '',
      newContent: '',
      ...(group ? { group } : {}),
      ...(st === 'R' && oldPathOf[p] ? { oldPath: oldPathOf[p] } : {}),
    };

    if (c.binary) {
      files.push(file);
      continue;
    }

    const oldContent = await readOld(p, st);
    const newContent = await readNew(p, st);

    // Неотслеживаемого файла нет ни в одном diff, поэтому бинарность и число строк
    // определяются по содержимому: иначе новый файл показывался как «+0».
    if (c.untracked) {
      if (looksBinary(newContent)) {
        file.binary = true;
        files.push(file);
        continue;
      }

      file.add = countLines(newContent);
    }

    if (oldContent.length > MAX_BYTES || newContent.length > MAX_BYTES) {
      file.tooBig = true;
    } else {
      file.oldContent = oldContent;
      file.newContent = newContent;
    }

    files.push(file);
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
    // ДО: из HEAD (для новых — пусто); при переименовании — по старому пути.
    readOld: (p, st) => (st === 'A' ? '' : showHead(cwd, st === 'R' ? (oldPathOf[p] || p) : p)),
    // ПОСЛЕ: из воркдира (для удалённых — пусто).
    readNew: (p, st) => (st === 'D' ? '' : readWork(cwd, p)),
  });

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
export async function worktreeChanges(cwd: string): Promise<CodeWorktreeChanges> {
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

  const stagedStatus = parseNameStatus(stagedNameStatus);
  const staged = await collectFiles({
    statuses: stagedStatus.statuses,
    oldPathOf: stagedStatus.oldPathOf,
    counts: parseNumstat(stagedNumstat),
    group: 'staged',
    // ДО — HEAD (при переименовании по старому пути), ПОСЛЕ — индекс.
    readOld: (p, st) => (st === 'A' ? '' : showHead(cwd, st === 'R' ? (stagedStatus.oldPathOf[p] || p) : p)),
    readNew: (p, st) => (st === 'D' ? '' : showIndex(cwd, p)),
  });

  const workStatus = parseNameStatus(workNameStatus);
  const untracked = new Set(parseUntracked(porcelain));

  for (const u of untracked) {
    workStatus.statuses[u] = 'A';
  }

  const workCounts = parseNumstat(workNumstat);

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
    // ДО — индекс: у неотслеживаемого файла его там нет по определению.
    readOld: (p, st) => (untracked.has(p)
      ? ''
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

const ACTION_PATHS_MAX = 500;
const COMMIT_MESSAGE_MAX = 5_000;
const COMMIT_PATCH_MAX_BYTES = 120_000;

/**
 * Проверяет выбор файла по свежей группе Git и добавляет старый путь переименования.
 * Клиент не может превратить кнопку строки в произвольный pathspec: принимаются только
 * пути, которые прямо сейчас присутствуют в соответствующей группе.
 */
function actionPaths(files: CodeGitFile[], requested: unknown): GitActionSelection {
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
  const changes = await worktreeChanges(cwd);

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
  const changes = await worktreeChanges(cwd);

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
export async function commitStagedChanges(cwd: string, value: unknown): Promise<CodeCommitResponse> {
  const changes = await worktreeChanges(cwd);

  if (!changes.staged.length) {
    throw new CodeGitError('no_staged_changes', 'Сначала добавь изменения в индекс.');
  }

  const message = commitMessage(value);

  await git(cwd, ['commit', '-m', message], {
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
  };
}

/** Возвращает первое непустое значение git-config без интерпретации shell. */
async function gitConfig(cwd: string, key: string): Promise<string> {
  return (await git(cwd, ['config', '--get', key]).catch(() => '')).trim();
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
  limit = COMMIT_PATCH_MAX_BYTES,
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
    }, 30_000);

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
        reject(new CodeGitError('git_diff_timeout', 'Git слишком долго собирал staged diff.'));

        return;
      }
      if (code !== 0 && !truncated) {
        const detail = Buffer.concat(errors).toString('utf8').trim();

        reject(new CodeGitError('git_diff_failed', detail || 'Не удалось прочитать staged diff.'));

        return;
      }

      resolve({
        output,
        truncated,
      });
    });
  });
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
