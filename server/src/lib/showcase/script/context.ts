// Контекст для генерации: что именно видит модель.
//
// Пути и Git-ссылки резолвит СЕРВЕР по зарегистрированным репозиториям стенда.
// Модель их не задаёт и не может расширить: она получает готовый текст, а не
// возможность попросить другой.
//
// Вход ограничен по размеру, и обрезка помечается явно. Без пометки модель выдала
// бы разбор половины изменений за разбор всей работы, а человек об этом не узнал бы.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Предел объёма diff. Он щедрый для обычной задачи и жёсткий для «переписали всё»:
// длинный контекст не улучшает сценарий, зато делает вызов дорогим и медленным.
const DIFF_LIMIT = 60_000;

// База сравнения. Пробуются по очереди: у разных установок главная ветка называется
// по-разному, и угадывать одну — верный способ получить пустой diff.
const BASE_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master'];

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
async function mergeBase(cwd: string, head: string): Promise<string> {
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
 * Diff одного репозитория. Бинарные файлы исключены самим форматом вывода, а
 * секретные пути не попадают в контекст: сравниваются отслеживаемые файлы, и
 * `.env` с ключами в репозитории не лежит по договорённости проекта.
 */
async function repoDiff(repo: RepoRef): Promise<DiffContext | null> {
  const head = repo.branch || 'HEAD';
  const base = await mergeBase(repo.path, head);

  if (!base) {
    return null;
  }

  const diff = await git(repo.path, [
    'diff',
    `${base}..${head}`,
    '--no-color',
    '--stat',
    '--patch',
    '--',
    ':(exclude)*.lock',
    ':(exclude)package-lock.json',
  ]).catch(() => '');

  if (!diff.trim()) {
    return null;
  }

  return {
    diff,
    base,
    head,
    truncated: false,
  };
}

/**
 * Общий контекст изменений по всем репозиториям стенда. Каждый называет себя, чтобы
 * модель не смешивала работу в разных репозиториях в одну сцену.
 */
export async function collectDiffContext(repos: RepoRef[]): Promise<DiffContext> {
  const parts: string[] = [];
  const bases: string[] = [];
  const heads: string[] = [];

  for (const repo of repos) {
    const own = await repoDiff(repo).catch(() => null);

    if (!own) {
      continue;
    }

    parts.push(`# репозиторий ${repo.name}\n${own.diff}`);
    bases.push(`${repo.name}:${own.base.slice(0, 12)}`);
    heads.push(`${repo.name}:${own.head}`);
  }

  const joined = parts.join('\n\n');
  const truncated = joined.length > DIFF_LIMIT;

  return {
    diff: truncated ? joined.slice(0, DIFF_LIMIT) : joined,
    base: bases.join(', ') || 'не определена',
    head: heads.join(', ') || 'не определена',
    truncated,
  };
}
