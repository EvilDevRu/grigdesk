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
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);
// Предел на размер стороны файла — не тащить в браузер гигантские блобы.
const MAX_BYTES = 1_500_000;

async function git(cwd, args, options = {}) {
  // core.quotePath=false обязателен: с дефолтным `true` git отдаёт не-ASCII путь
  // октальными байтами («"\321\204\320\260\320\271\320\273.txt"»), и такой файл
  // не открыть ни по имени, ни через `git show` — диф выходил пустым.
  const { stdout } = await exec(
    'git',
    ['-C', cwd, '-c', 'core.quotePath=false', ...args],
    {
      maxBuffer: 64 * 1024 * 1024,
      ...options,
      env: {
        ...process.env,
        ...(options.env || {}),
      },
    },
  );
  return stdout;
}

export class CodeGitError extends Error {
  constructor(code, message, status = 409) {
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

// Столько первых символов git просматривает в поисках NUL, решая, бинарный ли файл.
const BINARY_PROBE_CHARS = 8000;

/**
 * Число строк текста по правилу git: строкой считается каждый перевод строки, а
 * незавершённый хвост — ещё одна. Нужно только неотслеживаемым файлам: в diff они
 * не попадают, и без этого счёта новый файл показывался как «+0», а итог группы врал.
 */
function countLines(text) {
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
function looksBinary(text) {
  return text.slice(0, BINARY_PROBE_CHARS).includes('\0');
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
  for (const u of untracked) {
    statuses[u] = 'A';
    if (!counts[u]) counts[u] = { add: 0, del: 0, binary: false, untracked: true };
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
    if (!workCounts[u]) workCounts[u] = { add: 0, del: 0, binary: false, untracked: true };
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

const ACTION_PATHS_MAX = 500;
const COMMIT_MESSAGE_MAX = 5_000;
const COMMIT_PATCH_MAX_BYTES = 120_000;

/**
 * Проверяет выбор файла по свежей группе Git и добавляет старый путь переименования.
 * Клиент не может превратить кнопку строки в произвольный pathspec: принимаются только
 * пути, которые прямо сейчас присутствуют в соответствующей группе.
 */
function actionPaths(files, requested) {
  if (!Array.isArray(requested) || !requested.length || requested.length > ACTION_PATHS_MAX) {
    throw new CodeGitError('bad_paths', 'Нужен непустой список изменённых файлов.', 400);
  }

  const byPath = new Map(files.map((file) => [file.path, file]));
  const selected = [];

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

  return [...new Set(selected)];
}

/**
 * Индексирует все изменения группы либо точные строки из последнего снимка.
 * `git add -A` нужен и для удалений; `--` отделяет pathspec от аргументов команды.
 */
export async function stageWorktreeChanges(cwd, { all = false, paths = [] } = {}) {
  const changes = await worktreeChanges(cwd);
  if (!changes.files.length) {
    throw new CodeGitError('no_worktree_changes', 'В рабочем дереве нечего индексировать.');
  }

  const selected = all
    ? ['.']
    : actionPaths(changes.files, paths);

  await git(cwd, ['add', '-A', '--', ...selected]);

  return {
    ok: true,
    changed: all ? changes.files.length : paths.length,
  };
}

/** Есть ли HEAD, из которого `git restore --staged` восстановит индекс. */
async function hasHead(cwd) {
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
 */
export async function unstageWorktreeChanges(cwd, { all = false, paths = [] } = {}) {
  const changes = await worktreeChanges(cwd);
  if (!changes.staged.length) {
    throw new CodeGitError('no_staged_changes', 'В индексе нечего возвращать.');
  }

  const selected = all
    ? ['.']
    : actionPaths(changes.staged, paths);

  if (await hasHead(cwd)) {
    await git(cwd, ['restore', '--staged', '--', ...selected]);
  } else {
    await git(cwd, ['rm', '--cached', '-r', '-f', '--ignore-unmatch', '--', ...selected]);
  }

  return {
    ok: true,
    changed: all ? changes.staged.length : paths.length,
  };
}

/**
 * Нормализует пользовательское сообщение, сохраняя возможное тело коммита.
 * NUL и прочие управляющие символы отвергаются до передачи аргументом процессу Git.
 */
function commitMessage(value) {
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
export async function commitStagedChanges(cwd, value) {
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
export async function gitTrackingStatus(cwd) {
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
async function gitConfig(cwd, key) {
  return (await git(cwd, ['config', '--get', key]).catch(() => '')).trim();
}

/**
 * Выбирает remote для первой публикации ветки тем же порядком, что ожидает человек:
 * branch pushRemote → remote.pushDefault → branch remote → origin → единственный remote.
 */
async function publishRemote(cwd, branch) {
  const remotes = (await git(cwd, ['remote']).catch(() => ''))
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  const candidates = [
    await gitConfig(cwd, `branch.${branch}.pushRemote`),
    await gitConfig(cwd, 'remote.pushDefault'),
    await gitConfig(cwd, `branch.${branch}.remote`),
    remotes.includes('origin') ? 'origin' : '',
    remotes.length === 1 ? remotes[0] : '',
  ];

  return candidates.find((candidate) => candidate && candidate !== '.'
    && remotes.includes(candidate)) || '';
}

/**
 * Пушит текущую ветку. Если upstream ещё нет, публикует HEAD в выбранный remote
 * и закрепляет связь, чтобы следующие нажатия работали обычным `git push`.
 */
export async function pushCurrentBranch(cwd) {
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
async function limitedGit(cwd, args, limit = COMMIT_PATCH_MAX_BYTES) {
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
    const chunks = [];
    const errors = [];
    let size = 0;
    let errorSize = 0;
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, 30_000);

    child.stdout.on('data', (chunk) => {
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
    child.stderr.on('data', (chunk) => {
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

      resolve({ output, truncated });
    });
  });
}

/**
 * Снимок staged diff для генератора названия: список, статистика, ограниченный patch
 * и несколько свежих тем коммитов для сохранения принятого в репозитории стиля.
 */
export async function stagedCommitContext(cwd) {
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
