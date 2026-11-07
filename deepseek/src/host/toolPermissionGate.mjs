import { realpathSync } from 'node:fs';
import path from 'node:path';

import { decideToolPermission } from './toolPermissionPolicy.mjs';
import { toolPermissionPathFacts } from './toolPermissionPaths.mjs';

export const name = 'grigdesk-tool-permissions';
export const inject = ['tools', 'approval', 'sandboxPolicy', 'permissionPresets', 'agents'];

/**
 * Host policy читается один раз до boot и не расширяется значениями модели или settings.
 * Неизвестный формат и неполная action-матрица запрещают рабочий запуск.
 */
export function validateToolPermissionPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.format !== 1 || value.consumer !== 'deepseek-chat'
    || value.revision !== 'grigdesk-tool-permissions-v1'
    || !['default', 'auto', 'read-only'].includes(value.mode)
    || typeof value.workspaceRoot !== 'string' || !path.isAbsolute(value.workspaceRoot)
    || !value.workActions || typeof value.workActions !== 'object' || Array.isArray(value.workActions)) {
    throw new Error('Некорректная политика разрешений DeepSeek');
  }

  const workspaceRoot = realpathSync.native(value.workspaceRoot);
  const workActions = {};

  for (const [tool, actions] of Object.entries(value.workActions)) {
    if (!/^mcp__grigdesk-work__[a-z_]+$/u.test(tool)
      || !actions || typeof actions !== 'object' || Array.isArray(actions)
      || Object.values(actions).some((kind) => !['read', 'broker'].includes(kind))) {
      throw new Error('Некорректная таблица рабочих операций DeepSeek');
    }

    workActions[tool] = Object.freeze({ ...actions });
  }

  return Object.freeze({
    ...value,
    workspaceRoot,
    workActions: Object.freeze(workActions),
  });
}

/**
 * Обязательный native gate предшествует эффекту, а финальный guard не даёт обойти его
 * ранним allow другого listener. Допуск принадлежит одному execution, не имени или callId.
 */
export function apply(ctx, input) {
  const policy = validateToolPermissionPolicy(input);
  const standingMode = policy.mode === 'read-only' ? 'read-only' : 'workspace-write';
  const roots = new WeakMap();
  const grants = new WeakMap();
  const tools = ctx.tools;
  const agents = ctx.agents;
  const approval = ctx.approval;
  const sandbox = ctx.sandboxPolicy;
  const presets = ctx.permissionPresets;

  /**
   * Персистентные overrides не должны переживать выбор прав нового хода.
   * Эта синхронная установка происходит до systemPrompt.assemble, а pre-step остаётся veto.
   */
  function initialize(agent) {
    if (!agents.roots().includes(agent)) {
      return;
    }

    try {
      presets.set(agent.session, standingMode);

      const definitions = new Map(tools.schemas(agent).map((schema) => {
        const definition = tools.get(schema.name, agent);

        return [schema.name, { definition, execute: definition?.execute }];
      }));

      roots.set(agent, { definitions });
    } catch (error) {
      roots.set(agent, { error });
    }
  }

  /**
   * Проверяются текущие native значения, включая session override, а не только overlay.
   * Чужой или делегированный агент не получает права root разговора.
   */
  function denial(agent) {
    const state = agent && roots.get(agent);

    if (!state || state.error || agents.get(agent.id) !== agent || !agents.roots().includes(agent)) {
      return 'Политика разрешений не установлена для этого агента';
    }

    const actual = sandbox.resolve({ session: agent.session });
    const approvalPolicy = approval.overrideOf(agent.session) ?? approval.config.policy ?? 'ask';

    if (actual.mode !== standingMode || actual.workspaceRoot !== policy.workspaceRoot
      || approvalPolicy !== 'ask') {
      return 'Права native сессии не совпадают с выбранным режимом';
    }

    return undefined;
  }

  /**
   * Readonly аргументы native registry не замораживают сам execution до результата.
   * Снимок до первого await исключает подмену владельца, args или функции во время ответа.
   */
  function executionUnchanged(exec, snapshot) {
    return snapshot.agent === exec.agent && snapshot.name === exec.name
      && snapshot.callId === exec.callId && snapshot.token === exec.token
      && snapshot.rootCallId === exec.rootCallId && snapshot.parent === exec.parent
      && snapshot.args === exec.arguments && tools.get(exec.name, exec.agent) === snapshot.definition
      && snapshot.definition?.execute === snapshot.execute;
  }

  ctx.on('agent/session-start', ({ agent }) => initialize(agent));
  ctx.on('agent/disposed', ({ agent }) => roots.delete(agent));
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (denial(agent)) {
      return { kind: 'reject' };
    }

    return next();
  }, { prepend: true });

  ctx.on('tools/pre-execute', async (exec, next) => {
    const initialDenial = denial(exec.agent);

    if (initialDenial || exec.signal.aborted) {
      return { kind: 'deny', reason: initialDenial || 'Действие отменено' };
    }

    const definition = tools.get(exec.name, exec.agent);
    const registered = roots.get(exec.agent).definitions.get(exec.name);
    const trusted = registered?.definition === definition && registered?.execute === definition?.execute;
    const pathFacts = ['write', 'edit'].includes(exec.name)
      ? toolPermissionPathFacts(policy.workspaceRoot, exec.arguments.file_path) : undefined;
    const snapshot = Object.freeze({
      definition,
      execute: definition?.execute,
      agent: exec.agent,
      name: exec.name,
      callId: exec.callId,
      token: exec.token,
      rootCallId: exec.rootCallId,
      parent: exec.parent,
      args: exec.arguments,
      pathFacts,
    });
    const downstream = await next();

    if (downstream.kind === 'deny') {
      return downstream;
    }

    if (!executionUnchanged(exec, snapshot)) {
      return { kind: 'deny', reason: 'Вызов изменился во время проверки разрешений' };
    }

    const decision = decideToolPermission({
      mode: policy.mode,
      name: exec.name,
      args: exec.arguments,
      pathFacts,
      trusted,
      workActions: policy.workActions,
    });

    if (decision.kind === 'deny') {
      return decision;
    }

    if (decision.kind === 'ask' || downstream.kind === 'ask') {
      const result = await approval.request({
        agent: exec.agent,
        toolName: exec.name,
        callId: exec.callId,
        reason: downstream.reason || decision.reason,
        signal: exec.signal,
      });

      if (result !== 'allowed-once') {
        return { kind: 'deny', reason: 'Действие не разрешено пользователем' };
      }
    }

    if (exec.signal.aborted || denial(exec.agent)) {
      return { kind: 'deny', reason: 'Разрешение потеряло силу' };
    }

    grants.set(exec, snapshot);

    return { kind: 'allow' };
  }, { prepend: true });

  tools.guard((exec) => {
    const grant = grants.get(exec);

    grants.delete(exec);

    if (!grant || exec.signal.aborted || denial(exec.agent)
      || !executionUnchanged(exec, grant)) {
      return 'Действие не прошло обязательную проверку разрешений';
    }

    if (grant.pathFacts && grant.pathFacts.fingerprint
      !== toolPermissionPathFacts(policy.workspaceRoot, exec.arguments.file_path).fingerprint) {
      return 'Путь изменился во время ожидания разрешения; повторите действие';
    }

    return undefined;
  });
  ctx.on('tools/result', (exec) => grants.delete(exec));
  ctx.provide('grigdeskToolPermissions', Object.freeze({ ready: true, mode: policy.mode }));
}
