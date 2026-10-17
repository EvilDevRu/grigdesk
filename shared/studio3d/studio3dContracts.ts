// Контракт API раздела «3D». Сервер отдаёт эти формы, окно принимает их только после
// проверки полей: незнакомый статус или вид не включает запасную ветку экрана.

import { contractDecoders } from '../lib/contractDecoders.ts';
import type { Decoded, Decoder, Fields } from '../lib/contractDecoders.ts';
import { VERSION_KINDS } from './studio3dOperations.ts';
import type { FieldValue, FieldValues } from './studio3dOperations.ts';

export class Studio3dContractError extends Error {
  constructor(path: string) {
    super(`Некорректный ответ раздела «3D»: поле ${path}`);
    this.name = 'Studio3dContractError';
  }
}

export const VERSION_STATUSES = [
  'submitting',
  'waiting',
  'queued',
  'running',
  'downloading',
  'ready',
  'failed',
  'unknown',
  'unresolved',
  'remote',
  'lightened',
] as const;

export type VersionStatus = typeof VERSION_STATUSES[number];

// Статусы, при которых заказ ещё идёт и сервер его опрашивает.
export const ACTIVE_STATUSES: readonly VersionStatus[] = [
  'submitting',
  'waiting',
  'queued',
  'running',
  'downloading',
  'unknown',
];

export const MODEL_ORIGINS = ['section', 'agent', 'file', 'import'] as const;

export type ModelOrigin = typeof MODEL_ORIGINS[number];

export const MODEL_CATEGORIES = [
  {
    id: 'character',
    label: 'Персонаж'
  },
  {
    id: 'prop',
    label: 'Предмет'
  },
  {
    id: 'part',
    label: 'Деталь'
  },
  {
    id: 'scene',
    label: 'Сцена'
  },
] as const;

export type ModelCategory = typeof MODEL_CATEGORIES[number]['id'];

const {
  boolean,
  listOf,
  mapOf,
  numeric,
  objectOf: baseObjectOf,
  oneOf,
  optional,
  text,
  wholeNumber,
} = contractDecoders((path) => {
  throw new Studio3dContractError(path);
});

/**
 * DTO раздела закрыты: незнакомое поле также означает ошибку контракта.
 * Это не позволяет случайно вынести credentials/accountKey или принять другой формат.
 */
function objectOf<Shape extends Fields>(fields: Shape): Decoder<Decoded<Shape>> {
  const decode = baseObjectOf(fields);

  return (value, path) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(fields, key)) {
          throw new Studio3dContractError(`${path}.${key}`);
        }
      }
    }

    return decode(value, path);
  };
}

/**
 * Финансовое число конечно и неотрицательно; неизвестность представлена null.
 * Нельзя показывать NaN/Infinity как цену или отрицательный доступный баланс.
 */
const amount: Decoder<number> = (value, path) => {
  const result = numeric(value, path);

  if (result < 0) {
    throw new Studio3dContractError(path);
  }

  return result;
};

/**
 * Прогресс является процентом, а не произвольным целым числом. Исполнитель
 * нормализует свой ответ раньше; сетевой DTO с 150 должен быть отвергнут.
 */
const percent: Decoder<number> = (value, path) => {
  const result = wholeNumber(value, path);

  if (result > 100) {
    throw new Studio3dContractError(path);
  }

  return result;
};

/**
 * Library и intent адресуются UUID, а не произвольной строкой пути.
 * Проверка формы не заменяет серверную проверку принадлежности текущей библиотеке.
 */
const uuid: Decoder<string> = (value, path) => {
  const result = text(value, path);

  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(result)) {
    throw new Studio3dContractError(path);
  }

  return result;
};

export const PAYMENT_STATES = ['unpaid', 'reserved', 'charged', 'refunded', 'unknown', 'free'] as const;

export type PaymentState = typeof PAYMENT_STATES[number];

/**
 * Значение поля формы: строка, число, флаг, пусто, список строк или правки видов.
 * Другие формы — ошибка контракта, а не «что-нибудь».
 */
