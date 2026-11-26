import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';

import { GLM_GATE_REVISION, glmGateHash, parseGlmGateProof } from './glmGateProtocol.mjs';

export const name = 'grigdesk-glm-gate';
export const inject = ['tools', 'agents', 'shell', 'sessionProjections', 'approval'];

/**
 * Native gate принадлежит GLM-процессу и проверяет все registry executions.
 * Окончательный guard не зависит от порядка разрешающих pre-execute listeners.
 */
export async function apply(ctx, config) {
  if (!config || typeof config.command !== 'string' || !config.command
    || typeof config.launchId !== 'string' || !config.launchId
    || typeof config.policyFile !== 'string' || !config.policyFile) {
    throw new Error('Не задана обязательная конфигурация native gate GLM');
  }

  const document = JSON.parse(readFileSync(config.policyFile, 'utf8'));
  const projectPrefix = document.projectMcp ? `mcp__${document.projectMcp}__` : '';
  const isProjectTool = (tool) => projectPrefix && tool.startsWith(projectPrefix);
  const policyHash = glmGateHash(document);
  const preflight = { launchId: config.launchId, policyHash };
  const check = await ctx.shell.run(ctx.shell.resolve({
    command: config.command,
    stdin: JSON.stringify({ preflight }),
    workdir: process.cwd(),
    signal: AbortSignal.timeout(30_000),
    timeoutMs: 30_000,
  }));

  if (check.exitCode !== 0 || check.stdout.text !== JSON.stringify({ ready: true, ...preflight })) {
    throw new Error('Helper native gate GLM не готов');
  }

  if (Array.isArray(config.visibleTools)) {
    const visible = new Set(config.visibleTools);
    const work = new Set(config.workToolNames ?? []);

    ctx.provide('grigdeskGlmToolVisible', (tool, agent) => {
      const child = agent.session.header.origin === 'subagent';

      if (child && ['create_goal', 'update_goal', 'ask_user_question'].includes(tool)) {
        return false;
      }

      return visible.has(tool) || work.has(tool) || !child && Boolean(isProjectTool(tool));
    });
  }

  const active = new AsyncLocalStorage();
  const proofs = new WeakMap();
  const projectGrants = new WeakSet();
  const lineage = new Map();
  const ready = new Set();
  let fatal = false;

  /**
   * Ошибка enforcement закрывает все новые действия процесса немедленно.
   * Типизированный журнал даёт серверу причину остановить принадлежащее ему дерево.
   */
  function broken(agent) {
    if (fatal) {
      return;
    }

    fatal = true;
    agent?.session.append('grigdesk/glm-policy-error', {
      launchId: config.launchId,
      code: 'glm_policy_gate_failed',
    });

    for (const root of ctx.agents.roots()) {
      if (root !== agent) {
        root.session.append('grigdesk/glm-policy-error', {
          launchId: config.launchId,
          code: 'glm_policy_gate_failed',
        });
      }

      root.cancel({ kind: 'parent' });
    }
  }

  /**
   * Identity берётся из registry execution и текущей проекции хода.
   * В аргументы helper не подмешиваются произвольные поля модели с идентификаторами.
   */
  function bindingOf(exec) {
    if (!exec.agent || !ready.has(exec.agent.session.id)) {
      throw new Error('Вызов GLM без зарегистрированного владельца');
    }

    return {
      format: 1,
      consumer: 'chat',
      launchId: config.launchId,
      policyHash,
      sessionId: exec.agent.session.id,
      agentId: exec.agent.id,
      turn: ctx.sessionProjections.stateOf(exec.agent.session, 'turnBoundary').lastTurn,
      callId: exec.callId,
      name: exec.name,
      sha256: glmGateHash(exec.arguments),
    };
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (fatal) {
        return { kind: 'deny', reason: 'Проверка политики GLM остановлена' };
      }

      const binding = bindingOf(exec);
      const result = await ctx.shell.run(ctx.shell.resolve({
        command: config.command,
        stdin: JSON.stringify({ binding, arguments: exec.arguments }),
        workdir: exec.agent.session.header.cwd,
        signal: exec.signal,
        timeoutMs: 30_000,
      }));

      if (result.exitCode !== 0 || exec.signal.aborted) {
        throw new Error('Helper GLM не подтвердил вызов');
      }

      const proof = parseGlmGateProof(result.stdout.text, binding);

      proofs.set(exec, proof);
      exec.agent.session.append('grigdesk/glm-policy', proof);

      if (proof.decision === 'deny') {
        return { kind: 'deny', reason: proof.reason };
      }
      if (isProjectTool(exec.name)) {
        if (!ctx.approval || !ctx.agents.roots().includes(exec.agent)) {
          return { kind: 'deny', reason: 'Проектный MCP требует решения человека в основном чате' };
        }

        const approval = await ctx.approval.request({
          agent: exec.agent,
          toolName: exec.name,
          callId: exec.callId,
          reason: 'Вызов проектного MCP',
          signal: exec.signal,
        });

        if (approval !== 'allowed-once' || exec.signal.aborted) {
          return { kind: 'deny', reason: 'Вызов проектного MCP не подтверждён' };
        }

        parseGlmGateProof(JSON.stringify(proof), bindingOf(exec));
        projectGrants.add(exec);
      }

      return next();
    } catch {
      if (!exec.signal.aborted) {
        broken(exec.agent);
      }

      return { kind: 'deny', reason: 'Не получено подтверждение политики GLM' };
    }
  }, { global: true });

  ctx.tools.guard((exec) => {
    const proof = proofs.get(exec);

    try {
      if (fatal || exec.signal.aborted || !proof || proof.decision !== 'allow') {
        throw new Error('Нет действующего подтверждения GLM');
      }

      parseGlmGateProof(JSON.stringify(proof), bindingOf(exec));

      if (isProjectTool(exec.name) && !projectGrants.has(exec)) {
        return 'Вызов проектного MCP требует разового подтверждения';
      }

      return undefined;
    } catch {
      if (!exec.signal.aborted) {
        broken(exec.agent);
      }

      return 'Окончательная проверка GLM запретила вызов';
    }
  });

  ctx.on('tools/execute', (exec, next) => active.run(exec, next), { global: true });
  ctx.on('tools/result', (exec) => proofs.delete(exec), { global: true });

  ctx.on('agent/created', ({ agent }) => {
    try {
      const exec = active.getStore();
      const child = agent.session.header.origin === 'subagent';

      if (child) {
        const proof = exec && proofs.get(exec);

        if (!proof || !['subagent', 'subagent_fork'].includes(exec.name)
          || agent.session.header.parentSession !== exec.agent.session.id) {
          throw new Error('Создание ребёнка без вызова делегирования');
        }

        const link = {
          version: 1,
          launchId: config.launchId,
          parentSessionId: exec.agent.session.id,
          parentTurn: proof.turn,
          parentCallId: exec.callId,
          childSessionId: agent.session.id,
          childAgentId: agent.id,
          mode: 'one-shot',
        };

        lineage.set(agent.session.id, {
          link,
          parent: exec.agent.session,
          announced: false
        });
      }

      ready.add(agent.session.id);
      agent.session.append('grigdesk/glm-ready', {
        revision: GLM_GATE_REVISION,
        launchId: config.launchId,
        policyHash,
        sessionId: agent.session.id,
        agentId: agent.id,
      });
    } catch {
      broken(agent);
    }
  }, { global: true });

  // Каталог появляется раньше descriptor: follow в этот момент отвергает сессию.
  // Публикуем связь после native descriptor, до первого запроса дочерней модели.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'subagent/descriptor') {
      return;
    }

    const child = lineage.get(session.id);

    if (!child || child.announced) {
      return;
    }

    try {
      if (event.data.mode !== 'one-shot') {
        throw new Error('Неподдерживаемый режим ребёнка GLM');
      }

      child.announced = true;
      child.parent.append('grigdesk/glm-delegation', child.link);
    } catch {
      broken();
    }
  }, { global: true });

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (fatal || !ready.has(agent.session.id)
      || agent.session.header.origin === 'subagent' && !lineage.has(agent.session.id)) {
      return { kind: 'reject' };
    }

    return next();
  }, { global: true, prepend: true });

  ctx.on('user-questions/request', (request, next) => {
    const exec = active.getStore();
    const proof = exec && proofs.get(exec);

    if (fatal || !proof || proof.name !== 'ask_user_question'
      || request.agent !== exec.agent || exec.signal.aborted) {
      throw new Error('Вопрос GLM без подтверждённого execution');
    }

    request.grigdeskGlm = proof;

    return next();
  }, { global: true, prepend: true });
}
