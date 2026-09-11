// Контракт раздела «Презентации»: цель показа, ролик со сценами, задания и события.
// Типы выводятся из декодеров, поэтому форма данных и её проверка имеют один
// источник. Тем же декодером сервер читает собственное хранилище: повреждённый
// файл ролика обязан давать ошибку чтения, а не становиться состоянием раздела.
//
// Наружу уходит только то, что показывает интерфейс. Пути репозиториев, адрес
// серверной записи, состояние входа и переменные окружения остаются на сервере —
// они нужны исполнению, а не показу, и их утечка расширила бы область доверия.

import { contractDecoders } from './contractDecoders.ts';

/**
 * Идентификаторы генерирует сервер, поэтому форма у них узкая и общая для обеих
 * сторон: этим же выражением проверяется параметр маршрута, и клиент обязан
 * отклонять ровно то, что отклонит сервер.
 */
export const SHOWCASE_ID_RE = /^[a-z0-9]{10,32}$/;

/**
 * Версия схемы хранилища. Она хранится в каждом файле ролика: чтение обязано
 * отличать «файл другой версии» от «повреждённый файл», иначе миграция и починка
 * выглядят одинаково.
 */
export const SHOWCASE_SCHEMA_VERSION = 1;

export class ShowcaseContractError extends Error {
  constructor(path: string) {
    super(`Некорректные данные раздела «Презентации»: поле ${path}`);
    this.name = 'ShowcaseContractError';
  }
}

const {
  boolean,
  listOf,
  nullable,
  numeric,
  objectOf,
  oneOf,
  optional,
  record,
  text,
  wholeNumber,
} = contractDecoders((path) => {
  throw new ShowcaseContractError(path);
});

// Вид цели показа. Задача и песочница — разные источники: у задачи может не быть
// стенда вовсе, и подменять её адресом проекта нельзя.
const targetKind = oneOf('project', 'sandbox', 'task');

// Среда показа. Мутации возможны позже и только на подготовленной демо-копии;
// read-only означает права учётки на чтение, а не обещание «клик безопасен».
const environment = oneOf('isolated-demo', 'read-only');

// Возможности цели объявляет сервер: интерфейс не выводит их из вида цели, потому
// что профиль может не поддерживать вход, запись или подготовку данных.
const capability = oneOf('record', 'login', 'seed', 'mutations');

const screen = objectOf({
  id: text,
  title: text,
  // Путь показывается человеку в подсказке экрана; полный адрес записи остаётся
  // на сервере вместе с политикой.
  path: text,
});

/**
 * Публичная проекция области показа. `viewUrl` — готовая ссылка постоянного стенда;
 * у песочницы она null, потому что её внешний адрес зависит от места, где человек
 * открыл кокпит. Адрес серверной записи сюда не попадает вовсе.
 */
const scope = objectOf({
  targetKind,
  targetLabel: text,
  profile: text,
  viewUrl: nullable(text),
  environment,
  capabilities: listOf(capability),
  screens: listOf(screen),
  // Отпечатки цели и политики: по ним сервер отличает «та же цель» от «слот
  // переиспользован под другую задачу». Клиент их только показывает и возвращает.
  targetFingerprint: text,
  policyRevision: text,
  dataRevision: text,
  // Соответствие развёрнутой версии исходникам подтверждается, только если профиль
  // публикует ревизию сборки. Иначе интерфейс обязан сказать, что не подтверждено.
  buildRevision: nullable(text),
});

const targetRef = objectOf({
  kind: targetKind,
  id: text,
});

const targetOptionRef = objectOf({
  kind: oneOf('project', 'sandbox'),
  id: text,
});

// Цель либо готова к работе, либо названа причина и следующий шаг. Промежуточного
// «наверное сработает» нет: запись без проверенной цели не запускается.
const readyTarget = objectOf({
  status: oneOf('ready'),
  ref: targetRef,
  scope,
});