const fieldValue: Decoder<FieldValue> = (value, path) => {
  if (value === null || ['string', 'boolean'].includes(typeof value)
    || (typeof value === 'number' && Number.isFinite(value))) {
    return value as FieldValue;
  }

  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value as string[];
  }

  if (Array.isArray(value)) {
    return listOf(objectOf({
      view: oneOf('front', 'left', 'back', 'right'),
      prompt: text
    }))(value, path);
  }

  throw new Studio3dContractError(path);
};

const fieldValues: Decoder<FieldValues> = mapOf(fieldValue);
const scalar = (value: unknown, path: string) => {
  if (value === null || ['string', 'boolean'].includes(typeof value)
    || (typeof value === 'number' && Number.isFinite(value))) {
    return value as string | number | boolean | null;
  }

  throw new Studio3dContractError(path);
};

const unitForms = objectOf({
  one: text,
  few: text,
  many: text
});

const statsSize: Decoder<[number, number, number]> = (value, path) => {
  const result = listOf(amount)(value, path);

  if (result.length !== 3) {
    throw new Studio3dContractError(path);
  }

  return result as [number, number, number];
};

const stats = objectOf({
  triangles: wholeNumber,
  vertices: wholeNumber,
  meshes: wholeNumber,
  materials: wholeNumber,
  bones: wholeNumber,
  animations: listOf(objectOf({
    name: text,
    duration: amount
  })),
  textures: listOf(optional(objectOf({
    format: oneOf('png', 'jpeg', 'webp'),
    width: wholeNumber,
    height: wholeNumber
  }))),
  size: optional(statsSize),
  facing: optional(oneOf('x', 'z')),
  parts: listOf(text),
  extensions: listOf(text),
});

const fileEntry = objectOf({
  id: text,
  role: text,
  name: text,
  size: wholeNumber,
  url: text,
  sha256: text
});

const errorEntry = objectOf({
  kind: text,
  message: text,
  detail: optional(text)
});

const checkCommon = {
  jobId: uuid,
  childId: text,
  at: text
};

const checkDecoders = {
  pending: objectOf({ ...checkCommon, status: oneOf('pending') }),
  ready: objectOf({
    ...checkCommon,
    status: oneOf('ready'),
    riggable: boolean,
    rigType: optional(text)
  }),
  failed: objectOf({
    ...checkCommon,
    status: oneOf('failed'),
    error: errorEntry
  }),
  unknown: objectOf({
    ...checkCommon,
    status: oneOf('unknown'),
    error: optional(errorEntry)
  }),
  unresolved: objectOf({
    ...checkCommon,
    status: oneOf('unresolved'),
    error: optional(errorEntry)
  }),
};

/**
 * Проверка скелета имеет собственную задачу и lifecycle. Поля результата
 * появляются только у ready; остальные состояния не выдают ложное «нельзя».
 */
const rigCheck: Decoder<ReturnType<typeof checkDecoders[keyof typeof checkDecoders]>> = (value, path) => {
  const status = value && typeof value === 'object' ? (value as Record<string, unknown>).status : null;

  if (typeof status !== 'string' || !Object.hasOwn(checkDecoders, status)) {
    throw new Studio3dContractError(`${path}.status`);
  }

  return checkDecoders[status as keyof typeof checkDecoders](value, path);
};

const expenditureFields = {
  provider: text,
  unit: optional(unitForms),
  actual: amount,
  estimated: amount,
  refunded: amount,
  unknownCount: wholeNumber,
  unknownEstimated: amount,
};

const expenditure = objectOf(expenditureFields);
const weeklyExpenditure = objectOf({
  ...expenditureFields,
  sectionActual: amount,
  externalActual: amount,
  reserved: amount,
});

