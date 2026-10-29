import { setTimeout as pause } from 'node:timers/promises';

import { recordOrEmpty } from '../../../../shared/lib/objects.ts';
import {
  GLM_GATE_REVISION, glmGateHash, parseGlmGateProof,
} from '../../../../shared/node/glmGateProtocol.ts';
import type { GlmGateProof } from '../../../../shared/node/glmGateProtocol.ts';
import { glmAccessError } from './env.ts';
import { glmMcpLossError } from './mcp.ts';
import { GLM_WORK_SERVER_NAME, glmMcpToolName, glmToolKind } from './policy.ts';

interface Call {
  turn: number;
  name: string;
  input: Record<string, unknown>;
  hash: string;
  done: boolean;
}

export interface NativeGateIdentity {
  launchId: string;
  policyHash: string;
}

/**
 * Сверяет native proof и remote owner в пределах единственного запуска.
 * Исторический proof, чужой агент и завершённый call не открывают панель подтверждения.
 */
export function createGlmNativeGuard(options: NativeGateIdentity & {
  rootSessionId: string;
  workTools: readonly string[];
}) {
  const owners = new Map<string, string>();
  const sessions = new Set<string>();
  const turns = new Map<string, number>();
  const calls = new Map<string, Call>();
  const proofs = new Map<string, GlmGateProof>();
  const work = new Set(options.workTools.map((name) => glmMcpToolName(GLM_WORK_SERVER_NAME, name)));
  const key = (sessionId: string, turn: number, callId: string) => JSON.stringify([sessionId, turn, callId]);

  /**
   * События принимаются только из проверенного session/follow этого дерева.
   * Ready текущего launch отделяет собственные действия от истории fork и resume.
   */
  function inspectEvent(sessionId: string, event: Record<string, unknown>): void {
    const data = recordOrEmpty(event.data);

    if (event.type === 'grigdesk/glm-ready' && data.launchId === options.launchId
      && data.sessionId === sessionId) {
      if (data.revision !== GLM_GATE_REVISION || data.policyHash !== options.policyHash
        || typeof data.agentId !== 'string' || !data.agentId
        || owners.has(data.agentId) && owners.get(data.agentId) !== sessionId) {
        throw glmAccessError('glm_policy_gate_failed', 'Runtime GLM не подтвердил native gate.');
      }

      owners.set(data.agentId, sessionId);
      sessions.add(sessionId);
    }

    if (!sessions.has(sessionId)) {
      return;
    }

    if (event.type === 'grigdesk/glm-policy-error' && data.launchId === options.launchId) {
      throw glmAccessError('glm_policy_gate_failed', 'Обязательная проверка GLM отказала; ход остановлен.');
    }

    if (event.type === 'turn/start') {
      turns.set(sessionId, Number(data.turn));
    }
    if (event.type === 'turn/end') {
      turns.delete(sessionId);
    }
    if (event.type === 'tool/call') {
      const input = recordOrEmpty(JSON.parse(String(data.arguments)));
      const callKey = key(sessionId, Number(data.turn), String(data.callId));

      if (calls.has(callKey)) {
        throw glmAccessError('glm_policy_gate_failed', 'Повторный идентификатор вызова GLM.');
      }

      calls.set(callKey, {
        name: String(data.name),
        turn: Number(data.turn),
        input,
        hash: glmGateHash(input),
        done: false,
      });
    }

    if (event.type === 'grigdesk/glm-policy' && data.launchId === options.launchId) {
      const callKey = key(sessionId, Number(data.turn), String(data.callId));
      const call = calls.get(callKey);

      if (!call || call.done || proofs.has(callKey)) {
        throw glmAccessError('glm_policy_gate_failed', 'Дескриптор GLM не связан с текущим вызовом.');
      }

      const proof = parseGlmGateProof(JSON.stringify(data), {
        format: 1,
        consumer: 'chat',
        launchId: options.launchId,
        policyHash: options.policyHash,
        sessionId,
        agentId: String(data.agentId),
        turn: call.turn,
        callId: String(data.callId),
        name: call.name,
        sha256: call.hash,
      });

      if (owners.get(proof.agentId) !== sessionId) {
        throw glmAccessError('glm_policy_gate_failed', 'Владелец дескриптора GLM не совпал.');
      }

      proofs.set(callKey, proof);
    }

    if (event.type === 'tool/result') {
      const message = recordOrEmpty(data.message);
      const content = Array.isArray(message.content) ? message.content.map(recordOrEmpty) : [];
      const callId = String(recordOrEmpty(message.source).callId ?? message.toolCallId ?? '');
      const call = calls.get(key(sessionId, Number(data.turn), callId));
      const block = content.find((item) => item.toolCallId === callId) ?? message;
      const proof = proofs.get(key(sessionId, Number(data.turn), callId));
      const error = glmMcpLossError(call?.name ?? '', block.content, block.isError === true,
        GLM_WORK_SERVER_NAME);

      if (!proof && block.isError !== true) {
        throw glmAccessError('glm_policy_gate_failed', 'Результат GLM не подтверждён native gate.');
      }

      if (call) {
        call.done = true;
      }
      if (error) {
        throw error;
      }
    }
  }

  /**
   * Повреждённые аргументы и proof означают отказ инфраструктуры политики.
   * Ошибка JSON/схемы не должна превращаться в обычный неоднозначный ответ модели.
   */
  function inspect(sessionId: string, event: Record<string, unknown>): void {
    try {
      inspectEvent(sessionId, event);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        throw error;
      }

      throw glmAccessError('glm_policy_gate_failed',
        'Повреждено подтверждение политики GLM; ход остановлен.');
    }
  }

  /**
   * Remote может опередить follow; ожидание связывает два канала до вопроса человеку.
   * Этот предел относится к доставке доказательства, а не времени ответа в панели.
   */
  async function validate(frame: Record<string, unknown>, signal: AbortSignal) {
    const request = recordOrEmpty(frame.request);
    const question = frame.event === 'user-questions/request';
    const native = recordOrEmpty(request.grigdeskGlm);
    const callId = String(question ? native.callId ?? '' : request.callId ?? '');
    const deadline = Date.now() + 10_000;

    if (!callId || typeof frame.agentId !== 'string') {
      return null;
    }

    while (!signal.aborted && Date.now() < deadline) {
      const sessionId = owners.get(String(frame.agentId));

      if (sessionId && sessionId !== options.rootSessionId) {
        return null;
      }

      const turn = turns.get(options.rootSessionId);
      const callKey = key(options.rootSessionId, turn ?? -1, callId);
      const call = calls.get(callKey);
      const proof = proofs.get(callKey);

      if (call && proof && sessionId) {
        if (call.done || proof.decision !== 'allow' || proof.turn !== call.turn
          || proof.sha256 !== call.hash || proof.agentId !== frame.agentId
          || (question ? call.name !== 'ask_user_question' : call.name !== request.toolName)) {
          return null;
        }
        if (question && glmGateHash(native) !== glmGateHash(proof)) {
          return null;
        }

        return { call, question };
      }

      await pause(20, undefined, { signal }).catch(() => { });
    }

    return null;
  }

  /**
   * Автоодобрение служебного inventory идёт после той же проверки identity.
   * Расширение песочницы остаётся разовым решением человека, включая режим Авто.
   */
  async function approve(frame: Record<string, unknown>, signal: AbortSignal) {
    const checked = await validate(frame, signal);

    if (!checked) {
      return { allow: false };
    }
    if (checked.question) {
      return { question: true };
    }
    if (work.has(checked.call.name) && !checked.call.input.sandbox_permissions) {
      return { allow: true };
    }

    return {
      presentation: {
        isQuestion: false,
        acceptsComment: false,
        canRemember: false,
        requiresExplicitUser: true,
        source: 'GLM',
        tool: checked.call.name,
        input: { ...checked.call.input, kind: glmToolKind(checked.call.name) },
      },
    };
  }

  return {
    inspect,
    approve,
    isDelegation(sessionId: string, turn: number, callId: string) {
      const proof = proofs.get(key(sessionId, turn, callId));

      return proof?.decision === 'allow' && ['subagent', 'subagent_fork'].includes(proof.name);
    },
    isReady: (sessionId: string) => sessions.has(sessionId),
  };
}
