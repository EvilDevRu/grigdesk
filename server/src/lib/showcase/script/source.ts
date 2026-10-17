// Источник рассказа: что из репозиториев цели читает разбор по выбору человека.
//
// Выбор приходит от человека, а пути и ссылки резолвит сервер: имя репозитория
// сверяется с реестром цели, коммит — с историей её HEAD. Модель получает готовый
// текст и расширить выбор не может.
//
// История читается по первому родителю — так выглядит линия ветки, на которой
// стоит стенд. Слияние видно, но не выбирается: его патч смешивает чужую ветку с
// разрешением конфликтов, и отделить одно от другого нечем. Подряд выбранные коммиты
// склеиваются в один diff, пропуск делит выбор на куски.
//
// Явный выбор читается целиком или не читается вовсе: каждая выбранная часть берётся
// от одного разрешённого HEAD, ошибка git — отказ, а не пустой кусок, и сдвиг HEAD за
// время чтения делает выбор устаревшим. Умолчание цели остаётся прежним: у песочницы
// это diff от общего предка с главной веткой до рабочего дерева, у постоянного
// стенда — ничего.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { ShowcaseError } from '../errors.ts';
import {
  collectDiffContext,
  DIFF_LIMIT,
  EXCLUDED_PATHS,
  mergeBase,
  TEST_PATH,
  trimPatch,
} from './context.ts';
import type { RepoRef } from './context.ts';
import { readUntrackedText } from './untracked.ts';
import { SHOWCASE_SOURCE_NOTE_MAX } from '../../../../../shared/plugins/showcase/showcaseContracts.ts';
import type {
  ShowcaseSourceOptions,
  ShowcaseSourceOutsideGroup,
  ShowcaseSourceRepoOption,
  ShowcaseStorySource,
  ShowcaseStorySourceRepo,
  ShowcaseTargetKind,
} from '../../../../../shared/plugins/showcase/showcaseContracts.ts';

const run = promisify(execFile);

// Сколько коммитов показать человеку на выбор: свежая работа почти всегда в них.
const SOURCE_COMMITS_SHOWN = 50;

// Окно истории для проверки выбора. Оно шире списка: пока человек выбирал, ветка
// могла получить новые коммиты, и выбранное не должно стать «неизвестным».
const SOURCE_LINE_WINDOW = 200;

// Пределы описаний: заголовок с телом одного коммита и весь блок с заголовками
// репозиториев и пометкой обрезки. Длинные описания вытеснили бы сами изменения.
const MESSAGE_LIMIT = 600;
const MESSAGES_LIMIT = 8_000;
const MESSAGES_CUT = '\n… (описания коммитов обрезаны)';

// Git явного пути ограничен по времени и буферу: зависший или огромный вывод — отказ
// с причиной, а не вечное ожидание разбора.
const GIT_TIMEOUT_MS = 30_000;
const GIT_BUFFER = 64 * 1024 * 1024;

// Новые файлы явного выбора: как у прежнего diff — немного и коротко.
const UNTRACKED_FILE_LIMIT = 4_000;
const UNTRACKED_FILES_MAX = 12;

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

interface LineCommit {
  id: string;
  parents: string[];
  date: string;
  subject: string;
  body: string;
}

// Кусок изменений: левая сторона — коммит или пустое дерево, правая — коммит или
// рабочее дерево (пустая строка), и с рабочим деревом — его новые файлы.
interface DiffChunk {
  label: string;
  from: string;
  to: string;
  untracked: boolean;
}

// Что читается в одном репозитории: куски изменений и коммиты для описаний.
interface StoryPlan {
  name: string;
  cwd: string;
  chunks: DiffChunk[];
  messages: LineCommit[];
  // У умолчания часть своих коммитов старше окна истории: описания неполны.
  messagesCut: boolean;
}

// Подготовленный снимок выбранного репозитория: один HEAD и линия от него. И проверка
// выбора, и куски берутся из него, а не из повторного чтения ветки.
export interface PreparedRepo {
  repo: RepoRef;
  head: string;
  line: LineCommit[];
}

