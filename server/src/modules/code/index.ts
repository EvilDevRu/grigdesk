// Модуль code — плагин «Код»: просмотр кода и управление Git рабочих копий.
// Дерево файлов и содержимое отдаются по любому ДЕРЕВУ репозитория: основному или
// worktree (их создаёт фабрика под задачи и слоты) — выбор дерева на клиенте.
// Несохранённые изменения считает тот же lib/git.ts, что и диф приёмки задач,
// рисует их тот же Monaco на клиенте.
//
// Доступ: корень обязан быть деревом из `git worktree list` репозитория проекта,
// путь внутри — префикс-проверкой. Это дисциплина, а не песочница: кокпит и так
// отдаёт полный шелл в «Терминале», но файловому API за auth-гардом она положена.
import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Dirent } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PROFILE_RE, listProjects } from '../../lib/profiles.js';
import { projectRepos } from '../../lib/projects.js';
import { generateCommitTitle } from '../../lib/codeCommitMessage.ts';
import type { CommitTargetResolver } from '../../lib/codeCommitMessage.ts';
import type {
  CodeDirectoryResponse,
  CodeFileResponse,
  CodeGitLogEntry,
  CodeGitResponse,
  CodeRepo,
  CodeReposResponse,
  CodeRoot,
  CodeRootsResponse,
  CodeWorktree,
} from '../../../../shared/codeContracts.ts';
import {
  CodeGitError,
  commitStagedChanges,
  gitTrackingStatus,
  pushCurrentBranch,
  stageWorktreeChanges,
  unstageWorktreeChanges,
  worktreeChanges,
} from '../../lib/git.ts';

declare module 'fastify' {
  interface FastifyInstance {
    pluginEnabled(id: string): boolean;
    pluginSettings?(id: string): unknown;
  }
}

export interface CodeModuleConfig extends Record<string, unknown> {
  profilesDir: string;
  chatsDir?: string | null;
  telegramDir?: string | null;
  githubDir?: string | null;
}

export interface CodePreferences {
  read(): unknown;
}

export interface CodeModuleOptions {
  config: CodeModuleConfig;
  prefs: CodePreferences;
  resolveCommitTarget?: CommitTargetResolver;
}

interface CodeRoute {
  Params: {
    project: string;
  };
  Querystring: {
    repo?: unknown;
    root?: unknown;
    dir?: unknown;
    path?: unknown;
  };
  Body: unknown;
}

type ProjectRepo = Omit<CodeRepo, 'trees'>;

interface RootContext {
  repo: ProjectRepo;
  tree: CodeWorktree;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requestBody(req: FastifyRequest<CodeRoute>): Record<string, unknown> {
  return isRecord(req.body) ? req.body : {};
}

function errorMessage(error: unknown): string {
  return isRecord(error) && typeof error.message === 'string' ? error.message : String(error);
}

/**
 * Общий каталог проектов пока написан на JS. На границе плагина проверяется его
 * результат, чтобы произвольное legacy-значение не стало файловым корнем.
 */
async function readProjectRepos(
  config: CodeModuleConfig,
  prefs: CodePreferences,
  id: string,
): Promise<ProjectRepo[]> {
  const result: unknown = await projectRepos({
    config,
    prefs,
    id,
  });

  if (!Array.isArray(result)) {
    throw new TypeError('Некорректный список репозиториев проекта');
  }

  return result.map((repo: unknown) => {
    if (!isRecord(repo) || typeof repo.key !== 'string' || typeof repo.dir !== 'string'
        || (repo.from !== undefined && typeof repo.from !== 'string')) {
      throw new TypeError('Некорректный репозиторий проекта');
    }

    return {
      key: repo.key,
      dir: repo.dir,
      ...(typeof repo.from === 'string' ? { from: repo.from } : {}),
    };
  });
}

/**
 * JS-каталог объединяет фабричные и пользовательские проекты. Плагин принимает
 * только строковые идентификаторы, сохраняя неизвестный ответ за этой границей.
 */
async function readProjectIds(config: CodeModuleConfig, prefs: CodePreferences): Promise<string[]> {
  const reader: unknown = listProjects;

  if (typeof reader !== 'function') {
    throw new TypeError('Каталог проектов недоступен');
  }

  const result: unknown = await reader(config, prefs);

  if (!Array.isArray(result) || !result.every((id: unknown) => typeof id === 'string')) {
    throw new TypeError('Некорректный список проектов');
  }

  return result;
}

const exec = promisify(execFile);
const MAX_BYTES = 1_500_000; // как в lib/git.ts: гигантские блобы в браузер не тащим

// Картинки JSON-роут `file` всегда считает бинарными: их отдаёт отдельный raw-роут
// сырыми байтами. Набор только растровый, SVG исключён намеренно (умеет скрипты) —
// тот же принцип, что у просмотрщика документов. Список обязан совпадать с IMAGE_EXT
// в web/src/views/code/CodePanel.vue — сторож в tests/server/code-raw.test.js.
export const RAW_IMAGE_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['bmp', 'image/bmp'],
  ['ico', 'image/x-icon'],
]);
// У картинок свой потолок: байты идут потоком, а не раздуваются в JSON, но скриншоты
// и фото легко переваливают за текстовые 1,5 МБ.
export const RAW_MAX_BYTES = 10_000_000;