const blockedTarget = objectOf({
  status: oneOf('blocked'),
  ref: targetRef,
  profile: optional(text),
  reason: text,
  nextAction: nullable(objectOf({
    kind: oneOf('open-sandboxes', 'choose-project-url', 'configure-profile', 'retry'),
    label: text,
    hint: text,
  })),
});

/**
 * Объединение проверяется по метке состояния: сначала выбирается ветка, затем
 * работает её собственный декодер. Разбор «по наличию поля» принял бы ответ,
 * в котором есть и scope, и причина отказа.
 */
function targetResolution(value: unknown, path: string) {
  const source = record(value, path);

  if (source.status === 'ready') {
    return readyTarget(value, path);
  }

  return blockedTarget(value, path);
}

const artifactRef = objectOf({
  id: text,
  kind: oneOf('audio', 'clip', 'frame', 'final', 'subtitles'),
  // Хеш входов и хеш содержимого считает сервер: свежесть артефакта определяется
  // ими, а не отметкой времени и не ручным флагом «устарел».
  inputHash: text,
  contentHash: text,
  producerVersion: text,
  durationMs: nullable(wholeNumber),
  byteSize: wholeNumber,
});

const check = objectOf({
  id: text,
  kind: oneOf('speech', 'frame', 'ready', 'limits'),
  // Непроверенное отличается от пройденного и от заблокированного: пропущенная
  // проверка не красится в зелёный и не запрещает работу целиком.
  status: oneOf('passed', 'warning', 'blocked', 'skipped'),
  inputHash: text,
  artifactId: nullable(text),
  reason: text,
  textRange: nullable(objectOf({
    from: wholeNumber,
    to: wholeNumber,
  })),
  suggestions: listOf(text),
});

// Действие сцены — размеченное объединение, а не строка команды. Цель называется
// идентификатором из карты экранов: произвольный селектор, JS и путь к файлу сюда
// не проходят, поэтому предложение модели не может расширить полномочия.
const viewAction = objectOf({
  kind: oneOf('goto', 'click', 'hover', 'highlight', 'waitVisible'),
  targetId: text,
});

const scrollAction = objectOf({
  kind: oneOf('scroll'),
  targetId: nullable(text),
  delta: numeric,
});

const waitAction = objectOf({
  kind: oneOf('wait'),
  ms: wholeNumber,
});

function action(value: unknown, path: string) {
  const source = record(value, path);

  if (source.kind === 'scroll') {
    return scrollAction(value, path);
  }

  if (source.kind === 'wait') {
    return waitAction(value, path);
  }

  return viewAction(value, path);
}

// Указания речи: тон, темп, акценты и паузы. Ударения и паузы приходят одной
// канонической структурой — форма ввода со знаками разбирается на сервере, чтобы
// у них не появилось двух независимых источников.
const direction = objectOf({
  tone: nullable(text),
  pace: nullable(oneOf('slow', 'normal', 'fast')),
  emphasis: listOf(objectOf({
    from: wholeNumber,
    to: wholeNumber,
  })),
  pauses: listOf(objectOf({
    at: wholeNumber,
    ms: wholeNumber,
  })),
  stresses: listOf(objectOf({
    at: wholeNumber,
    vowel: wholeNumber,
  })),
});

const timing = objectOf({
  preRollMs: wholeNumber,
  narrationStartMs: wholeNumber,
  speechEndMs: wholeNumber,
  actionsEndMs: wholeNumber,
  postRollMs: wholeNumber,
  totalMs: wholeNumber,
});

// Источник звука сцены. Загруженная запись — полноправный источник того же
// конвейера, а не поддельный синтез: переозвучивать её автоматически нельзя.
const audioSource = objectOf({
  kind: oneOf('tts', 'recorded'),
  voiceRef: nullable(text),
  artifactId: nullable(text),
});

