// Модуль chat — интерактивное обсуждение с агентом (Claude) прямо из кокпита.
// Два режима:
//   • по задаче  — `claude -p` в worktree задачи (агент видит код, контекст через --resume);
//   • без задачи — свободный вопрос, `claude -p` в корне фабрики.
// permission-mode plan = обсуждение/чтение без правок (правки — отдельным действием).
import fp from 'fastify-plugin';
import { execFile } from 'node:child_process';

async function chatModule(fastify, opts) {
  const { factoryState, config, claudeAuth } = opts;

  /**
   * Единый запуск claude -p. cwd/доп-директории зависят от наличия задачи.
   * Возвращает { reply, sessionId, cost, contextTokens } или reply-ошибку.
   */
  async function runChat(reply, { id, message, model, effort, sessionId }) {
    let cwd = config.factoryHome;
    const extraDirs = [];
    if (id) {
      const env = await factoryState.readEnv(id);
      if (env.BE_WT) cwd = env.BE_WT;
      if (env.FE_WT) extraDirs.push(env.FE_WT);
    }
    const args = ['-p', message, '--output-format', 'json', '--permission-mode', 'plan'];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (sessionId) args.push('--resume', sessionId);
    for (const d of extraDirs) args.push('--add-dir', d);

    const env = claudeAuth ? claudeAuth.env() : process.env;
    return new Promise((resolve) => {
      execFile(config.claudeBin, args, { cwd, env, timeout: 300000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && !stdout) {
          return resolve(reply.code(500).send({ error: 'chat_failed', message: (stderr || err.message).slice(-600) }));
        }
        try {
          const j = JSON.parse(stdout);
          const u = j.usage || {};
          // Размер контекста = все входные токены последнего запроса (обычные + кэш).
          const contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          resolve({
            reply: j.result || '',
            sessionId: j.session_id || sessionId || null,
            cost: j.total_cost_usd ?? null,
            contextTokens,
            model: model || null,
          });
        } catch {
          resolve(reply.code(500).send({ error: 'parse_failed', message: 'не разобрать ответ claude', raw: (stdout || '').slice(0, 400) }));
        }
      });
    });
  }

  // Чат по задаче (worktree задачи).
  fastify.post('/api/tasks/:id/chat', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    const { message, model, effort, sessionId } = request.body || {};
    if (!message || !message.trim()) return reply.code(400).send({ error: 'empty_message' });
    return runChat(reply, { id, message, model, effort, sessionId });
  });

  // Свободный чат без задачи (корень фабрики).
  fastify.post('/api/chat', async (request, reply) => {
    const { message, model, effort, sessionId } = request.body || {};
    if (!message || !message.trim()) return reply.code(400).send({ error: 'empty_message' });
    return runChat(reply, { id: null, message, model, effort, sessionId });
  });
}

export default fp(chatModule, { name: 'module-chat' });