// Сегменты, закрытые в ЛЮБОМ дереве: внутренности гита (в .git/config лежат токены
// remote-ов) и конвенция `.state` — в проекте она гитигнорится целиком (`**/.state/`)
// и означает «секреты и рантайм» (server/.state: креды B24, cli-token, хеш пароля входа).
const HIDDEN_SEGMENTS = new Set(['.git', '.state']);

/**
 * Каталоги данных САМОГО кокпита (chats/, telegram/, github/): они лежат внутри его дерева,
 * гитигнорятся — и потому в дифе не видны, а в `ls`/`file` были бы видны целиком.
 *
 * Закрываются по фактическому пути из config, а НЕ по имени: имена настраиваются
 * переменными окружения, а одноимённый каталог в чужом репозитории — чужой код,
 * прятать его нельзя (сравни с `git`: там путь от клиента не приходит вовсе).
 */
function hiddenDirs(config: CodeModuleConfig): string[] {
  return [config.chatsDir, config.telegramDir, config.githubDir]
    .filter((dir): dir is string => typeof dir === 'string' && Boolean(dir))
    .map((d) => path.resolve(d));
}

/**
 * Закрывает служебные сегменты на любой глубине дерева. Каталоги данных кокпита
 * проверяются по фактическому пути, чтобы не скрывать одноимённые чужие каталоги.
 */
export function isHiddenPath(abs: string, dirs: readonly string[] = []): boolean {
  const p = path.resolve(abs);

  if (p.split(path.sep).some((seg) => HIDDEN_SEGMENTS.has(seg))) {
    return true;
  }

  return dirs.some((dir) => p === dir || p.startsWith(dir + path.sep));
}

/**
 * Возвращает основное дерево первым, сохраняя порядок Git worktree list.
 * Бейдж задачи выводится из имени каталога или ветки и не влияет на доступ.
 */
async function worktrees(dir: string): Promise<CodeWorktree[]> {
  const { stdout } = await exec('git', ['-C', dir, 'worktree', 'list', '--porcelain'], {
    maxBuffer: 4 * 1024 * 1024,
  });
  const out: Pick<CodeWorktree, 'path' | 'branch'>[] = [];
  let cur: Pick<CodeWorktree, 'path' | 'branch'> | null = null;

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = {
        path: line.slice(9),
        branch: '',
      };
      out.push(cur);
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace('refs/heads/', '');
    } else if (cur && line === 'detached') {
      cur.branch = '(detached)';
    }
  }

  return out.map((w, i) => {
    // Бейдж задачи — косметика по конвенциям фабрики: каталог …tNNNN или ветка task-NNNN.
    const byDir = path.basename(w.path).match(/t\d{3,6}$/);
    const byBranch = w.branch.match(/^task-(\d{3,6})/);

    return {
      ...w,
      main: i === 0,
      name: i === 0 ? 'основной' : path.basename(w.path),
      task: byDir ? byDir[0] : (byBranch ? `t${byBranch[1]}` : ''),
    };
  });
}

