// Контекст для генерации: что именно видит модель.
//
// Пути и Git-ссылки резолвит СЕРВЕР по зарегистрированным репозиториям стенда.
// Модель их не задаёт и не может расширить: она получает готовый текст, а не
// возможность попросить другой.
//
// Сравнивается РАБОЧЕЕ ДЕРЕВО, а не только коммиты ветки: попытка конвейера до
// отгрузки держит готовую работу незакоммиченной, и diff «база..ветка» у неё пуст.
// Незакоммиченные новые файлы тоже входят в контекст — без них модель рассказала
// бы о правках в старых файлах и промолчала о новом экране.
//
// Вход ограничен по размеру, и обрезка помечается явно. Без пометки модель выдала
// бы разбор половины изменений за разбор всей работы, а человек об этом не узнал бы.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { readUntrackedText } from './untracked.ts';

const run = promisify(execFile);

// Предел объёма diff. Он щедрый для обычной задачи и жёсткий для «переписали всё»:
// длинный контекст не улучшает сценарий, зато делает вызов дорогим и медленным.
export const DIFF_LIMIT = 90_000;

// Предел на один файл. Обрезка по общему объёму срезала бы хвост diff целиком —
// у задачи 8665 за бортом остался весь фронтенд с диалогом, ради которого ролик и
// снимали. Каждый файл получает свою долю, и модель видит все изменения по верхам.
const FILE_LIMIT = 4_000;

// Новых файлов в контексте немного и они короткие: длинный новый файл — это
// обычно сгенерированное или скопированное, а не то, о чём рассказывает ролик.
const UNTRACKED_FILE_LIMIT = 4_000;
const UNTRACKED_FILES_MAX = 12;

// Тесты в контекст не идут: ролик рассказывает о видимом поведении, а тестовый
// код занимает место, из-за которого обрезался сам продуктовый.
export const TEST_PATH =
  /(^|\/)(tests?|__tests__|e2e|spec|specs)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$/;

// База сравнения. Первым идёт то, что сам remote называет главной веткой; остальные
// имена — на случай, если `origin/HEAD` у клона не выставлен.
const BASE_CANDIDATES = ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'];

// Что не попадает в контекст: замороженные зависимости бесполезны модели, а файлы
// окружения стенд переписывает своими схемами и паролями — им в промпте не место.
export const EXCLUDED_PATHS = [
  ':(exclude)*.lock',
  ':(exclude)package-lock.json',
  ':(exclude).env*',
  ':(exclude)*/.env*',
];

export interface RepoRef {
  name: string;
  path: string;
  branch: string;
}

export interface DiffContext {
  diff: string;
  base: string;
  head: string;
  truncated: boolean;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], {
    maxBuffer: 8 * 1024 * 1024,
  });

  return stdout;
}

/**
 * База для сравнения ветки. Берётся общий предок с главной веткой, а не сама
 * главная: иначе в diff попадут чужие коммиты, приехавшие в неё после ответвления,
 * и сценарий расскажет о чужой работе.
 */
export async function mergeBase(cwd: string, head: string): Promise<string> {
  for (const candidate of BASE_CANDIDATES) {
    const base = await git(cwd, ['merge-base', candidate, head])
      .then((value) => value.trim())
      .catch(() => '');

    if (base) {
      return base;
    }
  }

  return '';
}

/**
 * Новые файлы, которых git ещё не знает. Бинарные пропускаются по признаку нулевого
 * байта: их содержимое модели не прочитать, а место в контексте они бы заняли.
 */
