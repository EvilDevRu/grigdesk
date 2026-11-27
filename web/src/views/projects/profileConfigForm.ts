import { isChatSpeed, type ChatSpeed } from '../../../../shared/chat/chatSpeed.ts';
import type {
  ModelConfigOperationView,
  ProfileConfigFile,
  ProfileConfigView,
  ProfileVariableChangeView,
  RunnerConfigOperationView,
} from '../../shared/profileConfigApi.ts';

type ModelField = 'family' | 'familyFailover' | 'version' | 'variant' | 'effort' | 'speed' | 'exact';

export interface ConfigFormRow {
  id: string;
  name: string;
  value: string | null;
  editable: boolean;
  reason: 'variable' | 'file' | 'runner' | null;
  file?: ProfileConfigFile;
  speedModes?: readonly ChatSpeed[];
}

interface RunnerGroup {
  kind: 'runner';
  role?: string;
  primary: string;
  failover: string;
}

interface ModelGroup {
  kind: 'model';
  role: string;
  provider: string;
  fields: Array<{ key: string; field: ModelField }>;
}

export interface ConfigFormModel {
  rows: ConfigFormRow[];
  groups: Array<RunnerGroup | ModelGroup>;
}

export interface ConfigSummaryRow {
  name: string;
  before: string | null;
  after: string;
}

export interface ConfigSavePlan {
  variables: Array<{ file: ProfileConfigFile; changes: ProfileVariableChangeView[] }>;
  operations: RunnerConfigOperationView[];
  summary: ConfigSummaryRow[];
  blocked: string[];
}

const PROVIDER = /^[a-z][a-z0-9_-]*$/;
const ROLE = /^[A-Z][A-Z0-9_]*$/;
const MODEL_FIELDS: Array<[string, ModelField]> = [
  ['FAMILY_FAILOVER', 'familyFailover'],
  ['FAMILY', 'family'],
  ['VERSION', 'version'],
  ['VARIANT', 'variant'],
  ['EFFORT', 'effort'],
  ['SPEED', 'speed'],
  ['EXACT', 'exact'],
];

// Режимы согласованы с SupportsSpeed в Go, runnerOperations и chatSpeed адаптеров.
const PROFILE_SPEED_MODES: Readonly<Partial<Record<string, readonly ChatSpeed[]>>> = {
  codex: ['standard', 'fast', 'ultrafast'],
  claude: ['standard', 'fast'],
};

const profileSpeedModes = (provider: string) => Object.hasOwn(PROFILE_SPEED_MODES, provider)
  ? PROFILE_SPEED_MODES[provider] : undefined;

/**
 * Пропущенная синтетическая скорость и пустое наследование совпадают.
 * Остальные отсутствующие строки сохраняют исходную семантику редактирования.
 */
export function matchesConfigRowValue(row: ConfigFormRow, value: string): boolean {
  return row.value === value || (row.speedModes !== undefined && row.value === null && value === '');
}

/**
 * Выделяет проектную пару или роль из полного ключа. Суффикс отделяется
 * от конца строки: внутри RUN_KEY могут законно находиться подчёркивания.
 */
function runnerGroup(key: string): RunnerGroup | null {
  if (key === 'PROJECT_RUNNER_PRIMARY') {
    return {
      kind: 'runner',
      primary: key,
      failover: 'PROJECT_RUNNER_FAILOVER'
    };
  }

  const stage = /^STAGE_([A-Z][A-Z0-9_]*)_PRIMARY$/.exec(key)?.[1];

  return stage ? {
    kind: 'runner',
    role: stage,
    primary: key,
    failover: `STAGE_${stage}_FAILOVER`,
  } : null;
}

/**
 * Проверяет все возможные границы role/provider, сохраняя исходный provider ID.
 * Коллизия нормализации или два допустимых разбиения делают ключ read-only.
 */
