import type {
  DraftMachine,
  DraftNode,
  RouteTransitionDoc,
} from '../../../../shared/pipeline/routeDefinition.ts';
import type { RouteDraft } from '../../../../shared/pipeline/routesEditorContracts.ts';

export type RouteCommandScope = { kind: 'route'; routeId: string } | { kind: 'bootstrap' };
export type RunKeyFactory = (suggested: string, used: ReadonlySet<string>) => string;
export type NewExecutor = 'agent' | 'command' | 'gate' | 'status';

export interface RouteCommandIssue {
  code: string;
  message: string;
  path?: string;
}

export interface RouteCommandResult {
  draft: RouteDraft;
  issues: RouteCommandIssue[];
  createdNodeIds: string[];
}

export interface AddNodeOptions {
  ownerId?: string;
  template?: Record<string, unknown>;
}

/**
 * Выбирает граф и набор промптов для области редактирования.
 * Команда возвращает снимок и проблемы, не мутируя входной черновик.
 */
function documentAt(draft: RouteDraft, scope: RouteCommandScope): {
  machine: DraftMachine;
  prompts: Record<string, string>;
} | null {
  if (scope.kind === 'bootstrap') {
    return { machine: draft.bootstrap, prompts: draft.bootstrapPrompts };
  }

  const bundle = draft.routes[scope.routeId];

  return bundle ? { machine: bundle.route, prompts: bundle.prompts } : null;
}

function unchanged(draft: RouteDraft, code: string, message: string): RouteCommandResult {
  return {
    draft,
    issues: [{ code, message }],
    createdNodeIds: []
  };
}

/**
 * Переносит только поддерживаемые поля подписи из шаблона.
 * Команда возвращает снимок и проблемы, не мутируя входной черновик.
 */
function safeDisplay(template: Record<string, unknown> | undefined):
  Pick<DraftNode, 'label' | 'description'> {
  const display: Pick<DraftNode, 'label' | 'description'> = {};

  if (typeof template?.label === 'string') {
    display.label = template.label;
  }
  if (typeof template?.description === 'string') {
    display.description = template.description;
  }

  return display;
}

function safeExecutionFields() {
  return {
    policy: {
      filesystem: 'state-only',
      browser: 'forbid',
      timeoutClass: 'standard',
      budgetClass: 'standard'
    },
    fanout: {
      mode: 'single',
      maxExecutors: 1,
      degrade: 'forbid'
    },
    retry: {
      noResult: 0,
      productFailure: 0,
      providerFailure: { attempts: 0, strategy: 'none' }
    },
  };
}

function emptyOutcomes(): Record<string, null> {
  return {
    done: null,
    skipped: null,
    failed: null,
    exhausted: null
  };
}

/**
 * Добавляет узел указанного типа с безопасным ключом запуска.
 * Команда возвращает снимок и проблемы, не мутируя входной черновик.
 */
export function addNode(draft: RouteDraft, scope: RouteCommandScope, executor: NewExecutor,
  allocateRunKey: RunKeyFactory, options: AddNodeOptions = {}): RouteCommandResult {
  const copy = structuredClone(draft);
  const document = documentAt(copy, scope);

  if (!document) {
    return unchanged(draft, 'route_missing', 'Маршрут отсутствует в черновике.');
  }

  const { machine, prompts } = document;
  const used = new Set(machine.nodes.map((node) => node.runKey ?? node.key ?? ''));
  const runKey = allocateRunKey(executor.toUpperCase(), used);
  const id = runKey.toLowerCase();

  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(runKey)
    || machine.nodes.some((node) => node.id === id || node.runKey === runKey || node.key === runKey)) {
    return unchanged(draft, 'node_id_conflict', 'Ключ этапа уже занят или недопустим.');
  }

  let phase: 'bootstrap' | 'main' | 'tail' = scope.kind === 'bootstrap' ? 'bootstrap' : 'main';
  let node: DraftNode;

  if (executor === 'agent') {
    const file = `${scope.kind === 'bootstrap' ? 'bootstrap/' : ''}prompts/${id}.base.md`;

    node = {
      id,
      executor,
      phase,
      runKey,
      emits: [],
      prompt: { blocks: [{ file }], requiredContext: ['task'] },
      ...safeExecutionFields(),
      on: emptyOutcomes(),
      ...safeDisplay(options.template)
    };
    prompts[file] = '';
  } else if (executor === 'command') {
    node = {
      id,
      executor,
      phase,
      runKey,
      commandId: '',
      emits: [],
      ...safeExecutionFields(),
      on: emptyOutcomes(),
      ...safeDisplay(options.template)
    };
  } else if (executor === 'gate') {
    node = {
      id,
      executor,
      phase,
      runKey,
      emits: [],
      on: { approved: null, rejected: null },
      ...safeDisplay(options.template)
    };
  } else if (executor === 'status') {
    const owner = machine.nodes.find((candidate) => candidate.id === options.ownerId
      && candidate.executor !== 'status');

    if (!owner) {
      return unchanged(draft, 'owner_required', 'Выберите исполняемый этап-владелец статуса.');
    }

    phase = owner.phase as 'bootstrap' | 'main' | 'tail';
    node = {
      id,
      executor,
      phase,
      key: runKey,
      owner: owner.id,
      ...safeDisplay(options.template)
    };
    owner.emits = [...(owner.emits ?? []), id];
  } else {
    return unchanged(draft, 'executor_unavailable', 'Этот тип этапа пока нельзя добавить.');
  }

  machine.nodes.push(node);

  if (executor !== 'status') {
    machine.sequence[phase] ??= [];
    machine.sequence[phase]?.push(id);

    if (machine.entry === null) {
      machine.entry = id;
    }
  }

  return {
    draft: copy,
    issues: [],
    createdNodeIds: [id]
  };
}

