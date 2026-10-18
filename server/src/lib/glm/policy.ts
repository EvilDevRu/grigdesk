import { createHash } from 'node:crypto';

import { evaluateDirectCommand } from '../executors/_directSshPolicy.ts';
import {
  GLM_MCP_HASH_LENGTH,
  GLM_MCP_NAME_LIMIT,
  GLM_NATIVE_TOOLS,
  canonicalGlmJson,
} from './contract.ts';

export interface GlmToolPolicy {
  workTools: readonly string[];
  ssh: boolean;
  db: boolean;
  strictDb: boolean;
}

export type GlmToolKind = 'read' | 'search' | 'edit' | 'execute' | 'question' | 'plan' | 'mcp' | 'other';

export interface GlmToolDecision {
  allow: boolean;
  kind: GlmToolKind;
  reason: string;
}

export const GLM_WORK_SERVER_NAME = 'grigdesk-work';

const KINDS: Readonly<Record<string, GlmToolKind>> = Object.freeze({
  read: 'read',
  glob: 'search',
  grep: 'search',
  write: 'edit',
  edit: 'edit',
  bash: 'execute',
  ask_user_question: 'question',
  todo_write: 'plan',
});

/**
 * Имя MCP-инструмента по формуле dsh-mcp-client: `mcp__<сервер>__<инструмент>`;
 * при любой нормализации или длине больше 64 — префикс и хвост sha256 «сервер\0инструмент».
 */
export function glmMcpToolName(server: string, tool: string): string {
  const joined = `mcp__${server}__${tool}`;
  const normalized = joined.replace(/[^A-Za-z0-9_-]/gu, '_');

  if (normalized === joined && normalized.length <= GLM_MCP_NAME_LIMIT) {
    return normalized;
  }

  const hash = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, GLM_MCP_HASH_LENGTH);

  return `${normalized.slice(0, GLM_MCP_NAME_LIMIT - GLM_MCP_HASH_LENGTH - 1)}_${hash}`;
}

/**
 * Тип действия — только по точному имени инструмента, без догадок по заголовку.
 * MCP-имена получают тип mcp, всё прочее — other.
 */
export function glmToolKind(name: string): GlmToolKind {
  if (Object.hasOwn(KINDS, name)) {
    return KINDS[name]!;
  }

  return name.startsWith('mcp__') ? 'mcp' : 'other';
}

/**
 * Хэш аргументов вызова: sha256 канонического JSON (ключи отсортированы рекурсивно).
 * Одни и те же аргументы дают один хэш при любом порядке ключей.
 */
export function glmArgumentsHash(input: unknown): string {
  return createHash('sha256').update(canonicalGlmJson(input)).digest('hex');
}

/**
 * Политика запуска принимается только целиком; иначе hook падает и отказывает (exit 2).
 * Неверная форма — исключение, а не молча пустой инвентарь.
 */
export function parseGlmToolPolicy(value: unknown): GlmToolPolicy {
  const policy = value as Partial<GlmToolPolicy> | null;

  if (!policy || typeof policy !== 'object' || !Array.isArray(policy.workTools)
    || policy.workTools.some((name) => typeof name !== 'string' || !name)
    || typeof policy.ssh !== 'boolean' || typeof policy.db !== 'boolean'
    || typeof policy.strictDb !== 'boolean') {
    throw new TypeError('Политика инструментов GLM повреждена');
  }

  return {
    workTools: [...policy.workTools],
    ssh: policy.ssh,
    db: policy.db,
    strictDb: policy.strictDb,
  };
}

/**
 * Решение hook по точному имени и аргументам до эффекта: свои инструменты профиля,
 * shell через общую SSH/БД-политику, grigdesk-work — только инструменты инвентаря запуска.
 */
export function decideGlmTool(name: string, input: unknown, policy: GlmToolPolicy): GlmToolDecision {
  const kind = glmToolKind(name);

  if (name.startsWith('mcp__')) {
    const allowed = policy.workTools.some((tool) => glmMcpToolName(GLM_WORK_SERVER_NAME, tool) === name);

    return {
      allow: allowed,
      kind,
      reason: allowed ? '' : 'MCP-инструмент не входит в инвентарь этого запуска',
    };
  }

  if (!GLM_NATIVE_TOOLS.includes(name)) {
    return {
      allow: false,
      kind,
      reason: `инструмент «${name}» GLM не разрешён`,
    };
  }

  if (name === 'bash') {
    const command = (input as { command?: unknown } | null)?.command;
    const verdict = evaluateDirectCommand(command, {
      blockDirectSsh: policy.ssh,
      blockDirectDb: policy.db,
      strictUnknownDbClient: policy.strictDb,
    });

    if (verdict.verdict === 'deny') {
      return {
        allow: false,
        kind,
        reason: verdict.kind === 'ssh'
          ? 'прямой SSH запрещён настройкой'
          : 'прямой клиент БД запрещён настройкой',
      };
    }
  }

  return {
    allow: true,
    kind,
    reason: '',
  };
}
