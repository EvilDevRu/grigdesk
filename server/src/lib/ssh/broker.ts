import { limitSshOutput } from './output.ts';
import type { SshAuditInput } from './audit.ts';
import type { PublicSshSession } from './sessionManager.ts';

// Что модель говорит инструменту. Больше здесь ничего нет намеренно: адрес, порт и
// пароль выбирает человек в панели, а агент выбирает открытую разрешённую сессию.
export interface BrokerInput {
  action?: string;
  sessionId?: string;
  label?: string;
  role?: string;
  command?: string;
}

// Чат для доставки подтверждения навязывает сервер. Проект разговора не ограничивает
// SSH: человек выдаёт доступ каждой живой сессии переключателем в панели.
export interface BrokerScope {
  chatKey?: string;
}

export interface BrokerResult {
  ok?: boolean;
  error?: string;
  comment?: string;
  output?: string;
  shownBytes?: number;
  totalBytes?: number;
  truncated?: boolean;
  notice?: string;
  exitCode?: number;
  signal?: string;
}

export interface AgentSessionView {
  sessionId: string;
  projectId: string;
  label: string;
  role: string;
}

interface PermissionDecision {
  allow?: boolean;
  error?: string;
  comment?: string;
}

interface PermissionQueue {
  enqueue: (request: Record<string, unknown>) => { result: Promise<PermissionDecision> };
}

// Журнал приходит из приложения обёрнутым в рассылку событий, поэтому от него
// требуется только запись — и та необязательна: без журнала broker всё равно
// спрашивает человека, а молча исполнить команду не может.
interface BrokerAudit {
  append?: (entry: SshAuditInput) => Promise<unknown>;
}

interface BrokerSessions {
  listForAgent: () => PublicSshSession[];
  exec: (id: string, command: string) => Promise<BrokerResult>;
}

export interface SshBrokerOptions {
  pluginEnabled?: (id: string) => boolean;
  sessions: BrokerSessions;
  permissionQueue?: PermissionQueue | null;
  audit?: BrokerAudit | null;
  outputLimitBytes?: () => number;
}

export interface SshBroker {
  invoke: (scope?: BrokerScope, input?: BrokerInput) => Promise<BrokerResult | AgentSessionView[]>;
}

function agentSession(value: PublicSshSession): AgentSessionView {
  return {
    sessionId: String(value.id),
    projectId: String(value.projectId),
    label: String(value.label),
    role: String(value.role),
  };
}

function safeResult(result: Record<string, unknown>): BrokerResult {
  const allowed = [
    'ok', 'error', 'comment', 'output', 'shownBytes', 'totalBytes', 'truncated',
    'notice', 'exitCode', 'signal',
  ];
  const value: Record<string, unknown> = {};
  for (const key of allowed) {
    if (result?.[key] !== undefined) {
      value[key] = result[key];
    }
  }

  return value as BrokerResult;
}

/**
 * Broker перепроверяет живую capability до списка, до approval и после него.
 * Модель получает только selector и ограниченный типизированный результат.
 */
export function createSshBroker(options: SshBrokerOptions): SshBroker {
  const enabled = options.pluginEnabled || (() => false);
  const sessions = options.sessions;
  const permissionQueue = options.permissionQueue;
  const audit = options.audit;
  const outputLimitBytes = options.outputLimitBytes || (() => 64 * 1_024);

  function allowedSessions(): PublicSshSession[] {
    return sessions.listForAgent().filter((session) => session.agentAllowed);
  }

  /**
   * Выбор делается среди всех разрешённых сессий до запроса подтверждения.
   * После решения проверяется исходная сессия, без повторного выбора по имени.
   */
  async function invoke(
    scope: BrokerScope = {},
    input: BrokerInput = {},
  ): Promise<BrokerResult | AgentSessionView[]> {
    if (!enabled('ssh')) {
      return { ok: false, error: 'plugin_disabled' };
    }
    if (input.action === 'list') {
      return allowedSessions().map(agentSession);
    }
    if (input.action !== 'exec') {
      return { ok: false, error: 'invalid_action' };
    }
    const command = String(input.command || '');

    if (!command || (!input.sessionId && (!input.label || !input.role))) {
      return { ok: false, error: 'invalid_arguments' };
    }

    const matches = allowedSessions().filter((session) => (
      (!input.sessionId || session.id === input.sessionId)
      && (!input.label || session.label === input.label)
      && (!input.role || session.role === input.role)
    ));

    if (matches.length > 1) {
      return { ok: false, error: 'ambiguous_session' };
    }

    const session = matches[0];

    if (!session) {
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

    const current = allowedSessions().find((item) => item.id === session.id);
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
      projectId: current.projectId,
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