/**
 * Создаёт независимые копии выбранных узлов.
 * Команда возвращает снимок и проблемы, не мутируя входной черновик.
 */
export function cloneNodes(draft: RouteDraft, _scope: RouteCommandScope, _nodeIds: string[],
  _allocateRunKey: RunKeyFactory): RouteCommandResult {
  const copy = structuredClone(draft);
  const document = documentAt(copy, _scope);

  if (!document) {
    return unchanged(draft, 'route_missing', 'Маршрут отсутствует в черновике.');
  }

  const { machine, prompts } = document;
  const selected = _nodeIds.map((id) => machine.nodes.find((node) => node.id === id));

  if (selected.some((node) => !node) || new Set(_nodeIds).size !== _nodeIds.length) {
    return unchanged(draft, 'node_missing', 'Один из выбранных этапов отсутствует или повторён.');
  }

  const usedKeys = new Set(machine.nodes.map((node) => node.runKey ?? node.key ?? ''));
  const usedIds = new Set(machine.nodes.map((node) => node.id));
  const ids = new Map<string, { id: string; key: string }>();

  for (const node of selected as DraftNode[]) {
    const key = _allocateRunKey(node.runKey ?? node.key ?? node.id.toUpperCase(), usedKeys);
    const id = key.toLowerCase();

    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || usedKeys.has(key) || usedIds.has(id)) {
      return unchanged(draft, 'node_id_conflict', 'Ключ копии уже занят или недопустим.');
    }

    usedKeys.add(key);
    usedIds.add(id);
    ids.set(node.id, { id, key });
  }

  const issues: RouteCommandIssue[] = [];
  const copiedPromptFiles = new Map<string, string>();
  const cloned: DraftNode[] = [];
  const external = (path: string, target: string): void => {
    issues.push({
      code: 'external_reference',
      message: `Связь с этапом «${target}» осталась за пределами копии.`,
      path
    });
  };

  for (const source of selected as DraftNode[]) {
    const target = ids.get(source.id)!;
    const node = structuredClone(source);

    node.id = target.id;

    if (node.executor === 'status') {
      node.key = target.key;
    }
    else {
      node.runKey = target.key;
    }
    if (node.owner) {
      if (ids.has(node.owner)) {
        node.owner = ids.get(node.owner)!.id;
      }
      else {
        external(`nodes.${node.id}.owner`, node.owner);
      }
    }

    node.emits = node.emits?.map((id) => {
      if (ids.has(id)) {
        return ids.get(id)!.id;
      }

      external(`nodes.${node.id}.emits`, id);

      return id;
    });

    for (const [groupName, group] of [['on', node.on], ['onFailure', node.onFailure]] as const) {
      if (!group) {
        continue;
      }

      for (const [outcome, transition] of Object.entries(group)) {
        if (!transition) {
          continue;
        }

        const path = `nodes.${node.id}.${groupName}.${outcome}`;

        for (const field of ['next', 'rewind'] as const) {
          const targetId = transition[field];

          if (!targetId) {
            continue;
          }
          if (ids.has(targetId)) {
            transition[field] = ids.get(targetId)!.id;
          }
          else {
            external(`${path}.${field}`, targetId);
          }
        }

        if (transition.reset) {
          transition.reset = transition.reset.map((id) => {
          if (ids.has(id)) {
            return ids.get(id)!.id;
          }

          external(`${path}.reset`, id);

          return id;
        });
        }
      }
    }
    for (let index = 0; index < (node.prompt?.blocks.length ?? 0); index++) {
      const block = node.prompt!.blocks[index];

      if (!block) {
        continue;
      }

      let newFile = copiedPromptFiles.get(block.file);

      if (!newFile) {
        const prefix = _scope.kind === 'bootstrap' ? 'bootstrap/prompts/' : 'prompts/';
        const name = block.file.split('/').at(-1) ?? '';
        const suffix = name.startsWith(`${source.id}.`) ? name.slice(source.id.length + 1)
          : `block${index + 1}.md`;

        newFile = `${prefix}${node.id}.${suffix}`;

        let counter = 2;

        while (Object.hasOwn(prompts, newFile)) {
          newFile = `${prefix}${node.id}.${counter}.${suffix}`;
          counter += 1;
        }

        copiedPromptFiles.set(block.file, newFile);
        prompts[newFile] = prompts[block.file] ?? '';
      }

      block.file = newFile;
    }

    cloned.push(node);
  }
  for (const node of cloned) {
    machine.nodes.push(node);

    if (node.executor !== 'status') {
      const phase = node.phase as 'bootstrap' | 'main' | 'tail';

      machine.sequence[phase] ??= [];
      machine.sequence[phase]?.push(node.id);
    }
  }
  for (const record of [...machine.escalation]) {
    const target = ids.get(record.from);

    if (target) {
      machine.escalation.push({ ...record, from: target.id });
    }
  }

  return {
    draft: copy,
    issues,
    createdNodeIds: cloned.map((node) => node.id)
  };
}

