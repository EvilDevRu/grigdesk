// Модуль demo — серверная часть плагина «Демо фичи»: съёмка демо-видео готовой
// задачи с её живого стенда ПО КНОПКЕ (вне конвейера — демо убрано из цепочки
// фабрики решением человека 2026-07-27) + галерея готовых роликов.
// Запуск: factory <task> demo — одиночный прогон DEMO-агента в своём transient
// scope (тот же паттерн, что запуск конвейера: жизнь кокпита агента не касается).
import fp from 'fastify-plugin';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { PROFILE_RE } from '../../lib/profiles.js';

export async function profileHasCapability(profilesDir, profile, capability) {
  if (!PROFILE_RE.test(String(profile || '')) || !/^[a-z][a-z0-9_-]*$/.test(capability)) {
    return false;
  }
  try {
    const graph = JSON.parse(await fs.readFile(path.join(profilesDir, profile, 'graph.json'), 'utf8'));
    return Array.isArray(graph.capabilities) && graph.capabilities.includes(capability);
  } catch {
    return false;
  }
}

async function demoModule(fastify, opts) {
  const { config, factoryState } = opts;
  const demoDir = path.join(config.stateDir, 'demo');

  // Гейт плагина: выключен — раздела нет (404, как у несуществующего API).
  function gate(reply) {
    if (fastify.pluginEnabled('demo')) return null;
    return reply.code(404).send({ error: 'plugin_disabled', message: 'Плагин «Демо» выключен.' });
  }

  // Обзор: задачи фабрики (стенд/статус DEMO) + готовые ролики из STATE_DIR/demo.
  fastify.get('/api/demo/overview', async (request, reply) => {
    if (gate(reply)) return reply;
    const tasks = [];
    for (const t of await factoryState.listTasks()) {
      const profile = t.profile || t.registry?.PROFILE || '';
      if (!(await profileHasCapability(config.profilesDir, profile, 'demo'))) continue;
      let env = {};
      try { env = await factoryState.readEnv(t.task); } catch { /* стенд не поднимался */ }
      tasks.push({
        task: t.task,
        profile,
        demo: t.registry?.DEMO || 'pending',
        demoAt: t.registry?.DEMO_AT || null,
        shipDone: t.registry?.SHIP === 'done',
        fePort: env.FE_PORT || null,
        sandboxAlive: !!env.FE_PORT,
      });
    }
    const videos = [];
    try {
      for (const f of await fs.readdir(demoDir)) {
        if (!/\.(mp4|webm)$/i.test(f)) continue;
        const st = await fs.stat(path.join(demoDir, f));
        videos.push({ file: f, url: `/demo/${f}`, size: st.size, mtime: st.mtimeMs });
      }
      videos.sort((a, b) => b.mtime - a.mtime);
    } catch { /* роликов ещё нет */ }
    return { tasks, videos };
  });

  // Запуск съёмки: одиночный демо-агент фабрики. Исход виден по DEMO в реестре
  // (running → done|failed) — фронт поллит обзор.
  fastify.post('/api/demo/:id/run', async (request, reply) => {
    if (gate(reply)) return reply;
    const match = /^(?:t)?([1-9][0-9]*)$/.exec(String(request.params.id));
    if (!match) return reply.code(400).send({ error: 'bad_task_id' });
    const id = match[1];
    let reg = null;
    try { reg = (await factoryState.readRegistry(id)).registry; } catch { /* нет реестра */ }
    if (!reg) return reply.code(404).send({ error: 'no_registry', message: 'задача не проходила конвейер — демо снимать не с чего' });
    if (reg.DEMO === 'running') return { outcome: 'already_running' };
    if (!(await profileHasCapability(config.profilesDir, reg.PROFILE, 'demo'))) {
      return reply.code(409).send({
        error: 'demo_unsupported',
        message: `Профиль «${reg.PROFILE || 'неизвестный'}» не поддерживает этап DEMO.`,
      });
    }

    const launchLog = path.join(config.stateDir, `t${id}.launch.log`);
    const out = await fs.open(launchLog, 'a');
    const haveScope = await new Promise((res) => execFile('systemd-run', ['--version'], (err) => res(!err)));
    const args = [id, 'demo', '--profile', reg.PROFILE || ''];
    const launchEnv = {
      FACTORY_PROFILES_DIR: config.profilesDir,
      FACTORY_STATE: config.stateDir,
      STATE_DIR: config.stateDir,
    };
    const scopeEnv = Object.entries(launchEnv).map(([k, v]) => `--setenv=${k}=${v}`);
    const [bin, argv] = haveScope
      ? ['systemd-run', ['--user', '--scope', '--quiet', '--collect', ...scopeEnv, `--unit=factory-demo-t${id}`, config.factoryBin, ...args]]
      : [config.factoryBin, args];
    const child = spawn(bin, argv, {
      detached: true,
      stdio: ['ignore', out.fd, out.fd],
      env: { ...process.env, ...launchEnv },
    });
    child.unref();
    await out.close();
    return { outcome: 'launched' };
  });
}

export default fp(demoModule, { name: 'module-demo' });
