// Дополнение исполняется внутри выбранного CLI, без записи в его установку.
// Только профиль проверенного ACP получает новые read-only статус и условное закрытие.
export const QWEN_IDLE_EXTENSION = String.raw`
/**
 * Полный снимок включает будущие таймеры и мониторы, которых нет в native holds.
 * Любой неизвестный контракт удерживает процесс вместо ложного разрешения на закрытие.
 */
function grigDeskSessionActivity(session, closingAllowed = false) {
  try {
    if (!session || session.disposed || (session.closing && !closingAllowed)) {
      return { state: 'unknown', reasons: [{ kind: 'unknown' }] };
    }

    const config = session.getConfig();
    const holds = grigDeskOriginalHolds.call(session);
    const reasons = [];
    const categories = new Map([
      ['agent', 'subagent'], ['notification', 'subagent'], ['shell', 'command'],
      ['workflow', 'workflow'], ['session', 'turn'], ['tool', 'turn'],
    ]);

    for (const hold of holds) {
      const kind = categories.get(hold.category);

      if (!kind) {
        throw new Error('unknown hold');
      }

      const previous = reasons.find((reason) => reason.kind === kind);

      if (previous) {
        previous.count += 1;
      } else {
        reasons.push({ kind, count: 1 });
      }
    }

    if (!closingAllowed && !session.isTurnIdle() && !reasons.some((reason) => reason.kind === 'turn')) {
      reasons.push({ kind: 'turn', count: 1 });
    }

    const monitors = config.getMonitorRegistry().getAll();

    if (!Array.isArray(monitors) || monitors.some((task) =>
      !['running', 'completed', 'failed', 'cancelled'].includes(task.status))) {
      throw new Error('unknown monitor state');
    }

    const runningMonitors = monitors.filter((task) => task.status === 'running');

    if (runningMonitors.length) {
      reasons.push({ kind: 'monitor', count: runningMonitors.length });
    }

    const scheduler = config.getCronScheduler();
    const schedules = scheduler.list();
    const queued = session.cronQueue ?? [];

    if (!Array.isArray(schedules) || typeof scheduler.hasGatesInFlight !== 'function') {
      throw new Error('unknown scheduler');
    }

    if (schedules.length || queued.length || scheduler.pendingFires?.length
      || scheduler.hasGatesInFlight() || scheduler.firePersistPending?.size
      || scheduler.pendingAdd?.size || scheduler.pendingRemoval?.size) {
      const nextTimes = schedules.map((job) => job.fireAtMs)
        .filter((value) => typeof value === 'number' && Number.isFinite(value) && value > Date.now());
      const reason = { kind: 'schedule', count: Math.max(1, schedules.length + queued.length) };

      if (nextTimes.length) {
        reason.nextAt = Math.min(...nextTimes);
      }

      reasons.push(reason);
    }

    const goal = config.getGoalRuntime().getSnapshot();

    if (goal.goal?.status === 'active') {
      reasons.push({ kind: 'goal', count: 1 });
    }

    return { state: reasons.length ? 'busy' : 'idle', reasons };
  } catch {
    return { state: 'unknown', reasons: [{ kind: 'unknown' }] };
  }
}

const grigDeskOriginalHolds = Session.prototype.collectActiveWorkHolds;

/**
 * Дополняет native условное закрытие: повторные проверки под его close gate
 * видят расписания и мониторы даже после асинхронного flush истории.
 */
Session.prototype.collectActiveWorkHolds = function () {
  const original = grigDeskOriginalHolds.call(this);

  if (this.disposed) {
    return original;
  }

  const activity = grigDeskSessionActivity(this, true);

  const extras = activity.reasons.filter((reason) =>
    ['monitor', 'schedule', 'goal', 'unknown'].includes(reason.kind));

  return [...original, ...extras.map((reason) => ({
    category: 'tool', id: 'grigdesk:lifecycle:' + reason.kind,
  }))];
};

/**
 * Внешний запрос не выбирает чужой процесс: sessionId ищется в этом ACP agent.
 * Native onlyIfUnheld повторно проверяет расширенные holds перед удалением сессии.
 */
async function grigDeskIdleRequest(agent, method, params) {
  if (agent.privateParentState !== 'trusted'
    || typeof params.sessionId !== 'string' || !params.sessionId) {
    throw new Error('invalid lifecycle session');
  }

  const session = agent.sessions.get(params.sessionId);
  const activity = grigDeskSessionActivity(session);
  const result = { v: 1, sessionId: params.sessionId, ...activity };

  if (method.endsWith('/grigdesk-idle-status-v1')) {
    return result;
  }

  if (!session || activity.state !== 'idle') {
    return { ...result, closed: false };
  }

  const outcome = await agent.closeStoredSession(params.sessionId, {
    onlyIfUnheld: true, requireFlush: true, skipMemoryFlush: true, drainTimeoutMs: 8000,
  });

  return {
    v: 1, sessionId: params.sessionId, closed: outcome.closed === true,
    ...grigDeskSessionActivity(agent.sessions.get(params.sessionId)),
  };
}
`;

// Preload остаётся прозрачным в reader helper и включается только в самом CLI.
// NODE_OPTIONS снимается до запуска его дочерних программ, чтобы они не наследовали мост.
export const QWEN_IDLE_PRELOAD = String.raw`
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const configuration = process.env.GRIGDESK_QWEN_IDLE_BRIDGE;

if (configuration && process.argv[1]) {
  const settings = JSON.parse(readFileSync(configuration, 'utf8'));

  if ([settings.entry, settings.cli].includes(realpathSync(process.argv[1]))) {

    registerHooks({
      load(url, context, nextLoad) {
        const loaded = nextLoad(url, context);

        if (url !== settings.moduleUrl || loaded.format !== 'module') {
          return loaded;
        }

        delete process.env.NODE_OPTIONS;
        delete process.env.GRIGDESK_QWEN_IDLE_BRIDGE;
        const source = String(loaded.source);
        const digest = createHash('sha256').update(source).digest('hex');

        if (digest !== settings.sha256) {
          throw new Error('Qwen: исходник lifecycle-моста изменился после подготовки');
        }

        const marker = 'async extMethodInternal(method,params){';

        if (source.split(marker).length !== 2) {
          throw new Error('Qwen: несовместимый lifecycle-мост');
        }

        const dispatch = marker
          + "if(method==='qwen/status/session/grigdesk-idle-status-v1'"
          + "||method==='qwen/control/session/grigdesk-idle-close-v1')"
          + '{return grigDeskIdleRequest(this,method,params);}';
        const extension = readFileSync(settings.extension, 'utf8');

        return { ...loaded, source: source.replace(marker, dispatch) + '\n' + extension };
      },
    });
  }
}
`;