/**
 * Меняет тип узла с контролем несовместимых полей.
 * Команда возвращает снимок и проблемы, не мутируя входной черновик.
 */
export function changeNodeExecutor(draft: RouteDraft, scope: RouteCommandScope,
  nodeId: string, executor: NewExecutor, acceptLoss = false): RouteCommandResult {
  const source = documentAt(draft, scope)?.machine.nodes.find((node) => node.id === nodeId);

  if (!source) {
    return unchanged(draft, 'node_missing', 'Этап отсутствует в черновике.');
  }
  if (source.executor === executor) {
    return {
      draft,
      issues: [],
      createdNodeIds: []
    };
  }
  if (source.executor !== 'agent' || executor !== 'command') {
    return unchanged(draft, 'executor_change_unavailable', 'Смена этого типа этапа пока недоступна.');
  }

  const prompts = documentAt(draft, scope)!.prompts;
  const text = source.prompt?.blocks.map((block) => prompts[block.file] ?? '').join('\n') ?? '';
  const issues: RouteCommandIssue[] = [{
    code: 'text_loss',
    path: `nodes.${nodeId}.prompt`,
    message: `Инструкция будет отсоединена от этапа: ${text}`
  }];
  const defaults = safeExecutionFields();

  if (source.fanout && JSON.stringify(source.fanout) !== JSON.stringify(defaults.fanout)) {
    issues.push({
      code: 'fanout_reset',
      path: `nodes.${nodeId}.fanout`,
      message: 'parallel и прежние настройки fanout будут сброшены: command исполняется одним процессом.'
    });
  }
  if (source.retry && JSON.stringify(source.retry) !== JSON.stringify(defaults.retry)) {
    issues.push({
      code: 'retry_reset',
      path: `nodes.${nodeId}.retry`,
      message: 'Повторы будут сброшены: command всегда создаётся с нулевым retry.'
    });
  }
  if (source.policy?.filesystem === 'transactional-write') {
    issues.push({
      code: 'policy_reset',
      path: `nodes.${nodeId}.policy.filesystem`,
      message: 'Файловая политика transactional-write будет заменена на state-only.'
    });
  }
  if (!acceptLoss) {
    return {
      draft,
      issues,
      createdNodeIds: []
    };
  }

  const copy = structuredClone(draft);
  const machine = documentAt(copy, scope)!.machine;
  const index = machine.nodes.findIndex((node) => node.id === nodeId);
  const node = machine.nodes[index]!;

  machine.nodes[index] = {
    id: node.id,
    executor: 'command',
    phase: node.phase,
    runKey: node.runKey,
    ...(node.label !== undefined ? { label: node.label } : {}),
    ...(node.description !== undefined ? { description: node.description } : {}),
    commandId: '',
    emits: node.emits,
    policy: node.policy?.filesystem === 'transactional-write'
      ? { ...node.policy, filesystem: 'state-only' } : node.policy,
    fanout: defaults.fanout,
    retry: defaults.retry,
    on: node.on,
    ...(node.onFailure ? { onFailure: node.onFailure } : {}),
  };

  return {
    draft: copy,
    issues,
    createdNodeIds: []
  };
}

