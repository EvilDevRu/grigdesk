import { contractDecoders } from '../lib/contractDecoders.ts';

export interface StageRunnerIdentity {
  task: string;
  profile: string;
  attempt: string;
  node: string;
  stage: string;
}

export interface StageRunnerSelection {
  primary: string | null;
  parametersFor: string;
  model: string | null;
  effort: string | null;
}

export interface StageRunnerRun {
  id: string;
  epoch: number;
}

export interface StageRunnerModel {
  id: string;
  label?: string;
  efforts: string[];
  aliases?: string[];
}

export interface StageRunnerReceipt {
  requestId: string;
  payloadHash?: string;
  state: 'saved' | 'pending' | 'consumed' | 'started' | 'failed' | 'stale';
  reason?: string;
}

export interface StageRunnerOptions {
  schema: 1;
  identity: StageRunnerIdentity;
  revision: number;
  selection: StageRunnerSelection;
  sources: {
    primary: string;
    model: string;
    effort: string;
  };
  effective: {
    primary: string;
    model: string;
    effort: string;
  };
  chain: string[];
  models: StageRunnerModel[];
  catalogRevision: string;
  actual: {
    run: StageRunnerRun;
    provider: string | null;
    model: string | null;
    effort: string | null;
  } | null;
  receipt: StageRunnerReceipt | null;
  inherited?: {
    primary: string;
    model: string;
    effort: string;
    chain: string[];
  };
}

export interface StageRunnerApply {
  identity: StageRunnerIdentity;
  expectedRevision: number;
  expectedRun: StageRunnerRun | null;
  catalogRevision: string;
  requestId: string;
  mode: 'next' | 'restart';
  selection: StageRunnerSelection;
}

export class StageRunnerSettingsInputError extends Error {}

function fail(path: string): never {
  throw new StageRunnerSettingsInputError(`Некорректные настройки этапа: ${path}`);
}

const d = contractDecoders(fail);

/**
 * Закрытый объект отклоняет лишние поля до обращения к движку.
 * Поля проверяются тем же общим каркасом, что и остальные сетевые контракты.
 */
function exact(value: unknown, keys: string[], path: string) {
  const source = d.record(value, path);

  if (Object.keys(source).some((key) => !keys.includes(key)) || keys.some((key) => !(key in source))) {
    fail(path);
  }

  return source;
}

function identifier(value: unknown, pattern: RegExp, path: string): string {
  const text = d.text(value, path);

  return pattern.test(text) ? text : fail(path);
}

const provider = (value: unknown, path: string) => identifier(value, /^[a-z][a-z0-9_-]{0,63}$/u, path);
const nullableText = (value: unknown, path: string) => value === null ? null : d.text(value, path);

/**
 * Identity сохраняется без нормализации: опечатка не может стать чужим узлом.
 * Этот decoder используется клиентом и сервером перед exact CLI.
 */
export function decodeStageRunnerIdentity(value: unknown): StageRunnerIdentity {
  const source = exact(value, ['task', 'profile', 'attempt', 'node', 'stage'], 'identity');

  return {
    task: identifier(source.task, /^[1-9][0-9]{0,18}$/u, 'task'),
    profile: identifier(source.profile, /^[a-z0-9][a-z0-9_-]{0,63}$/u, 'profile'),
    attempt: identifier(source.attempt, /^a_[a-f0-9]{32}$/u, 'attempt'),
    node: identifier(source.node, /^[a-z0-9][a-z0-9_-]{0,40}$/u, 'node'),
    stage: identifier(source.stage, /^[A-Z][A-Z0-9_]{0,63}$/u, 'stage'),
  };
}

/**
 * Null означает независимое наследование, пустой effort остаётся явным значением.
 * Прозрачные подписи модели не участвуют в проверке её непрозрачного идентификатора.
 */
export function decodeStageRunnerSelection(value: unknown): StageRunnerSelection {
  const source = exact(value, ['primary', 'parametersFor', 'model', 'effort'], 'selection');
  const result = {
    primary: source.primary === null ? null : provider(source.primary, 'primary'),
    parametersFor: provider(source.parametersFor, 'parametersFor'),
    model: nullableText(source.model, 'model'),
    effort: nullableText(source.effort, 'effort'),
  };

  for (const key of ['model', 'effort'] as const) {
    const text = result[key];

    if (text !== null && (text.length > 2048 || /[\u0000-\u001f]/u.test(text))) {
      fail(key);
    }
  }

  return result;
}

/**
 * Ожидаемый запуск задаётся парой id/epoch либо явным отсутствием живого процесса.
 * Нулевая эпоха не представляет уже допущенный запуск и отвергается на входе.
 */
function decodeRun(value: unknown): StageRunnerRun | null {
  if (value === null) {
    return null;
  }

  const source = exact(value, ['id', 'epoch'], 'run');
  const epoch = d.wholeNumber(source.epoch, 'epoch');

  if (epoch === 0) {
    fail('epoch');
  }

  return { id: identifier(source.id, /^[A-Za-z0-9._-]+$/u, 'run.id'), epoch };
}