// Чтение репозитория для списка выбора вместе с окном истории.
interface CatalogRead {
  option: ShowcaseSourceRepoOption;
  window: LineCommit[];
  // Явные отметки читали бы меньше умолчания: история глубже списка или слияния.
  narrowing: boolean;
}

export interface StoryContext {
  diff: string;
  commits: string;
  base: string;
  head: string;
  truncated: boolean;
}

function short(id: string): string {
  return id.slice(0, 7);
}

function emptyPlan(name: string): StoryPlan {
  return {
    name,
    cwd: '',
    chunks: [],
    messages: [],
    messagesCut: false,
  };
}

function unavailable(name: string): ShowcaseError {
  return new ShowcaseError(
    'source_unavailable',
    `Не удалось прочитать репозиторий «${name}». Повторите позже или снимите его в блоке «О чём ролик».`,
    503,
  );
}

function outdated(problem: string): ShowcaseError {
  return new ShowcaseError('source_outdated', `${problem} Выберите заново в блоке «О чём ролик».`, 409);
}

/**
 * Git явного пути: имена файлов как есть, без восьмеричных кодов, и без записи индекса
 * даже у `status`. Отказ — исключение, а не пустой вывод: пустой контекст выглядел бы
 * успешным чтением.
 */
async function gitStrict(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, '-c', 'core.quotePath=false', ...args], {
    maxBuffer: GIT_BUFFER,
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });

  return stdout;
}

/**
 * HEAD репозитория полным идентификатором. Пустая строка — коммитов ещё нет: это не
 * ошибка, а ветка без истории. Любой другой отказ git остаётся ошибкой.
 */
async function resolveHead(cwd: string): Promise<string> {
  try {
    return (await gitStrict(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).trim();
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) {
      return '';
    }

    throw error;
  }
}

async function emptyTree(cwd: string): Promise<string> {
  return (await gitStrict(cwd, ['hash-object', '-t', 'tree', '/dev/null'])).trim();
}

/**
 * Линия ветки по первому родителю от данного HEAD вглубь. Тело коммита читается сразу:
 * описания выбранных коммитов идут в промпт, и второй проход по истории не нужен.
 */
async function readLine(cwd: string, head: string, max: number): Promise<LineCommit[]> {
  if (!head) {
    return [];
  }

  const output = await gitStrict(cwd, [
    'log',
    '-z',
    '--first-parent',
    `--max-count=${max}`,
    '--format=%H%x00%P%x00%cI%x00%s%x00%b',
    head,
  ]);
  // NUL разделяет поля фиксированной записи. Обычный управляющий символ может быть
  // частью описания коммита и не должен создавать поддельную запись истории.
  const fields = output.split('\0');
  const commits: LineCommit[] = [];

  for (let index = 0; index + 4 < fields.length; index += 5) {
    const [id = '', parents = '', date = '', subject = '', body = ''] = fields.slice(index, index + 5);

    commits.push({
      id,
      parents: parents.split(' ').filter(Boolean),
      date,
      subject,
      body: body.trim(),
    });
  }

  return commits;
}

/**
 * Своя ветка — всё после общего предка с главной: коммиты окна, их общее число и число
 * слияний на линии. Без главной ветки своих не отличить, и умолчание остаётся пустым.
 */
async function ownHistory(cwd: string, head: string): Promise<{
  ids: Set<string>;
  total: number;
  merges: number;
}> {
  const base = head ? await mergeBase(cwd, head) : '';

  if (!base) {
    return {
      ids: new Set(),
      total: 0,
      merges: 0,
    };
  }

  const range = `${base}..${head}`;
  const [listed, total, merges] = await Promise.all([
    gitStrict(cwd, ['rev-list', '--first-parent', `--max-count=${SOURCE_LINE_WINDOW}`, range]),
    gitStrict(cwd, ['rev-list', '--first-parent', '--count', range]),
    gitStrict(cwd, ['rev-list', '--first-parent', '--merges', '--count', range]),
  ]);

  return {
    ids: new Set(listed.split('\n').map((line) => line.trim()).filter(Boolean)),
    total: Number(total.trim()) || 0,
    merges: Number(merges.trim()) || 0,
  };
}