/**
 * Меняет идентификатор узла и связанные ссылки.
 * Команда возвращает снимок и проблемы, не мутируя входной черновик.
 */
export function renameNode(draft: RouteDraft, _scope: RouteCommandScope,
  _nodeId: string, _nextId: string): RouteCommandResult {
  const copy = structuredClone(draft);
  const machine = documentAt(copy, _scope)?.machine;

  if (!machine) {
    return unchanged(draft, 'route_missing', 'Маршрут отсутствует в черновике.');
  }

  const node = machine.nodes.find((candidate) => candidate.id === _nodeId);

  if (!node) {
    return unchanged(draft, 'node_missing', 'Этап отсутствует в черновике.');
  }
  if (_nodeId === _nextId) {
    return {
      draft,
      issues: [],
      createdNodeIds: []
    };
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(_nextId) || _nextId === 'catalog'
    || machine.nodes.some((candidate) => candidate.id === _nextId)) {
    return unchanged(draft, 'node_id_conflict', 'Новый ID этапа занят или недопустим.');
  }

  const special = new Set(['ship', 'instrument', 'proof']);

  if (special.has(_nodeId) || special.has(_nextId)) {
    return unchanged(draft, 'semantic_node_id', 'Особый ID этапа нельзя переименовать обычной командой.');
  }

  node.id = _nextId;

  if (node.executor === 'status') {
    node.key = _nextId.toUpperCase();
  }
  else {
    node.runKey = _nextId.toUpperCase();
  }

  eachNodeReference(machine, (reference) => {
    if (reference.target === _nodeId) {
      reference.set(_nextId);
    }
  });

  const oldPosition = _scope.kind === 'bootstrap'
    ? `b:${_nodeId}` : `r:${_scope.routeId}:${_nodeId}`;
  const newPosition = _scope.kind === 'bootstrap'
    ? `b:${_nextId}` : `r:${_scope.routeId}:${_nextId}`;

  if (Object.hasOwn(copy.presentation, oldPosition)) {
    copy.presentation[newPosition] = copy.presentation[oldPosition];
    delete copy.presentation[oldPosition];
  }

  return {
    draft: copy,
    issues: [],
    createdNodeIds: []
  };
}

/**
 * Обновляет краткую подпись узла в допустимом размере.
 * Команда возвращает снимок и проблемы, не мутируя входной черновик.
 */
export function setNodeLabel(draft: RouteDraft, scope: RouteCommandScope,
  nodeId: string, label: string): RouteCommandResult {
  if (label.length > 500) {
    return unchanged(draft, 'label_too_long', 'Название этапа слишком длинное.');
  }

  const copy = structuredClone(draft);
  const node = documentAt(copy, scope)?.machine.nodes.find((candidate) => candidate.id === nodeId);

  if (!node) {
    return unchanged(draft, 'node_missing', 'Этап отсутствует в черновике.');
  }

  node.label = label;

  return {
    draft: copy,
    issues: [],
    createdNodeIds: []
  };
}

/**
 * Обновляет подробное описание узла в допустимом размере.
 * Команда возвращает снимок и проблемы, не мутируя входной черновик.
 */
export function setNodeDescription(draft: RouteDraft, scope: RouteCommandScope,
  nodeId: string, description: string): RouteCommandResult {
  if (description.length > 4000) {
    return unchanged(draft, 'description_too_long', 'Описание этапа слишком длинное.');
  }

  const copy = structuredClone(draft);
  const node = documentAt(copy, scope)?.machine.nodes.find((item) => item.id === nodeId);

  if (!node) {
    return unchanged(draft, 'node_missing', 'Этап отсутствует в черновике.');
  }
  if (description) {
    node.description = description;
  }
  else {
    delete node.description;
  }

  return {
    draft: copy,
    issues: [],
    createdNodeIds: []
  };
}

