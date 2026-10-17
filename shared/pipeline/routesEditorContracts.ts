import type { DraftMachine } from './routeDefinition.ts';

export const ROUTES_EDITOR_LIMITS = {
  promptFileBytes: 1024 * 1024,
  promptBundleBytes: 8 * 1024 * 1024,
  draftBytes: 64 * 1024 * 1024,
  patchBytes: 64 * 1024 * 1024,
  importBytes: 64 * 1024 * 1024,
  routes: 64,
  nodes: 512,
  promptBlocks: 128,
  operations: 128,
  simulationSteps: 200,
  // Маршрут с циклом: потолок до 300 кругов — это 601 шаг до остановки `loop-ceiling`
  // (передача и ответ исполнителя на каждый круг), с запасом на ворота и решения человека.
  loopSimulationSteps: 1200,
  loopMaxRounds: 300,
  undoCommands: 100,
} as const;

// Потолок кругов по умолчанию — тот же, что у движка без строки в профиле.
export const ROUTES_LOOP_DEFAULT_MAX_ROUNDS = 20;

/** Предел шагов пробного сценария: у маршрута с циклом он вмещает весь потолок кругов. */
export function routeSimulationStepLimit(loopMaxRounds: number | null | undefined): number {
  return loopMaxRounds === null || loopMaxRounds === undefined
    ? ROUTES_EDITOR_LIMITS.simulationSteps
    : ROUTES_EDITOR_LIMITS.loopSimulationSteps;
}

export interface RoutePublication {
  operationId: string;
  requestHash: string;
  draftId: string;
  draftRevision: number;
  fromCatalogHash: string | null;
  toCatalogHash: string;
  sourceRevision: number;
  state: 'committed' | 'aborted';
  currentChanged: boolean;
  createdAt: string;
  comment?: string;
}

export interface RouteDraftContent {
  routes: Record<string, { route: DraftMachine; prompts: Record<string, string> }>;
  bootstrap: DraftMachine;
  bootstrapPrompts: Record<string, string>;
  presentation: Record<string, unknown>;
  provenance: Record<string, unknown>;
}

export interface RouteTransferBundle {
  format: 'cockpit-route-authoring';
  schema: 1;
  sourceProfile: string;
  content: RouteDraftContent;
  dependencies: string[];
}

export interface RouteDraft extends RouteDraftContent {
  schema: 1;
  id: string;
  profile: string;
  title: string;
  revision: number;
  baseCatalogHash: string | null;
  baseSourceRevision: number;
  state: 'editing' | 'published' | 'archived';
  createdAt: string;
  updatedAt: string;
  publication: RoutePublication | null;
}

export interface RouteDraftSummary {
  id: string;
  profile: string;
  title: string;
  revision: number;
  baseCatalogHash: string | null;
  state: RouteDraft['state'];
  updatedAt: string;
}

export interface RouteTransferImportResult {
  draft: RouteDraft;
  cancelled?: boolean;
  unresolvedDependencies: string[];
  issues: RouteEditorIssue[];
}

export interface RouteEditorIssue {
  code: string;
  severity: 'error' | 'warning';
  scope: 'catalog' | 'bootstrap' | 'route' | 'profile';
  routeId: string | null;
  nodeId: string | null;
  path: string;
  message: string;
}

export interface RouteDraftValidationReport {
  draftId: string;
  draftRevision: number;
  capabilitiesHash: string | null;
  issues: RouteEditorIssue[];
}

export interface RouteCompareChange {
  scope: 'route' | 'bootstrap';
  routeId: string | null;
  kind: 'added' | 'removed' | 'changed';
  before: unknown | null;
  after: unknown | null;
  fields: Array<{
    path: string;
    kind: 'added' | 'removed' | 'changed';
    before: unknown | null;
    after: unknown | null;
  }>;
}

export interface RouteCompareReport {
  draftId: string;
  draftRevision: number;
  currentCatalogHash: string | null;
  sourceMode: 'profile-script' | 'editor';
  sourceRevision: number;
  capabilitiesHash: string | null;
  changes: RouteCompareChange[];
  presentationChanges?: RouteCompareChange['fields'];
}

export interface RouteRevisionCompareReport {
  fromCatalogHash: string;
  toCatalogHash: string;
  changes: RouteCompareChange[];
  presentationChanges: RouteCompareChange['fields'];
}

export interface RouteRebaseResolution {
  scope: 'route' | 'bootstrap';
  routeId: string | null;
  choice: 'mine' | 'current';
}

export interface RouteRebaseConflict {
  scope: 'route' | 'bootstrap';
  routeId: string | null;
  base: unknown | null;
  mine: unknown | null;
  current: unknown | null;
}

export interface RouteRebasePreview {
  draftId: string;
  draftRevision: number;
  baseCatalogHash: string | null;
  currentCatalogHash: string;
  conflicts: RouteRebaseConflict[];
}

export interface RoutePromptPreviewResponse {
  draftRevision: number;
  text: string;
  includedBlocks: string[];
  excludedBlocks: string[];
  issues: Array<{ code: string; path: string; message: string;
    severity?: string }>;
}