/**
 * Сколько путей изменено и не закоммичено. Переименование несёт старый путь отдельной
 * записью; файлы окружения не считаются — их переписывает стенд, и в разбор они не идут.
 */
async function workFileCount(cwd: string): Promise<number> {
  const records = (await gitStrict(cwd, ['status', '--porcelain=v1', '-z'])).split('\0');
  let count = 0;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? '';

    if (!record) {
      continue;
    }

    if (/^[RC]/.test(record)) {
      index += 1;
    }

    if (!/(^|\/)\.env/.test(record.slice(3))) {
      count += 1;
    }
  }

  return count;
}

async function branchOf(cwd: string): Promise<string> {
  return (await gitStrict(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
}

/**
 * Общие исключения новых файлов явного пути: тесты, файлы окружения и замороженные
 * зависимости. Прежний diff ветки фильтрует по-своему и этим правилом не меняется.
 */
function excludedPath(relative: string): boolean {
  const name = path.posix.basename(relative);

  return TEST_PATH.test(relative)
    || /^\.env/.test(name)
    || name.endsWith('.lock')
    || name === 'package-lock.json';
}

// Имя с переводом строки или управляющим знаком показывается строкой JSON: иначе оно
// разорвало бы список имён на два ложных файла.
function displayName(relative: string): string {
  return CONTROL_CHARS.test(relative) ? JSON.stringify(relative) : relative;
}

async function untrackedPaths(cwd: string): Promise<string[]> {
  const listed = await gitStrict(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);

  return listed.split('\0').filter((relative) => relative && !excludedPath(relative));
}

/**
 * Содержимое новых файлов явного выбора. Бинарный файл пропускается по нулевому байту,
 * исчезнувший за время чтения — тоже: на момент чтения его нет. Другая ошибка — отказ.
 */
async function untrackedContent(cwd: string, paths: string[]): Promise<{ text: string; trimmed: boolean }> {
  const parts: string[] = [];
  let trimmed = paths.length > UNTRACKED_FILES_MAX;

  for (const relative of paths.slice(0, UNTRACKED_FILES_MAX)) {
    const text = await readUntrackedText(cwd, relative, UNTRACKED_FILE_LIMIT);

    if (text === null) {
      continue;
    }

    trimmed = trimmed || text.length > UNTRACKED_FILE_LIMIT;

    const shown = text.length > UNTRACKED_FILE_LIMIT
      ? `${text.slice(0, UNTRACKED_FILE_LIMIT)}\n… (файл обрезан)`
      : text;

    parts.push(`## новый файл ${displayName(relative)}\n${shown}`);
  }

  return { text: parts.join('\n\n'), trimmed };
}

/**
 * Строка репозитория в списке выбора вместе с окном истории. Нечитаемый репозиторий
 * остаётся в списке с причиной без пути: пропавший выглядел бы как «у стенда его нет».
 */
async function readCatalogRepo(repo: RepoRef): Promise<CatalogRead> {
  try {
    const head = await resolveHead(repo.path);
    const [window, own, workFiles, branch] = await Promise.all([
      readLine(repo.path, head, SOURCE_LINE_WINDOW),
      ownHistory(repo.path, head),
      workFileCount(repo.path),
      branchOf(repo.path),
    ]);
    const shown = window.slice(0, SOURCE_COMMITS_SHOWN);
    const visibleOwn = shown.filter((commit) => own.ids.has(commit.id)).length;

    return {
      option: {
        name: repo.name,
        branch,
        workFiles,
        commits: shown.map((commit) => ({
          id: commit.id,
          subject: commit.subject,
          date: commit.date,
          own: own.ids.has(commit.id),
          merge: commit.parents.length > 1,
        })),
        error: null,
      },
      window,
      narrowing: own.merges > 0 || own.total > visibleOwn,
    };
  } catch {
    return {
      option: {
        name: repo.name,
        branch: '',
        workFiles: 0,
        commits: [],
        error: 'История репозитория не читается.',
      },
      window: [],
      narrowing: true,
    };
  }
}

function outsideCommit(
  id: string,
  subject: string | null,
  state: 'available' | 'outdated' | 'unavailable',
) {
  return {
    id,
    subject,
    state,
  };
}

/**
 * Сохранённый выбор вне видимого списка: коммиты глубже 50, выпавшие из линии и
 * репозитории, которых у цели больше нет. Человек обязан их видеть, чтобы снять.
 */
function outsideGroups(
  saved: ShowcaseStorySource | null,
  reads: CatalogRead[],
): ShowcaseSourceOutsideGroup[] {
  const groups: ShowcaseSourceOutsideGroup[] = [];

  for (const choice of saved?.repos ?? []) {
    const read = reads.find((item) => item.option.name === choice.name);

    if (!read) {
      groups.push({
        name: choice.name,
        missing: true,
        commits: choice.commits.map((id) => outsideCommit(id, null, 'outdated')),
      });

      continue;
    }

    const shown = new Set(read.option.commits.map((commit) => commit.id));
    const window = new Map(read.window.map((commit) => [commit.id, commit]));
    const commits = choice.commits
      .filter((id) => !shown.has(id))
      .map((id) => {
        const found = window.get(id);

        if (read.option.error) {
          return outsideCommit(id, null, 'unavailable');
        }

        return found ? outsideCommit(id, found.subject, 'available') : outsideCommit(id, null, 'outdated');
      });

    if (commits.length) {
      groups.push({
        name: choice.name,
        missing: false,
        commits,
      });
    }
  }

  return groups;
}

/**
 * Из чего выбирать источник рассказа. Умолчание отдаётся видимой проекцией: с неё
 * начинается черновик. Если явные отметки прочитали бы меньше умолчания, сервер
 * просит интерфейс спросить человека, а сохранённое вне списка показывает отдельно.
 */
export async function readSourceOptions(
  repos: RepoRef[],
  { kind, taskAvailable, saved = null }: {
    kind: ShowcaseTargetKind;
    taskAvailable: boolean;
    saved?: ShowcaseStorySource | null;
  },
): Promise<ShowcaseSourceOptions> {
  const reads = await Promise.all(repos.map(readCatalogRepo));
  const sandbox = kind !== 'project';

  return {
    taskAvailable,
    noteMax: SHOWCASE_SOURCE_NOTE_MAX,
    defaults: {
      task: taskAvailable,
      note: '',
      code: true,
      repos: reads.map(({ option }) => ({
        name: option.name,
        work: sandbox && option.workFiles > 0,
        commits: sandbox
          ? option.commits.filter((commit) => commit.own && !commit.merge).map((commit) => commit.id)
          : [],
      })),
    },
    requiresExplicitSelectionConfirmation: sandbox && reads.some((read) => read.narrowing),
    selectedOutsideCatalog: outsideGroups(saved, reads),
    repos: reads.map((read) => read.option),
  };
}

/**
 * Проверка формы выбора без git: длина пожелания, имена из реестра цели без повторов,
 * полные идентификаторы коммитов без повторов. Возвращает причину словами или null.
 */
function structuralProblem(source: ShowcaseStorySource, repos: RepoRef[]): string | null {
  if (source.note.trim().length > SHOWCASE_SOURCE_NOTE_MAX) {
    return `Пожелание длиннее ${SHOWCASE_SOURCE_NOTE_MAX} знаков — сократите его.`;
  }

  const seen = new Set<string>();

  for (const choice of source.repos ?? []) {
    if (seen.has(choice.name) || !repos.some((repo) => repo.name === choice.name)) {
      return `Репозиторий «${choice.name}» не принадлежит стенду или назван дважды.`;
    }

    seen.add(choice.name);

    if (new Set(choice.commits).size !== choice.commits.length
      || choice.commits.some((id) => !COMMIT_ID.test(id))) {
      return `Коммиты репозитория «${choice.name}» названы не полными идентификаторами или повторяются.`;
    }
  }

  return null;
}

/**
 * Снимок выбранных репозиториев: один разрешённый HEAD и окно линии от него. Ошибка
 * чтения — отказ с именем репозитория: пустая история выглядела бы честным выбором.
 */
export async function prepareSelection(
  repos: RepoRef[],
  selection: ShowcaseStorySourceRepo[],
): Promise<PreparedRepo[]> {
  const prepared: PreparedRepo[] = [];

  for (const choice of selection) {
    const repo = repos.find((item) => item.name === choice.name);

    if (!repo) {
      continue;
    }

    try {
      const head = await resolveHead(repo.path);
      const line = choice.commits.length ? await readLine(repo.path, head, SOURCE_LINE_WINDOW) : [];

      prepared.push({
        repo,
        head,
        line,
      });
    } catch {
      throw unavailable(repo.name);
    }
  }

  return prepared;
}

/**
 * Снимок всё ещё описывает ветку: HEAD каждого выбранного репозитория не сдвинулся с
 * подготовки. Аренда держит стенд, но не git: коммит за время чтения делает выбор
 * устаревшим, а не смешанным.
 */
export async function assertSelectionCurrent(prepared: PreparedRepo[]): Promise<void> {
  for (const item of prepared) {
    let current = '';

    try {
      current = await resolveHead(item.repo.path);
    } catch {
      throw unavailable(item.repo.name);
    }

    if (current !== item.head) {
      throw outdated(`Ветка репозитория «${item.repo.name}» сдвинулась во время чтения.`);
    }
  }
}

/**
 * Проверка выбранных коммитов по снимку: каждый — на линии ветки в окне истории и не
 * слияние. Возвращает причину словами или null.
 */
function historyProblem(selection: ShowcaseStorySourceRepo[], prepared: PreparedRepo[]): string | null {
  for (const item of prepared) {
    const choice = selection.find((entry) => entry.name === item.repo.name);
    const known = new Map(item.line.map((commit) => [commit.id, commit]));

    for (const id of choice?.commits ?? []) {
      const commit = known.get(id);

      if (!commit) {
        return `Коммит ${short(id)} репозитория «${item.repo.name}» не найден в истории стенда.`;
      }

      if (commit.parents.length > 1) {
        return `Коммит ${short(id)} репозитория «${item.repo.name}» — слияние, его выбрать нельзя.`;
      }
    }
  }

  return null;
}

/**
 * Что не так с выбором человека — словами для него, или null. Форма проверяется без
 * git, коммиты — по живой истории цели. Нечитаемый репозиторий — отказ
 * `source_unavailable`, а не «коммит не найден».
 */
export async function sourceProblem(
  source: ShowcaseStorySource | null,
  repos: RepoRef[],
): Promise<string | null> {
  if (!source) {
    return null;
  }

  const structural = structuralProblem(source, repos);

  if (structural || !source.repos) {
    return structural;
  }

  return historyProblem(source.repos, await prepareSelection(repos, source.repos));
}

/**
 * Кусок из подряд выбранных коммитов. Левая сторона — родитель первого из них, у
 * корневого — пустое дерево; кусок, дошедший до HEAD, с незакоммиченным читается до
 * рабочего дерева вместе с новыми файлами.
 */
async function runChunk(cwd: string, run: LineCommit[], toDisk: boolean): Promise<DiffChunk | null> {
  const first = run[0];
  const last = run.at(-1);

  if (!first || !last) {
    return null;
  }

  const title = run.length === 1
    ? `коммит ${short(last.id)}`
    : `коммиты ${short(first.id)}..${short(last.id)} (${run.length})`;

  return {
    label: `## ${title}${toDisk ? ' и незакоммиченные правки' : ''}`,
    from: first.parents[0] ?? await emptyTree(cwd),
    to: toDisk ? '' : last.id,
    untracked: toDisk,
  };
}

/**
 * План одного репозитория по снимку: подряд идущие коммиты линии — один кусок, пропуск
 * начинает новый. Незакоммиченное без выбранного HEAD идёт своим куском от
 * разрешённого HEAD, а у ветки без коммитов — от пустого дерева.
 */
async function explicitPlan(item: PreparedRepo, choice: ShowcaseStorySourceRepo): Promise<StoryPlan> {
  const picked = new Set(choice.commits);
  const chain = [...item.line].reverse();
  const headPicked = Boolean(item.head) && picked.has(item.head);
  const chunks: DiffChunk[] = [];
  let run: LineCommit[] = [];

  // Проход до позиции за последним коммитом: она закрывает кусок, дошедший до HEAD.
  for (let index = 0; index <= chain.length; index += 1) {
    const commit = chain[index];

    if (commit && picked.has(commit.id)) {
      run.push(commit);

      continue;
    }

    const chunk = await runChunk(item.repo.path, run, choice.work && !commit && headPicked);

    if (chunk) {
      chunks.push(chunk);
    }

    run = [];
  }

  if (choice.work && !headPicked) {
    chunks.push({
      label: '## незакоммиченные правки',
      from: item.head || await emptyTree(item.repo.path),
      to: '',
      untracked: true,
    });
  }

  return {
    name: item.repo.name,
    cwd: item.repo.path,
    chunks,
    messages: chain.filter((commit) => picked.has(commit.id)),
    messagesCut: false,
  };
}

/**
 * Умолчание песочницы для разбора без кода: отрезок прежнего diff от общего предка с
 * главной веткой до рабочего дерева с новыми файлами. Описания — свои коммиты окна без
 * слияний; если своих больше, чем в окне, это помечается.
 */
async function defaultPlan(repo: RepoRef): Promise<StoryPlan> {
  const base = await mergeBase(repo.path, repo.branch || 'HEAD');

  if (!base) {
    return emptyPlan(repo.name);
  }

  const head = await resolveHead(repo.path);
  const [own, line] = await Promise.all([
    ownHistory(repo.path, head),
    readLine(repo.path, head, SOURCE_LINE_WINDOW),
  ]);
  const messages = line.filter((commit) => own.ids.has(commit.id) && commit.parents.length < 2).reverse();

  return {
    name: repo.name,
    cwd: repo.path,
    chunks: [{
      label: '',
      from: base,
      to: '',
      untracked: true,
    }],
    messages,
    messagesCut: own.total > own.ids.size,
  };
}

/**
 * Текст одного куска. С кодом — сводка и patch по файлам с той же обрезкой, что у
 * прежнего diff; без кода — сводка и имена новых файлов: модель видит, ЧТО менялось.
 * Кусок без изменений даёт пустую строку, а не одинокий заголовок.
 */
async function renderChunk(
  cwd: string,
  chunk: DiffChunk,
  code: boolean,
): Promise<{ text: string; trimmed: boolean }> {
  const sides = chunk.to ? [chunk.from, chunk.to] : [chunk.from];
  const format = code ? ['--stat', '--patch'] : ['--stat'];
  const tracked = await gitStrict(cwd, [
    'diff',
    ...sides,
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    ...format,
    '--',
    '.',
    ...EXCLUDED_PATHS,
  ]);
  const fresh = chunk.untracked ? await untrackedPaths(cwd) : [];
  let body = '';
  let trimmed = false;

  if (code) {
    const patch = trimPatch(tracked.trim());
    const untracked = await untrackedContent(cwd, fresh);

    body = [patch.text, untracked.text].filter(Boolean).join('\n\n');
    trimmed = patch.trimmed || untracked.trimmed;
  } else {
    const names = fresh.length ? `## новые файлы\n${fresh.map(displayName).join('\n')}` : '';

    body = [tracked.trim(), names].filter(Boolean).join('\n\n');
  }

  return {
    text: body ? [chunk.label, body].filter(Boolean).join('\n\n') : '',
    trimmed,
  };
}

/**
 * Описание одного коммита: заголовок и тело вместе не длиннее предела, продолжение
 * тела сдвинуто под заголовок.
 */
function commitLine(commit: LineCommit): string {
  const full = commit.body ? `${commit.subject}\n${commit.body}` : commit.subject;
  const text = full.length > MESSAGE_LIMIT ? `${full.slice(0, MESSAGE_LIMIT)}…` : full;
  const [title = '', ...rest] = text.split('\n');
  const tail = rest.length ? `\n${rest.map((line) => `  ${line}`).join('\n')}` : '';

  return `- ${short(commit.id)} ${title}${tail}`;
}

/**
 * Описания коммитов по репозиториям. Это недоверенный текст авторов коммитов — промпт
 * ставит его к остальным данным. Весь блок вместе с пометкой обрезки укладывается в
 * предел.
 */
function renderMessages(plans: StoryPlan[]): string {
  const parts: string[] = [];

  for (const plan of plans) {
    if (plan.messages.length === 0) {
      continue;
    }

    const lines = plan.messages.map(commitLine);

    if (plan.messagesCut) {
      lines.push(`… (описания своих коммитов старше последних ${SOURCE_LINE_WINDOW} не читались)`);
    }

    parts.push(`# репозиторий ${plan.name}\n${lines.join('\n')}`);
  }

  const joined = parts.join('\n\n');

  return joined.length > MESSAGES_LIMIT
    ? `${joined.slice(0, MESSAGES_LIMIT - MESSAGES_CUT.length)}${MESSAGES_CUT}`
    : joined;
}

/**
 * Склеивает куски всех репозиториев в контекст. Строгий режим явного выбора превращает
 * любую ошибку git в отказ с именем репозитория; умолчание без кода пропускает
 * нечитаемый кусок, как и прежний diff.
 */
async function renderPlans(plans: StoryPlan[], code: boolean, strict: boolean): Promise<StoryContext> {
  const parts: string[] = [];
  const bases: string[] = [];
  const heads: string[] = [];
  let trimmed = false;

  for (const plan of plans) {
    const texts: string[] = [];

    for (const chunk of plan.chunks) {
      let rendered = { text: '', trimmed: false };

      try {
        rendered = await renderChunk(plan.cwd, chunk, code);
      } catch {
        if (strict) {
          throw unavailable(plan.name);
        }
      }

      if (!rendered.text) {
        continue;
      }

      texts.push(rendered.text);
      bases.push(`${plan.name}:${chunk.from.slice(0, 12)}`);
      heads.push(`${plan.name}:${chunk.to ? chunk.to.slice(0, 12) : 'рабочее дерево'}`);
      trimmed = trimmed || rendered.trimmed;
    }

    if (texts.length) {
      parts.push(`# репозиторий ${plan.name}\n${texts.join('\n\n')}`);
    }
  }

  const joined = parts.join('\n\n');
  const truncated = trimmed || joined.length > DIFF_LIMIT;

  return {
    diff: truncated ? joined.slice(0, DIFF_LIMIT) : joined,
    commits: renderMessages(plans),
    base: bases.join(', ') || 'не определена',
    head: heads.join(', ') || 'не определена',
    truncated,
  };
}

/**
 * Контекст разбора по выбору источника. Без выбора песочница получает прежний diff
 * ветки — ролик без выбора не меняется, — а постоянный стенд не получает ничего. Явный
 * выбор проверяется, читается по одному снимку и даёт отказ вместо неполного текста.
 */
export async function collectStoryContext(
  repos: RepoRef[],
  source: ShowcaseStorySource | null,
  kind: ShowcaseTargetKind,
): Promise<StoryContext> {
  const code = source?.code ?? true;

  if (!source?.repos && kind === 'project') {
    return {
      diff: '',
      commits: '',
      base: 'не определена',
      head: 'не определена',
      truncated: false,
    };
  }

  if (!source?.repos) {
    const plans = await Promise.all(repos.map((repo) => (
      defaultPlan(repo).catch(() => emptyPlan(repo.name))
    )));

    if (!code) {
      return renderPlans(plans, false, false);
    }

    return {
      ...await collectDiffContext(repos),
      commits: renderMessages(plans),
    };
  }

  const selection = source.repos;
  const structural = structuralProblem(source, repos);

  if (structural) {
    throw outdated(structural);
  }

  const prepared = await prepareSelection(repos, selection);
  const history = historyProblem(selection, prepared);

  if (history) {
    throw outdated(history);
  }

  const plans: StoryPlan[] = [];

  for (const item of prepared) {
    const choice = selection.find((entry) => entry.name === item.repo.name);

    if (choice) {
      plans.push(await explicitPlan(item, choice).catch(() => {
        throw unavailable(item.repo.name);
      }));
    }
  }

  const context = await renderPlans(plans, code, true);

  await assertSelectionCurrent(prepared);

  return context;
}
