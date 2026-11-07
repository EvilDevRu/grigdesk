import { BROWSER_DESCRIPTOR } from '../../../../shared/browser/browserTool.ts';

import { lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { decideGlmBaseTool, glmMcpToolName } from './policy.ts';
import type { GlmToolDecision } from './policy.ts';

export type GlmFactoryFilesystem = 'state-only' | 'workspace-write';

export interface GlmFactoryToolPolicy {
  format: 1;
  consumer: 'factory';
  filesystem: GlmFactoryFilesystem;
  stateDir?: string;
  browser?: true;
  rawTools: string[];
}

// Имя host-owned статусного MCP фабрики и его точный inventory в именах DSH.
export const GLM_FACTORY_STATUS_SERVER = 'factory-status';

export const GLM_FACTORY_STATUS_TOOLS: readonly string[] = Object.freeze(['stage_progress', 'stage_result']
  .map((name) => glmMcpToolName(GLM_FACTORY_STATUS_SERVER, name)));

const BROWSER_TOOLS: readonly string[] = Object.freeze([
  ...GLM_FACTORY_STATUS_TOOLS,
  glmMcpToolName(GLM_FACTORY_STATUS_SERVER, BROWSER_DESCRIPTOR.name),
]);

/**
 * Factory status inventory расширяется одним точным именем по capability хоста.
 * Без browser сохраняется прежний набор и прежняя форма JSON policy.
 */
export function glmFactoryToolInventory(browser = false): readonly string[] {
  return browser ? BROWSER_TOOLS : GLM_FACTORY_STATUS_TOOLS;
}

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
    mode: 'workspace-write' as const,
    approval: 'never' as const,
    allowQuestions: false as const,
  };
}

/**
 * Browser policy не заменяет filesystem policy: проверяющий может пользоваться UI.
 * Только trusted factory context добавляет browser=true и точный третий raw tool.
 */
export function glmFactoryToolPolicy(
  filesystem: GlmFactoryFilesystem,
  stateDir?: string,
  browser = false,
): GlmFactoryToolPolicy {
  glmFactoryPolicy(filesystem);

  return parseGlmFactoryToolPolicy({
    format: 1,
    consumer: 'factory',
    filesystem,
    ...(filesystem === 'state-only' ? { stateDir } : {}),
    ...(browser ? { browser: true } : {}),
    rawTools: [...glmFactoryToolInventory(browser)],
  });
}

/**
 * Optional marker разрешён только как true с полным exact browser inventory.
 * Wildcard, похожее имя сервера и browser tool без marker отклоняются до hook.
 */
export function parseGlmFactoryToolPolicy(value: unknown): GlmFactoryToolPolicy {
  const policy = value as Partial<GlmFactoryToolPolicy> | null;
  const browser = policy?.browser === true;
  const expected = glmFactoryToolInventory(browser);
  const keys = ['consumer', 'filesystem', 'format', 'rawTools',
    ...(policy?.filesystem === 'state-only' ? ['stateDir'] : []),
    ...(browser ? ['browser'] : []),
  ].sort().join(',');

  if (!policy || typeof policy !== 'object' || Array.isArray(policy)
    || Object.keys(policy).sort().join(',') !== keys
    || policy.format !== 1 || policy.consumer !== 'factory'
    || !['state-only', 'workspace-write'].includes(String(policy.filesystem))
    || policy.filesystem === 'state-only' && !validStateDirectory(policy.stateDir)
    || !Array.isArray(policy.rawTools) || policy.rawTools.length !== expected.length
    || new Set(policy.rawTools).size !== expected.length
    || policy.rawTools.some((name) => !expected.includes(name))) {
    throw Object.assign(new TypeError('Политика GLM Factory повреждена'), {
      code: 'glm_factory_policy_invalid',
    });
  }

  return {
    format: 1,
    consumer: 'factory',
    filesystem: policy.filesystem!,
    ...(policy.filesystem === 'state-only' ? { stateDir: policy.stateDir! } : {}),
    ...(browser ? { browser: true as const } : {}),
    rawTools: [...policy.rawTools],
  };
}

/**
 * Корень записи задаёт хост: существующий физический каталог без NUL и относительных частей.
 * Повреждённый или подменённый ссылкой корень закрывает hook до запуска инструмента.
 */
function validStateDirectory(value: unknown): value is string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    return false;
  }

  try {
    return realpathSync(value) === value && statSync(value).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Новый артефакт может ещё не иметь каталогов, но его путь целиком остаётся в STATE_DIR.
 * Ссылки в существующей части запрещены: hook не разрешает выход через файл или родителя.
 */
function stateFileAllowed(input: unknown, stateDir: string | undefined): boolean {
  const file = (input as { file_path?: unknown } | null)?.file_path;

  if (!validStateDirectory(stateDir) || typeof file !== 'string' || !file || file.includes('\0')
    || file.split(path.sep).includes('..')) {
    return false;
  }

  const target = path.resolve(stateDir, file);
  const relative = path.relative(stateDir, target);

  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    return false;
  }

  for (let current = target; current !== stateDir; current = path.dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        return false;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return false;
      }
    }
  }

  return true;
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
    const allow = stateFileAllowed(input, policy.stateDir);

    return {
      allow,
      kind: 'edit',
      reason: allow ? '' : 'Запись узла разрешена только в STATE_DIR без символических ссылок',
    };
  }

  return decideGlmBaseTool(name, input, {
    workTools: [],
    ssh: true,
    db: true,
    strictDb: true,
  });
}