const version = objectOf({
  libraryId: uuid,
  id: text,
  seq: wholeNumber,
  parent: optional(text),
  kind: oneOf(...VERSION_KINDS),
  operation: optional(text),
  provider: optional(text),
  label: text,
  status: oneOf(...VERSION_STATUSES),
  progress: percent,
  etaSeconds: optional(numeric),
  params: fieldValues,
  files: listOf(fileEntry),
  preview: optional(text),
  stats: optional(stats),
  task: optional(objectOf({
    provider: text,
    id: text,
    type: text
  })),
  cost: objectOf({
    estimated: optional(amount),
    actual: optional(amount),
    free: boolean,
    unit: optional(unitForms),
    state: oneOf(...PAYMENT_STATES)
  }),
  error: optional(errorEntry),
  origin: oneOf(...MODEL_ORIGINS),
  createdAt: text,
  updatedAt: text,
  savedTo: listOf(objectOf({
    path: text,
    at: text,
    sha256: text
  })),
  rigCheck: optional(rigCheck),
  intentId: optional(uuid),
  childId: optional(text),
  waitReason: optional(text),
  retryAvailable: boolean,
  retryReason: optional(text),
  views: listOf(oneOf('front', 'left', 'back', 'right')),
  mainFileId: optional(text),
});

const modelSummary = objectOf({
  id: text,
  name: text,
  project: optional(text),
  category: optional(oneOf('character', 'prop', 'part', 'scene')),
  tags: listOf(text),
  origin: oneOf(...MODEL_ORIGINS),
  createdAt: text,
  updatedAt: text,
  mainVersion: optional(text),
  preview: optional(text),
  versions: wholeNumber,
  active: wholeNumber,
  spent: optional(amount),
  spending: listOf(expenditure),
  sizeBytes: wholeNumber,
  has: objectOf({
    rig: boolean,
    animation: boolean,
    parts: boolean,
    images: boolean
  }),
});

const modelList = objectOf({
  libraryId: uuid,
  models: listOf(modelSummary),
  total: wholeNumber,
  broken: listOf(text)
});

const modelDetail = objectOf({
  libraryId: uuid,
  model: modelSummary,
  notes: text,
  versions: listOf(version),
  incoming: listOf(text),
  modelDirectory: text,
  saveFolders: optional(mapOf(mapOf(text))),
});

const providerState = objectOf({
  id: text,
  name: text,
  local: boolean,
  available: boolean,
  unit: optional(unitForms),
  balance: optional(objectOf({
    available: amount,
    reserved: amount
  })),
  billingUrl: optional(text),
});

const state = objectOf({
  libraryId: uuid,
  library: objectOf({
    dir: text,
    ok: boolean,
    error: optional(text),
    bytes: wholeNumber,
    freeBytes: optional(wholeNumber),
    lowDisk: boolean,
    modelBytes: wholeNumber,
    inputBytes: wholeNumber,
    temporaryBytes: wholeNumber,
  }),
  providers: listOf(providerState),
  active: wholeNumber,
  autoImport: boolean,
});

const quote = objectOf({
  total: optional(amount),
  lines: listOf(objectOf({
    label: text,
    amount
  })),
  unit: optional(unitForms),
  usd: optional(amount),
  note: optional(text),
});

const issue = objectOf({
  field: optional(text),
  message: text
});

const validation = objectOf({
  values: fieldValues,
  errors: listOf(issue),
  warnings: listOf(issue)
});

const fieldOption = objectOf({
  value: text,
  label: text,
  hint: optional(text),
  group: optional(text)
});

const operationField = objectOf({
  id: text,
  kind: oneOf('text', 'textarea', 'number', 'select', 'toggle', 'multiselect', 'view-prompts'),
  label: text,
  hint: optional(text),
  required: optional(boolean),
  default: optional(fieldValue),
  min: optional(numeric),
  max: optional(numeric),
  step: optional(numeric),
  maxLength: optional(wholeNumber),
  maxItems: optional(wholeNumber),
  unit: optional(text),
  options: optional(listOf(fieldOption)),
  advanced: optional(boolean),
  visibleWhen: optional(listOf(objectOf({
    field: text,
    is: optional(listOf(scalar)),
    not: optional(listOf(scalar))
  }))),
});