export interface RouteSimulationCursor {
  scope: 'route' | 'bootstrap';
  routeId: string | null;
  nodeId: string;
  terminal: boolean;
}

export interface RouteSimulationCounters {
  noResult: Record<string, number>;
  productFailure: Record<string, number>;
  rewinds: Record<string, number>;
}

export interface RouteSimulationStepRequest {
  expectedRevision: number;
  cursor: RouteSimulationCursor;
  counters: RouteSimulationCounters;
  outcome: string;
  failureOwner: string | null;
  selectedRouteId: string | null;
  pinned: boolean;
  humanApproved: boolean;
  stepIndex: number;
  // Потолок кругов цикла (1..300): живёт в профиле, поэтому сценарий передаёт его явно.
  // Только для маршрута с `loop`; без поля движок считает по умолчанию 20.
  loopMaxRounds?: number;
}

export interface RouteSimulationStepResponse {
  draftRevision: number;
  ok: boolean;
  action?: Record<string, unknown>;
  cursor?: RouteSimulationCursor;
  counters?: RouteSimulationCounters;
  reset?: string[];
  stop?: string | null;
  escalation?: string[] | null;
  requiresHuman?: boolean;
  issues: Array<{ code: string; path: string; message: string }>;
}

export interface RouteEditorInfo {
  profile: string;
  source: { mode: 'profile-script' | 'editor'; revision: number };
  currentCatalogHash: string | null;
  capabilitiesHash: string | null;
  capabilities: {
    schema: 1;
    commands: Array<{ id: string; label: string; filesystem: string[] }>;
    contextSections: Array<{ id: string; label: string }>;
    filesystem: string[];
    timeoutClasses: string[];
    retryStrategies: string[];
  };
  issues: RouteEditorIssue[];
}

export interface RouteEffectivePolicy {
  runKey: string;
  primary: string | null;
  failover: string[];
  source: string;
  models: Record<string, {
    exact: string | null;
    family: string | null;
    version: string | null;
    variant: string | null;
    effort: string | null;
  } | null>;
}

export type DraftOperation =
  | { kind: 'setTitle'; title: string }
  | { kind: 'putRoute'; routeId: string; route: DraftMachine; prompts: Record<string, string> }
  | { kind: 'removeRoute'; routeId: string }
  | { kind: 'putBootstrap'; bootstrap: DraftMachine; prompts: Record<string, string> }
  | { kind: 'putPresentation'; presentation: Record<string, unknown> }
  | { kind: 'putProvenance'; provenance: Record<string, unknown> };

export class RoutesEditorContractError extends Error {
  constructor(path: string) {
    super(`Некорректный документ редактора маршрутов: поле ${path}`);
    this.name = 'RoutesEditorContractError';
  }
}

/**
 * Проверяет полный набор ключей и возвращает исходный объект без потери полей.
 * Этот decoder намеренно строже общего contractDecoders.objectOf().
 */
