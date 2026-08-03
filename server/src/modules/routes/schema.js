// Строгий schema=2 контракт маршрутов. Он намеренно не является «почти JSON Schema»:
// runtime получает уже проверенный объект, а неизвестные поля отклоняются. Так в route
// нельзя незаметно протащить shell, provider/model policy или новый недетерминированный
// оператор шаблонов.

const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENTITY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const RUN_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const CLASS_ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const CONTEXT_PATH_RE = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/;
const PROMPT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}(?:\.[a-z0-9][a-z0-9_-]{0,40})*$/;
export const ROUTES_V2_HASH_RE = /^[a-f0-9]{64}$/;

const EXECUTORS = new Set(['agent', 'command', 'gate', 'status']);
const PHASES = new Set(['bootstrap', 'main', 'tail']);
const FILESYSTEM_POLICIES = new Set([
  'state-only',
  'workspace-write',
  'transactional-write',
]);
const COMMAND_FILESYSTEM_POLICIES = new Set(['state-only', 'workspace-write']);
// Эти классы исполняет engine/lib/core.sh. Произвольный идентификатор здесь
// опасен: движок лишь пишет предупреждение и молча отдаёт узлу общий timeout.
const TIMEOUT_CLASSES = new Set([
  'planning',
  'standard',
  'review',
  'delivery',
  'check',
  'test',
  'build',
  'diagnostic',
  'browser',
]);
const STOP_TARGETS = new Set(['human', 'failed', 'done']);
const FAILURE_OWNERS = new Set(['build', 'tests', 'environment', 'plan', 'human']);
const PROVIDER_RETRY_STRATEGIES = new Set([
  'none',
  'same-runner',
  'runner-failover',
]);
const FORBIDDEN_ROUTE_FIELDS = new Set(['model', 'effort', 'provider']);