const scene = objectOf({
  id: text,
  order: wholeNumber,
  title: text,
  screenId: text,
  startState: nullable(text),
  readyCondition: nullable(text),
  actions: listOf(action),
  // Произносимый текст, экранная подпись и субтитр — три разных строки. Подпись
  // не выдаётся за дословные субтитры, а субтитр повторяет смысл речи письменно.
  narration: text,
  caption: text,
  subtitleText: text,
  direction,
  timing: nullable(timing),
  audioSource,
  audio: nullable(artifactRef),
  clip: nullable(artifactRef),
  frame: nullable(artifactRef),
  checks: listOf(check),
  // Свежесть считает сервер по хешам входов; клиент её только показывает.
  stale: boolean,
});

const decision = objectOf({
  id: text,
  kind: oneOf('script', 'check', 'final', 'data', 'provider'),
  // Решение привязано к хешу того входа, на который оно выдано: изменённое
  // проверяется заново, а старое подтверждение не переносится на новую редакцию.
  inputHash: text,
  decidedAt: text,
  note: text,
});

const finalArtifact = objectOf({
  video: artifactRef,
  subtitles: nullable(artifactRef),
  manifestId: text,
  builtAt: text,
  // Итог помечается предыдущим, если входы ролика с тех пор изменились: старый
  // файл можно посмотреть, но нельзя выдать за актуальный.
  current: boolean,
});

const projectSummary = objectOf({
  id: text,
  title: text,
  ref: targetRef,
  targetLabel: text,
  revision: wholeNumber,
  sceneCount: wholeNumber,
  state: oneOf('draft', 'ready', 'building', 'blocked', 'done'),
  hasFinal: boolean,
  updatedAt: text,
});

const project = objectOf({
  schemaVersion: wholeNumber,
  id: text,
  title: text,
  revision: wholeNumber,
  ref: targetRef,
  target: targetResolution,
  brief: listOf(text),
  scenes: listOf(scene),
  decisions: listOf(decision),
  latestFinal: nullable(finalArtifact),
  createdAt: text,
  updatedAt: text,
});

// Задание. Терминальные состояния обратно в работу не возвращаются: продолжение
// создаёт новую попытку с повторной проверкой входов.
const jobState = oneOf(
  'queued', 'running', 'awaiting_review', 'cancelling',
  'succeeded', 'failed', 'interrupted', 'cancelled',
);

const job = objectOf({
  id: text,
  projectId: text,
  kind: oneOf('script', 'voice', 'record', 'assemble'),
  state: jobState,
  attempt: wholeNumber,
  // Номер сообщения растёт монотонно: поздний отчёт прошлой попытки не должен
  // затирать статус новой, и сравнение идёт по нему, а не по времени прихода.
  sequence: wholeNumber,
  progress: objectOf({
    index: wholeNumber,
    total: wholeNumber,
    label: text,
  }),
  error: nullable(text),
  startedAt: text,
  finishedAt: nullable(text),
});

// Готовность по операциям, а не одним флагом: отсутствие голосового движка не
// запрещает скачать ролик, а отсутствие браузера не мешает готовить сценарий.
const doctorOperation = objectOf({
  id: oneOf('target', 'login', 'network', 'browser', 'media', 'voice', 'speech', 'storage'),
  title: text,
  status: oneOf('ready', 'warning', 'blocked', 'unknown'),
  reason: text,
  // Проверки, которые ходят в сеть или стоят денег, запускаются отдельно и явно.
  manual: boolean,
});

const doctor = objectOf({
  operations: listOf(doctorOperation),
  checkedAt: text,
});

// Старый список профилей остаётся в overview на время совместимости прежних
// клиентов. Новая форма использует только уже связанные сервером targetOption.
const targetProfile = objectOf({
  id: text,
  ready: boolean,
  reason: text,
});