function recordAt(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RoutesEditorContractError(path);
  }

  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);

  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new RoutesEditorContractError(`${path}.${key}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) {
      throw new RoutesEditorContractError(`${path}.${key}`);
    }
  }

  return record;
}

function stringAt(value: unknown, path: string): void {
  if (typeof value !== 'string') {
    throw new RoutesEditorContractError(path);
  }
}

function uuidAt(value: unknown, path: string): void {
  if (typeof value !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) {
    throw new RoutesEditorContractError(path);
  }
}

function hashAt(value: unknown, path: string): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new RoutesEditorContractError(path);
  }
}

function dateAt(value: unknown, path: string): void {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    || Number.isNaN(Date.parse(value))) {
    throw new RoutesEditorContractError(path);
  }
}

function integerAt(value: unknown, min: number, path: string): void {
  if (!Number.isInteger(value) || Number(value) < min) {
    throw new RoutesEditorContractError(path);
  }
}

function booleanAt(value: unknown, path: string): void {
  if (typeof value !== 'boolean') {
    throw new RoutesEditorContractError(path);
  }
}

function enumAt(value: unknown, choices: readonly string[], path: string): void {
  if (typeof value !== 'string' || !choices.includes(value)) {
    throw new RoutesEditorContractError(path);
  }
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new RoutesEditorContractError(path);
  }

  return value;
}

function stringsAt(value: unknown, path: string): void {
  arrayAt(value, path).forEach((item, index) => stringAt(item, `${path}[${index}]`));
}

/**
 * Отвергает функции, undefined и нечисловые значения в свободных полях представления.
 * Их внутренняя форма задаётся отдельными действиями редактора.
 */
function jsonAt(value: unknown, path: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => jsonAt(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      jsonAt(child, `${path}.${key}`);
    }
    return;
  }

  throw new RoutesEditorContractError(path);
}

function transitionAt(value: unknown, path: string): void {
  if (value === null) {
    return;
  }

  const transition = recordAt(value, [], ['next', 'rewind', 'reset', 'stop', 'escalate'], path);
  const modes = ['next', 'rewind', 'stop', 'escalate'].filter((key) => Object.hasOwn(transition, key));
  if (modes.length !== 1) {
    throw new RoutesEditorContractError(path);
  }

  if (modes[0] === 'next') {
    recordAt(value, ['next'], [], path);
    stringAt(transition.next, `${path}.next`);
  } else if (modes[0] === 'rewind') {
    recordAt(value, ['rewind', 'reset'], [], path);
    stringAt(transition.rewind, `${path}.rewind`);
    stringsAt(transition.reset, `${path}.reset`);
  } else if (modes[0] === 'stop') {
    recordAt(value, ['stop'], [], path);
    enumAt(transition.stop, ['human', 'failed', 'done'], `${path}.stop`);
  } else {
    recordAt(value, ['escalate'], [], path);
    const escalate = recordAt(transition.escalate, ['routes'], [], `${path}.escalate`);
    stringsAt(escalate.routes, `${path}.escalate.routes`);
  }
}

function outcomesAt(value: unknown, outcomes: readonly string[], path: string): void {
  const on = recordAt(value, outcomes, [], path);

  for (const outcome of outcomes) {
    transitionAt(on[outcome], `${path}.${outcome}`);
  }
}

function promptAt(value: unknown, path: string): void {
  const prompt = recordAt(value, ['blocks', 'requiredContext'], [], path);
  stringsAt(prompt.requiredContext, `${path}.requiredContext`);
  arrayAt(prompt.blocks, `${path}.blocks`).forEach((item, index) => {
    const blockPath = `${path}.blocks[${index}]`;
    const block = recordAt(item, ['file'], ['when'], blockPath);
    stringAt(block.file, `${blockPath}.file`);

    if (Object.hasOwn(block, 'when')) {
      const when = recordAt(block.when, ['context', 'equals'], [], `${blockPath}.when`);
      stringAt(when.context, `${blockPath}.when.context`);
      if (when.equals !== null && typeof when.equals !== 'string'
        && typeof when.equals !== 'boolean'
        && !(typeof when.equals === 'number' && Number.isFinite(when.equals))) {
        throw new RoutesEditorContractError(`${blockPath}.when.equals`);
      }
    }
  });
}

function policyAt(value: unknown, path: string): void {
  const policy = recordAt(
    value,
    ['filesystem'],
    ['timeoutClass', 'budgetClass', 'browser'],
    path,
  );
  enumAt(
    policy.filesystem,
    ['state-only', 'workspace-write', 'transactional-write'],
    `${path}.filesystem`,
  );
  for (const key of ['timeoutClass', 'budgetClass']) {
    if (Object.hasOwn(policy, key)) {
      stringAt(policy[key], `${path}.${key}`);
    }
  }
  if (Object.hasOwn(policy, 'browser')) {
    enumAt(policy.browser, ['forbid', 'allow'], `${path}.browser`);
  }
}

function fanoutAt(value: unknown, path: string): void {
  const fanout = recordAt(value, ['mode', 'maxExecutors', 'degrade'], [], path);
  enumAt(fanout.mode, ['single', 'parallel'], `${path}.mode`);
  integerAt(fanout.maxExecutors, 1, `${path}.maxExecutors`);
  enumAt(fanout.degrade, ['forbid', 'allow-single'], `${path}.degrade`);
}

function retryAt(value: unknown, path: string): void {
  const retry = recordAt(value, ['noResult', 'productFailure', 'providerFailure'], [], path);
  integerAt(retry.noResult, 0, `${path}.noResult`);
  integerAt(retry.productFailure, 0, `${path}.productFailure`);
  const provider = recordAt(
    retry.providerFailure,
    ['attempts', 'strategy'],
    [],
    `${path}.providerFailure`,
  );
  integerAt(provider.attempts, 0, `${path}.providerFailure.attempts`);
  enumAt(
    provider.strategy,
    ['none', 'same-runner', 'runner-failover'],
    `${path}.providerFailure.strategy`,
  );
}

/**
 * Читает точную форму узла по executor, сохраняя null у ещё не назначенных исходов.
 */
function nodeAt(value: unknown, path: string): void {
  const base = recordAt(value, ['id', 'executor', 'phase'], [
    'label', 'description', 'runKey', 'key', 'owner', 'emits', 'commandId',
    'prompt', 'policy', 'fanout', 'retry', 'on', 'onFailure',
  ], path);
  enumAt(base.executor, ['agent', 'command', 'gate', 'status'], `${path}.executor`);
  enumAt(base.phase, ['bootstrap', 'main', 'tail'], `${path}.phase`);
  stringAt(base.id, `${path}.id`);

  const display = ['label', 'description'];
  if (base.executor === 'status') {
    recordAt(value, ['id', 'executor', 'phase', 'key', 'owner'], display, path);
    stringAt(base.key, `${path}.key`);
    stringAt(base.owner, `${path}.owner`);
  } else {
    const common = ['id', 'executor', 'phase', 'runKey', 'emits', 'on'];
    const additional = base.executor === 'gate'
      ? []
      : ['policy', 'fanout', 'retry', base.executor === 'agent' ? 'prompt' : 'commandId'];
    const optional = base.executor === 'gate' ? display : [...display, 'onFailure'];
    recordAt(value, [...common, ...additional], optional, path);

    stringAt(base.runKey, `${path}.runKey`);
    stringsAt(base.emits, `${path}.emits`);
    outcomesAt(
      base.on,
      base.executor === 'gate'
        ? ['approved', 'rejected']
        : ['done', 'skipped', 'failed', 'exhausted'],
      `${path}.on`,
    );
    if (Object.hasOwn(base, 'onFailure')) {
      outcomesAt(
        base.onFailure,
        ['build', 'tests', 'environment', 'plan', 'human'],
        `${path}.onFailure`,
      );
    }
    if (base.executor !== 'gate') {
      policyAt(base.policy, `${path}.policy`);
      fanoutAt(base.fanout, `${path}.fanout`);
      retryAt(base.retry, `${path}.retry`);

      if (base.executor === 'agent') {
        promptAt(base.prompt, `${path}.prompt`);
      } else {
        stringAt(base.commandId, `${path}.commandId`);
      }
    }
  }

  for (const key of display) {
    if (Object.hasOwn(base, key)) {
      stringAt(base[key], `${path}.${key}`);
    }
  }
}

function machineAt(value: unknown, path: string): void {
  const machine = recordAt(value, [
    'schema', 'kind', 'profile', 'id', 'entry', 'sequence', 'nodes', 'escalation',
  ], ['title', 'bootstrap', 'loop'], path);
  if (machine.schema !== 2) {
    throw new RoutesEditorContractError(`${path}.schema`);
  }
  enumAt(machine.kind, ['route', 'bootstrap'], `${path}.kind`);
  if (Object.hasOwn(machine, 'bootstrap')) {
    if (machine.kind !== 'route') {
      throw new RoutesEditorContractError(`${path}.bootstrap`);
    }
    enumAt(machine.bootstrap, ['required', 'skip'], `${path}.bootstrap`);
  }
  // Пара цикла переживает черновик как есть; смысл пары проверяет схема публикации.
  if (Object.hasOwn(machine, 'loop')) {
    if (machine.kind !== 'route') {
      throw new RoutesEditorContractError(`${path}.loop`);
    }
    const loop = recordAt(machine.loop, ['lead', 'worker'], [], `${path}.loop`);
    stringAt(loop.lead, `${path}.loop.lead`);
    stringAt(loop.worker, `${path}.loop.worker`);
  }
  stringAt(machine.profile, `${path}.profile`);
  stringAt(machine.id, `${path}.id`);
  if (machine.entry !== null) {
    stringAt(machine.entry, `${path}.entry`);
  }
  if (Object.hasOwn(machine, 'title')) {
    stringAt(machine.title, `${path}.title`);
  }

  const phases = machine.kind === 'route' ? ['main', 'tail'] : ['bootstrap'];
  const sequence = recordAt(machine.sequence, phases, [], `${path}.sequence`);
  for (const phase of phases) {
    stringsAt(sequence[phase], `${path}.sequence.${phase}`);
  }

  arrayAt(machine.nodes, `${path}.nodes`).forEach((node, index) => {
    nodeAt(node, `${path}.nodes[${index}]`);
  });
  arrayAt(machine.escalation, `${path}.escalation`).forEach((item, index) => {
    const recordPath = `${path}.escalation[${index}]`;
    const record = recordAt(
      item,
      ['from', 'allowedRoutes', 'requiresHumanWhenPinned'],
      [],
      recordPath,
    );
    stringAt(record.from, `${recordPath}.from`);
    stringsAt(record.allowedRoutes, `${recordPath}.allowedRoutes`);
    booleanAt(record.requiresHumanWhenPinned, `${recordPath}.requiresHumanWhenPinned`);
  });
}

function promptMapAt(value: unknown, path: string): void {
  const prompts = recordAt(value, [], Object.keys(value ?? {}), path);

  for (const [file, text] of Object.entries(prompts)) {
    stringAt(text, `${path}.${file}`);
  }
}

export function parseRouteDraftContent(value: unknown): RouteDraftContent {
  const content = recordAt(value, [
    'routes', 'bootstrap', 'bootstrapPrompts', 'presentation', 'provenance',
  ], [], 'routeDraftContent');
  const routes = recordAt(content.routes, [], Object.keys(content.routes ?? {}),
    'routeDraftContent.routes');
  for (const [routeId, value] of Object.entries(routes)) {
    const routePath = `routeDraftContent.routes.${routeId}`;
    const entry = recordAt(value, ['route', 'prompts'], [], routePath);
    machineAt(entry.route, `${routePath}.route`);
    promptMapAt(entry.prompts, `${routePath}.prompts`);
  }
  machineAt(content.bootstrap, 'routeDraftContent.bootstrap');
  promptMapAt(content.bootstrapPrompts, 'routeDraftContent.bootstrapPrompts');
  recordAt(content.presentation, [], Object.keys(content.presentation ?? {}),
    'routeDraftContent.presentation');
  recordAt(content.provenance, [], Object.keys(content.provenance ?? {}),
    'routeDraftContent.provenance');
  jsonAt(content.presentation, 'routeDraftContent.presentation');
  jsonAt(content.provenance, 'routeDraftContent.provenance');
  return value as RouteDraftContent;
}

export function parseRouteTransferBundle(value: unknown): RouteTransferBundle {
  const bundle = recordAt(value, [
    'format', 'schema', 'sourceProfile', 'content', 'dependencies',
  ], [], 'routeTransfer');
  if (bundle.format !== 'cockpit-route-authoring' || bundle.schema !== 1) {
    throw new RoutesEditorContractError('routeTransfer.format/schema');
  }
  if (typeof bundle.sourceProfile !== 'string'
    || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(bundle.sourceProfile)) {
    throw new RoutesEditorContractError('routeTransfer.sourceProfile');
  }
  parseRouteDraftContent(bundle.content);
  stringsAt(bundle.dependencies, 'routeTransfer.dependencies');
  const dependencies = bundle.dependencies as string[];
  if (dependencies.some((id) => !/^[a-z0-9][a-z0-9_-]{0,40}$/.test(id)
    || id === 'catalog') || new Set(dependencies).size !== dependencies.length) {
    throw new RoutesEditorContractError('routeTransfer.dependencies');
  }
  return value as RouteTransferBundle;
}

export function parseRouteTransferImportResult(value: unknown): RouteTransferImportResult {
  const result = recordAt(value, ['draft', 'unresolvedDependencies', 'issues'],
    ['cancelled'], 'routeTransferImport');
  parseRouteDraft(result.draft);
  stringsAt(result.unresolvedDependencies, 'routeTransferImport.unresolvedDependencies');
  arrayAt(result.issues, 'routeTransferImport.issues').forEach(parseRouteEditorIssue);
  if (result.cancelled !== undefined) {
    booleanAt(result.cancelled, 'routeTransferImport.cancelled');
  }
  return value as RouteTransferImportResult;
}

export function parseRouteDraft(value: unknown): RouteDraft {
  const draft = recordAt(value, [
    'schema', 'id', 'profile', 'title', 'revision', 'baseCatalogHash',
    'baseSourceRevision', 'routes', 'bootstrap', 'bootstrapPrompts',
    'presentation', 'provenance', 'state', 'createdAt', 'updatedAt', 'publication',
  ], [], 'routeDraft');

  if (draft.schema !== 1) {
    throw new RoutesEditorContractError('routeDraft.schema');
  }

  if (!Number.isInteger(draft.revision) || Number(draft.revision) < 1) {
    throw new RoutesEditorContractError('routeDraft.revision');
  }
  if (!Object.hasOwn(draft, 'baseCatalogHash') || (
    draft.baseCatalogHash !== null
    && (typeof draft.baseCatalogHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(draft.baseCatalogHash))
  )) {
    throw new RoutesEditorContractError('routeDraft.baseCatalogHash');
  }
  if (draft.state !== 'editing' && draft.state !== 'published' && draft.state !== 'archived') {
    throw new RoutesEditorContractError('routeDraft.state');
  }

  uuidAt(draft.id, 'routeDraft.id');
  stringAt(draft.profile, 'routeDraft.profile');
  stringAt(draft.title, 'routeDraft.title');
  integerAt(draft.baseSourceRevision, 0, 'routeDraft.baseSourceRevision');
  dateAt(draft.createdAt, 'routeDraft.createdAt');
  dateAt(draft.updatedAt, 'routeDraft.updatedAt');

  parseRouteDraftContent({
    routes: draft.routes,
    bootstrap: draft.bootstrap,
    bootstrapPrompts: draft.bootstrapPrompts,
    presentation: draft.presentation,
    provenance: draft.provenance,
  });

  if (draft.publication !== null) {
    parseRoutePublication(draft.publication);
  }

  return value as RouteDraft;
}

export function parseRouteDraftList(value: unknown): { drafts: RouteDraftSummary[] } {
  const list = recordAt(value, ['drafts'], [], 'routeDraftList');
  arrayAt(list.drafts, 'routeDraftList.drafts').forEach((item, index) => {
    const path = `routeDraftList.drafts[${index}]`;
    const summary = recordAt(item, [
      'id', 'profile', 'title', 'revision', 'baseCatalogHash', 'state', 'updatedAt',
    ], [], path);
    uuidAt(summary.id, `${path}.id`);
    stringAt(summary.profile, `${path}.profile`);
    stringAt(summary.title, `${path}.title`);
    integerAt(summary.revision, 1, `${path}.revision`);
    if (summary.baseCatalogHash !== null) {
      hashAt(summary.baseCatalogHash, `${path}.baseCatalogHash`);
    }
    enumAt(summary.state, ['editing', 'published', 'archived'], `${path}.state`);
    dateAt(summary.updatedAt, `${path}.updatedAt`);
  });

  return value as { drafts: RouteDraftSummary[] };
}

export function parseRouteEditorIssue(value: unknown): RouteEditorIssue {
  const issue = recordAt(value, [
    'code', 'severity', 'scope', 'routeId', 'nodeId', 'path', 'message',
  ], [], 'routeEditorIssue');
  stringAt(issue.code, 'routeEditorIssue.code');
  enumAt(issue.severity, ['error', 'warning'], 'routeEditorIssue.severity');
  enumAt(issue.scope, ['catalog', 'bootstrap', 'route', 'profile'], 'routeEditorIssue.scope');
  if (issue.routeId !== null) {
    stringAt(issue.routeId, 'routeEditorIssue.routeId');
  }
  if (issue.nodeId !== null) {
    stringAt(issue.nodeId, 'routeEditorIssue.nodeId');
  }
  stringAt(issue.path, 'routeEditorIssue.path');
  stringAt(issue.message, 'routeEditorIssue.message');

  return value as RouteEditorIssue;
}

export function parseRouteDraftValidationReport(value: unknown): RouteDraftValidationReport {
  const report = recordAt(value, [
    'draftId', 'draftRevision', 'capabilitiesHash', 'issues',
  ], [], 'routeDraftValidation');
  uuidAt(report.draftId, 'routeDraftValidation.draftId');
  integerAt(report.draftRevision, 1, 'routeDraftValidation.draftRevision');
  if (report.capabilitiesHash !== null) {
    hashAt(report.capabilitiesHash, 'routeDraftValidation.capabilitiesHash');
  }
  arrayAt(report.issues, 'routeDraftValidation.issues').forEach(parseRouteEditorIssue);
  return value as RouteDraftValidationReport;
}

function parseCompareFields(value: unknown, label: string): void {
  arrayAt(value, label).forEach((raw, index) => {
    const field = recordAt(raw, ['path', 'kind', 'before', 'after'], [], `${label}[${index}]`);
    stringAt(field.path, `${label}[${index}].path`);
    enumAt(field.kind, ['added', 'removed', 'changed'], `${label}[${index}].kind`);
  });
}

function parseCompareChanges(value: unknown, label: string): void {
  arrayAt(value, label).forEach((item, index) => {
    const change = recordAt(item, ['scope', 'routeId', 'kind', 'before', 'after'], ['fields'],
      `${label}[${index}]`);
    enumAt(change.scope, ['route', 'bootstrap'], `${label}[${index}].scope`);
    if (change.routeId !== null) stringAt(change.routeId, `${label}[${index}].routeId`);
    enumAt(change.kind, ['added', 'removed', 'changed'], `${label}[${index}].kind`);
    for (const side of ['before', 'after'] as const) {
      if (change[side] !== null && (typeof change[side] !== 'object'
        || Array.isArray(change[side]))) {
        throw new RoutesEditorContractError(`${label}[${index}].${side}`);
      }
    }
    if (change.fields !== undefined) {
      parseCompareFields(change.fields, `${label}[${index}].fields`);
    }
  });
}

export function parseRouteCompareReport(value: unknown): RouteCompareReport {
  const report = recordAt(value, [
    'draftId', 'draftRevision', 'currentCatalogHash', 'sourceMode', 'sourceRevision',
    'capabilitiesHash', 'changes',
  ], ['presentationChanges'], 'routeCompare');
  uuidAt(report.draftId, 'routeCompare.draftId');
  integerAt(report.draftRevision, 1, 'routeCompare.draftRevision');
  if (report.currentCatalogHash !== null) {
    hashAt(report.currentCatalogHash, 'routeCompare.currentCatalogHash');
  }
  enumAt(report.sourceMode, ['profile-script', 'editor'], 'routeCompare.sourceMode');
  integerAt(report.sourceRevision, 0, 'routeCompare.sourceRevision');
  if (report.capabilitiesHash !== null) {
    hashAt(report.capabilitiesHash, 'routeCompare.capabilitiesHash');
  }
  parseCompareChanges(report.changes, 'routeCompare.changes');
  if (report.presentationChanges !== undefined) {
    parseCompareFields(report.presentationChanges, 'routeCompare.presentationChanges');
  }
  return value as RouteCompareReport;
}

export function parseRouteRevisionCompareReport(value: unknown): RouteRevisionCompareReport {
  const report = recordAt(value, [
    'fromCatalogHash', 'toCatalogHash', 'changes', 'presentationChanges',
  ], [], 'routeRevisionCompare');
  hashAt(report.fromCatalogHash, 'routeRevisionCompare.fromCatalogHash');
  hashAt(report.toCatalogHash, 'routeRevisionCompare.toCatalogHash');
  parseCompareChanges(report.changes, 'routeRevisionCompare.changes');
  parseCompareFields(report.presentationChanges, 'routeRevisionCompare.presentationChanges');
  return value as RouteRevisionCompareReport;
}

export function parseRouteRebasePreview(value: unknown): RouteRebasePreview {
  const preview = recordAt(value, [
    'draftId', 'draftRevision', 'baseCatalogHash', 'currentCatalogHash', 'conflicts',
  ], [], 'routeRebasePreview');
  uuidAt(preview.draftId, 'routeRebasePreview.draftId');
  integerAt(preview.draftRevision, 1, 'routeRebasePreview.draftRevision');
  if (preview.baseCatalogHash !== null) {
    hashAt(preview.baseCatalogHash, 'routeRebasePreview.baseCatalogHash');
  }
  hashAt(preview.currentCatalogHash, 'routeRebasePreview.currentCatalogHash');
  arrayAt(preview.conflicts, 'routeRebasePreview.conflicts').forEach((raw, index) => {
    const conflict = recordAt(raw, ['scope', 'routeId', 'base', 'mine', 'current'], [],
      `routeRebasePreview.conflicts[${index}]`);
    enumAt(conflict.scope, ['route', 'bootstrap'],
      `routeRebasePreview.conflicts[${index}].scope`);
    if (conflict.scope === 'bootstrap' && conflict.routeId !== null) {
      throw new RoutesEditorContractError(`routeRebasePreview.conflicts[${index}].routeId`);
    }
    if (conflict.scope === 'route') {
      stringAt(conflict.routeId, `routeRebasePreview.conflicts[${index}].routeId`);
    }
  });
  return value as RouteRebasePreview;
}

export function parseRoutePromptPreview(value: unknown): RoutePromptPreviewResponse {
  const preview = recordAt(value, [
    'draftRevision', 'text', 'includedBlocks', 'excludedBlocks', 'issues',
  ], [], 'routePromptPreview');
  integerAt(preview.draftRevision, 1, 'routePromptPreview.draftRevision');
  stringAt(preview.text, 'routePromptPreview.text');
  stringsAt(preview.includedBlocks, 'routePromptPreview.includedBlocks');
  stringsAt(preview.excludedBlocks, 'routePromptPreview.excludedBlocks');
  arrayAt(preview.issues, 'routePromptPreview.issues').forEach((raw, index) => {
    const issue = recordAt(raw, ['code', 'path', 'message'], ['severity'],
      `routePromptPreview.issues[${index}]`);
    stringAt(issue.code, `routePromptPreview.issues[${index}].code`);
    stringAt(issue.path, `routePromptPreview.issues[${index}].path`);
    stringAt(issue.message, `routePromptPreview.issues[${index}].message`);
    if (issue.severity !== undefined) {
      stringAt(issue.severity, `routePromptPreview.issues[${index}].severity`);
    }
  });
  return value as RoutePromptPreviewResponse;
}

export function parseRouteSimulationStep(value: unknown): RouteSimulationStepResponse {
  const result = recordAt(value, ['draftRevision', 'ok', 'issues'], [
    'action', 'cursor', 'counters', 'reset', 'stop', 'escalation', 'requiresHuman',
  ], 'routeSimulationStep');
  integerAt(result.draftRevision, 1, 'routeSimulationStep.draftRevision');
  booleanAt(result.ok, 'routeSimulationStep.ok');
  arrayAt(result.issues, 'routeSimulationStep.issues').forEach((raw, index) => {
    const issue = recordAt(raw, ['code', 'path', 'message'], ['severity'],
      `routeSimulationStep.issues[${index}]`);
    stringAt(issue.code, `routeSimulationStep.issues[${index}].code`);
    stringAt(issue.path, `routeSimulationStep.issues[${index}].path`);
    stringAt(issue.message, `routeSimulationStep.issues[${index}].message`);
  });
  if (result.ok) {
    const cursor = recordAt(result.cursor, ['scope', 'routeId', 'nodeId', 'terminal'], [],
      'routeSimulationStep.cursor');
    enumAt(cursor.scope, ['route', 'bootstrap'], 'routeSimulationStep.cursor.scope');
    if (cursor.routeId !== null) stringAt(cursor.routeId, 'routeSimulationStep.cursor.routeId');
    stringAt(cursor.nodeId, 'routeSimulationStep.cursor.nodeId');
    booleanAt(cursor.terminal, 'routeSimulationStep.cursor.terminal');
    const counters = recordAt(result.counters, ['noResult', 'productFailure', 'rewinds'], [],
      'routeSimulationStep.counters');
    for (const name of ['noResult', 'productFailure', 'rewinds']) {
      const counts = counters[name];
      const record = recordAt(counts, [], Object.keys(counts ?? {}),
        `routeSimulationStep.counters.${name}`);
      for (const [key, count] of Object.entries(record)) {
        integerAt(count, 0, `routeSimulationStep.counters.${name}.${key}`);
      }
    }
    stringsAt(result.reset, 'routeSimulationStep.reset');
    if (result.stop !== null) stringAt(result.stop, 'routeSimulationStep.stop');
    if (result.escalation !== null) stringsAt(result.escalation,
      'routeSimulationStep.escalation');
    booleanAt(result.requiresHuman, 'routeSimulationStep.requiresHuman');
  }
  return value as RouteSimulationStepResponse;
}

export function parseRouteEditorInfo(value: unknown): RouteEditorInfo {
  const info = recordAt(value, [
    'profile', 'source', 'currentCatalogHash', 'capabilitiesHash', 'capabilities', 'issues',
  ], [], 'routeEditorInfo');
  stringAt(info.profile, 'routeEditorInfo.profile');
  const source = recordAt(info.source, ['mode', 'revision'], [], 'routeEditorInfo.source');
  enumAt(source.mode, ['profile-script', 'editor'], 'routeEditorInfo.source.mode');
  integerAt(source.revision, 0, 'routeEditorInfo.source.revision');
  if (info.currentCatalogHash !== null) {
    hashAt(info.currentCatalogHash, 'routeEditorInfo.currentCatalogHash');
  }
  if (info.capabilitiesHash !== null) {
    hashAt(info.capabilitiesHash, 'routeEditorInfo.capabilitiesHash');
  }
  const capabilities = recordAt(info.capabilities, [
    'schema', 'commands', 'contextSections', 'filesystem', 'timeoutClasses', 'retryStrategies',
  ], [], 'routeEditorInfo.capabilities');
  if (capabilities.schema !== 1) {
    throw new RoutesEditorContractError('routeEditorInfo.capabilities.schema');
  }
  arrayAt(capabilities.commands, 'routeEditorInfo.capabilities.commands').forEach((item, index) => {
    const command = recordAt(item, ['id', 'label', 'filesystem'], [],
      `routeEditorInfo.capabilities.commands[${index}]`);
    stringAt(command.id, `routeEditorInfo.capabilities.commands[${index}].id`);
    stringAt(command.label, `routeEditorInfo.capabilities.commands[${index}].label`);
    stringsAt(command.filesystem, `routeEditorInfo.capabilities.commands[${index}].filesystem`);
  });
  arrayAt(capabilities.contextSections,
    'routeEditorInfo.capabilities.contextSections').forEach((item, index) => {
    const section = recordAt(item, ['id', 'label'], [],
      `routeEditorInfo.capabilities.contextSections[${index}]`);
    stringAt(section.id, `routeEditorInfo.capabilities.contextSections[${index}].id`);
    stringAt(section.label, `routeEditorInfo.capabilities.contextSections[${index}].label`);
  });
  stringsAt(capabilities.filesystem, 'routeEditorInfo.capabilities.filesystem');
  stringsAt(capabilities.timeoutClasses, 'routeEditorInfo.capabilities.timeoutClasses');
  stringsAt(capabilities.retryStrategies, 'routeEditorInfo.capabilities.retryStrategies');
  arrayAt(info.issues, 'routeEditorInfo.issues').forEach(parseRouteEditorIssue);
  return value as RouteEditorInfo;
}

export function parseRouteEffectivePolicy(value: unknown): RouteEffectivePolicy {
  const policy = recordAt(value, ['runKey', 'primary', 'failover', 'source', 'models'], [],
    'routeEffectivePolicy');
  stringAt(policy.runKey, 'routeEffectivePolicy.runKey');
  if (policy.primary !== null) stringAt(policy.primary, 'routeEffectivePolicy.primary');
  stringsAt(policy.failover, 'routeEffectivePolicy.failover');
  stringAt(policy.source, 'routeEffectivePolicy.source');
  if (!policy.models || typeof policy.models !== 'object' || Array.isArray(policy.models)) {
    throw new RoutesEditorContractError('routeEffectivePolicy.models');
  }
  for (const [provider, raw] of Object.entries(policy.models)) {
    if (raw === null) continue;
    const model = recordAt(raw, ['exact', 'family', 'version', 'variant', 'effort'], [],
      `routeEffectivePolicy.models.${provider}`);
    for (const [key, field] of Object.entries(model)) {
      if (field !== null) stringAt(field, `routeEffectivePolicy.models.${provider}.${key}`);
    }
  }
  return value as RouteEffectivePolicy;
}

export function parseRoutePublication(value: unknown): RoutePublication {
  const receipt = recordAt(value, [
    'operationId', 'requestHash', 'draftId', 'draftRevision', 'fromCatalogHash',
    'toCatalogHash', 'sourceRevision', 'state', 'currentChanged', 'createdAt',
  ], ['comment'], 'routePublication');
  uuidAt(receipt.operationId, 'routePublication.operationId');
  hashAt(receipt.requestHash, 'routePublication.requestHash');
  uuidAt(receipt.draftId, 'routePublication.draftId');
  integerAt(receipt.draftRevision, 1, 'routePublication.draftRevision');
  if (receipt.fromCatalogHash !== null) {
    hashAt(receipt.fromCatalogHash, 'routePublication.fromCatalogHash');
  }
  hashAt(receipt.toCatalogHash, 'routePublication.toCatalogHash');
  integerAt(receipt.sourceRevision, 0, 'routePublication.sourceRevision');
  enumAt(receipt.state, ['committed', 'aborted'], 'routePublication.state');
  booleanAt(receipt.currentChanged, 'routePublication.currentChanged');
  dateAt(receipt.createdAt, 'routePublication.createdAt');
  if (receipt.comment !== undefined) {
    stringAt(receipt.comment, 'routePublication.comment');
    if (new TextEncoder().encode(receipt.comment as string).length > 2000) {
      throw new RoutesEditorContractError('routePublication.comment');
    }
  }

  return value as RoutePublication;
}
