import type { DraftNode } from './routeDefinition.ts';
import { parseRouteDraftContent, ROUTES_EDITOR_LIMITS } from './routesEditorContracts.ts';
import { contractDecoders } from '../lib/contractDecoders.ts';

export const STAGE_ROLE_IDS = ['review', 'tests', 'browser', 'human', 'command', 'custom'] as const;

export type StageRoleId = typeof STAGE_ROLE_IDS[number];

export interface StageRoleAnswers {
  filesystem?: string;
  services?: boolean;
  browser?: boolean;
  failure?: 'ask' | 'return' | 'self-fix';
  returnTargetId?: string;
  description?: string;
  commandId?: string;
}

export interface StageRoleSource {
  node: DraftNode | null;
  prompts: Record<string, string>;
}

export interface StageRoleTemplate extends StageRoleSource {
  id: StageRoleId;
  defaults: StageRoleAnswers;
  companion?: StageRoleSource;
}

export interface StageRoleCatalog {
  schema: 1;
  roles: StageRoleTemplate[];
}

const decode = contractDecoders((path) => {
  throw new Error(`Неверный каталог ролей: ${path}`);
});

/**
 * Отвергает неизвестные поля публичного DTO.
 * Шаблон не может незаметно расширить возможности мастера.
 */
function closed(value: unknown, fields: string[]): Record<string, unknown> {
  const record = decode.record(value, 'stageRoles');

  if (Object.keys(record).some((key) => !fields.includes(key))) {
    throw new Error('Неизвестное поле каталога ролей');
  }

  return record;
}

/**
 * Сверяет размер инструкций в UTF-8 с ограничениями сохранения черновика.
 * Один контракт применяется к каталогу, подготовленной роли и итоговому пакету.
 */
export function stagePromptLimitExceeded(prompts: Record<string, string>): boolean {
  const encoder = new TextEncoder();
  let totalBytes = 0;

  for (const text of Object.values(prompts)) {
    const bytes = encoder.encode(text).byteLength;

    if (bytes > ROUTES_EDITOR_LIMITS.promptFileBytes) {
      return true;
    }

    totalBytes += bytes;
  }

  return totalBytes > ROUTES_EDITOR_LIMITS.promptBundleBytes;
}

/**
 * Проверяет форму узла существующим декодером route-v2.
 * Временная машина служит только оболочкой и нигде не сохраняется.
 */
function sourceAt(value: unknown): StageRoleSource {
  const source = closed(value, ['node', 'prompts']);
  const prompts = decode.mapOf(decode.text)(source.prompts, 'prompts');

  if (stagePromptLimitExceeded(prompts)) {
    throw new Error('Слишком большая инструкция роли');
  }

  const machine = {
    schema: 2,
    kind: 'bootstrap',
    profile: 'catalog',
    id: 'catalog',
    entry: null,
    sequence: { bootstrap: [] },
    nodes: source.node === null ? [] : [source.node],
    escalation: [],
  };
  const parsed = parseRouteDraftContent({
    routes: {},
    bootstrap: machine,
    bootstrapPrompts: prompts,
    presentation: {},
    provenance: {},
  });

  return { node: parsed.bootstrap.nodes[0] ?? null, prompts };
}

/**
 * Декодирует отдельный каталог, не меняя контракт editor-info.
 * Набор ролей и ответов закрыт, инструкции остаются обычными данными.
 */
export function parseStageRoleCatalog(value: unknown): StageRoleCatalog {
  const catalog = closed(value, ['schema', 'roles']);

  decode.oneOf(1)(catalog.schema, 'schema');

  const roles = decode.listOf((item) => {
    const role = closed(item, ['id', 'node', 'prompts', 'defaults', 'companion']);
    const id = decode.oneOf(...STAGE_ROLE_IDS)(role.id, 'role.id');
    const defaults = closed(role.defaults,
      ['filesystem', 'services', 'browser', 'failure', 'commandId']);

    if (defaults.filesystem !== undefined) {
      decode.oneOf('state-only', 'workspace-write')(defaults.filesystem, 'filesystem');
    }

    for (const key of ['services', 'browser']) {
      if (defaults[key] !== undefined) {
        decode.boolean(defaults[key], key);
      }
    }

    if (defaults.failure !== undefined) {
      decode.oneOf('ask', 'return', 'self-fix')(defaults.failure, 'failure');
    }
    if (defaults.commandId !== undefined) {
      decode.text(defaults.commandId, 'commandId');
    }

    return {
      id,
      ...sourceAt({ node: role.node, prompts: role.prompts }),
      defaults: defaults as StageRoleAnswers,
      ...(role.companion === undefined ? {} : { companion: sourceAt(role.companion) }),
    };
  })(catalog.roles, 'roles');

  if (roles.length > 6 || new Set(roles.map((role) => role.id)).size !== roles.length) {
    throw new Error('Повтор роли каталога');
  }

  return { schema: 1, roles };
}