// Цель для новой формы ролика уже связана сервером с доверенным профилем и
// адресом. Клиент выбирает эту запись целиком и не вводит профиль или порт сам.
const targetOption = objectOf({
  ref: targetOptionRef,
  profile: text,
  // Для ручной песочницы server-owned журнал может только предположить профиль.
  // Старый ответ без признака читается как null и получает безопасную базовую policy.
  profileBinding: optional(oneOf('verified', 'inferred')),
  label: text,
  // Постоянный стенд публикует готовую ссылку. Для локальной песочницы localhost
  // был бы адресом сервера, а не браузера человека, поэтому наружу идёт лишь порт.
  viewUrl: nullable(text),
  viewPort: nullable(wholeNumber),
  status: oneOf('ready', 'blocked'),
  reason: text,
  // Число экранов именно из объявления профиля. Ноль допустим: сервер даст
  // безопасный корневой экран, но UI честно покажет, что карта не настроена.
  screenCount: wholeNumber,
});

const overview = objectOf({
  targets: listOf(targetOption),
  // Старый список временно остаётся на проводе для совместимости клиентов,
  // которые ещё не перешли на выбор уже разрешённой цели.
  profiles: listOf(targetProfile),
  projects: listOf(projectSummary),
  jobs: listOf(job),
  limits: objectOf({
    maxScenes: wholeNumber,
    maxSceneSeconds: wholeNumber,
    maxTotalSeconds: wholeNumber,
    retentionDays: wholeNumber,
  }),
});

// Голосовые движки: наружу уходят возможности и описание голосов, но не способ
// подключения. Недоступный движок остаётся в списке с причиной — исчезнувший
// выглядел бы как «движков нет вовсе».
const voiceInfo = objectOf({
  id: text,
  name: text,
  language: text,
  available: boolean,
  reason: text,
});

const voiceEngineStatus = objectOf({
  id: text,
  name: text,
  kind: oneOf('local', 'cloud'),
  doctor: objectOf({
    status: oneOf('ready', 'blocked', 'unknown'),
    reason: text,
    // Установка движка и весов — отдельное действие настройки: doctor только
    // называет недостающее и ничего не скачивает.
    install: text,
  }),
  voices: listOf(voiceInfo),
});

// Голоса, которые раздел умеет поставить сам, и состояние идущей установки.
// Размер показывается до нажатия: качается это по сети человека и в его каталог.
const voicePackage = objectOf({
  id: text,
  // Пакет ставит конкретный движок и может нести несколько голосов сразу: человек
  // выбирает, кого услышит, а не файл модели.
  engineId: text,
  name: text,
  language: text,
  timbre: text,
  byteSize: wholeNumber,
  license: text,
  voices: listOf(text),
  installed: boolean,
});

const voiceInstallState = oneOf('running', 'succeeded', 'failed', 'cancelled', 'interrupted');

const voiceInstallJob = objectOf({
  id: text,
  engineId: text,
  voiceId: text,
  state: voiceInstallState,
  step: text,
  label: text,
  error: nullable(text),
  startedAt: text,
  finishedAt: nullable(text),
});

const voiceInstall = objectOf({
  available: listOf(voicePackage),
  job: nullable(voiceInstallJob),
});

const voiceCatalog = objectOf({
  engines: listOf(voiceEngineStatus),
  install: voiceInstall,
});

// События SSE несут только безопасную сводку: полные данные интерфейс перечитывает
// через ручку под сессией человека.
const progressEvent = objectOf({
  jobId: text,
  projectId: text,
  state: jobState,
  sequence: wholeNumber,
  label: text,
});

const changedEvent = objectOf({
  projectId: text,
  revision: wholeNumber,
});

// Установка голоса идёт минутами и не привязана к ролику, поэтому у неё своё
// событие: показывать её строкой прогресса проекта было бы неправдой.
const voiceEvent = objectOf({
  installId: text,
  voiceId: text,
  state: voiceInstallState,
  step: text,
  label: text,
  error: nullable(text),
});

