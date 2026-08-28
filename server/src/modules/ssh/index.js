import { isLocalRequest, isSecureRequest } from '../../plugins/auth.js';

function wrap(name, fallback) {
  return async (service, ...args) => {
    const operation = service?.[name];
    if (typeof operation !== 'function') {
      return fallback;
    }
    return operation.call(service, ...args);
  };
}

const call = {
  listConnections: wrap('listConnections', []),
  createConnection: wrap('createConnection', null),
  updateConnection: wrap('updateConnection', null),
  deleteConnection: wrap('deleteConnection', false),
  probeHostKey: wrap('probeHostKey', null),
  decideHostKey: wrap('decideHostKey', null),
  listSessions: wrap('listSessions', []),
  setAgentAccess: wrap('setAgentAccess', null),
  closeSession: wrap('closeSession', false),
  listFiles: wrap('listFiles', []),
  downloadFile: wrap('downloadFile', null),
  uploadFile: wrap('uploadFile', null),
  listAudit: wrap('listAudit', { items: [], nextCursor: null }),
  answerApproval: wrap('answerApproval', { ok: false, error: 'not_found' }),
};

function sendError(reply, error) {
  const code = error?.code || error?.error || 'ssh_error';
  const statuses = {
    not_found: 404,
    session_not_found: 404,
    challenge_not_found: 404,
    duplicate_selector: 409,
    trust_required: 409,
    origin_mismatch: 409,
    already_resolved: 409,
    invalid_connection: 400,
    invalid_decision: 400,
    project_not_found: 400,
  };
  return reply.code(statuses[code] || 500).send({
    error: code,
    ...(error?.message ? { message: error.message } : {}),
  });
}

/**
 * Human API проверяет живой флаг на каждом запросе, включая WebSocket upgrade.
 * Auth provenance дополнительно закрывает SFTP и пароль от internal/CLI каналов.
 */
async function sshModule(fastify, options = {}) {
  const { service } = options;

  if (!fastify.hasContentTypeParser('application/octet-stream')) {
    fastify.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: 16 * 1_024 },
      (_request, body, done) => done(null, body),
    );
  }

  fastify.addHook('onRequest', async (request, reply) => {
    if (!fastify.pluginEnabled('ssh')) {
      return reply.code(404).send({ error: 'plugin_disabled' });
    }
    if (request.authKind !== 'session') {
      return reply.code(403).send({ error: 'session_required' });
    }
  });

  fastify.get('/api/ssh/connections', async (_request, reply) => {
    try {
      const result = await call.listConnections(service);
      return Array.isArray(result) ? { connections: result } : result;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post('/api/ssh/connections', async (request, reply) => {
    try {
      return await call.createConnection(service, request.body || {});
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.put('/api/ssh/connections/:id', async (request, reply) => {
    try {
      return await call.updateConnection(service, String(request.params.id), request.body || {});
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.delete('/api/ssh/connections/:id', async (request, reply) => {
    try {
      return { ok: await call.deleteConnection(service, String(request.params.id)) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post('/api/ssh/connections/:id/host-key/probe', async (request, reply) => {
    try {
      return await call.probeHostKey(service, String(request.params.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post('/api/ssh/host-key/:challengeId', async (request, reply) => {
    try {
      return await call.decideHostKey(
        service,
        String(request.params.challengeId),
        String(request.body?.decision || ''),
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get('/api/ssh/sessions', async (_request, reply) => {
    try {
      const result = await call.listSessions(service);
      return Array.isArray(result) ? { sessions: result } : result;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post('/api/ssh/connections/:id/sessions', async (request, reply) => {
    if (!isLocalRequest(request) && !isSecureRequest(request)) {
      return reply.code(403).send({ error: 'secure_connect_required' });
    }
    const password = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from(request.body || '');
    try {
      return await service.openSession(String(request.params.id), password);
    } catch (error) {
      return sendError(reply, error);
    } finally {
      password.fill(0);
    }
  });

  fastify.put('/api/ssh/sessions/:sid/agent-access', async (request, reply) => {
    try {
      return await call.setAgentAccess(
        service,
        String(request.params.sid),
        request.body?.allowed === true,
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.delete('/api/ssh/sessions/:sid', async (request, reply) => {
    try {
      return { ok: await call.closeSession(service, String(request.params.sid)) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get('/api/ssh/sessions/:sid/terminal', { websocket: true }, (socket, request) => {
    const sid = String(request.params.sid);
    let detach;
    try {
      detach = service.attachTerminal(sid, socket);
    } catch {
      socket.close(1008, 'session_not_found');
      return;
    }
    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (message.t === 'in' && typeof message.d === 'string') {
        service.writeTerminal?.(sid, message.d);
      }
      if (message.t === 'resize') {
        service.resizeTerminal?.(sid, message.cols, message.rows);
      }
    });
    socket.once('close', () => detach?.());
    socket.once('error', () => detach?.());
  });

  fastify.get('/api/ssh/sessions/:sid/files', async (request, reply) => {
    try {
      const result = await call.listFiles(service, String(request.params.sid), request.query?.path);
      return Array.isArray(result) ? { files: result } : result;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get('/api/ssh/sessions/:sid/files/download', async (request, reply) => {
    try {
      const result = await call.downloadFile(
        service,
        String(request.params.sid),
        request.query?.path,
      );
      if (result?.contentType) {
        reply.type(result.contentType);
      }
      return reply.send(result?.stream || result?.data || result);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post('/api/ssh/sessions/:sid/files/upload', async (request, reply) => {
    try {
      return await call.uploadFile(service, String(request.params.sid), request);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get('/api/ssh/audit', async (request, reply) => {
    try {
      return await call.listAudit(service, request.query || {});
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post('/api/ssh/approvals/:pid', async (request, reply) => {
    // Пояснение необязательно: трение стоит на разрешении, а не на отказе. Требование
    // текста заворачивало пустой отказ в 400, клиент молча перечитывал очередь, и
    // карточка возвращалась на экран без единого слова о причине.
    const body = {
      allow: request.body?.allow === true,
      comment: String(request.body?.comment || '').trim().slice(0, 4_000),
    };
    try {
      const result = await call.answerApproval(service, String(request.params.pid), body);
      if (result?.ok === false) {
        return sendError(reply, result);
      }
      return result;
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

export default sshModule;