export class RoutesError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RoutesError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, path = '') {
  throw new RoutesError(code, message, path ? { path } : {});
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertObject(value, path) {
  if (!isObject(value)) fail('ROUTES_V2_INVALID_SCHEMA', `${path}: ожидался объект`, path);
}

function assertExactKeys(value, required, optional, path) {
  assertObject(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail('ROUTES_V2_INVALID_SCHEMA', `${path}: неизвестное поле «${key}»`, `${path}.${key}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail('ROUTES_V2_INVALID_SCHEMA', `${path}: отсутствует поле «${key}»`, `${path}.${key}`);
    }
  }
}

function traversalLike(value) {
  return typeof value === 'string'
    && (value.includes('/') || value.includes('\\') || value.includes('\0')
      || value === '.' || value === '..');
}

function assertIdentifier(value, regexp, path) {
  if (traversalLike(value)) {
    fail('ROUTES_V2_PATH_TRAVERSAL', `${path}: путь вместо идентификатора`, path);
  }
  if (typeof value !== 'string' || !regexp.test(value)) {
    fail('ROUTES_V2_INVALID_ID', `${path}: недопустимый идентификатор`, path);
  }
  return value;
}

export function assertProfileId(value, path = 'profile') {
  return assertIdentifier(value, PROFILE_ID_RE, path);
}

export function assertRouteId(value, path = 'route') {
  const id = assertIdentifier(value, ENTITY_ID_RE, path);
  if (id === 'catalog') {
    fail('ROUTES_V2_INVALID_ID', `${path}: «catalog» зарезервирован хранилищем`, path);
  }
  return id;
}

export function assertRevisionHash(value, path = 'hash') {
  if (traversalLike(value)) {
    fail('ROUTES_V2_PATH_TRAVERSAL', `${path}: путь вместо hash`, path);
  }
  if (typeof value !== 'string' || !ROUTES_V2_HASH_RE.test(value)) {
    fail('ROUTES_V2_INVALID_HASH', `${path}: нужен sha256 в нижнем регистре`, path);
  }
  return value;
}

function assertString(value, path, { max = 10_000, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length === 0)) {
    fail('ROUTES_V2_INVALID_SCHEMA', `${path}: недопустимая строка`, path);
  }
}

function assertInteger(value, path, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail('ROUTES_V2_INVALID_SCHEMA', `${path}: ожидалось целое ${min}…${max}`, path);
  }
}

function assertBoolean(value, path) {
  if (typeof value !== 'boolean') {
    fail('ROUTES_V2_INVALID_SCHEMA', `${path}: ожидался boolean`, path);
  }
}

function assertEnum(value, allowed, path) {
  if (!allowed.has(value)) {
    fail('ROUTES_V2_INVALID_SCHEMA', `${path}: недопустимое значение`, path);
  }
}

function assertNoExecutionPolicy(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoExecutionPolicy(item, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_ROUTE_FIELDS.has(key)) {
      fail(
        'ROUTES_V2_FORBIDDEN_FIELD',
        `${path}.${key}: модельная политика живёт только в runners.env`,
        `${path}.${key}`,
      );
    }
    assertNoExecutionPolicy(child, `${path}.${key}`);
  }
}

function assertUniqueIds(value, path, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail('ROUTES_V2_INVALID_SCHEMA', `${path}: ожидался массив идентификаторов`, path);
  }
  const seen = new Set();
  for (let index = 0; index < value.length; index++) {
    const id = assertIdentifier(value[index], ENTITY_ID_RE, `${path}[${index}]`);
    if (seen.has(id)) {
      fail('ROUTES_V2_INVALID_SCHEMA', `${path}: повтор «${id}»`, `${path}[${index}]`);
    }
    seen.add(id);
  }
  return seen;
}

function assertContextPath(value, path) {
  if (typeof value !== 'string' || !CONTEXT_PATH_RE.test(value)) {
    fail('ROUTES_V2_INVALID_SCHEMA', `${path}: недопустимый путь контекста`, path);
  }
  const root = value.split('.')[0];
  if (FORBIDDEN_ROUTE_FIELDS.has(root)) {
    fail(
      'ROUTES_V2_FORBIDDEN_FIELD',
      `${path}: модельная политика не является route-контекстом`,
      path,
    );
  }
}

function expectedPromptPath(prefix, name) {
  return `${prefix}${name}.md`;
}

function parsePromptPath(value, prefix, path) {
  if (typeof value !== 'string' || !value.startsWith(prefix) || !value.endsWith('.md')) {
    fail('ROUTES_V2_PATH_TRAVERSAL', `${path}: недопустимый путь prompt-файла`, path);
  }
  const name = value.slice(prefix.length, -3);
  if (!PROMPT_NAME_RE.test(name) || value !== expectedPromptPath(prefix, name)) {
    fail('ROUTES_V2_PATH_TRAVERSAL', `${path}: недопустимый путь prompt-файла`, path);
  }
  return value;
}

/**
 * Проверяет карту prompt-файлов до публикации.
 * Ключ — полный относительный путь внутри bundle.
 */
export function validatePromptFiles(prompts, {
  prefix,
  path = 'prompts',
  maxFileBytes = 1024 * 1024,
  maxTotalBytes = 8 * 1024 * 1024,
} = {}) {
  assertObject(prompts, path);
  if (prefix !== 'prompts/' && prefix !== 'bootstrap/prompts/') {
    fail('ROUTES_V2_INVALID_SCHEMA', `${path}: неизвестный prompt prefix`, path);
  }
  let total = 0;
  const files = new Set();
  for (const [file, text] of Object.entries(prompts)) {
    parsePromptPath(file, prefix, `${path}.${file}`);
    if (typeof text !== 'string' || text.trim().length === 0) {
      fail('ROUTES_V2_INVALID_SCHEMA', `${path}.${file}: prompt пуст`, `${path}.${file}`);
    }
    const bytes = Buffer.byteLength(text);
    if (bytes > maxFileBytes) {
      fail('ROUTES_V2_INVALID_SCHEMA', `${path}.${file}: prompt слишком велик`, `${path}.${file}`);
    }
    total += bytes;
    files.add(file);
  }
  if (total > maxTotalBytes) {
    fail('ROUTES_V2_INVALID_SCHEMA', `${path}: общий размер prompts слишком велик`, path);
  }
  return files;
}

function validateWhen(value, requiredContext, path) {
  assertExactKeys(value, ['context', 'equals'], [], path);
  assertContextPath(value.context, `${path}.context`);
  const root = value.context.split('.')[0];
  if (!requiredContext.has(root)) {
    fail(
      'ROUTES_V2_INVALID_SCHEMA',
      `${path}.context: секция «${root}» отсутствует в requiredContext`,
      `${path}.context`,
    );
  }
  const comparable = value.equals === null
    || typeof value.equals === 'string'
    || typeof value.equals === 'boolean'
    || (typeof value.equals === 'number' && Number.isFinite(value.equals));
  if (!comparable) {
    fail(
      'ROUTES_V2_INVALID_SCHEMA',
      `${path}.equals: разрешён только JSON scalar`,
      `${path}.equals`,
    );
  }
}

function validatePrompt(value, promptFiles, prefix, path) {
  assertExactKeys(value, ['blocks', 'requiredContext'], [], path);
  if (!Array.isArray(value.requiredContext) || value.requiredContext.length === 0) {
    fail('ROUTES_V2_INVALID_SCHEMA', `${path}.requiredContext: нужен непустой массив`, `${path}.requiredContext`);
  }
  const requiredContext = new Set();
  value.requiredContext.forEach((item, index) => {
    assertContextPath(item, `${path}.requiredContext[${index}]`);
    if (item.includes('.')) {
      fail(
        'ROUTES_V2_INVALID_SCHEMA',
        `${path}.requiredContext[${index}]: перечисляются только корневые секции`,
        `${path}.requiredContext[${index}]`,
      );
    }
    if (requiredContext.has(item)) {
      fail('ROUTES_V2_INVALID_SCHEMA', `${path}.requiredContext: повтор «${item}»`, `${path}.requiredContext[${index}]`);
    }
    requiredContext.add(item);
  });

  if (!Array.isArray(value.blocks) || value.blocks.length === 0) {
    fail('ROUTES_V2_INVALID_SCHEMA', `${path}.blocks: нужен непустой массив`, `${path}.blocks`);
  }
  value.blocks.forEach((block, index) => {
    const blockPath = `${path}.blocks[${index}]`;
    assertExactKeys(block, ['file'], ['when'], blockPath);
    parsePromptPath(block.file, prefix, `${blockPath}.file`);
    if (!promptFiles.has(block.file)) {
      fail(
        'ROUTES_V2_INVALID_SCHEMA',
        `${blockPath}.file: файл отсутствует в bundle`,
        `${blockPath}.file`,
      );
    }
    if (Object.hasOwn(block, 'when')) {
      validateWhen(block.when, requiredContext, `${blockPath}.when`);
    }
  });
}

function validatePolicy(value, path) {
  assertExactKeys(value, ['filesystem'], ['timeoutClass', 'budgetClass', 'browser'], path);
  assertEnum(value.filesystem, FILESYSTEM_POLICIES, `${path}.filesystem`);
  if (Object.hasOwn(value, 'timeoutClass')) {
    assertIdentifier(value.timeoutClass, CLASS_ID_RE, `${path}.timeoutClass`);
    assertEnum(value.timeoutClass, TIMEOUT_CLASSES, `${path}.timeoutClass`);
  }
  if (Object.hasOwn(value, 'budgetClass')) {
    assertIdentifier(value.budgetClass, CLASS_ID_RE, `${path}.budgetClass`);
  }
  // Браузер — отдельное разрешение узла, а не следствие файловой политики:
  // state-only узел может законно водить браузер (приёмка), но разведке и
  // планированию он не положен. Умолчание — forbid: иначе Scout может менять
  // живое приложение песочницы кликами.
  if (Object.hasOwn(value, 'browser')) {
    assertEnum(value.browser, new Set(['forbid', 'allow']), `${path}.browser`);
  }
}

function validateFanout(value, path) {
  assertExactKeys(value, ['mode', 'maxExecutors', 'degrade'], [], path);
  assertEnum(value.mode, new Set(['single', 'parallel']), `${path}.mode`);
  assertInteger(value.maxExecutors, `${path}.maxExecutors`, 1, 16);
  assertEnum(value.degrade, new Set(['forbid', 'allow-single']), `${path}.degrade`);
  if (value.mode === 'single' && (value.maxExecutors !== 1 || value.degrade !== 'forbid')) {
    fail(
      'ROUTES_V2_INVALID_SCHEMA',
      `${path}: single требует maxExecutors=1 и degrade=forbid`,
      path,
    );
  }
  if (value.mode === 'parallel' && value.maxExecutors < 2) {
    fail('ROUTES_V2_INVALID_SCHEMA', `${path}: parallel требует минимум двух исполнителей`, path);
  }
}

function validateRetry(value, path) {
  assertExactKeys(value, ['noResult', 'providerFailure', 'productFailure'], [], path);
  assertInteger(value.noResult, `${path}.noResult`, 0, 10);
  assertInteger(value.productFailure, `${path}.productFailure`, 0, 10);
  assertExactKeys(value.providerFailure, ['attempts', 'strategy'], [], `${path}.providerFailure`);
  assertInteger(value.providerFailure.attempts, `${path}.providerFailure.attempts`, 0, 10);
  assertEnum(
    value.providerFailure.strategy,
    PROVIDER_RETRY_STRATEGIES,
    `${path}.providerFailure.strategy`,
  );
  if ((value.providerFailure.attempts === 0) !== (value.providerFailure.strategy === 'none')) {
    fail(
      'ROUTES_V2_INVALID_SCHEMA',
      `${path}.providerFailure: strategy=none эквивалентна attempts=0`,
      `${path}.providerFailure`,
    );
  }
}

function validateTransition(value, path) {
  assertObject(value, path);
  const modes = ['next', 'rewind', 'stop', 'escalate'].filter((key) => Object.hasOwn(value, key));
  if (modes.length !== 1) {
    fail('ROUTES_V2_INVALID_SCHEMA', `${path}: нужен ровно один вид перехода`, path);
  }
  const mode = modes[0];
  if (mode === 'next') {
    assertExactKeys(value, ['next'], [], path);
    assertIdentifier(value.next, ENTITY_ID_RE, `${path}.next`);
  } else if (mode === 'rewind') {
    assertExactKeys(value, ['rewind', 'reset'], [], path);
    assertIdentifier(value.rewind, ENTITY_ID_RE, `${path}.rewind`);
    assertUniqueIds(value.reset, `${path}.reset`, { allowEmpty: false });
  } else if (mode === 'stop') {
    assertExactKeys(value, ['stop'], [], path);
    assertEnum(value.stop, STOP_TARGETS, `${path}.stop`);
  } else {
    assertExactKeys(value, ['escalate'], [], path);
    assertExactKeys(value.escalate, ['routes'], [], `${path}.escalate`);
    assertUniqueIds(value.escalate.routes, `${path}.escalate.routes`, { allowEmpty: false });
  }
}

function validateOn(value, executor, path) {
  const outcomes = executor === 'gate'
    ? ['approved', 'rejected']
    : ['done', 'skipped', 'failed', 'exhausted'];
  assertExactKeys(value, outcomes, [], path);
  for (const outcome of outcomes) validateTransition(value[outcome], `${path}.${outcome}`);
}

function validateFailureRoutes(value, path) {
  assertExactKeys(value, [...FAILURE_OWNERS], [], path);
  for (const owner of FAILURE_OWNERS) validateTransition(value[owner], `${path}.${owner}`);
}

function validateNode(node, promptFiles, promptPrefix, path) {
  assertObject(node, path);
  assertIdentifier(node.id, ENTITY_ID_RE, `${path}.id`);
  assertEnum(node.executor, EXECUTORS, `${path}.executor`);
  assertEnum(node.phase, PHASES, `${path}.phase`);

  const display = ['label', 'description'];
  if (node.executor === 'agent') {
    assertExactKeys(
      node,
      ['id', 'executor', 'phase', 'runKey', 'emits', 'prompt', 'policy', 'fanout', 'retry', 'on'],
      [...display, 'onFailure'],
      path,
    );
  } else if (node.executor === 'command') {
    assertExactKeys(
      node,
      ['id', 'executor', 'phase', 'runKey', 'commandId', 'emits', 'policy', 'fanout', 'retry', 'on'],
      [...display, 'onFailure'],
      path,
    );
  } else if (node.executor === 'gate') {
    assertExactKeys(
      node,
      ['id', 'executor', 'phase', 'runKey', 'emits', 'on'],
      display,
      path,
    );
  } else {
    assertExactKeys(node, ['id', 'executor', 'phase', 'key', 'owner'], display, path);
  }

  for (const key of display) {
    if (Object.hasOwn(node, key)) assertString(node[key], `${path}.${key}`, { max: 500 });
  }

  if (node.executor === 'status') {
    assertIdentifier(node.key, RUN_KEY_RE, `${path}.key`);
    assertIdentifier(node.owner, ENTITY_ID_RE, `${path}.owner`);
    return;
  }

  assertIdentifier(node.runKey, RUN_KEY_RE, `${path}.runKey`);
  // Cockpit пока разрешает решение ворот через runKey.toLowerCase(). Если эти
  // значения расходятся, UI покажет одни ворота, а runtime зафиксирует другие.
  if (node.id !== node.runKey.toLowerCase()) {
    fail(
      'ROUTES_V2_INVALID_SCHEMA',
      `${path}: id обязан равняться runKey.toLowerCase()`,
      `${path}.runKey`,
    );
  }
  assertUniqueIds(node.emits, `${path}.emits`);
  validateOn(node.on, node.executor, `${path}.on`);

  if (node.executor === 'gate') return;
  validatePolicy(node.policy, `${path}.policy`);
  validateFanout(node.fanout, `${path}.fanout`);
  validateRetry(node.retry, `${path}.retry`);
  if (node.fanout.mode === 'parallel' && node.policy.filesystem !== 'state-only') {
    fail(
      'ROUTES_V2_INVALID_SCHEMA',
      `${path}.fanout: parallel разрешён только для state-only узла`,
      `${path}.fanout`,
    );
  }
  if (node.executor === 'command' && node.fanout.mode !== 'single') {
    fail(
      'ROUTES_V2_INVALID_SCHEMA',
      `${path}.fanout: command обязан быть single`,
      `${path}.fanout`,
    );
  }
  if (
    node.executor === 'command'
    && !COMMAND_FILESYSTEM_POLICIES.has(node.policy.filesystem)
  ) {
    fail(
      'ROUTES_V2_INVALID_SCHEMA',
      `${path}.policy.filesystem: command поддерживает только state-only/workspace-write`,
      `${path}.policy.filesystem`,
    );
  }
  if (
    node.executor === 'command'
    && (
      node.retry.noResult !== 0
      || node.retry.productFailure !== 0
      || node.retry.providerFailure.attempts !== 0
      || node.retry.providerFailure.strategy !== 'none'
    )
  ) {
    fail(
      'ROUTES_V2_INVALID_SCHEMA',
      `${path}.retry: command исполняется ровно один раз без runner retry`,
      `${path}.retry`,
    );
  }
  if (Object.hasOwn(node, 'onFailure')) {
    validateFailureRoutes(node.onFailure, `${path}.onFailure`);
  }

  if (node.executor === 'agent') {
    validatePrompt(node.prompt, promptFiles, promptPrefix, `${path}.prompt`);
  } else {
    assertIdentifier(node.commandId, ENTITY_ID_RE, `${path}.commandId`);
  }
}

function validateEscalation(value, nodesById, path) {
  if (!Array.isArray(value)) {
    fail('ROUTES_V2_INVALID_SCHEMA', `${path}: ожидался массив`, path);
  }
  const bySource = new Map();
  value.forEach((record, index) => {
    const recordPath = `${path}[${index}]`;
    assertExactKeys(
      record,
      ['from', 'allowedRoutes', 'requiresHumanWhenPinned'],
      [],
      recordPath,
    );
    assertIdentifier(record.from, ENTITY_ID_RE, `${recordPath}.from`);
    const source = nodesById.get(record.from);
    if (!source || source.executor === 'status') {
      fail('ROUTES_V2_INVALID_SCHEMA', `${recordPath}.from: нужен исполняемый узел`, `${recordPath}.from`);
    }
    if (bySource.has(record.from)) {
      fail('ROUTES_V2_INVALID_SCHEMA', `${path}: повтор source «${record.from}»`, `${recordPath}.from`);
    }
    const routes = assertUniqueIds(
      record.allowedRoutes,
      `${recordPath}.allowedRoutes`,
      { allowEmpty: false },
    );
    assertBoolean(record.requiresHumanWhenPinned, `${recordPath}.requiresHumanWhenPinned`);
    bySource.set(record.from, routes);
  });
  return bySource;
}

function collectSequence(sequence, kind) {
  const required = kind === 'bootstrap' ? ['bootstrap'] : ['main', 'tail'];
  assertExactKeys(sequence, required, [], 'machine.sequence');
  const order = [];
  const phaseById = new Map();
  for (const phase of required) {
    const ids = assertUniqueIds(sequence[phase], `machine.sequence.${phase}`, {
      allowEmpty: kind === 'route' && phase === 'tail',
    });
    for (const id of ids) {
      if (phaseById.has(id)) {
        fail('ROUTES_V2_INVALID_SCHEMA', `machine.sequence: повтор «${id}»`, `machine.sequence.${phase}`);
      }
      phaseById.set(id, phase);
      order.push(id);
    }
  }
  return { order, phaseById };
}

function validateMachine(machine, {
  kind,
  profile,
  id,
  promptFiles,
  promptPrefix,
  allowLegacyProductFailureRewind = false,
}) {
  assertNoExecutionPolicy(machine);
  const required = ['schema', 'kind', 'profile', 'id', 'entry', 'sequence', 'nodes', 'escalation'];
  assertExactKeys(machine, required, ['title'], 'machine');
  if (machine.schema !== 2 || machine.kind !== kind) {
    fail('ROUTES_V2_INVALID_SCHEMA', `machine: ожидались schema=2 и kind=${kind}`, 'machine');
  }
  assertProfileId(machine.profile, 'machine.profile');
  assertRouteId(machine.id, 'machine.id');
  if (machine.profile !== profile || machine.id !== id) {
    fail('ROUTES_V2_INVALID_SCHEMA', 'machine: profile/id не совпадают с адресом bundle', 'machine');
  }
  if (Object.hasOwn(machine, 'title')) assertString(machine.title, 'machine.title', { max: 200 });
  assertIdentifier(machine.entry, ENTITY_ID_RE, 'machine.entry');
  const { order, phaseById } = collectSequence(machine.sequence, kind);

  if (!Array.isArray(machine.nodes) || machine.nodes.length === 0) {
    fail('ROUTES_V2_INVALID_SCHEMA', 'machine.nodes: нужен непустой массив', 'machine.nodes');
  }
  const nodesById = new Map();
  machine.nodes.forEach((node, index) => {
    validateNode(node, promptFiles, promptPrefix, `machine.nodes[${index}]`);
    if (nodesById.has(node.id)) {
      fail('ROUTES_V2_INVALID_SCHEMA', `machine.nodes: повтор «${node.id}»`, `machine.nodes[${index}].id`);
    }
    nodesById.set(node.id, node);
  });

  if (kind === 'route') {
    const ship = nodesById.get('ship');
    const deliveryNodes = [...nodesById.values()].filter((node) => (
      node.executor !== 'status'
      && (
        node.id === 'ship'
        || node.runKey === 'SHIP'
        || node.policy?.timeoutClass === 'delivery'
        || node.prompt?.requiredContext?.includes('delivery')
      )
    ));
    if (!ship && deliveryNodes.length > 0) {
      fail(
        'ROUTES_V2_INVALID_SCHEMA',
        'machine: delivery-capability запрещена в маршруте без узла ship',
        'machine.nodes',
      );
    }
    if (ship) {
      const shipIsCanonical = ship.executor === 'agent'
        && ship.phase === 'tail'
        && ship.runKey === 'SHIP'
        && ship.policy?.filesystem === 'workspace-write'
        && ship.policy?.timeoutClass === 'delivery'
        && ship.prompt?.requiredContext?.includes('delivery')
        && machine.sequence.tail.includes('ship');
      if (!shipIsCanonical) {
        fail(
          'ROUTES_V2_INVALID_SCHEMA',
          'machine.nodes.ship: publish-маршрут требует канонический delivery-узел в tail',
          'machine.nodes.ship',
        );
      }
      if (deliveryNodes.some((node) => node.id !== 'ship')) {
        fail(
          'ROUTES_V2_INVALID_SCHEMA',
          'machine: delivery-capability разрешена только каноническому узлу ship',
          'machine.nodes',
        );
      }
    }
  }

  const executable = [...nodesById.values()].filter((node) => node.executor !== 'status');
  if (order.length !== executable.length) {
    fail(
      'ROUTES_V2_INVALID_SCHEMA',
      'machine.sequence должна перечислять каждый исполняемый узел ровно один раз',
      'machine.sequence',
    );
  }
  for (const node of executable) {
    if (!phaseById.has(node.id) || phaseById.get(node.id) !== node.phase) {
      fail(
        'ROUTES_V2_INVALID_SCHEMA',
        `machine.sequence: phase узла «${node.id}» не совпадает`,
        'machine.sequence',
      );
    }
  }
  if (order[0] !== machine.entry) {
    fail('ROUTES_V2_INVALID_SCHEMA', 'machine.entry должен быть первым узлом sequence', 'machine.entry');
  }

  for (const node of nodesById.values()) {
    if (node.executor !== 'status') continue;
    const owner = nodesById.get(node.owner);
    if (!owner || owner.executor === 'status') {
      fail('ROUTES_V2_INVALID_SCHEMA', `status «${node.id}»: owner не исполняется`, `machine.nodes.${node.id}.owner`);
    }
    if (owner.phase !== node.phase || !owner.emits.includes(node.id)) {
      fail(
        'ROUTES_V2_INVALID_SCHEMA',
        `status «${node.id}»: нужны одинаковая phase и обратная ссылка owner.emits`,
        `machine.nodes.${node.id}`,
      );
    }
  }
  for (const owner of executable) {
    for (const emitted of owner.emits) {
      const status = nodesById.get(emitted);
      if (!status || status.executor !== 'status' || status.owner !== owner.id) {
        fail(
          'ROUTES_V2_INVALID_SCHEMA',
          `emits «${emitted}» узла «${owner.id}» не связан со status`,
          `machine.nodes.${owner.id}.emits`,
        );
      }
    }
  }

  const registryKeys = new Map();
  for (const node of nodesById.values()) {
    const key = node.executor === 'status' ? node.key : node.runKey;
    if (registryKeys.has(key)) {
      fail(
        'ROUTES_V2_INVALID_SCHEMA',
        `machine.nodes: ключ состояния «${key}» повторяется у «${registryKeys.get(key)}» и «${node.id}»`,
        `machine.nodes.${node.id}`,
      );
    }
    registryKeys.set(key, node.id);
  }

  const escalationBySource = validateEscalation(machine.escalation, nodesById, 'machine.escalation');
  const ordinal = new Map(order.map((nodeId, index) => [nodeId, index]));
  const reachable = new Map(executable.map((node) => [node.id, new Set()]));

  for (const node of executable) {
    const transitions = [
      ...Object.entries(node.on).map(([outcome, transition]) => ({
        outcome,
        transition,
        transitionPath: `machine.nodes.${node.id}.on.${outcome}`,
      })),
      ...Object.entries(node.onFailure || {}).map(([owner, transition]) => ({
        outcome: 'failed',
        transition,
        transitionPath: `machine.nodes.${node.id}.onFailure.${owner}`,
      })),
    ];
    for (const { outcome, transition, transitionPath } of transitions) {
      // productFailure повторяет ТОТ ЖЕ узел до применения его перехода. Если failed
      // объявляет rewind к автору/строителю, исправить вход может только цель rewind:
      // повтор проверяющего увидит прежний артефакт и второй раз выдаст то же замечание.
      // Старые immutable-бандлы остаются читаемыми через явный compatibility-флаг store,
      // но опубликовать новую такую схему нельзя.
      if (
        !allowLegacyProductFailureRewind
        && outcome === 'failed'
        && Object.hasOwn(transition, 'rewind')
        && (node.retry?.productFailure || 0) > 0
      ) {
        fail(
          'ROUTES_V2_INVALID_SCHEMA',
          `${transitionPath}: productFailure должен быть 0 — failed уже возвращает работу на «${transition.rewind}»`,
          `machine.nodes.${node.id}.retry.productFailure`,
        );
      }
      if (Object.hasOwn(transition, 'next')) {
        const target = nodesById.get(transition.next);
        if (!target || target.executor === 'status') {
          fail('ROUTES_V2_INVALID_SCHEMA', `${transitionPath}.next: цель не исполняется`, `${transitionPath}.next`);
        }
        if (ordinal.get(target.id) <= ordinal.get(node.id)) {
          fail('ROUTES_V2_INVALID_SCHEMA', `${transitionPath}.next: назад можно идти только через rewind`, `${transitionPath}.next`);
        }
        reachable.get(node.id).add(target.id);
      } else if (Object.hasOwn(transition, 'rewind')) {
        const target = nodesById.get(transition.rewind);
        if (!target || target.executor === 'status') {
          fail('ROUTES_V2_INVALID_SCHEMA', `${transitionPath}.rewind: цель не исполняется`, `${transitionPath}.rewind`);
        }
        if (ordinal.get(target.id) >= ordinal.get(node.id)) {
          fail('ROUTES_V2_INVALID_SCHEMA', `${transitionPath}.rewind: цель должна быть раньше`, `${transitionPath}.rewind`);
        }
        const reset = new Set(transition.reset);
        const expectedReset = order.slice(
          ordinal.get(target.id),
          ordinal.get(node.id) + 1,
        );
        if (
          reset.size !== expectedReset.length
          || expectedReset.some((resetId) => !reset.has(resetId))
        ) {
          fail(
            'ROUTES_V2_INVALID_SCHEMA',
            `${transitionPath}.reset: нужен весь непрерывный участок от цели до текущего узла`,
            `${transitionPath}.reset`,
          );
        }
        for (const resetId of reset) {
          const resetNode = nodesById.get(resetId);
          if (!resetNode || resetNode.executor === 'status') {
            fail('ROUTES_V2_INVALID_SCHEMA', `${transitionPath}.reset: status/unknown узел`, `${transitionPath}.reset`);
          }
        }
        reachable.get(node.id).add(target.id);
      } else if (Object.hasOwn(transition, 'escalate')) {
        const allowed = escalationBySource.get(node.id);
        if (!allowed) {
          fail('ROUTES_V2_INVALID_SCHEMA', `${transitionPath}: escalation не объявлена`, transitionPath);
        }
        for (const route of transition.escalate.routes) {
          if (!allowed.has(route)) {
            fail('ROUTES_V2_INVALID_SCHEMA', `${transitionPath}: маршрут «${route}» не разрешён`, transitionPath);
          }
        }
      }
    }
  }

  const visited = new Set();
  const queue = [machine.entry];
  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...reachable.get(current));
  }
  for (const node of executable) {
    if (!visited.has(node.id)) {
      fail('ROUTES_V2_INVALID_SCHEMA', `machine.nodes: узел «${node.id}» недостижим`, `machine.nodes.${node.id}`);
    }
  }

  const referencedPrompts = new Set();
  for (const node of executable) {
    if (node.executor !== 'agent') continue;
    node.prompt.blocks.forEach((block) => referencedPrompts.add(block.file));
  }
  for (const file of promptFiles) {
    if (!referencedPrompts.has(file)) {
      fail('ROUTES_V2_INVALID_SCHEMA', `prompt «${file}» не используется`, file);
    }
  }
  return machine;
}

export function validateRoute(route, {
  profile,
  routeId,
  promptFiles = new Set(),
  allowLegacyProductFailureRewind = false,
} = {}) {
  assertProfileId(profile, 'address.profile');
  assertRouteId(routeId, 'address.route');
  return validateMachine(route, {
    kind: 'route',
    profile,
    id: routeId,
    promptFiles: promptFiles instanceof Set ? promptFiles : new Set(promptFiles),
    promptPrefix: 'prompts/',
    allowLegacyProductFailureRewind,
  });
}

export function validateBootstrap(bootstrap, {
  profile,
  promptFiles = new Set(),
} = {}) {
  assertProfileId(profile, 'address.profile');
  return validateMachine(bootstrap, {
    kind: 'bootstrap',
    profile,
    id: 'scout',
    promptFiles: promptFiles instanceof Set ? promptFiles : new Set(promptFiles),
    promptPrefix: 'bootstrap/prompts/',
  });
}

export function validateCatalog(catalog, { profile } = {}) {
  assertNoExecutionPolicy(catalog, 'catalog');
  assertProfileId(profile, 'address.profile');
  assertExactKeys(catalog, ['schema', 'profile', 'routes', 'bootstrap'], [], 'catalog');
  if (catalog.schema !== 2 || catalog.profile !== profile) {
    fail('ROUTES_V2_INVALID_SCHEMA', 'catalog: schema/profile не совпадают', 'catalog');
  }
  assertObject(catalog.routes, 'catalog.routes');
  if (Object.keys(catalog.routes).length === 0) {
    fail('ROUTES_V2_INVALID_SCHEMA', 'catalog.routes: нужен хотя бы один маршрут', 'catalog.routes');
  }
  for (const [routeId, hash] of Object.entries(catalog.routes)) {
    assertRouteId(routeId, `catalog.routes.${routeId}`);
    assertRevisionHash(hash, `catalog.routes.${routeId}`);
  }
  assertExactKeys(catalog.bootstrap, ['file'], [], 'catalog.bootstrap');
  if (catalog.bootstrap.file !== 'bootstrap/scout.json') {
    fail(
      'ROUTES_V2_PATH_TRAVERSAL',
      'catalog.bootstrap.file должен быть bootstrap/scout.json',
      'catalog.bootstrap.file',
    );
  }
  return catalog;
}