export type ShowcaseTargetKind = ReturnType<typeof targetKind>;
export type ShowcaseCapability = ReturnType<typeof capability>;
export type ShowcaseScreen = ReturnType<typeof screen>;
export type ShowcaseScope = ReturnType<typeof scope>;
export type ShowcaseTargetRef = ReturnType<typeof targetRef>;
// Новая форма выбирает только опубликованный постоянный стенд или песочницу.
// `task` остаётся в общем ref лишь для чтения старых сохранённых роликов.
export type ShowcaseSelectableTargetRef = {
  kind: Exclude<ShowcaseTargetKind, 'task'>;
  id: string;
};
export type ShowcaseTarget = ReturnType<typeof targetResolution>;
export type ShowcaseArtifactRef = ReturnType<typeof artifactRef>;
export type ShowcaseCheck = ReturnType<typeof check>;
export type ShowcaseAction = ReturnType<typeof action>;
export type ShowcaseDirection = ReturnType<typeof direction>;
export type ShowcaseTiming = ReturnType<typeof timing>;
export type ShowcaseScene = ReturnType<typeof scene>;
export type ShowcaseDecision = ReturnType<typeof decision>;
export type ShowcaseFinal = ReturnType<typeof finalArtifact>;
export type ShowcaseTargetProfile = ReturnType<typeof targetProfile>;
export type ShowcaseTargetOption = ReturnType<typeof targetOption>;
export type ShowcaseProjectSummary = ReturnType<typeof projectSummary>;
export type ShowcaseProject = ReturnType<typeof project>;
export type ShowcaseJob = ReturnType<typeof job>;
export type ShowcaseJobState = ReturnType<typeof jobState>;
export type ShowcaseDoctor = ReturnType<typeof doctor>;
export type ShowcaseVoiceInfo = ReturnType<typeof voiceInfo>;
export type ShowcaseVoiceEngineStatus = ReturnType<typeof voiceEngineStatus>;
export type ShowcaseVoicePackage = ReturnType<typeof voicePackage>;
export type ShowcaseVoiceInstallJob = ReturnType<typeof voiceInstallJob>;
export type ShowcaseVoiceInstall = ReturnType<typeof voiceInstall>;
export type ShowcaseVoiceCatalog = ReturnType<typeof voiceCatalog>;
export type ShowcaseOverview = ReturnType<typeof overview>;
export type ShowcaseProgressEvent = ReturnType<typeof progressEvent>;
export type ShowcaseChangedEvent = ReturnType<typeof changedEvent>;
export type ShowcaseVoiceEvent = ReturnType<typeof voiceEvent>;

export function parseShowcaseOverview(value: unknown): ShowcaseOverview {
  return overview(value, 'overview');
}

export function parseShowcaseProject(value: unknown): ShowcaseProject {
  return project(value, 'project');
}

export function parseShowcaseTarget(value: unknown): ShowcaseTarget {
  return targetResolution(value, 'target');
}

export function parseShowcaseJob(value: unknown): ShowcaseJob {
  return job(value, 'job');
}

export function parseShowcaseDoctor(value: unknown): ShowcaseDoctor {
  return doctor(value, 'doctor');
}

export function parseShowcaseVoiceCatalog(value: unknown): ShowcaseVoiceCatalog {
  return voiceCatalog(value, 'voices');
}

export function parseShowcaseProgressEvent(value: unknown): ShowcaseProgressEvent {
  return progressEvent(value, 'progress');
}

export function parseShowcaseChangedEvent(value: unknown): ShowcaseChangedEvent {
  return changedEvent(value, 'changed');
}

export function parseShowcaseVoiceEvent(value: unknown): ShowcaseVoiceEvent {
  return voiceEvent(value, 'voice');
}

/**
 * Краткая карточка для списка роликов. Считается из полной записи на сервере,
 * чтобы список и карточка не разошлись в оценке состояния: у списка нет своего
 * мнения о том, готов ли ролик.
 */
export function toProjectSummary(source: ShowcaseProject, state: ShowcaseProjectSummary['state']) {
  return {
    id: source.id,
    title: source.title,
    ref: source.ref,
    targetLabel: source.target.status === 'ready' ? source.target.scope.targetLabel : '',
    revision: source.revision,
    sceneCount: source.scenes.length,
    state,
    hasFinal: source.latestFinal !== null,
    updatedAt: source.updatedAt,
  };
}