/**
 * Меняет ключ запуска узла с проверкой уникальности.
 * Команда возвращает снимок и проблемы, не мутируя входной черновик.
 */
export function setNodeRunKey(draft: RouteDraft, scope: RouteCommandScope,
  nodeId: string, runKey: string): RouteCommandResult {
  const copy = structuredClone(draft);
  const machine = documentAt(copy, scope)?.machine;
  const node = machine?.nodes.find((item) => item.id === nodeId);

  if (!node) {
    return unchanged(draft, 'node_missing', 'Этап отсутствует в черновике.');
  }
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(runKey)
    || machine?.nodes.some((item) => item.id !== nodeId
      && (item.runKey === runKey || item.key === runKey))) {
    return unchanged(draft, 'run_key_invalid', 'Ключ запуска недопустим или уже занят.');
  }
  if (node.executor === 'status') {
    node.key = runKey;
  }
  else {
    node.runKey = runKey;
  }

  return {
    draft: copy,
    issues: [],
    createdNodeIds: []
  };
}

/**
 * Удаляет связь со status из исходов узла.
 * Команда возвращает снимок и проблемы, не мутируя входной черновик.
 */
export function removeEmitReference(draft: RouteDraft, scope: RouteCommandScope,
  nodeId: string, statusId: string): RouteCommandResult {
  const copy = structuredClone(draft);
  const machine = documentAt(copy, scope)?.machine;
  const node = machine?.nodes.find((item) => item.id === nodeId);

  if (!node || node.executor === 'status' || !node.emits?.includes(statusId)) {
    return unchanged(draft, 'emit_missing', 'Ссылка на статус отсутствует.');
  }
  if (machine?.nodes.some((item) => item.id === statusId && item.owner === nodeId)) {
    return unchanged(draft, 'status_still_owned',
      'Живой статус принадлежит этому этапу: сначала переназначьте или удалите его.');
  }

  node.emits = node.emits.filter((id) => id !== statusId);

  return {
    draft: copy,
    issues: [],
    createdNodeIds: []
  };
}

type NodeReference = {
  target: string;
  relation: 'entry' | 'sequence' | 'transition' | 'reset' | 'owner' | 'emits' | 'escalation' | 'loop';
  path: string;
  sourceId?: string;
  set: (value: string) => void;
};

/**
 * Обходит входящие и внутренние ссылки на узлы графа.
 * Команда возвращает снимок и проблемы, не мутируя входной черновик.
 */
function eachNodeReference(machine: DraftMachine, visit: (reference: NodeReference) => void): void {
  if (machine.entry) {
    visit({
      target: machine.entry,
      relation: 'entry',
      path: 'entry',
      set: (value) => {
         machine.entry = value;
      }
    });
  }

  // Роли цикла — такие же ссылки на этапы: переименование обязано их перенести,
  // а удаление ведущего или исполнителя без новой цели — назвать висячую связь.
  const loop = machine.loop;

  if (loop) {
    for (const role of ['lead', 'worker'] as const) {
      visit({
        target: loop[role],
        relation: 'loop',
        path: `loop.${role}`,
        set: (value) => {
          loop[role] = value;
        }
      });
    }
  }

  for (const phase of ['bootstrap', 'main', 'tail'] as const) {
    const sequence = machine.sequence[phase];

    sequence?.forEach((target, index) => visit({
      target,
      relation: 'sequence',
      path: `sequence.${phase}.${index}`,
      set: (value) => {
         sequence[index] = value;
      }
    }));
  }
  for (const node of machine.nodes) {
    if (node.owner) {
      visit({
        target: node.owner,
        relation: 'owner',
        sourceId: node.id,
      path: `nodes.${node.id}.owner`,
        set: (value) => {
         node.owner = value;
      }
      });
    }

    node.emits?.forEach((target, index) => visit({
      target,
      relation: 'emits',
      sourceId: node.id,
      path: `nodes.${node.id}.emits.${index}`,
      set: (value) => {
         node.emits![index] = value;
      }
    }));

    for (const groupName of ['on', 'onFailure'] as const) {
      const group = node[groupName];

      if (!group) {
        continue;
      }

      for (const [outcome, transition] of Object.entries(group)) {
        if (!transition) {
          continue;
        }

        const prefix = `nodes.${node.id}.${groupName}.${outcome}`;

        for (const field of ['next', 'rewind'] as const) {
          const target = transition[field];

          if (!target) {
            continue;
          }

          visit({
            target,
            relation: 'transition',
            sourceId: node.id,
            path: `${prefix}.${field}`,
            set: (value) => {
               transition[field] = value;
            }
          });
        }

        transition.reset?.forEach((target, index) => visit({
          target,
          relation: 'reset',
          sourceId: node.id,
          path: `${prefix}.reset.${index}`,
          set: (value) => {
             transition.reset![index] = value;
          }
        }));
      }
    }
  }

  machine.escalation.forEach((record, index) => visit({
    target: record.from,
    relation: 'escalation',
    path: `escalation.${index}.from`,
    set: (value) => {
       record.from = value;
    }
  }));
}

