import { limitSshOutput } from './output.js';

function agentSession(value) {
  return value ? { label: String(value.label), role: String(value.role) } : null;
}

function safeResult(result) {
  const allowed = [
    'ok', 'error', 'comment', 'output', 'shownBytes', 'totalBytes', 'truncated',
    'notice', 'exitCode', 'signal',
  ];
  const value = {};
  for (const key of allowed) {
    if (result?.[key] !== undefined) {
      value[key] = result[key];
    }
  }
  return value;
}

/**
 * Broker перепроверяет живую capability до списка, до approval и после него.
 * Модель получает только selector и ограниченный типизированный результат.
 */
export function createSshBroker(options = {}) {
  const enabled = options.pluginEnabled || (() => false);
  const sessions = options.sessions;
  const permissionQueue = options.permissionQueue;
  const audit = options.audit;
  const outputLimitBytes = options.outputLimitBytes || (() => 64 * 1_024);

  function findSession(projectId, input) {
    if (typeof sessions.findForAgent === 'function') {
      return sessions.findForAgent(projectId, input.label, input.role);
    }
    return (sessions.listForAgent(projectId) || []).find((session) => (
      session.label === input.label && session.role === input.role
    )) || null;
  }

  async function invoke(scope = {}, input = {}) {
    if (!enabled('ssh')) {
      return { ok: false, error: 'plugin_disabled' };
    }
    const projectId = String(scope.projectId || '');
    if (!projectId) {
      return input.action === 'list'
        ? []
        : { ok: false, error: 'project_scope_unavailable' };
    }
    if (input.action === 'list') {
      return (sessions.listForAgent(projectId) || []).map(agentSession).filter(Boolean);
    }
    if (input.action !== 'exec') {
      return { ok: false, error: 'invalid_action' };
    }
    const command = String(input.command || '');
    if (!command || !input.label || !input.role) {
      return { ok: false, error: 'invalid_arguments' };
    }
    const session = await findSession(projectId, input);
    if (!session || !session.agentAllowed) {
      return { ok: false, error: 'not_available' };
    }
    if (!permissionQueue) {
      return { ok: false, error: 'approval_unavailable' };
    }
    const pending = permissionQueue.enqueue({
      origin: 'ssh',
      chatKey: String(scope.chatKey || ''),
      sessionId: session.id,
      generation: session.generation,
      canRemember: false,
      presentation: {
        server: {
          label: session.label,
          host: session.host,
          port: session.port,
        },
        user: session.user,
        isRoot: session.user === 'root',
        usesSudo: /(^|[;&|]\s*|\s)sudo(?:\s|$)/.test(command),
        command,
      },
    });
    const decision = await pending.result;
    if (!decision.allow) {
      const denied = decision.error
        ? { ok: false, error: decision.error }
        : { ok: false, error: 'denied', comment: decision.comment || '' };
      await audit?.append?.({
        ...session,
        projectId,
        command,
        decision: 'deny',
        comment: decision.comment || '',
        result: denied.error,
      });
      return denied;
    }
    if (!enabled('ssh')) {
      return { ok: false, error: 'plugin_disabled' };
    }
    const current = await findSession(projectId, input);
    if (!current
      || current.id !== session.id
      || current.generation !== session.generation
      || !current.agentAllowed) {
      return { ok: false, error: 'session_lost' };
    }
    const executed = await sessions.exec(current.id, command);
    const limited = executed.output === undefined
      ? null
      : limitSshOutput(executed.output, Number(outputLimitBytes()) || 64 * 1_024);
    const result = safeResult({
      ...executed,
      ...(limited || {}),
      ...(limited ? { output: limited.text } : {}),
    });
    await audit?.append?.({
      projectId,
      connectionId: current.connectionId,
      sessionId: current.id,
      label: current.label,
      role: current.role,
      host: current.host,
      user: current.user,
      command,
      decision: 'allow',
      result: result.ok ? 'ok' : result.error,
      exitCode: result.exitCode,
      signal: result.signal,
      output: limited || undefined,
    });
    return result;
  }

  return { invoke };
}

export default createSshBroker;
