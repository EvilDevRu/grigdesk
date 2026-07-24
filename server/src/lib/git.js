// Гит-хелперы для дифа задачи (приёмка). Диф — несохранённые изменения воркдира vs HEAD
// (правки фабрики до коммита; именно их смотрят на приёмке). Ветка vs master зашумлена мёржами.
// Отдаём по файлу содержимое ДО (HEAD) и ПОСЛЕ (воркдир) — диф строит Monaco на клиенте
// (тот же виджет, что в VS Code: side-by-side, подсветка, сворачивание неизменённого).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);
// Предел на размер стороны файла — не тащить в браузер гигантские блобы.
const MAX_BYTES = 1_500_000;

async function git(cwd, args) {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * Содержимое файла в HEAD (пусто, если файла в HEAD нет — новый файл).
 */
async function showHead(cwd, relPath) {
  try { return await git(cwd, ['show', `HEAD:${relPath}`]); }
  catch { return ''; }
}

/**
 * Содержимое файла в воркдире (пусто, если удалён).
 */
async function readWork(cwd, relPath) {
  try { return await fs.readFile(path.join(cwd, relPath), 'utf8'); }
  catch { return ''; }
}

/**
 * Диф воркдира: список изменённых файлов с содержимым до/после.
 * @param {string} cwd путь воркдира
 * @returns {Promise<{branch:string, stat:string, files:Array}>}
 */
export async function taskDiff(cwd) {
  const [branch, stat, numstat, nameStatus, porcelain] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
    git(cwd, ['diff', '--stat', 'HEAD']).catch(() => ''),
    git(cwd, ['diff', '--numstat', 'HEAD']).catch(() => ''),
    git(cwd, ['diff', '--name-status', 'HEAD']).catch(() => ''),
    git(cwd, ['status', '--porcelain']).catch(() => ''),
  ]);

  // numstat: "add\tdel\tpath" (бинарные — "-\t-\tpath").
  const counts = {};
  for (const line of numstat.split('\n')) {
    const m = line.match(/^(\S+)\t(\S+)\t(.+)$/);
    if (!m) continue;
    const bin = m[1] === '-' && m[2] === '-';
    counts[m[3]] = { add: bin ? 0 : Number(m[1]), del: bin ? 0 : Number(m[2]), binary: bin };
  }
  // name-status: "M\tpath" | "A\tpath" | "D\tpath" | "R100\told\tnew".
  const statuses = {};
  const oldPathOf = {};
  for (const line of nameStatus.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const code = parts[0][0];
    if (code === 'R' && parts.length >= 3) { statuses[parts[2]] = 'R'; oldPathOf[parts[2]] = parts[1]; }
    else { statuses[parts[1]] = code; }
  }
  // Неотслеживаемые (новые) файлы — в git diff HEAD не попадают.
  const untracked = porcelain.split('\n').filter((l) => l.startsWith('??')).map((l) => l.slice(3).trim()).filter(Boolean);
  for (const u of untracked) { statuses[u] = 'A'; if (!counts[u]) counts[u] = { add: 0, del: 0, binary: false }; }

  const files = [];
  for (const p of Object.keys(statuses)) {
    const st = statuses[p];
    const c = counts[p] || { add: 0, del: 0, binary: false };
    const file = { path: p, status: st, add: c.add, del: c.del, binary: c.binary, tooBig: false, oldContent: '', newContent: '' };
    if (c.binary) { files.push(file); continue; }
    // ДО: из HEAD (для новых — пусто); при переименовании — по старому пути.
    const oldContent = st === 'A' ? '' : await showHead(cwd, st === 'R' ? (oldPathOf[p] || p) : p);
    // ПОСЛЕ: из воркдира (для удалённых — пусто).
    const newContent = st === 'D' ? '' : await readWork(cwd, p);
    if (oldContent.length > MAX_BYTES || newContent.length > MAX_BYTES) { file.tooBig = true; }
    else { file.oldContent = oldContent; file.newContent = newContent; }
    files.push(file);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { branch: branch.trim(), stat: stat.trim(), files };
}