export interface NodeReferenceInfo {
  target: string;
  relation: NodeReference['relation'];
  path: string;
  sourceId?: string;
}

export interface PromptReferenceInfo {
  file: string;
  selectedUsers: string[];
  otherUsers: string[];
}

export interface NodeInspection {
  references: NodeReferenceInfo[];
  promptFiles: PromptReferenceInfo[];
}

/**
 * Показывает зависимости перед удалением узлов.
 * Команда возвращает снимок и проблемы, не мутируя входной черновик.
 */
export function inspectNodeReferences(draft: RouteDraft, scope: RouteCommandScope,
  nodeIds: string[]): NodeInspection {
  const document = documentAt(draft, scope);

  if (!document) {
    return { references: [], promptFiles: [] };
  }

  const selected = new Set(nodeIds);
  const references: NodeReferenceInfo[] = [];

  eachNodeReference(document.machine, ({ set: _set, ...reference }) => {
    if (selected.has(reference.target)) {
      references.push(reference);
    }
  });

  const users = new Map<string, { selectedUsers: string[]; otherUsers: string[] }>();

  for (const node of document.machine.nodes) {
    for (const block of node.prompt?.blocks ?? []) {
      const item = users.get(block.file) ?? { selectedUsers: [], otherUsers: [] };
      const list = selected.has(node.id) ? item.selectedUsers : item.otherUsers;

      if (!list.includes(node.id)) {
        list.push(node.id);
      }

      users.set(block.file, item);
    }
  }

  const promptFiles = [...users].filter(([, item]) => item.selectedUsers.length > 0)
    .map(([file, item]) => ({ file, ...item }));

  return { references, promptFiles };
}

export interface RemoveNodesOptions {
  retarget?: Record<string, string>;
  deletePromptFiles?: string[];
}

/**
 * Удаляет узлы, разрешая или сообщая о затронутых ссылках.
 * Команда возвращает снимок и проблемы, не мутируя входной черновик.
 */
export function removeNodes(draft: RouteDraft, scope: RouteCommandScope,
  nodeIds: string[], options: RemoveNodesOptions = {}): RouteCommandResult {
  const copy = structuredClone(draft);
  const document = documentAt(copy, scope);

  if (!document) {
    return unchanged(draft, 'route_missing', 'Маршрут отсутствует в черновике.');
  }

  const { machine, prompts } = document;
  const selected = new Set(nodeIds);

  if (selected.size !== nodeIds.length
    || nodeIds.some((id) => !machine.nodes.some((node) => node.id === id))) {
    return unchanged(draft, 'node_missing', 'Один из выбранных этапов отсутствует или повторён.');
  }

  for (const target of Object.values(options.retarget ?? {})) {
    if (selected.has(target) || !machine.nodes.some((node) => node.id === target)) {
      return unchanged(draft, 'retarget_invalid', 'Новая цель должна существовать вне удаления.');
    }
  }

  const inspection = inspectNodeReferences(copy, scope, nodeIds);

  machine.nodes = machine.nodes.filter((node) => !selected.has(node.id));

  for (const phase of ['bootstrap', 'main', 'tail'] as const) {
    if (machine.sequence[phase]) {
      machine.sequence[phase] = machine.sequence[phase]!.filter((id) => !selected.has(id));
    }
  }

  if (machine.entry && selected.has(machine.entry)) {
    machine.entry = options.retarget?.[machine.entry] ?? null;
  }

  const issues: RouteCommandIssue[] = [];

  eachNodeReference(machine, (reference) => {
    if (!selected.has(reference.target)) {
      return;
    }

    const replacement = options.retarget?.[reference.target];

    if (replacement) {
      reference.set(replacement);
    }
    else {
      issues.push({
        code: 'dangling_reference',
        path: reference.path,
      message: `Связь с удалённым этапом «${reference.target}» требует решения.`
      });
    }
  });

  for (const file of options.deletePromptFiles ?? []) {
    const info = inspection.promptFiles.find((item) => item.file === file);

    if (!info || info.otherUsers.length > 0) {
      issues.push({
        code: 'prompt_shared',
        path: file,
        message: `Файл «${file}» используется другим этапом или не был показан.`
      });
      continue;
    }

    delete prompts[file];
  }

  return {
    draft: copy,
    issues,
    createdNodeIds: []
  };
}