/**
 * Одна команда несёт целую связку и все CAS-ожидания прочитанного options.
 * Редактор не отправляет отдельные записи полей и не выбирает latest run сам.
 */
export function decodeStageRunnerApply(value: unknown): StageRunnerApply {
  const source = exact(value, [
    'identity', 'expectedRevision', 'expectedRun', 'catalogRevision', 'requestId', 'mode', 'selection',
  ], 'apply');

  return {
    identity: decodeStageRunnerIdentity(source.identity),
    expectedRevision: d.wholeNumber(source.expectedRevision, 'expectedRevision'),
    expectedRun: decodeRun(source.expectedRun),
    catalogRevision: identifier(source.catalogRevision, /^.{1,256}$/u, 'catalogRevision'),
    requestId: identifier(source.requestId, /^[A-Za-z0-9._-]{1,128}$/u, 'requestId'),
    mode: d.oneOf('next', 'restart')(source.mode, 'mode'),
    selection: decodeStageRunnerSelection(source.selection),
  };
}

/**
 * Options изолированы от graph telemetry и проверяются до замены состояния формы.
 * Источник будущего выбора и фактическая пара запуска остаются разными объектами.
 */
export function decodeStageRunnerOptions(value: unknown): StageRunnerOptions {
  const raw = d.record(value, 'options');
  const { inherited, ...fields } = raw;
  const source = exact(fields, [
    'schema', 'identity', 'revision', 'selection', 'sources', 'effective', 'chain',
    'models', 'catalogRevision', 'actual', 'receipt',
  ], 'options');
  const sources = exact(source.sources, ['primary', 'model', 'effort'], 'sources');
  const effective = exact(source.effective, ['primary', 'model', 'effort'], 'effective');
  const models = source.models;

  if (!Array.isArray(models)) {
    fail('models');
  }

  const actual = source.actual === null ? null : exact(
    source.actual, ['run', 'provider', 'model', 'effort'], 'actual',
  );
  const receipt = source.receipt === null ? null : d.record(source.receipt, 'receipt');

  return {
    schema: d.oneOf(1)(source.schema, 'schema'),
    identity: decodeStageRunnerIdentity(source.identity),
    revision: d.wholeNumber(source.revision, 'revision'),
    selection: decodeStageRunnerSelection(source.selection),
    sources: {
      primary: d.text(sources.primary, 'sources.primary'),
      model: d.text(sources.model, 'sources.model'),
      effort: d.text(sources.effort, 'sources.effort'),
    },
    effective: {
      primary: provider(effective.primary, 'effective.primary'),
      model: d.text(effective.model, 'effective.model'),
      effort: d.text(effective.effort, 'effective.effort'),
    },
    chain: d.listOf(provider)(source.chain, 'chain'),
    models: models.map((item) => {
      const model = d.record(item, 'model');

      return {
        id: d.text(model.id, 'model.id'),
        label: d.text(model.label ?? model.id, 'label'),
        efforts: d.listOf(d.text)(model.efforts, 'efforts'),
        aliases: d.listOf(d.text)(model.aliases ?? [], 'aliases'),
      };
    }),
    catalogRevision: d.text(source.catalogRevision, 'catalogRevision'),
    actual: actual ? {
      run: decodeRun(actual.run) ?? fail('actual.run'),
      provider: nullableText(actual.provider, 'actual.provider'),
      model: nullableText(actual.model, 'actual.model'),
      effort: nullableText(actual.effort, 'actual.effort'),
    } : null,
    receipt: receipt ? {
      requestId: d.text(receipt.requestId, 'receipt.requestId'),
      state: d.oneOf('saved', 'pending', 'consumed', 'started', 'failed', 'stale')(
        receipt.state, 'receipt.state',
      ),
      ...(receipt.payloadHash === undefined ? {} : {
        payloadHash: d.text(receipt.payloadHash, 'payloadHash'),
      }),
      ...(receipt.reason === undefined ? {} : { reason: d.text(receipt.reason, 'reason') }),
    } : null,
    ...(inherited === undefined ? {} : {
      inherited: d.objectOf({
        primary: provider,
        model: d.text,
        effort: d.text,
        chain: d.listOf(provider),
      })(inherited, 'inherited'),
    }),
  };
}

/**
 * Сервер и редактор проверяют согласованность пары по одному metadata-снимку.
 * Отказ не меняет второе поле и не подбирает запасную модель или глубину.
 */
export function stageRunnerSelectionError(
  selection: StageRunnerSelection, options: StageRunnerOptions,
): string | null {
  const primary = selection.primary ?? options.inherited?.primary ?? options.effective.primary;

  if (selection.parametersFor !== primary) {
    return 'parametersFor: параметры относятся к другому исполнителю.';
  }

  const model = selection.model ?? options.inherited?.model ?? options.effective.model;
  const effort = selection.effort ?? options.inherited?.effort ?? options.effective.effort;
  const entry = options.models.find((item) => item.id === model || item.aliases?.includes(model));

  if (!entry) {
    return `model_unavailable: модель ${model} недоступна.`;
  }

  return entry.efforts.includes(effort) ? null : `effort_unavailable: ${effort} не подходит модели ${model}.`;
}
