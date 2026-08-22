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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);
// Предел на размер стороны файла — не тащить в браузер гигантские блобы.
const MAX_BYTES = 1_500_000;

async function git(cwd, args) {
  // core.quotePath=false обязателен: с дефолтным `true` git отдаёт не-ASCII путь
  // октальными байтами («"\321\204\320\260\320\271\320\273.txt"»), и такой файл
  // не открыть ни по имени, ни через `git show` — диф выходил пустым.
  const { stdout } = await exec(
    'git',
    ['-C', cwd, '-c', 'core.quotePath=false', ...args],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}

/**
 * Снимает C-кавычки git с пути. Даже при `core.quotePath=false` git квотирует путь
 * с пробелом, кавычкой или управляющим символом, поэтому кавычки надо снимать всегда.
 * Октальные escape поддержаны на случай чужого конфига: молча испортить имя нельзя.
 */
export function unquotePath(raw) {
  const value = String(raw ?? '');
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  const bytes = [];
  const simple = { n: 10, t: 9, r: 13, f: 12, b: 8, v: 11, a: 7, '\\': 92, '"': 34 };
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue; }
    const next = body[i + 1];
    if (next === undefined) break;
    if (next >= '0' && next <= '7') {
      const octal = body.slice(i + 1, i + 4);
      bytes.push(parseInt(octal, 8) & 0xff);
      i += octal.length;
      continue;
    }
    bytes.push(simple[next] ?? Buffer.from(next, 'utf8')[0]);
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Путь-цель из `--numstat`: при переименовании git пишет его одной строкой —
 * «old => new» либо с общим префиксом «dir/{sub => }/f.txt». Без раскрытия счётчик
 * не находил файл по его настоящему пути, и правки показывались как 0/0.
 */
function numstatPath(raw) {
  if (!raw.includes(' => ')) return unquotePath(raw);
  const brace = raw.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  const merged = brace
    ? `${brace[1]}${brace[3]}${brace[4]}`
    : raw.slice(raw.lastIndexOf(' => ') + 4);
  return unquotePath(merged.replace(/\/{2,}/g, '/'));
}

/** numstat: "add\tdel\tpath" (бинарные — "-\t-\tpath"). */
function parseNumstat(text) {
  const counts = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\S+)\t(\S+)\t(.+)$/);
    if (!m) continue;
    const bin = m[1] === '-' && m[2] === '-';
    counts[numstatPath(m[3])] = { add: bin ? 0 : Number(m[1]), del: bin ? 0 : Number(m[2]), binary: bin };
  }
  return counts;
}

/** Формат строки name-status: "M\tpath" | "A\tpath" | "D\tpath" | "R100\told\tnew". */
function parseNameStatus(text) {
  const statuses = {};
  const oldPathOf = {};
  for (const line of text.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const code = parts[0][0];
    if (code === 'R' && parts.length >= 3) {
      const to = unquotePath(parts[2]);
      statuses[to] = 'R';
      oldPathOf[to] = unquotePath(parts[1]);
    } else {
      statuses[unquotePath(parts[1])] = code;
    }
  }
  return { statuses, oldPathOf };
}

/**
 * Неотслеживаемые (новые) файлы — их нет ни в индексе, ни в HEAD, поэтому в diff
 * они не попадают вовсе. `--untracked-files=all`: иначе porcelain схлопывает новый
 * каталог в одну запись «?? dir/», которая попадает в список как «файл» с пустым дифом.
 */
function parseUntracked(porcelain) {
  return porcelain.split('\n')
    .filter((l) => l.startsWith('??'))
    .map((l) => unquotePath(l.slice(3).trim()))
    .filter(Boolean);
}

/** Содержимое файла в HEAD (пусто, если файла в HEAD нет — новый файл). */
async function showHead(cwd, relPath) {
  try { return await git(cwd, ['show', `HEAD:${relPath}`]); }
  catch { return ''; }
}

/** Содержимое файла в ИНДЕКСЕ (пусто, если файла там нет). */
async function showIndex(cwd, relPath) {
  try { return await git(cwd, ['show', `:${relPath}`]); }
  catch { return ''; }
}

/** Содержимое файла в воркдире (пусто, если удалён). */
async function readWork(cwd, relPath) {
  try { return await fs.readFile(path.join(cwd, relPath), 'utf8'); }
  catch { return ''; }
}

/**
 * Собирает список файлов группы: статус, счётчики и содержимое сторон.
 * Стороны читает вызывающий (`readOld`/`readNew`) — они и отличают группы друг от друга.
 */
async function collectFiles({ statuses, oldPathOf, counts, group, readOld, readNew }) {
  const files = [];
  for (const p of Object.keys(statuses)) {
    const st = statuses[p];
    const c = counts[p] || { add: 0, del: 0, binary: false };
    const file = {
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
    if (c.binary) { files.push(file); continue; }
    const oldContent = await readOld(p, st);
    const newContent = await readNew(p, st);
    if (oldContent.length > MAX_BYTES || newContent.length > MAX_BYTES) file.tooBig = true;
    else { file.oldContent = oldContent; file.newContent = newContent; }
    files.push(file);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/**
 * Диф воркдира ОТНОСИТЕЛЬНО HEAD: список изменённых файлов с содержимым до/после.
 * Индекс здесь намеренно не отделяется — приёмка задачи спрашивает «что сделано
 * поверх последнего коммита», а не «что уже проиндексировано».
 * @param {string} cwd путь воркдира
 * @returns {Promise<{branch:string, stat:string, files:Array}>}
 */
export async function taskDiff(cwd) {
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
  for (const u of untracked) { statuses[u] = 'A'; if (!counts[u]) counts[u] = { add: 0, del: 0, binary: false }; }

  const files = await collectFiles({
    statuses,
    oldPathOf,
    counts,
    // ДО: из HEAD (для новых — пусто); при переименовании — по старому пути.
    readOld: (p, st) => (st === 'A' ? '' : showHead(cwd, st === 'R' ? (oldPathOf[p] || p) : p)),
    // ПОСЛЕ: из воркдира (для удалённых — пусто).
    readNew: (p, st) => (st === 'D' ? '' : readWork(cwd, p)),
  });
  return { branch: branch.trim(), stat: stat.trim(), files };
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
 *
 * @param {string} cwd путь рабочего дерева
 * @returns {Promise<{branch:string, stat:string, files:Array, staged:Array}>}
 */
export async function worktreeChanges(cwd) {
  const [branch, stat, stagedNumstat, stagedNameStatus, workNumstat, workNameStatus, porcelain]
    = await Promise.all([
      git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
      git(cwd, ['diff', '--stat', 'HEAD']).catch(() => ''),
      git(cwd, ['diff', '--cached', '--numstat', 'HEAD']).catch(() => ''),
      git(cwd, ['diff', '--cached', '--name-status', 'HEAD']).catch(() => ''),
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
    if (!workCounts[u]) workCounts[u] = { add: 0, del: 0, binary: false };
  }
  const files = await collectFiles({
    statuses: workStatus.statuses,
    oldPathOf: workStatus.oldPathOf,
    counts: workCounts,
    group: 'work',
    // ДО — индекс: у неотслеживаемого файла его там нет по определению.
    readOld: (p, st) => (untracked.has(p) ? '' : showIndex(cwd, st === 'R' ? (workStatus.oldPathOf[p] || p) : p)),
    // ПОСЛЕ — рабочее дерево (для удалённых — пусто).
    readNew: (p, st) => (st === 'D' ? '' : readWork(cwd, p)),
  });

  return { branch: branch.trim(), stat: stat.trim(), files, staged };
}