/**
 * Меняет действие для выбранного исхода узла.
 * Команда возвращает снимок и проблемы, не мутируя входной черновик.
 */
export function setTransition(draft: RouteDraft, scope: RouteCommandScope,
  nodeId: string, outcome: string, transition: RouteTransitionDoc | null,
  group: 'on' | 'onFailure' = 'on'): RouteCommandResult {
  if (transition !== null) {
    const modes = ['next', 'rewind', 'stop', 'escalate'].filter((key) =>
      Object.hasOwn(transition, key));
    const expected = modes[0] === 'rewind' ? ['rewind', 'reset'] : modes;

    if (modes.length !== 1 || Object.keys(transition).some((key) => !expected.includes(key))) {
      return unchanged(draft, 'transition_action_invalid', 'Выберите ровно одно действие исхода.');
    }
    if (transition.stop !== undefined
      && !['human', 'failed', 'done'].includes(transition.stop)) {
      return unchanged(draft, 'transition_action_invalid', 'Недопустимый вид остановки.');
    }
  }

  const copy = structuredClone(draft);
  const machine = documentAt(copy, scope)?.machine;

  if (!machine) {
    return unchanged(draft, 'route_missing', 'Маршрут отсутствует в черновике.');
  }

  const node = machine.nodes.find((candidate) => candidate.id === nodeId);

  if (!node || node.executor === 'status' || !node[group]
    || !Object.hasOwn(node[group], outcome)) {
    return unchanged(draft, 'outcome_missing', 'Исход отсутствует у выбранного этапа.');
  }

  let next = transition === null ? null : structuredClone(transition);

  if (next?.next !== undefined && next.next !== '') {
    const target = machine.nodes.find((candidate) => candidate.id === next!.next);

    if (!target || target.executor === 'status') {
      return unchanged(draft, target ? 'status_target' : 'target_missing',
        'Цель перехода должна быть исполняемым этапом.');
    }
  }
  if (next?.escalate !== undefined) {
    const allowed = machine.escalation.find((record) => record.from === nodeId)?.allowedRoutes ?? [];
    const routes = next.escalate.routes;

    if (!Array.isArray(routes) || new Set(routes).size !== routes.length
      || routes.some((routeId) => !allowed.includes(routeId))) {
      return unchanged(draft, 'escalation_route_unavailable',
        'Цель смены маршрута должна входить в разрешённый список этапа.');
    }
  }
  if (next?.rewind !== undefined && next.rewind !== '') {
    const order = [
      ...(machine.sequence.bootstrap ?? []),
      ...(machine.sequence.main ?? []),
      ...(machine.sequence.tail ?? []),
    ];
    const from = order.indexOf(next.rewind);
    const to = order.indexOf(nodeId);

    if (from < 0 || to < 0 || from >= to) {
      return unchanged(draft, 'rewind_target_invalid',
        'Цель возврата должна быть более ранним исполняемым этапом.');
    }

    next = { rewind: next.rewind, reset: order.slice(from, to + 1) };
  }

  node[group]![outcome] = next;

  return {
    draft: copy,
    issues: [],
    createdNodeIds: []
  };
}

/**
 * Переставляет стадию и согласует порядок графа.
 * Команда возвращает снимок и проблемы, не мутируя входной черновик.
 */
