// Модуль projects — раздел «Проекты»: реестр проектов и пути их репозиториев на диске.
// Сам список проектов и их схемы уже живут в базе маршрутов (modules/routes); здесь —
// только «паспорт»: где лежит код. Для проектов фабрики пути читаются из bash-профиля
// (единственный источник правды), для кокпитных — редактируются здесь и живут в prefs.
import fp from 'fastify-plugin';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { PROFILE_RE, listFactoryProfiles, listProjects } from '../../lib/profiles.js';
import {
  normalizeGitHubSlug,
  normalizeReviewBinding,
  projectRepos,
  projectsOverview,
  reviewBindingConflict,
} from '../../lib/projects.js';
import { parseReviewVerifyCommand } from '../../lib/reviews/service.js';

// Метка репозитория («be», «fe»…) — тот же формат, что префиксы PROFILE_TRIAGE_REPOS.
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,15}$/;
const exec = promisify(execFile);

async function projectsModule(fastify, opts) {
  const { config, prefs, reviews = null } = opts;
  const mutateRepositoryConfiguration = async (projectId, repoKeys, mutation) => {
    if (reviews?.mutateRepositoryConfiguration) {
      return reviews.mutateRepositoryConfiguration(projectId, repoKeys, mutation);
    }
    const keys = repoKeys == null
      ? [
        ...new Set([
          ...(((prefs.read().projects || {})[projectId]?.repos || []).map((repo) => repo.key)),
          ...Object.keys((prefs.read().projects || {})[projectId]?.review?.repositories || {}),
        ]),
      ]
      : repoKeys;
    for (const key of keys) {
      await reviews?.assertRepositoryMutable?.(projectId, key);
    }
    return mutation();
  };

  fastify.get('/api/projects', async () => {
    const projects = await projectsOverview({ config, prefs });
    if (!reviews?.projectStatus) return { projects };
    let statuses = [];
    let reviewStatusError = null;
    try {
      statuses = await reviews.projectStatus();
    } catch (error) {
      fastify.log?.warn?.({
        code: error?.code,
        err: error?.message,
      }, 'Не удалось прочитать состояние review subsystem');
      reviewStatusError = {
        code: 'REVIEW_STATUS_UNAVAILABLE',
        message: 'Состояние ревью временно недоступно',
      };
    }
    const byRepository = new Map(statuses.map((status) => [
      `${status.projectId}\u0000${status.repoKey}`,
      status,
    ]));
    return {
      projects: projects.map((project) => ({
        ...project,
        repos: project.repos.map((repo) => ({
          ...repo,
          reviewStatus: byRepository.get(`${project.id}\u0000${repo.key}`) || null,
          ...(reviewStatusError && { reviewStatusError }),
        })),
      })),
    };
  });

  // Пути репозиториев КОКПИТНОГО проекта. Фабричному с заданными в профиле путями
  // отказываем: второй источник правды разъедется с профилем — правится профиль.
  fastify.put('/api/projects/:id', async (req, reply) => {
    const id = String(req.params.id);
    if (!PROFILE_RE.test(id)) return reply.code(400).send({ error: 'bad_id' });
    if (!(await listProjects(config)).includes(id)) return reply.code(404).send({ error: 'not_found' });
    if ((await listFactoryProfiles(config.profilesDir)).includes(id)) {
      const { loadTriageProfile } = await import('../../lib/analysis/profile.js');
      const { repos } = await loadTriageProfile(config, id);
      if (repos.length) {
        return reply.code(409).send({
          error: 'factory_project',
          message: 'Пути этого проекта задаёт профиль фабрики (PROFILE_TRIAGE_REPOS) — правь их там.',
        });
      }
    }
    const repos = [];
    for (const r of (Array.isArray(req.body?.repos) ? req.body.repos : [])) {
      const key = String(r?.key || '').trim();
      const dir = String(r?.dir || '').trim();
      if (!KEY_RE.test(key)) return reply.code(400).send({ error: 'bad_key', message: `метка «${key}»: строчные латиница/цифры/-/_` });
      if (!path.isAbsolute(dir)) return reply.code(400).send({ error: 'bad_dir', message: `путь «${dir}» должен быть абсолютным` });
      if (repos.some((x) => x.key === key)) return reply.code(400).send({ error: 'dup_key', message: `метка «${key}» повторяется` });
      // Несуществующий путь не отклоняем: репозиторий мог ещё не клонироваться —
      // раздел честно покажет красную точку «нет на диске».
      repos.push({ key, dir: path.normalize(dir) });
    }
    try {
      await mutateRepositoryConfiguration(id, null, () => {
        const p = prefs.read();
        const current = (p.projects || {})[id] || {};
        prefs.write({ projects: { ...(p.projects || {}), [id]: { ...current, repos } } });
      });
    } catch (error) {
      return reply.code(409).send({
        error: error?.code || 'repository_run_active',
        message: String(error?.message || 'У репозитория есть активный review-запуск'),
      });
    }
    return { ok: true, repos };
  });

  /**
   * Подтверждение GitHub-привязки — отдельная настройка паспорта. Фабричные пути
   * остаются read-only, но review-настройки принадлежат Cockpit и сохраняются здесь.
   */
  fastify.put('/api/projects/:id/repositories/:key/github', async (req, reply) => {
    const id = String(req.params.id || '');
    const key = String(req.params.key || '');
    if (!PROFILE_RE.test(id) || !KEY_RE.test(key)) {
      return reply.code(400).send({ error: 'bad_id' });
    }
    if (!(await listProjects(config)).includes(id)) {
      return reply.code(404).send({ error: 'project_not_found' });
    }
    const repos = await projectRepos({ config, prefs, id });
    const repo = repos.find((item) => item.key === key);
    if (!repo) return reply.code(404).send({ error: 'repository_not_found' });

    const slug = normalizeGitHubSlug(req.body?.slug);
    if (!slug || req.body?.confirmed !== true) {
      return reply.code(400).send({
        error: 'confirmation_required',
        message: 'Укажи GitHub owner/repo и явно подтверди привязку.',
      });
    }
    const verifyCommands = [...new Set((Array.isArray(req.body?.verifyCommands)
      ? req.body.verifyCommands
      : [])
      .map((command) => String(command || '').trim())
      .filter(Boolean))]
      .slice(0, 20);
    try {
      verifyCommands.forEach((command, index) => parseReviewVerifyCommand(command, index));
    } catch (error) {
      return reply.code(400).send({
        error: error?.code || 'verify_command_invalid',
        message: String(error?.message || 'Некорректная команда проверки'),
      });
    }

    const overview = await projectsOverview({ config, prefs });
    const detectedSlug = overview.find((project) => project.id === id)
      ?.repos.find((item) => item.key === key)?.github?.detectedSlug || '';
    if (repo && !detectedSlug) {
      return reply.code(409).send({
        error: 'remote_unavailable',
        message: 'У локального репозитория нет доступного GitHub origin; привязка не сохранена.',
      });
    }
    if (detectedSlug && detectedSlug.toLowerCase() !== slug.toLowerCase()) {
      return reply.code(409).send({
        error: 'remote_mismatch',
        message: `git remote указывает на ${detectedSlug}, а подтверждается ${slug}`,
        detectedSlug,
      });
    }

    const p = prefs.read();
    const conflict = reviewBindingConflict(p.projects || {}, {
      projectId: id,
      repoKey: key,
      slug,
    });
    if (conflict) {
      return reply.code(409).send({
        error: 'duplicate_repository',
        message: `репозиторий уже привязан к ${conflict.projectId}:${conflict.repoKey}`,
        conflict,
      });
    }

    const binding = normalizeReviewBinding({
      slug,
      detectedSlug: detectedSlug || slug,
      confirmed: true,
      autoSync: req.body?.autoSync !== false,
      autoAnalyze: req.body?.autoAnalyze !== false,
      verifyCommands,
      verifyCoversCriteria: req.body?.verifyCoversCriteria === true,
    });
    try {
      await mutateRepositoryConfiguration(id, [key], () => {
        const fresh = prefs.read();
        const freshConflict = reviewBindingConflict(fresh.projects || {}, {
          projectId: id,
          repoKey: key,
          slug,
        });
        if (freshConflict) {
          const error = new Error(
            `репозиторий уже привязан к ${freshConflict.projectId}:${freshConflict.repoKey}`,
          );
          error.code = 'DUPLICATE_REPOSITORY';
          error.details = freshConflict;
          throw error;
        }
        const currentProject = (fresh.projects || {})[id] || {};
        const currentReview = currentProject.review || {};
        const currentRepositories = currentReview.repositories || {};
        prefs.write({
          projects: {
            ...(fresh.projects || {}),
            [id]: {
              ...currentProject,
              review: {
                ...currentReview,
                repositories: { ...currentRepositories, [key]: binding },
              },
            },
          },
        });
      });
    } catch (error) {
      if (error?.code === 'DUPLICATE_REPOSITORY') {
        return reply.code(409).send({
          error: 'duplicate_repository',
          message: error.message,
          conflict: error.details,
        });
      }
      return reply.code(409).send({
        error: error?.code || 'repository_run_active',
        message: String(error?.message || 'У репозитория есть активный review-запуск'),
      });
    }
    return { ok: true, binding };
  });

  fastify.delete('/api/projects/:id/repositories/:key/github', async (req, reply) => {
    const id = String(req.params.id || '');
    const key = String(req.params.key || '');
    if (!PROFILE_RE.test(id) || !KEY_RE.test(key)) {
      return reply.code(400).send({ error: 'bad_id' });
    }
    try {
      await mutateRepositoryConfiguration(id, [key], () => {
        const p = prefs.read();
        const currentProject = (p.projects || {})[id];
        if (!currentProject) {
          const error = new Error('Проект не найден');
          error.code = 'PROJECT_NOT_FOUND';
          throw error;
        }
        const repositories = { ...(currentProject.review?.repositories || {}) };
        delete repositories[key];
        prefs.write({
          projects: {
            ...(p.projects || {}),
            [id]: {
              ...currentProject,
              review: { ...(currentProject.review || {}), repositories },
            },
          },
        });
      });
    } catch (error) {
      if (error?.code === 'PROJECT_NOT_FOUND') {
        return reply.code(404).send({ error: 'project_not_found' });
      }
      return reply.code(409).send({
        error: error?.code || 'repository_run_active',
        message: String(error?.message || 'У репозитория есть активный review-запуск'),
      });
    }
    return { ok: true };
  });

  fastify.post('/api/projects/:id/repositories/:key/github/check', async (req, reply) => {
    const id = String(req.params.id || '');
    const key = String(req.params.key || '');
    const overview = await projectsOverview({ config, prefs });
    const repo = overview.find((project) => project.id === id)
      ?.repos.find((item) => item.key === key);
    if (!repo) return reply.code(404).send({ error: 'repository_not_found' });
    const slug = repo.github?.slug || repo.github?.detectedSlug;
    if (!slug) return reply.code(409).send({ error: 'github_not_configured' });
    try {
      const { stdout } = await exec('gh', ['api', `repos/${slug}`, '--jq', '.node_id'], {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        env: process.env,
      });
      return { ok: true, slug, repositoryId: stdout.trim() };
    } catch (error) {
      const detail = String(error?.stderr || error?.message || '').trim().slice(-400);
      return reply.code(502).send({
        error: 'github_unavailable',
        message: detail || 'GitHub CLI не подтвердил доступ',
      });
    }
  });
}

export default fp(projectsModule, { name: 'module-projects' });