const offer = objectOf({
  provider: text,
  providerName: text,
  local: boolean,
  operation: text,
  label: text,
  group: text,
  fields: listOf(operationField),
  presets: listOf(objectOf({
    id: text,
    label: text,
    hint: optional(text),
    values: fieldValues
  })),
  note: optional(text),
  priceKnown: boolean,
  available: boolean,
  reason: optional(text),
  quote,
});

const taskRow = objectOf({
  intentId: text,
  childId: text,
  modelId: optional(text),
  modelName: optional(text),
  versionId: optional(text),
  label: text,
  provider: optional(text),
  status: oneOf(...VERSION_STATUSES),
  progress: percent,
  etaSeconds: optional(numeric),
  estimated: optional(amount),
  actual: optional(amount),
  paymentState: oneOf(...PAYMENT_STATES),
  unit: optional(unitForms),
  waitReason: optional(text),
  retryAvailable: boolean,
  retryReason: optional(text),
  error: optional(errorEntry),
  updatedAt: text,
});

const externalTask = objectOf({
  provider: text,
  taskId: text,
  type: text,
  label: text,
  credits: optional(amount),
  createdAt: optional(text),
  modelId: optional(text),
});

const upload = objectOf({
  libraryId: uuid,
  uploadId: text,
  name: text,
  kind: oneOf('image', 'model'),
  size: wholeNumber,
  stats: optional(stats),
  width: optional(wholeNumber),
  height: optional(wholeNumber),
});

const jobChild = objectOf({
  childId: text,
  versionId: optional(text),
  operation: text,
  provider: optional(text),
  status: oneOf(...VERSION_STATUSES),
  waitReason: optional(text),
  estimated: amount,
  actual: optional(amount),
  unit: optional(unitForms),
  paymentState: oneOf(...PAYMENT_STATES),
  taskId: optional(text),
  candidates: listOf(objectOf({
    taskId: text,
    type: text,
    createdAt: optional(text),
    credits: optional(amount),
  })),
  retryAvailable: boolean,
  retryReason: optional(text),
  error: optional(errorEntry),
});

const job = objectOf({
  intentId: uuid,
  libraryId: uuid,
  deleted: boolean,
  modelId: optional(text),
  children: listOf(jobChild),
  updatedAt: text,
});

const batchRow = objectOf({
  provider: text,
  operation: text,
  values: fieldValues,
  name: text,
  project: optional(text),
  category: optional(oneOf('character', 'prop', 'part', 'scene')),
  expectedPrice: amount,
});

const batchSnapshot = objectOf({
  libraryId: uuid,
  rows: listOf(batchRow),
  catalogVersion: text,
  totalEstimated: amount,
  unit: optional(unitForms),
});

const batchQuote = objectOf({
  libraryId: uuid,
  snapshot: batchSnapshot,
  snapshotHash: text,
  totalEstimated: amount,
  unit: optional(unitForms),
});

const batchRun = objectOf({
  intentId: uuid,
  libraryId: uuid,
  children: listOf(objectOf({
    childId: text,
    intentId: uuid,
    modelId: optional(text),
    status: oneOf(...VERSION_STATUSES),
    estimated: amount,
  })),
  totalEstimated: amount,
  unit: optional(unitForms),
  status: oneOf(...VERSION_STATUSES),
});

export type Studio3dStats = ReturnType<typeof stats>;
export type Studio3dVersion = ReturnType<typeof version>;
export type Studio3dModel = ReturnType<typeof modelSummary>;
export type Studio3dModelList = ReturnType<typeof modelList>;
export type Studio3dModelDetail = ReturnType<typeof modelDetail>;
export type Studio3dState = ReturnType<typeof state>;
export type Studio3dQuote = ReturnType<typeof quote>;
export type Studio3dValidation = ReturnType<typeof validation>;
export type Studio3dField = ReturnType<typeof operationField>;
export type Studio3dOffer = ReturnType<typeof offer>;
export type Studio3dTaskRow = ReturnType<typeof taskRow>;
export type Studio3dExternalTask = ReturnType<typeof externalTask>;
export type Studio3dUpload = ReturnType<typeof upload>;
export type Studio3dRigCheck = ReturnType<typeof rigCheck>;
export type Studio3dExpenditure = ReturnType<typeof expenditure>;
export type Studio3dJob = ReturnType<typeof job>;
export type Studio3dBatchQuote = ReturnType<typeof batchQuote>;
export type Studio3dBatchSnapshot = ReturnType<typeof batchSnapshot>;
export type Studio3dBatchRun = ReturnType<typeof batchRun>;