export function moveStage(draft: RouteDraft, scope: RouteCommandScope,
  nodeId: string, phase: 'bootstrap' | 'main' | 'tail', index: number): RouteCommandResult {
  if ((scope.kind === 'bootstrap' && phase !== 'bootstrap')
    || (scope.kind === 'route' && phase === 'bootstrap') || !Number.isInteger(index)) {
    return unchanged(draft, 'phase_invalid', 'Недопустимая фаза или позиция этапа.');
  }

  const copy = structuredClone(draft);
  const machine = documentAt(copy, scope)?.machine;

  if (!machine) {
    return unchanged(draft, 'route_missing', 'Маршрут отсутствует в черновике.');
  }

  const node = machine.nodes.find((candidate) => candidate.id === nodeId);

  if (!node || node.executor === 'status') {
    return unchanged(draft, 'node_missing', 'Исполняемый этап отсутствует.');
  }

  for (const key of ['bootstrap', 'main', 'tail'] as const) {
    if (machine.sequence[key]) {
      machine.sequence[key] = machine.sequence[key]!.filter((id) => id !== nodeId);
    }
  }

  node.phase = phase;

  for (const status of machine.nodes.filter((candidate) => candidate.owner === nodeId)) {
    status.phase = phase;
  }

  const destination = machine.sequence[phase] ?? [];

  destination.splice(Math.max(0, Math.min(index, destination.length)), 0, nodeId);
  machine.sequence[phase] = destination;

  const order = [
    ...(machine.sequence.bootstrap ?? []),
    ...(machine.sequence.main ?? []),
    ...(machine.sequence.tail ?? []),
  ];
  const issues: RouteCommandIssue[] = [];

  for (const source of machine.nodes) {
    for (const groupName of ['on', 'onFailure'] as const) {
      for (const [outcome, transition] of Object.entries(source[groupName] ?? {})) {
        if (!transition) {
          continue;
        }

        const prefix = `nodes.${source.id}.${groupName}.${outcome}`;
        const from = order.indexOf(source.id);

        if (transition.next !== undefined && order.indexOf(transition.next) <= from) {
          issues.push({
            code: 'next_backwards',
            path: `${prefix}.next`,
            message: `Переход «${outcome}» теперь направлен назад; выберите новое действие.`
          });
        }
        if (transition.rewind !== undefined) {
          const to = order.indexOf(transition.rewind);

          if (to < 0 || from < 0 || to >= from) {
            issues.push({
              code: 'rewind_target_invalid',
              path: `${prefix}.rewind`,
              message: 'После перестановки цель возврата больше не находится раньше источника.'
            });
          } else {
            transition.reset = order.slice(to, from + 1);
          }
        }
      }
    }
  }

  return {
    draft: copy,
    issues,
    createdNodeIds: []
  };
}

/**
 * Включает или выключает маршрутизацию при ошибке.
 * Команда возвращает снимок и проблемы, не мутируя входной черновик.
 */
export function setFailureRoutes(draft: RouteDraft, scope: RouteCommandScope,
  nodeId: string, enabled: boolean): RouteCommandResult {
  const copy = structuredClone(draft);
  const node = documentAt(copy, scope)?.machine.nodes.find((candidate) => candidate.id === nodeId);

  if (!node || (node.executor !== 'agent' && node.executor !== 'command')) {
    return unchanged(draft, 'node_missing', 'Ветки отказов поддерживает только agent или command.');
  }
  if (enabled) {
    node.onFailure = Object.fromEntries([
      'build', 'tests', 'environment', 'plan', 'human',
    ].map((owner) => [owner, node.onFailure?.[owner] ?? null]));
  } else {
    delete node.onFailure;
  }

  return {
    draft: copy,
    issues: [],
    createdNodeIds: []
  };
}

/**
 * Настраивает переход к маршрутам и решение человека при пине.
 * Команда возвращает снимок и проблемы, не мутируя входной черновик.
 */
export function setEscalation(draft: RouteDraft, scope: RouteCommandScope,
  from: string, allowedRoutes: string[], requiresHumanWhenPinned: boolean): RouteCommandResult {
  const copy = structuredClone(draft);
  const machine = documentAt(copy, scope)?.machine;

  if (!machine || !machine.nodes.some((node) => node.id === from && node.executor !== 'status')) {
    return unchanged(draft, 'node_missing', 'Источник смены маршрута должен исполняться.');
  }
  if (new Set(allowedRoutes).size !== allowedRoutes.length
    || allowedRoutes.some((routeId) => !Object.hasOwn(copy.routes, routeId))) {
    return unchanged(draft, 'escalation_route_unavailable',
      'Разрешённый маршрут должен существовать в черновом каталоге.');
  }

  const record = {
    from,
    allowedRoutes: [...allowedRoutes],
    requiresHumanWhenPinned
  };
  const index = machine.escalation.findIndex((candidate) => candidate.from === from);

  if (index < 0) {
    machine.escalation.push(record);
  }
  else {
    machine.escalation[index] = record;
  }

  return {
    draft: copy,
    issues: [],
    createdNodeIds: []
  };
}