function modelAddress(key: string, providers: string[]): {
  role: string;
  provider: string;
  field: ModelField;
} | null {
  const candidates: Array<{
    role: string;
    provider: string;
    field: ModelField
  }> = [];

  if (!key.startsWith('MODEL_')) {
    return null;
  }

  for (const provider of providers) {
    const normalized = provider.toUpperCase().replaceAll('-', '_');

    for (const [suffix, field] of MODEL_FIELDS) {
      const ending = `_${normalized}_${suffix}`;
      const role = key.slice(6, -ending.length);

      if (key.endsWith(ending) && ROLE.test(role)) {
        candidates.push({
          role,
          provider,
          field
        });
      }
    }
  }

  return candidates.length === 1 ? candidates[0]! : null;
}

/**
 * Проецирует плоский снимок только в представимые операции текущего API.
 * Неизвестные ключи сохраняются в чтении и никогда не угадываются по split('_').
 */
export function configFormModel(config: ProfileConfigView): ConfigFormModel {
  const rows: ConfigFormRow[] = [];
  const groups: ConfigFormModel['groups'] = [];
  const files: Array<[ProfileConfigFile, ProfileConfigView['variables']['profileSh']]> = [
    ['profile.sh', config.variables.profileSh],
    ['dashboard.env', config.variables.dashboard],
  ];

  for (const [file, values] of files) {
    for (const item of values) {
      rows.push({
        id: `v:${file}:${item.name}`,
        name: item.name,
        value: item.value,
        editable: item.editable,
        file,
        reason: item.editable ? null : item.reason === 'file_missing' ? 'file' : 'variable',
      });
    }
  }

  const providers = new Set<string>();
  const runnerEntries = Object.entries(config.runners);

  for (const [key, value] of runnerEntries) {
    if (key === 'PROJECT_RUNNER_PRIMARY' || key === 'PROJECT_RUNNER_FAILOVER'
      || /^STAGE_[A-Z][A-Z0-9_]*_(PRIMARY|FAILOVER)$/.test(key)) {
      for (const provider of value.split(',')) {
        if (PROVIDER.test(provider)) {
          providers.add(provider);
        }
      }
    }
  }

  const writable = new Set<string>();
  const modelGroups = new Map<string, ModelGroup>();
  const speedByKey = new Map<string, readonly ChatSpeed[]>();
  const knownProviders = [...new Set([...providers, ...Object.keys(PROFILE_SPEED_MODES)])];

  /**
   * Строка скорости и существующие модельные поля принадлежат одной операции.
   * Порядок остальных полей и модельные адреса сохраняются.
   */
  const groupFor = (role: string, provider: string): ModelGroup => {
    const id = `${role}/${provider}`;
    const group: ModelGroup = modelGroups.get(id) ?? {
      kind: 'model',
      role,
      provider,
      fields: [],
    };

    modelGroups.set(id, group);

    return group;
  };

  for (const [key, value] of runnerEntries) {
    const runner = runnerGroup(key);

    if (runner && PROVIDER.test(value)) {
      groups.push(runner);
      writable.add(runner.primary);

      if (Object.hasOwn(config.runners, runner.failover)) {
        writable.add(runner.failover);
      }
    }

    const address = modelAddress(key, knownProviders);

    if (address) {
      const group = groupFor(address.role, address.provider);
      const modes = address.field === 'speed' ? profileSpeedModes(address.provider) : undefined;

      group.fields.push({ key, field: address.field });
      writable.add(key);

      if (modes) {
        speedByKey.set(key, modes);
      }
    }
  }

  for (const [key, value] of runnerEntries) {
    const runner = runnerGroup(key.replace(/_FAILOVER$/u, '_PRIMARY'));

    if (runner && (key === runner.primary || key === runner.failover)) {
      for (const provider of value.split(',')) {
        if (profileSpeedModes(provider)) {
          groupFor(runner.role ?? 'DEFAULT', provider);
        }
      }
    }
  }

  for (const group of modelGroups.values()) {
    const modes = profileSpeedModes(group.provider);
    const providerKey = group.provider.toUpperCase().replaceAll('-', '_');
    const key = `MODEL_${group.role}_${providerKey}_SPEED`;
    const address = modelAddress(key, knownProviders);

    if (!modes || address?.provider !== group.provider || address.role !== group.role
      || Object.hasOwn(config.runners, key)) {
      continue;
    }

    group.fields.push({ key, field: 'speed' });
    rows.push({
      id: `r:${key}`,
      name: key,
      value: null,
      editable: true,
      reason: null,
      speedModes: modes,
    });
  }

  groups.push(...[...modelGroups.values()].filter((group) => group.fields.length));

  for (const [key, value] of runnerEntries) {
    const speedModes = speedByKey.get(key);

    rows.push({
      id: `r:${key}`,
      name: key,
      value,
      editable: writable.has(key),
      reason: writable.has(key) ? null : 'runner',
      ...(speedModes ? { speedModes } : {}),
    });
  }

  return { rows, groups };
}