/**
 * Удалённое намерение возвращает tombstone без выдуманной модели и версий.
 * Существующая проекция сохраняет модель; проверка скелета может иметь пустой список.
 */
function runProjection(value: unknown) {
  const result = objectOf({
    libraryId: uuid,
    intentId: uuid,
    deleted: boolean,
    checkJobId: optional(uuid),
    model: optional(modelSummary),
    versions: listOf(version),
  })(value, 'run');

  if (result.deleted ? result.model !== null || result.versions.length !== 0 : result.model === null) {
    throw new Studio3dContractError('run.model');
  }

  return result;
}

/**
 * Разбор ответов по ручкам раздела. Корень пути попадает в текст ошибки: по нему видно,
 * какой ответ сервера не подошёл контракту.
 */
export const parseStudio3d = {
  ok: (value: unknown) => objectOf({ libraryId: uuid, ok: oneOf(true) })(value, 'ok'),
  values: (value: unknown): FieldValues => fieldValues(value, 'values'),
  unit: (value: unknown) => optional(unitForms)(value, 'unit'),
  price: (value: unknown) => quote(value, 'price'),
  validation: (value: unknown) => validation(value, 'validation'),
  stats: (value: unknown): Studio3dStats => stats(value, 'stats'),
  state: (value: unknown): Studio3dState => state(value, 'state'),
  models: (value: unknown): Studio3dModelList => modelList(value, 'models'),
  model: (value: unknown): Studio3dModelDetail => modelDetail(value, 'model'),
  version: (value: unknown): Studio3dVersion => version(value, 'version'),
  offers: (value: unknown) => objectOf({ libraryId: uuid, offers: listOf(offer) })(value, 'offers'),
  quote: (value: unknown) => objectOf({
    libraryId: uuid,
    quote,
    validation
  })(value, 'quote'),
  run: runProjection,
  job: (value: unknown): Studio3dJob => job(value, 'job'),
  batchQuote: (value: unknown): Studio3dBatchQuote => batchQuote(value, 'batchQuote'),
  batchRun: (value: unknown): Studio3dBatchRun => batchRun(value, 'batchRun'),
  createdModel: (value: unknown) => objectOf({
    libraryId: uuid,
    model: modelSummary,
    version
  })(value, 'createdModel'),
  upload: (value: unknown): Studio3dUpload => upload(value, 'upload'),
  tasks: (value: unknown) => objectOf({
    libraryId: uuid,
    active: listOf(taskRow),
    recent: listOf(taskRow),
    external: listOf(externalTask),
    week: objectOf({
      partial: boolean,
      groups: listOf(weeklyExpenditure)
    }),
    historyPartial: boolean,
    historyError: optional(text),
  })(value, 'tasks'),
  save: (value: unknown) => objectOf({
    libraryId: uuid,
    path: text,
    overwritten: boolean
  })(value, 'save'),
  scan: (value: unknown) => objectOf({
    libraryId: uuid,
    found: wholeNumber,
    imported: wholeNumber,
    skipped: wholeNumber,
    partial: boolean,
    reasons: listOf(text)
  })(value, 'scan'),
  lighten: (value: unknown) => objectOf({ libraryId: uuid, freed: wholeNumber })(value, 'lighten'),
  imported: (value: unknown) => objectOf({ libraryId: uuid, modelId: text })(value, 'imported'),
  viewer: (value: unknown) => objectOf({
    libraryId: uuid,
    url: text,
    name: text,
    ext: text,
    size: wholeNumber,
    libraryRef: optional(objectOf({
      modelId: text,
      versionId: text
    })),
  })(value, 'viewer'),
};