/**
 * Регистрирует просмотр файлов и явные Git-действия для деревьев проекта.
 * Файловая граница проверяется до чтения, а мутации одного дерева сериализуются.
 */
const codeModule: FastifyPluginAsync<CodeModuleOptions> = async (fastify, opts) => {
  const {
    config,
    prefs,
    resolveCommitTarget,
  } = opts;
  const hidden = hiddenDirs(config);
  const mutatingRoots = new Set<string>();

  // Живой гейт (как у video): тумблер в настройках действует без рестарта.
  const gate = (reply: FastifyReply) => fastify.pluginEnabled('code') ? null : reply.code(403).send({
    error: 'plugin_disabled',
    message: 'Плагин «Код» выключен — «Настройки → Плагины»',
  });

  /**
   * Разрешает репозиторий по метке проекта и проверяет принадлежность root.
   * Неизвестное дерево получает отказ до любых файловых или Git-операций.
   */
  async function resolveRoot(
    req: FastifyRequest<CodeRoute>,
    reply: FastifyReply,
  ): Promise<RootContext | null> {
    const id = String(req.params.project);

    if (!PROFILE_RE.test(id)) {
      reply.code(400).send({ error: 'bad_project' });

      return null;
    }

    const repos = await readProjectRepos(config, prefs, id);
    const repo = repos.find((r) => r.key === String(req.query.repo || ''));

    if (!repo) {
      reply.code(404).send({
        error: 'no_repo',
        message: 'у проекта нет такого репозитория',
      });

      return null;
    }

    let trees: CodeWorktree[] = [];

    try {
      trees = await worktrees(repo.dir);
    } catch {
      // Не Git или недоступен: ниже возвращается тот же no_git.
    }

    if (!trees.length) {
      reply.code(404).send({
        error: 'no_git',
        message: `${repo.dir}: не git-репозиторий или недоступен`,
      });

      return null;
    }

    const want = String(req.query.root || '') || trees[0]?.path;
    const tree = trees.find((t) => t.path === want);

    if (!tree) {
      reply.code(400).send({
        error: 'bad_root',
        message: 'root не является деревом этого репозитория',
      });

      return null;
    }

    return {
      repo,
      tree,
    };
  }

  /**
   * Абсолютный путь внутри дерева: нормализация + запрет выхода за корень.
   */
  function inside(root: string, rel: unknown, reply: FastifyReply): string | null {
    const abs = path.resolve(root, String(rel || ''));

    if (abs !== root && !abs.startsWith(root + path.sep)) {
      reply.code(400).send({ error: 'bad_path' });

      return null;
    }

    return abs;
  }

  /**
   * Возвращает безопасный текст Git-ошибки без credential userinfo из remote URL.
   * Полная команда из `Error.message` используется лишь когда stderr отсутствует.
   */
  function gitErrorMessage(error: unknown): string {
    const detail = isRecord(error) ? error : {};
    const source = String(detail.stderr || detail.stdout || detail.message || 'Git отклонил действие.');
    const redacted = source.replace(
      /([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/giu,
      '$1',
    );

    return redacted.trim().slice(-2_000) || 'Git отклонил действие.';
  }

  /**
   * Сохраняет код ожидаемого отказа Git и скрывает credentials в неизвестной ошибке.
   * Сбой процесса логируется, но не меняет протокол HTTP-ошибки действия.
   */
  function sendGitError(reply: FastifyReply, error: unknown): FastifyReply {
    const known = error instanceof CodeGitError;
    const status = known ? error.status : 409;
    const code = known ? error.code : 'git_failed';
    const message = known ? error.message : gitErrorMessage(error);

    if (!known) {
      fastify.log.warn({ err: error }, 'плагин «Код»: Git-действие не выполнено');
    }

    return reply.code(status).send({
      error: code,
      message,
    });
  }

  /**
   * Сериализует мутации одного worktree. Два окна могут нажать commit/stage одновременно,
   * но индекс должен меняться в определённом порядке, а не через случайный index.lock.
   */
  async function mutateRoot<Result>(
    ctx: RootContext,
    reply: FastifyReply,
    action: (root: string) => Promise<Result>,
  ): Promise<Result | FastifyReply> {
    const root = ctx.tree.path;

    if (mutatingRoots.has(root)) {
      return reply.code(409).send({
        error: 'git_busy',
        message: 'В этой рабочей копии уже выполняется другое Git-действие.',
      });
    }

    mutatingRoots.add(root);

    try {
      return await action(root);
    } catch (error) {
      return sendGitError(reply, error);
    } finally {
      mutatingRoots.delete(root);
    }
  }

  // Карта «абсолютный корень дерева → проект/репозиторий» по всем проектам.
  // Нужна мосту из чата: клиент по ней превращает файловую ссылку из ответа агента
  // в открытие этого файла панелью «Код». Ссылка — навигация, а не доступ: чтение
  // всё равно идёт обычными ls/file/raw с их проверками.
  fastify.get('/api/code/roots', async (req, reply) => {
    if (gate(reply)) {
      return reply;
    }

    const ids = await readProjectIds(config, prefs);
    const roots: CodeRoot[] = [];

    await Promise.all(ids.map(async (id) => {
      const repos = await readProjectRepos(config, prefs, id);

      await Promise.all(repos.map(async (repo) => {
        const trees = await worktrees(repo.dir).catch(() => []);

        for (const tree of trees) {
          roots.push({
            project: id,
            repo: repo.key,
            root: tree.path,
            main: tree.main,
            branch: tree.branch,
          });
        }
      }));
    }));

    return { roots } satisfies CodeRootsResponse;
  });

  // Репозитории проекта с их деревьями — для селекторов плагина.
  fastify.get<CodeRoute>('/api/code/:project/repos', async (req, reply) => {
    if (gate(reply)) {
      return reply;
    }

    const id = String(req.params.project);

    if (!PROFILE_RE.test(id)) {
      return reply.code(400).send({ error: 'bad_project' });
    }

    const repos = await readProjectRepos(config, prefs, id);

    return {
      repos: await Promise.all(repos.map(async (r) => ({
        key: r.key,
        dir: r.dir,
        from: r.from,
        trees: await worktrees(r.dir).catch(() => []),
      }))),
    } satisfies CodeReposResponse;
  });

  // Содержимое каталога — дерево ленивое, каталог читается при раскрытии.
  fastify.get<CodeRoute>('/api/code/:project/ls', async (req, reply) => {
    if (gate(reply)) {
      return reply;
    }

    const ctx = await resolveRoot(req, reply);

    if (!ctx) {
      return reply;
    }

    const abs = inside(ctx.tree.path, req.query.dir, reply);

    if (!abs) {
      return reply;
    }

    if (isHiddenPath(abs, hidden)) {
      return reply.code(404).send({
        error: 'no_dir',
        message: 'служебный каталог закрыт для просмотра',
      });
    }

    let entries: Dirent[] = [];

    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch (error) {
      return reply.code(404).send({
        error: 'no_dir',
        message: errorMessage(error),
      });
    }

    return {
      entries: entries
        .filter((e) => !isHiddenPath(path.join(abs, e.name), hidden))
        .map((e) => ({
          name: e.name,
          dir: e.isDirectory(),
        }))
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : (a.dir ? -1 : 1))),
    } satisfies CodeDirectoryResponse;
  });

  // Файл для read-only просмотра.
  fastify.get<CodeRoute>('/api/code/:project/file', async (req, reply) => {
    if (gate(reply)) {
      return reply;
    }

    const ctx = await resolveRoot(req, reply);

    if (!ctx) {
      return reply;
    }

    const abs = inside(ctx.tree.path, req.query.path, reply);

    if (!abs) {
      return reply;
    }

    if (isHiddenPath(abs, hidden)) {
      return reply.code(404).send({
        error: 'no_file',
        message: 'служебный каталог закрыт для просмотра',
      });
    }

    let buf: Buffer;

    try {
      buf = await fs.readFile(abs);
    } catch (error) {
      return reply.code(404).send({
        error: 'no_file',
        message: errorMessage(error),
      });
    }

    const binary = buf.subarray(0, 8000).includes(0);
    const tooBig = buf.length > MAX_BYTES;

    return {
      size: buf.length,
      binary,
      tooBig,
      content: binary || tooBig ? '' : buf.toString('utf8'),
    } satisfies CodeFileResponse;
  });

  // Сырые байты растровой картинки — предпросмотр в панели вместо пустого Monaco.
  fastify.get<CodeRoute>('/api/code/:project/raw', async (req, reply) => {
    if (gate(reply)) {
      return reply;
    }

    const ctx = await resolveRoot(req, reply);

    if (!ctx) {
      return reply;
    }

    const abs = inside(ctx.tree.path, req.query.path, reply);

    if (!abs) {
      return reply;
    }

    if (isHiddenPath(abs, hidden)) {
      return reply.code(404).send({
        error: 'no_file',
        message: 'служебный каталог закрыт для просмотра',
      });
    }

    const type = RAW_IMAGE_TYPES.get(path.extname(abs).slice(1).toLowerCase());

    if (!type) {
      return reply.code(415).send({
        error: 'not_image',
        message: 'raw отдаёт только растровые изображения',
      });
    }

    let buf: Buffer;

    try {
      buf = await fs.readFile(abs);
    } catch (error) {
      return reply.code(404).send({
        error: 'no_file',
        message: errorMessage(error),
      });
    }

    if (buf.length > RAW_MAX_BYTES) {
      return reply.code(413).send({
        error: 'too_big',
        message: `файл ${buf.length} байт — больше потолка ${RAW_MAX_BYTES}`,
      });
    }

    return reply
      .header('Content-Type', type)
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(buf);
  });

  // Гит выбранного дерева: ветка + изменения ДВУМЯ группами (индекс против HEAD и
  // рабочее дерево против индекса, как Source Control в VS Code) + свежие коммиты.
  // Приёмка задач считает своё «поверх HEAD» отдельной функцией: там индекс не при чём.
  fastify.get<CodeRoute>('/api/code/:project/git', async (req, reply) => {
    if (gate(reply)) {
      return reply;
    }

    const ctx = await resolveRoot(req, reply);

    if (!ctx) {
      return reply;
    }

    const [diff, tracking] = await Promise.all([
      worktreeChanges(ctx.tree.path),
      gitTrackingStatus(ctx.tree.path),
    ]);
    let log: CodeGitLogEntry[] = [];

    try {
      const { stdout } = await exec(
        'git',
        ['-C', ctx.tree.path, 'log', '-15', '--pretty=%h\t%s\t%cr'],
        { maxBuffer: 1024 * 1024 },
      );

      log = stdout.split('\n').filter(Boolean).map((l) => {
        const [hash = '', subject = '', when = ''] = l.split('\t');

        return {
          hash,
          subject,
          when,
        };
      });
    } catch {
      // Репозиторий без коммитов отдаёт пустую историю.
    }

    return {
      ...diff,
      tracking,
      log,
    } satisfies CodeGitResponse;
  });

  // `+` у файла или группы: рабочее дерево → индекс.
  fastify.post<CodeRoute>('/api/code/:project/stage', async (req, reply) => {
    if (gate(reply)) {
      return reply;
    }

    const ctx = await resolveRoot(req, reply);

    if (!ctx) {
      return reply;
    }


    return mutateRoot(ctx, reply, (root) => stageWorktreeChanges(root, {
      all: requestBody(req).all === true,
      paths: requestBody(req).paths,
    }));
  });

  // `−` у файла или группы: индекс → рабочее дерево, сами файлы не меняются.
  fastify.post<CodeRoute>('/api/code/:project/unstage', async (req, reply) => {
    if (gate(reply)) {
      return reply;
    }

    const ctx = await resolveRoot(req, reply);

    if (!ctx) {
      return reply;
    }


    return mutateRoot(ctx, reply, (root) => unstageWorktreeChanges(root, {
      all: requestBody(req).all === true,
      paths: requestBody(req).paths,
    }));
  });

  // Коммит берёт только индекс: неявного `git add` здесь нет.
  fastify.post<CodeRoute>('/api/code/:project/commit', async (req, reply) => {
    if (gate(reply)) {
      return reply;
    }

    const ctx = await resolveRoot(req, reply);

    if (!ctx) {
      return reply;
    }


    return mutateRoot(ctx, reply, (root) => commitStagedChanges(
      root,
      requestBody(req).message,
    ));
  });

  // Push текущей ветки; ветка без upstream публикуется и закрепляется за remote.
  fastify.post<CodeRoute>('/api/code/:project/push', async (req, reply) => {
    if (gate(reply)) {
      return reply;
    }

    const ctx = await resolveRoot(req, reply);

    if (!ctx) {
      return reply;
    }


    return mutateRoot(ctx, reply, (root) => pushCurrentBranch(root));
  });

  // Модель читает только staged diff через model-only transport без инструментов.
  fastify.post<CodeRoute>('/api/code/:project/commit-message', async (req, reply) => {
    if (gate(reply)) {
      return reply;
    }

    const ctx = await resolveRoot(req, reply);

    if (!ctx) {
      return reply;
    }


    const settings = fastify.pluginSettings?.('code');
    const setting = isRecord(settings) ? settings.commitMessageModel ?? null : null;
    const preferences = prefs.read();
    let result: Awaited<ReturnType<typeof generateCommitTitle>>;

    try {
      result = await generateCommitTitle({
        cwd: ctx.tree.path,
        modelRef: setting,
        config,
        providerSettings: isRecord(preferences) ? preferences.providerSettings || {} : {},
        log: fastify.log,
        ...(resolveCommitTarget ? { resolveTarget: resolveCommitTarget } : {}),
      });
    } catch (error) {
      return sendGitError(reply, error);
    }

    if (result.ok) {
      return result;
    }

    const messages: Record<string, string> = {
      no_model: 'Выбери модель: «Настройки → Плагины → Код».',
      invalid_model_ref: 'Настройка модели сообщения коммита повреждена — выбери её заново.',
      unknown_provider: 'Выбранный исполнитель больше не доступен — выбери модель заново.',
      unknown_model: 'Выбранной модели больше нет в реестре — выбери модель заново.',
      registry_failed: 'Не удалось прочитать реестр моделей.',
      executor_unavailable: 'Выбранный исполнитель сейчас недоступен.',
      unsafe_model_provider: 'Выбранная модель не поддерживает безопасное чтение diff. '
        + 'Выбери совместимую модель в «Настройки → Плагины → Код».',
      run_failed: 'Модель не смогла составить сообщение коммита.',
      bad_model_reply: 'Модель вернула ответ не в ожидаемом формате. Повтори генерацию.',
    };
    const upstreamFailure = ['run_failed', 'bad_model_reply', 'registry_failed']
      .includes(result.error);

    return reply.code(upstreamFailure ? 502 : 409).send({
      error: result.error,
      message: messages[result.error] || 'Не удалось составить сообщение коммита.',
    });
  });
};

export default fp(codeModule, { name: 'module-code' });