/**
 * Сопоставляет намерение с новым фактом после PATCH/конфликта. Совпавшее
 * считается применённым; исчезнувшие и неприменённые поля сохраняются.
 */
export function reconcileConfigEdits(
  config: ProfileConfigView,
  edits: Record<string, string>,
): Record<string, string> {
  const actual = new Map(configFormModel(config).rows.map((row) => [row.id, row]));

  return Object.fromEntries(Object.entries(edits)
    .filter(([key, desired]) => !actual.has(key) || !matchesConfigRowValue(actual.get(key)!, desired)));
}

/**
 * Собирает операции из одного снимка и показывает весь фактический payload.
 * Runner всегда несёт пару, модель — все существующие поля своей группы.
 */
export function configSavePlan(
  config: ProfileConfigView,
  edits: Record<string, string>,
): ConfigSavePlan {
  const model = configFormModel(config);
  const byId = new Map(model.rows.map((row) => [row.id, row]));
  const plan: ConfigSavePlan = {
    variables: [],
    operations: [],
    summary: [],
    blocked: []
  };
  const changed = new Set(Object.keys(reconcileConfigEdits(config, edits)));

  plan.blocked = [...changed].filter((id) => !byId.get(id)?.editable);

  for (const file of ['profile.sh', 'dashboard.env'] as const) {
    const changes = model.rows.filter((row) => row.file === file && changed.has(row.id)
      && row.editable).map((row) => ({
        name: row.name,
        from: row.value,
        to: edits[row.id]!
      }));

    if (changes.length) {
      plan.variables.push({ file, changes });
      plan.summary.push(...changes.map((change) => ({
        name: `${file}: ${change.name}`,
        before: change.from,
        after: change.to,
      })));
    }
  }

  const value = (key: string): string => edits[`r:${key}`] ?? config.runners[key] ?? '';
  const summarize = (key: string): void => {
    plan.summary.push({
      name: key,
      before: config.runners[key] ?? null,
      after: value(key)
    });
  };

  for (const group of model.groups) {
    if (group.kind === 'runner') {
      if (!changed.has(`r:${group.primary}`) && !changed.has(`r:${group.failover}`)) {
        continue;
      }

      plan.operations.push({
        kind: 'runner',
        ...(group.role ? { role: group.role } : {}),
        primary: value(group.primary),
        failover: value(group.failover),
      });
      summarize(group.primary);
      summarize(group.failover);
    } else if (group.fields.some((item) => changed.has(`r:${item.key}`))) {
      const operation: ModelConfigOperationView = {
        kind: 'model',
        role: group.role,
        provider: group.provider,
      };

      for (const item of group.fields) {
        if (item.field === 'speed') {
          const id = `r:${item.key}`;

          if (!changed.has(id)) {
            continue;
          }

          const speed = value(item.key);

          if (speed !== '' && (!isChatSpeed(speed) || !speed || !byId.get(id)?.speedModes?.includes(speed))) {
            plan.blocked.push(id);

            continue;
          }

          operation.speed = speed;
        } else {
          operation[item.field] = value(item.key);
        }

        summarize(item.key);
      }

      if (Object.keys(operation).length > 3) {
        plan.operations.push(operation);
      }
    }
  }

  return plan;
}
