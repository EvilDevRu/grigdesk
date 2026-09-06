import { isLocalRequest, isSecureRequest } from '../../plugins/auth.js';

function operation(service, name, fallback) {
  return typeof service?.[name] === 'function' ? service[name].bind(service) : async () => fallback;
}

function sendError(reply, error) {
  const code = error?.code || error?.error || 'db_error';
  const status = {
    not_found: 404,
    session_not_found: 404,
    origin_mismatch: 409,
    already_resolved: 409,
    duplicate_selector: 409,
    invalid_profile: 400,
    project_not_found: 400,
    secure_connect_required: 403,
  }[code] || 500;
  return reply.code(status).send({ error: code, ...(error?.message ? { message: error.message } : {}) });
}

/** Session-only HTTP API живо проверяет плагин до каждой операции. */
export default async function dbModule(fastify, { service } = {}) {
  if (!fastify.hasContentTypeParser('application/octet-stream')) {
    fastify.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: 16 * 1_024 },
      (_request, body, done) => done(null, body),
    );
  }
  fastify.addHook('onRequest', async (request, reply) => {
    if (!fastify.pluginEnabled('db')) return reply.code(404).send({ error: 'plugin_disabled' });
    if (request.authKind !== 'session') return reply.code(403).send({ error: 'session_required' });
  });

  const call = (name, fallback) => operation(service, name, fallback);
  fastify.get('/api/db/engines', async () => ({ engines: await call('listEngines', [])() }));
  fastify.get('/api/db/profiles', async () => ({ profiles: await call('listProfiles', [])() }));
  fastify.post('/api/db/profiles', async (request, reply) => {
    try { return await call('createProfile', null)(request.body || {}); } catch (error) {
      return sendError(reply, error);
    }
  });
  fastify.put('/api/db/profiles/:id', async (request, reply) => {
    try { return await call('updateProfile', null)(String(request.params.id), request.body || {}); }
    catch (error) { return sendError(reply, error); }
  });
  fastify.delete('/api/db/profiles/:id', async (request, reply) => {
    try { return { ok: await call('deleteProfile', false)(String(request.params.id)) }; }
    catch (error) { return sendError(reply, error); }
  });
  fastify.post('/api/db/profiles/:id/sessions', async (request, reply) => {
    if (!isLocalRequest(request) && !isSecureRequest(request)) {
      return reply.code(403).send({ error: 'secure_connect_required' });
    }
    const password = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body || '');
    try {
      return await call('openSession', null)(
        String(request.params.id),
        password,
        String(request.headers['x-cockpit-ssh-session-id'] || ''),
      );
    } catch (error) {
      return sendError(reply, error);
    } finally {
      password.fill(0);
    }
  });
  fastify.get('/api/db/sessions', async () => ({ sessions: await call('listSessions', [])() }));
  fastify.put('/api/db/sessions/:sid/agent-access', async (request, reply) => {
    try {
      return await call('setAgentAccess', null)(
        String(request.params.sid), request.body?.allowed === true,
      );
    } catch (error) { return sendError(reply, error); }
  });
  fastify.delete('/api/db/sessions/:sid', async (request, reply) => {
    try { return { ok: await call('closeSession', false)(String(request.params.sid)) }; }
    catch (error) { return sendError(reply, error); }
  });
  fastify.get('/api/db/sessions/:sid/schema', async (request, reply) => {
    try { return await call('schema', null)(String(request.params.sid)); }
    catch (error) { return sendError(reply, error); }
  });
  fastify.post('/api/db/sessions/:sid/query', async (request, reply) => {
    try {
      const result = await call('query', null)(String(request.params.sid), request.body || {});
      return reply.code(202).send(result);
    } catch (error) { return sendError(reply, error); }
  });
  fastify.get('/api/db/queries', async () => ({ queries: await call('listQueries', [])() }));
  fastify.get('/api/db/queries/:qid', async (request, reply) => {
    try { return await call('getQuery', null)(String(request.params.qid)); }
    catch (error) { return sendError(reply, error); }
  });
  fastify.post('/api/db/queries/:qid/cancel', async (request, reply) => {
    try { return await call('cancelQuery', null)(String(request.params.qid)); }
    catch (error) { return sendError(reply, error); }
  });
  fastify.get('/api/db/audit', async (request) => call('listAudit', { items: [] })(request.query));
  fastify.post('/api/db/approvals/:pid', async (request, reply) => {
    try {
      const result = await call('answerApproval', { ok: false, error: 'not_found' })(
        String(request.params.pid), { allow: request.body?.allow === true },
      );
      return result?.ok === false ? sendError(reply, result) : result;
    } catch (error) { return sendError(reply, error); }
  });
}
