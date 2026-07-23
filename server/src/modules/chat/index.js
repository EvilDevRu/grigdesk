// Модуль chat — интерактивное обсуждение задачи с агентом (Claude) прямо из кокпита.
// Гоняет `claude -p` в worktree задачи: агент видит код, контекст держится через --resume.
// permission-mode plan = обсуждение/чтение без правок (правки — отдельным действием).
import fp from 'fastify-plugin';
import { execFile } from 'node:child_process';

async function chatModule(fastify, opts) {
  const { factoryState, config } = opts;

  fastify.post('/api/tasks/:id/chat', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    const { message, model, effort, sessionId } = request.body || {};
    if (!message || !message.trim()) return reply.code(400).send({ error: 'empty_message' });

    const env = await factoryState.readEnv(id);
    const cwd = env.BE_WT || config.factoryHome;
    const args = ['-p', message, '--output-format', 'json', '--permission-mode', 'plan'];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (sessionId) args.push('--resume', sessionId);
    if (env.FE_WT) args.push('--add-dir', env.FE_WT);

    return new Promise((resolve) => {
      execFile(config.claudeBin, args, { cwd, timeout: 300000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && !stdout) {
          return resolve(reply.code(500).send({ error: 'chat_failed', message: (stderr || err.message).slice(-600) }));
        }
        try {
          const j = JSON.parse(stdout);
          resolve({
            reply: j.result || '',
            sessionId: j.session_id || sessionId || null,
            cost: j.total_cost_usd ?? null,
            model: model || null,
          });
        } catch {
          resolve(reply.code(500).send({ error: 'parse_failed', message: 'не разобрать ответ claude', raw: (stdout || '').slice(0, 400) }));
        }
      });
    });
  });
}

export default fp(chatModule, { name: 'module-chat' });
