// Модуль code — плагин «Код»: просмотр кода и гита проектов, только чтение.
// Дерево файлов и содержимое отдаются по любому ДЕРЕВУ репозитория: основному или
// worktree (их создаёт фабрика под задачи и слоты) — выбор дерева на клиенте.
// Несохранённые изменения считает тот же lib/git.js, что и диф приёмки задач,
// рисует их тот же Monaco на клиенте.
//
// Доступ: корень обязан быть деревом из `git worktree list` репозитория проекта,
// путь внутри — префикс-проверкой. Это дисциплина, а не песочница: кокпит и так
// отдаёт полный шелл в «Терминале», но файловому API за auth-гардом она положена.
import fp from 'fastify-plugin';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PROFILE_RE } from '../../lib/profiles.js';
import { projectRepos } from '../../lib/projects.js';
import { taskDiff } from '../../lib/git.js';

const exec = promisify(execFile);
const MAX_BYTES = 1_500_000; // как в lib/git.js: гигантские блобы в браузер не тащим

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
function hiddenDirs(config) {
  return [config.chatsDir, config.telegramDir, config.githubDir]
    .filter(Boolean)
    .map((d) => path.resolve(d));
}

/** Закрыт ли путь: по сегменту в любом месте дерева либо по каталогу кокпита. */
export function isHiddenPath(abs, dirs = []) {
  const p = path.resolve(abs);
  if (p.split(path.sep).some((seg) => HIDDEN_SEGMENTS.has(seg))) return true;
  return dirs.some((dir) => p === dir || p.startsWith(dir + path.sep));
}

/** Деревья репозитория: основное + worktree. Первым git всегда отдаёт основное. */
async function worktrees(dir) {
  const { stdout } = await exec('git', ['-C', dir, 'worktree', 'list', '--porcelain'], { maxBuffer: 4 * 1024 * 1024 });
  const out = [];
  let cur = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), branch: '' }; out.push(cur); }
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (cur && line === 'detached') cur.branch = '(detached)';
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

async function codeModule(fastify, opts) {
  const { config, prefs } = opts;
  const hidden = hiddenDirs(config);

  // Живой гейт (как у video): тумблер в настройках действует без рестарта.
  const gate = (reply) => (fastify.pluginEnabled('code') ? null
    : reply.code(403).send({ error: 'plugin_disabled', message: 'Плагин «Код» выключен — «Настройки → Плагины»' }));

  /** Репозиторий проекта по метке + проверка, что root — одно из его деревьев. */
  async function resolveRoot(req, reply) {
    const id = String(req.params.project);
    if (!PROFILE_RE.test(id)) { reply.code(400).send({ error: 'bad_project' }); return null; }
    const repos = await projectRepos({ config, prefs, id });
    const repo = repos.find((r) => r.key === String(req.query.repo || ''));
    if (!repo) { reply.code(404).send({ error: 'no_repo', message: 'у проекта нет такого репозитория' }); return null; }
    let trees = [];
    try { trees = await worktrees(repo.dir); } catch { /* не git или недоступен */ }
    if (!trees.length) { reply.code(404).send({ error: 'no_git', message: `${repo.dir}: не git-репозиторий или недоступен` }); return null; }
    const want = String(req.query.root || '') || trees[0].path;
    const tree = trees.find((t) => t.path === want);
    if (!tree) { reply.code(400).send({ error: 'bad_root', message: 'root не является деревом этого репозитория' }); return null; }
    return { repo, tree };
  }

  /** Абсолютный путь внутри дерева: нормализация + запрет выхода за корень. */
  function inside(root, rel, reply) {
    const abs = path.resolve(root, String(rel || ''));
    if (abs !== root && !abs.startsWith(root + path.sep)) { reply.code(400).send({ error: 'bad_path' }); return null; }
    return abs;
  }

  // Репозитории проекта с их деревьями — для селекторов плагина.
  fastify.get('/api/code/:project/repos', async (req, reply) => {
    if (gate(reply)) return reply;
    const id = String(req.params.project);
    if (!PROFILE_RE.test(id)) return reply.code(400).send({ error: 'bad_project' });
    const repos = await projectRepos({ config, prefs, id });
    return {
      repos: await Promise.all(repos.map(async (r) => ({
        key: r.key,
        dir: r.dir,
        from: r.from,
        trees: await worktrees(r.dir).catch(() => []),
      }))),
    };
  });

  // Содержимое каталога — дерево ленивое, каталог читается при раскрытии.
  fastify.get('/api/code/:project/ls', async (req, reply) => {
    if (gate(reply)) return reply;
    const ctx = await resolveRoot(req, reply);
    if (!ctx) return reply;
    const abs = inside(ctx.tree.path, req.query.dir, reply);
    if (!abs) return reply;
    if (isHiddenPath(abs, hidden)) {
      return reply.code(404).send({ error: 'no_dir', message: 'служебный каталог закрыт для просмотра' });
    }
    let entries = [];
    try { entries = await fs.readdir(abs, { withFileTypes: true }); }
    catch (e) { return reply.code(404).send({ error: 'no_dir', message: e.message }); }
    return {
      entries: entries
        .filter((e) => !isHiddenPath(path.join(abs, e.name), hidden))
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : (a.dir ? -1 : 1))),
    };
  });

  // Файл для read-only просмотра.
  fastify.get('/api/code/:project/file', async (req, reply) => {
    if (gate(reply)) return reply;
    const ctx = await resolveRoot(req, reply);
    if (!ctx) return reply;
    const abs = inside(ctx.tree.path, req.query.path, reply);
    if (!abs) return reply;
    if (isHiddenPath(abs, hidden)) {
      return reply.code(404).send({ error: 'no_file', message: 'служебный каталог закрыт для просмотра' });
    }
    let buf;
    try { buf = await fs.readFile(abs); }
    catch (e) { return reply.code(404).send({ error: 'no_file', message: e.message }); }
    const binary = buf.subarray(0, 8000).includes(0);
    const tooBig = buf.length > MAX_BYTES;
    return { size: buf.length, binary, tooBig, content: binary || tooBig ? '' : buf.toString('utf8') };
  });

  // Гит выбранного дерева: ветка + несохранённые изменения (формат дифа задачи) + свежие коммиты.
  fastify.get('/api/code/:project/git', async (req, reply) => {
    if (gate(reply)) return reply;
    const ctx = await resolveRoot(req, reply);
    if (!ctx) return reply;
    const diff = await taskDiff(ctx.tree.path);
    let log = [];
    try {
      const { stdout } = await exec('git', ['-C', ctx.tree.path, 'log', '-15', '--pretty=%h\t%s\t%cr'], { maxBuffer: 1024 * 1024 });
      log = stdout.split('\n').filter(Boolean).map((l) => {
        const [hash, subject, when] = l.split('\t');
        return { hash, subject, when };
      });
    } catch { /* репозиторий без коммитов */ }
    return { ...diff, log };
  });
}

export default fp(codeModule, { name: 'module-code' });