async function untrackedFiles(cwd: string): Promise<{ text: string; trimmed: boolean }> {
  const listed = await git(cwd, ['ls-files', '--others', '--exclude-standard'])
    .then((value) => value.split('\n').map((item) => item.trim()).filter(Boolean))
    .catch(() => [] as string[]);
  const parts: string[] = [];

  const product = listed.filter((relative) => !TEST_PATH.test(relative));
  let trimmed = product.length > UNTRACKED_FILES_MAX;

  for (const relative of product.slice(0, UNTRACKED_FILES_MAX)) {
    if (/(^|\/)\.env/.test(relative) || relative.endsWith('.lock')) {
      continue;
    }

    const text = await readUntrackedText(cwd, relative, UNTRACKED_FILE_LIMIT).catch(() => null);

    if (text === null) {
      continue;
    }

    trimmed = trimmed || text.length > UNTRACKED_FILE_LIMIT;

    const shown = text.length > UNTRACKED_FILE_LIMIT
      ? `${text.slice(0, UNTRACKED_FILE_LIMIT)}\n… (файл обрезан)`
      : text;

    parts.push(`## новый файл ${relative}\n${shown}`);
  }

  return { text: parts.join('\n\n'), trimmed };
}

/**
 * Diff одного репозитория относительно базы: коммиты ветки, незакоммиченные правки
 * и новые файлы. Бинарные файлы исключены самим форматом вывода, а файлы окружения —
 * явным списком: стенд переписывает их своими схемами и паролями.
 */
async function repoDiff(repo: RepoRef): Promise<DiffContext | null> {
  const head = repo.branch || 'HEAD';
  const base = await mergeBase(repo.path, head);

  if (!base) {
    return null;
  }

  const tracked = await git(repo.path, [
    'diff',
    base,
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--stat',
    '--patch',
    '--',
    '.',
    ...EXCLUDED_PATHS,
  ]).catch(() => '');
  const untracked = await untrackedFiles(repo.path);
  const patch = trimPatch(tracked.trim());
  const diff = [patch.text, untracked.text].filter(Boolean).join('\n\n');

  if (!diff.trim()) {
    return null;
  }

  return {
    diff,
    base,
    head,
    truncated: patch.trimmed || untracked.trimmed,
  };
}

/**
 * Patch по файлам: сводка `--stat` остаётся целиком (она короткая и перечисляет всё),
 * тестовые файлы выбрасываются, а каждый оставшийся получает не больше своей доли.
 * Обрезанный файл помечается прямо в тексте — модель видит, что хвоста нет.
 */
export function trimPatch(patch: string): { text: string; trimmed: boolean } {
  const sections = patch.split(/^(?=diff --git )/m);
  const kept: string[] = [];
  let trimmed = false;

  for (const section of sections) {
    const changedPath = /^diff --git a\/(\S+) b\//.exec(section)?.[1] ?? '';

    if (changedPath && TEST_PATH.test(changedPath)) {
      continue;
    }

    if (section.length > FILE_LIMIT) {
      trimmed = true;
      kept.push(`${section.slice(0, FILE_LIMIT)}\n… (файл обрезан)\n`);
    } else {
      kept.push(section);
    }
  }

  return { text: kept.join(''), trimmed };
}

/**
 * Общий контекст изменений по всем репозиториям стенда. Каждый называет себя, чтобы
 * модель не смешивала работу в разных репозиториях в одну сцену.
 */
export async function collectDiffContext(repos: RepoRef[]): Promise<DiffContext> {
  const parts: string[] = [];
  const bases: string[] = [];
  const heads: string[] = [];
  let trimmed = false;

  for (const repo of repos) {
    const own = await repoDiff(repo).catch(() => null);

    if (!own) {
      continue;
    }

    parts.push(`# репозиторий ${repo.name}\n${own.diff}`);
    bases.push(`${repo.name}:${own.base.slice(0, 12)}`);
    heads.push(`${repo.name}:${own.head}`);
    trimmed = trimmed || own.truncated;
  }

  const joined = parts.join('\n\n');
  const truncated = trimmed || joined.length > DIFF_LIMIT;

  return {
    diff: truncated ? joined.slice(0, DIFF_LIMIT) : joined,
    base: bases.join(', ') || 'не определена',
    head: heads.join(', ') || 'не определена',
    truncated,
  };
}
