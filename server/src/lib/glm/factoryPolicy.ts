import { decideGlmTool, glmMcpToolName } from './policy.ts';
import type { GlmToolDecision } from './policy.ts';

export type GlmFactoryFilesystem = 'state-only' | 'workspace-write';

export interface GlmFactoryToolPolicy {
  format: 1;
  consumer: 'factory';
  filesystem: GlmFactoryFilesystem;
  rawTools: string[];
}

// Имя host-owned статусного MCP фабрики и его точный inventory в именах DSH.
export const GLM_FACTORY_STATUS_SERVER = 'factory-status';

export const GLM_FACTORY_STATUS_TOOLS: readonly string[] = Object.freeze(['stage_progress', 'stage_result']
  .map((name) => glmMcpToolName(GLM_FACTORY_STATUS_SERVER, name)));

/**
 * Движок передаёт только доказанные файловые режимы узла.
 * Вопросы в отвязанном этапе завершаются отказом, а не ожиданием человека.
 */
export function glmFactoryPolicy(value: string) {
  if (value !== 'state-only' && value !== 'workspace-write') {
    throw Object.assign(new Error('Файловая политика GLM Factory не поддерживается'), {
      code: 'glm_factory_policy_unsupported',
    });
  }

  return {
    mode: value === 'state-only' ? 'read-only' as const : 'workspace-write' as const,
    approval: 'never' as const,
    allowQuestions: false as const,
  };
}

/**
 * Документ политики hook для отвязанного этапа пишет только host-wrapper.
 * Inventory равен точному набору статусных инструментов, без проектных MCP.
 */
export function glmFactoryToolPolicy(filesystem: GlmFactoryFilesystem): GlmFactoryToolPolicy {
  glmFactoryPolicy(filesystem);

  return {
    format: 1,
    consumer: 'factory',
    filesystem,
    rawTools: [...GLM_FACTORY_STATUS_TOOLS],
  };
}

/**
 * Factory policy принимает только точный статусный inventory этого host consumer.
 * Имя произвольного MCP не становится разрешённым только из-за общего префикса.
 */
export function parseGlmFactoryToolPolicy(value: unknown): GlmFactoryToolPolicy {
  const policy = value as Partial<GlmFactoryToolPolicy> | null;

  if (!policy || typeof policy !== 'object' || Array.isArray(policy)
    || Object.keys(policy).sort().join(',') !== 'consumer,filesystem,format,rawTools'
    || policy.format !== 1 || policy.consumer !== 'factory'
    || !['state-only', 'workspace-write'].includes(String(policy.filesystem))
    || !Array.isArray(policy.rawTools) || policy.rawTools.length !== GLM_FACTORY_STATUS_TOOLS.length
    || new Set(policy.rawTools).size !== GLM_FACTORY_STATUS_TOOLS.length
    || policy.rawTools.some((name) => !GLM_FACTORY_STATUS_TOOLS.includes(name))) {
    throw Object.assign(new TypeError('Политика GLM Factory повреждена'), {
      code: 'glm_factory_policy_invalid',
    });
  }

  return {
    format: 1,
    consumer: 'factory',
    filesystem: policy.filesystem!,
    rawTools: [...policy.rawTools],
  };
}

/**
 * Статус разрешён по точному имени, интерактивные вопросы не имеют получателя.
 * Native команды проходят прежнюю SSH/БД-политику и файловую песочницу DSH.
 */
export function decideGlmFactoryTool(
  name: string,
  input: unknown,
  policy: GlmFactoryToolPolicy,
): GlmToolDecision {
  if (name.startsWith('mcp__')) {
    const allow = policy.rawTools.includes(name);

    return {
      allow,
      kind: 'mcp',
      reason: allow ? '' : 'MCP не входит в Factory inventory',
    };
  }

  if (name === 'ask_user_question') {
    return {
      allow: false,
      kind: 'question',
      reason: 'Вопрос недоступен в отвязанном этапе',
    };
  }

  if (policy.filesystem === 'state-only' && ['write', 'edit'].includes(name)) {
    return {
      allow: false,
      kind: 'edit',
      reason: 'Узел доступен только для чтения',
    };
  }

  return decideGlmTool(name, input, {
    workTools: [],
    ssh: true,
    db: true,
    strictDb: true,
  });
}
