// Чат с агентами — МУЛЬТИСЕССИИ (вкладки, как в VS Code).
// Каждая сессия: своя задача (опционально), модель, усилие, история, sessionId (--resume),
// размер контекста. История хранится НА СЕРВЕРЕ (файл в .state кокпита) — общая для всех
// окон/устройств и переживает чистку браузера. Это единый источник истории для
// полноразмерной страницы «Чаты» и Telegram-пульта.
import { defineStore } from 'pinia';
import { normalizeChatWorkdir, normalizeRecentWorkdirs, sameChatWorkdir }
  from '../../../shared/chat/chatWorkdir.ts';
import { api } from '../shared/apiClient.ts';
import { router } from '../router.js';
import { useUiContextStore } from './ui-context.js';
import { useProvidersStore } from './providers.js';
import { alertUser, dismissAlert, dismissAlertScope } from '../shared/alerts.ts';
import { quickPermission } from '../shared/quickPermission.ts';
import { sseSubscribe } from '../composables/useSse.ts';
import { mdToText } from '../shared/md.ts';
import { createChatListPreviewCache } from '../shared/chatListPreview.ts';
import { captureChatHistorySnapshot } from '../shared/chatHistorySnapshot.ts';
import {
  createChatPersistenceProjectionCache,
  stringifyChatStoreSnapshot,
} from '../shared/chatPersistenceProjection.ts';
import { createChatHistoryStepReuseState, mayRetryFullHistory } from '../shared/chatHistoryStepReuse.ts';
import { chatVisibility } from '../shared/chat-visibility.js';
import { normalizeContextUsage } from '../../../shared/chat/chatContextUsage.ts';
import { normalizeChatRunSnapshot } from '../../../shared/chat/chatRun.ts';
import { IN_TURN_PROTOCOL, IN_TURN_TEXT_LIMIT_BYTES, utf8Bytes }
  from '../../../shared/chat/chatInTurnContracts.ts';
import {
  applyAssistantFinal,
  closeOpenDrafts,
  materializeInTurnMessages,
  mergeInTurnAvailability,
  mergeInTurnEntry,
  mergeInTurnPage,
  newChatInTurnRun,
} from './chatInTurn.ts';
import {
  applyGeneratedChatTitle,
  firstMessageTitle,
  provisionalChatTitle,
  shouldRequestChatTitle,
} from '../shared/chat-title.js';

// Оценочное окно контекста модели — для индикатора заполнения.
export const CONTEXT_WINDOW = 200000;
export const DEFAULT_SPEECH = Object.freeze({
  engine: 'browser',
  browserProcessing: 'auto',
  browserAutoConsent: false,
  language: 'auto',
  dictionary: '',
  quality: 'balanced',
  videoQuality: 'balanced',
  model: null,
  videoModel: null,
  device: 'auto',
  computeType: null,
  beamSize: null,
  vadSilenceMs: 500,
  conditionOnPreviousText: true,
  resident: false,
  keepAliveMin: 5,
  local: Object.freeze({ ready: false, reason: 'Локальный движок не настроен.' }),
  capabilities: Object.freeze({
    models: Object.freeze([]),
    cuda: Object.freeze({ state: 'probe_failed', reason: '' }),
    languages: Object.freeze(['ru', 'en', 'auto']),
    lastDictionaryMeasure: null,
    resident: null,
    benchmark: null,
  }),
  revision: '',
});

/**
 * Речь приезжает и внутри chat-store snapshot, и отдельным settings/SSE-ответом.
 * Нормализуем в одном месте: старый/частичный сервер не должен включить облачный путь
 * невалидным значением или уронить композер отсутствующим `local`.
 */
export function normalizeSpeechSnapshot(payload, previous = DEFAULT_SPEECH) {
  const raw = payload?.speech || payload?.settings || payload || {};
  const givenPrevious = previous || {};
  const prev = {
    ...DEFAULT_SPEECH,
    ...givenPrevious,
    local: { ...DEFAULT_SPEECH.local, ...(givenPrevious.local || {}) },
    capabilities: { ...DEFAULT_SPEECH.capabilities, ...(givenPrevious.capabilities || {}) },
  };
  const engine = raw.engine === 'browser' || raw.engine === 'whisper'
    ? raw.engine
    : prev.engine;
  const browserProcessing = raw.browserProcessing === 'local' || raw.browserProcessing === 'auto'
    ? raw.browserProcessing
    : prev.browserProcessing;
  const language = ['ru', 'en', 'auto'].includes(raw.language) ? raw.language : prev.language;
  const capabilitiesRaw = payload?.capabilities || raw.capabilities || prev.capabilities || {};
  const capabilityLocal = capabilitiesRaw.local;
  const local = raw.local && typeof raw.local === 'object'
    ? raw.local
    : (capabilityLocal && typeof capabilityLocal === 'object' ? capabilityLocal : prev.local);
  const capabilityLocalDetails = capabilityLocal && typeof capabilityLocal === 'object'
    ? capabilityLocal : local;
  const revision = raw.revision ?? payload?.revision;
  const nullableEnum = (value, allowed, fallback) => (value === null || allowed.includes(value) ? value : fallback);
  const nullableInt = (value, min, max, fallback) => (
    value === null || (Number.isInteger(value) && value >= min && value <= max) ? value : fallback
  );
  return {
    engine,
    browserProcessing,
    browserAutoConsent: raw.browserAutoConsent === undefined
      ? !!prev.browserAutoConsent
      : raw.browserAutoConsent === true,
    language,
    dictionary: typeof raw.dictionary === 'string' ? raw.dictionary : (prev.dictionary || ''),
    quality: ['fast', 'balanced', 'accurate'].includes(raw.quality) ? raw.quality : prev.quality,
    videoQuality: ['fast', 'balanced', 'accurate'].includes(raw.videoQuality)
      ? raw.videoQuality : prev.videoQuality,
    model: nullableEnum(raw.model, ['small', 'medium', 'large-v3', 'large-v3-turbo'], prev.model),
    videoModel: nullableEnum(raw.videoModel, ['small', 'medium', 'large-v3', 'large-v3-turbo'], prev.videoModel),
    device: ['auto', 'cpu', 'cuda'].includes(raw.device) ? raw.device : prev.device,
    computeType: nullableEnum(raw.computeType, ['int8', 'int8_float16', 'float16', 'float32'], prev.computeType),
    beamSize: nullableInt(raw.beamSize, 1, 10, prev.beamSize),
    vadSilenceMs: Number.isInteger(raw.vadSilenceMs) && raw.vadSilenceMs >= 100 && raw.vadSilenceMs <= 5000
      ? raw.vadSilenceMs : prev.vadSilenceMs,
    conditionOnPreviousText: typeof raw.conditionOnPreviousText === 'boolean'
      ? raw.conditionOnPreviousText : prev.conditionOnPreviousText,
    resident: typeof raw.resident === 'boolean' ? raw.resident : prev.resident,
    keepAliveMin: Number.isInteger(raw.keepAliveMin) && raw.keepAliveMin >= 0 && raw.keepAliveMin <= 60
      ? raw.keepAliveMin : prev.keepAliveMin,
    local: {
      ready: local?.ready === true,
      reason: typeof local?.reason === 'string' ? local.reason : '',
    },
    capabilities: {
      models: Array.isArray(capabilitiesRaw.models) ? capabilitiesRaw.models : (prev.capabilities?.models || []),
      cuda: capabilitiesRaw.cuda && typeof capabilitiesRaw.cuda === 'object'
        ? capabilitiesRaw.cuda : (prev.capabilities?.cuda || { state: 'probe_failed', reason: '' }),
      languages: Array.isArray(capabilitiesRaw.languages)
        ? capabilitiesRaw.languages : (prev.capabilities?.languages || ['ru', 'en', 'auto']),
      lastDictionaryMeasure: capabilitiesRaw.lastDictionaryMeasure ?? prev.capabilities?.lastDictionaryMeasure ?? null,
      resident: capabilitiesRaw.resident ?? prev.capabilities?.resident ?? null,
      benchmark: capabilitiesRaw.benchmark && typeof capabilitiesRaw.benchmark === 'object'
        ? capabilitiesRaw.benchmark : (prev.capabilities?.benchmark || null),
      local: {
        ready: capabilityLocalDetails?.ready === true,
        reason: typeof capabilityLocalDetails?.reason === 'string' ? capabilityLocalDetails.reason : '',
        checks: Array.isArray(capabilityLocalDetails?.checks) ? capabilityLocalDetails.checks : [],
      },
    },
    // CAS revision выдаётся как opaque-токен: его нельзя
    // приводить к числу или получится fail-open consent из stale-окна.
    revision: typeof revision === 'string' && revision ? revision : (prev.revision || ''),
  };
}
// Старое браузерное хранилище — остаётся только как источник одноразовой миграции.
const LS_KEY = 'cockpit-chat-v2';

function uid() { return `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`; }

function pickStore(j) {
  return {
    sessions: Array.isArray(j?.sessions) ? j.sessions : [],
    archived: Array.isArray(j?.archived) ? j.archived : [],
    activeId: j?.activeId || null,
    // Пусто = «ещё не выбирали»: модель нового чата возьмётся из реестра (см. defaultModelId).
    defModel: j?.defModel || '',
    defModelRef: j?.defModelRef || null,
    defEffort: j?.defEffort || '',
    // Режим прав по умолчанию для новых чатов (пусто = как решит сервер по странице).
    defMode: j?.defMode || '',
    defWorkdir: normalizeChatWorkdir(j?.defWorkdir) || { kind: 'cockpit' },
    recentWorkdirs: normalizeRecentWorkdirs(j?.recentWorkdirs),
  };
}

let persistTimer = null;
let retryTimer = null;
let retryDelay = 0;
let loadPromise = null;
// Ждёт ли записи страховочный снимок (см. _persist): изменилась переписка, а не черновик.
let needSnapshot = false;

// ── Что уже лежит на сервере ──────────────────────────────────────────────────
// id чата → его отпечаток (fingerprintOf) на момент последней УСПЕШНОЙ записи. По этой карте шлём только
// изменившееся: раньше каждое сохранение тащило весь стор одним телом, и когда история
// доросла до лимита запроса, сервер стал отвечать 413 — переписка перестала сохраняться
// совсем, а клиент молча ретраил. Теперь объём запроса не зависит от размера истории.
const historyPersistence = new WeakMap();
const persistenceProjections = new WeakMap();

/**
 * Подтверждения и dirty-сигнатуры принадлежат экземпляру стора, а не Pinia-снимку.
 * Поколение данных защищает от позднего ACK после принятого GET или удаления чата.
 */
function historyPersistenceFor(store) {
  let state = historyPersistence.get(store);

  if (!state) {
    state = createChatHistoryStepReuseState();
    historyPersistence.set(store, state);
    persistenceProjections.set(store, createChatPersistenceProjectionCache({
      active: slimOf,
      archived: archivedSlimOf,
      fingerprint: fingerprintOf,
      snapshot: stripSteps,
    }));

    const dispose = store.$dispose;

    store.$dispose = () => {
      state.clear();
      previewCaches.get(store)?.clear();
      persistenceProjections.get(store)?.clear();
      persistenceProjections.delete(store);
      historyPersistence.delete(store);
      dispose.call(store);
    };
  }

  return state;
}

const previewCaches = new WeakMap();
let sentMeta = '';
let saveWarned = false;

// Перед model POST чат сохраняется с CAS-revision. Другое окно может успеть записать
// черновик/ответ между нашим чтением и PUT — сервер сольёт историю, вернёт свежую
// revision и stale=true. Повторяем только безопасный PUT, сам ход агента здесь ещё
// не начинался. Бесконечно спорить с постоянно пишущим окном нельзя.
const CHAT_SAVE_ATTEMPTS = 3;

// ── Доставка хода по протоколу приёма ─────────────────────────────────────────
// Сервер, объявивший turnProtocol, принимает ход коротким POST с устойчивым turnId и
// исполняет его без HTTP-соединения; итог приходит через chats/pending. Раньше POST
// висел весь ход: несколько чатов съедали лимит соединений браузера, а оборванный
// запрос оставлял реплику без исполнителя и без объяснения.
const TURN_PROTOCOL = 1;
// Сколько ждать подтверждения приёма. Дольше — исход неизвестен, и безопасен только
// повтор ТЕМ ЖЕ turnId: сервер узнает его и исполнителя второй раз не запустит.
const ACCEPT_TIMEOUT_MS = 20000;
// Паузы автоматических повторов доставки; когда они кончились — кнопка у реплики.
const REDELIVERY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000];
// Сервер принимает не больше стольких id за один запрос статуса.
const TURN_STATUS_BATCH = 50;
// turnId → таймер следующей попытки доставки.
const redeliveryTimers = new Map();
// turnId, по которым прямо сейчас летит POST приёма: второй параллельный не нужен.
const postingTurns = new Set();
// turnId → контекст страницы на момент отправки: автоматический повтор несёт тот же.
// Отсутствие записи значит, что реплику отправляло другое окно или окно до F5.
const outgoing = new Map();
// Подбор pending и сверка после переподключения — по одному за раз; просьба, пришедшая
// во время прохода, даёт ещё один проход после него (повторные hello, chat-orphan).
let collectJob = null;
let collectAgain = false;
let reconnectJob = null;
let reconnectAgain = false;
// Чужая реплика без подтверждения приёма (её отправляет другое окно): даём владельцу
// время получить ответ и только потом сверяемся с сервером сами — вдруг он умер.
const FOREIGN_DELIVERY_GRACE_MS = 15000;
let reconcileTimer = null;

// Запись истории по чатам: id → { tail, next, force }. Следующий PUT чата ждёт ответа
// на предыдущий, а все просьбы, пришедшие за время полёта, склеиваются в одну.
const chatSaves = new Map();

/**
 * Id отправки: 8–80 символов [A-Za-z0-9_-], как требует сервер. Время в начале
 * упорядочивает id по созданию, случайный хвост делает их уникальными между окнами.
 */
function newTurnId() {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, '')
    || `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

  return `t${Date.now().toString(36)}${random.slice(0, 16)}`;
}

// Запись о доставке реплики для рендера этого окна: чей чат, стадия и номер попытки.
function deliveryOf(chatId, state, attempt) {
  return {
    chatId,
    state,
    attempt,
  };
}

function chatRevisionConflict() {
  const error = new Error('Чат одновременно меняется в другом окне. Закрой лишние окна или повтори отправку.');
  error.code = 'chat_revision_conflict';
  return error;
}

function isConnectionError(error) {
  return error instanceof TypeError
    || error?.name === 'TimeoutError'
    || error?.name === 'AbortError';
}

// Время отправки хранится у самой реплики, а не вычисляется из updatedAt чата:
// последний меняется и после ответа агента, переименования и синхронизации окон.
function messageSentAt(value) {
  const sentAt = Number(value);
  return Number.isSafeInteger(sentAt) && sentAt > 0 ? sentAt : 0;
}

// Ответ может приехать тремя путями: прямо в send(), из chats/pending после обрыва
// вкладки или синхронизацией истории с другого устройства. Ключи не дают одному ответу
// зазвонить дважды, если пути пересеклись. Set ограничиваем, чтобы долгая вкладка не росла.
const notifiedReplies = new Set();
function rememberReplyNotice(key) {
  if (!key || notifiedReplies.has(key)) return false;
  notifiedReplies.add(key);
  if (notifiedReplies.size > 500) notifiedReplies.delete(notifiedReplies.values().next().value);
  return true;
}

function messageNoticeKey(chatId, message, index) {
  if (message?.pid) return `${chatId}:pid:${message.pid}`;
  return `${chatId}:message:${index}:${message?.role || ''}:${message?.text || ''}`;
}

// Промежуточная реплика идущего хода — блок без итога: ни ленты шагов, ни прикреплённого финала.
// Оповещение и «непрочитано» относятся к итогу хода; агент, который пишет реплику на каждом
// шаге (GLM, DeepSeek), иначе звонил бы весь ход. Правило то же, что у ленты чата.
function isIntermediateReply(message) {
  return message?.kind === 'assistant-block'
    && !message.finalAssistantMessageId && !Array.isArray(message.steps);
}

// Когда историю последний раз сверяли с сервером целиком. Нужно, чтобы первое `hello`
// (оно приходит сразу после загрузки) не тянуло всю историю по второму разу.
let storeSyncedAt = 0;
// EventSource может прислать несколько hello подряд. Пропущенный за время
// разрыва speech-settings восстанавливаем одним shared GET, а не по запросу на hello.
let speechSyncPromise = null;
// GET сверки и SSE идут по разным соединениям. Если за время GET уже применился
// новый снимок (SSE, save или consent), поздний HTTP-ответ не имеет права откатить его.
let speechSnapshotEpoch = 0;

// Чаты, по которым прямо из ЭТОГО окна висит незакрытый запрос сжатия. Нужны, чтобы
// сверка активных ходов (_loadActive) не сняла заморозку под своим же запросом: у сжатия
// нет счётчика inflight, а сервер попадает в список активных не мгновенно.
const compactInflight = new Set();

// Явный reset исполнителя с server-owned binding меняет серверную сессию и потому
// является асинхронным.
// Карта не даёт отправить сообщение в коротком окне между нажатием «сбросить» и
// подтверждением сервера, а повторный reset того же чата присоединяется к первому.
const sessionResetJobs = new Map();

// Кто именно пишет — чтобы не принимать собственное эхо. Своё изменение уже в сторе,
// а серверная копия по нему прилетает тем же событием, что и чужая (см. `chat-store`).
const WINDOW_ID = `w${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

// Лента живёт скользящим окном, как и её копия на сервере: длинный ход даёт тысячи
// шагов, и без вытеснения окно (а с ним и DOM списка) растёт весь ход. Держим хвост —
// начало давно уехало за экран, а свежее и есть признак, что агент жив.
const MAX_STEPS = 400;

// Вытеснение не молчит: место самого старого шага занимает строка-счётчик, иначе живая
// лента выглядит полным отчётом о ходе, из которого начало уже выброшено. Копия
// серверной арифметики (`lib/chat/streamSteps.ts` → `pushChatStep`): стор грузят
// офлайн-тесты подменой импортов в исходнике, поэтому общий модуль сюда не завезёшь.
function pushStep(steps, step) {
  steps.push(step);
  if (steps.length <= MAX_STEPS) return;
  const removed = steps.splice(0, steps.length - (MAX_STEPS - 1));
  // Прежняя метка уехала вместе с вытесненными шагами — её счётчик продолжаем.
  const dropped = (removed.find((s) => s.truncated)?.dropped || 0)
    + removed.filter((s) => !s.truncated).length;
  steps.unshift({
    k: 'note',
    level: 'warn',
    truncated: true,
    dropped,
    text: `… ранние шаги хода скрыты: ${dropped}`,
    at: Date.now(),
  });
}

// Выжимка после сжатия едет агенту первым блоком следующего сообщения. Формат блока
// знает только это окно, поэтому и снимать его — здесь же: сервер запоминает в pending
// весь текст запроса как «вопрос пользователя», а в переписке блоку не место — там уже
// есть и вся история, и плашка о сжатии.
const SEED_OPEN = '[Выжимка предыдущего разговора — продолжаем с этого места]';
const SEED_CLOSE = '[/Выжимка]';
function withSeed(seed, text) {
  return seed ? `${SEED_OPEN}\n${seed}\n${SEED_CLOSE}\n\n${text}` : text;
}
function stripSeed(userText) {
  const text = String(userText || '');
  if (!text.startsWith(SEED_OPEN)) return text;
  const end = text.indexOf(`\n${SEED_CLOSE}\n\n`);
  return end < 0 ? text : text.slice(end + SEED_CLOSE.length + 3);
}
// Сама выжимка из текста запроса: итог принятого хода, сбросившего сессию, обязан
// вернуть её в ожидание — окно, отправлявшее ход, могло уже перезагрузиться.
function seedOf(userText) {
  const text = String(userText || '');

  if (!text.startsWith(SEED_OPEN)) {
    return '';
  }

  const end = text.indexOf(`\n${SEED_CLOSE}\n\n`);

  return end < 0 ? '' : text.slice(SEED_OPEN.length + 1, end);
}

// Рантайм-поля чата: живут только в окне и на сервер не едут (см. slimOf). При замене
// чата серверной копией их надо сохранить — иначе принятое чужое изменение погасило бы
// «думает…»/кольцо и стёрло ленту шагов идущего прямо сейчас хода.
const RUNTIME_KEYS = [
  'workdirChanging', 'workdirProposal', 'workdirPreview', 'workdirInitializing',
  'workdirImplicit', 'sending', 'compacting', 'stopping', 'progressTokens', 'progressTokensEstimate',
  'turnStartedAt', 'steps', 'error', 'inflight', 'offline',
  'sessionResetting', 'sessionResetFailed', 'liveContext', 'liveContextUsage', 'liveContextCache',
];
function runtimeOf(s) {
  const out = {};
  for (const k of RUNTIME_KEYS) if (s?.[k] !== undefined) out[k] = s[k];
  return out;
}

/**
 * Начало идущего хода по часам ЭТОГО окна из длительности, которую назвал сервер.
 * Ноль — длительности нет (старый сервер или мусор): таймер молчит, а не выдумывает.
 */
function turnStartFromElapsed(elapsedMs, now = Date.now()) {
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return 0;
  }

  return now - Math.floor(elapsedMs);
}

// Порядок чатов в сторе — как у сервера (по времени создания): иначе вкладки прыгали бы
// в зависимости от того, каким путём чат попал в окно — загрузкой или досинхронизацией.
function insertByCreated(list, chat) {
  const at = chat.createdAt || 0;
  const i = list.findIndex((c) => (c.createdAt || 0) > at);
  if (i < 0) list.push(chat); else list.splice(i, 0, chat);
}

const CONTEXT_CACHE_STATUSES = new Set(['reported', 'unavailable', 'not-applicable']);

/**
 * Кэш контекста — снимок одного model request, а не накопительный счётчик сессии.
 * Границу provider-а держим строгой: неизвестный статус и кривые числа не должны
 * превращаться в нулевой cache miss или выдуманную экономию.
 */
export function normalizeContextCache(value) {
  const status = value?.scope === 'request' && CONTEXT_CACHE_STATUSES.has(value?.status)
    ? value.status
    : 'unavailable';
  const normalized = { scope: 'request', status };
  if (status !== 'reported') return normalized;
  for (const key of ['readTokens', 'writeTokens', 'uncachedTokens']) {
    if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) normalized[key] = value[key];
  }
  return Object.keys(normalized).length > 2
    ? normalized
    : { scope: 'request', status: 'unavailable' };
}

/**
 * Неотправленные вложения черновика — те же ссылки на серверные файлы, что уходят в
 * историю вместе с сообщением. Абсолютный путь с диска, который отдаёт загрузка,
 * в JSON чата не кладём; мусорные записи старых или чужих копий отбрасываем.
 */
function draftAttachmentsOf(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((a) => typeof a?.file === 'string' && a.file)
    .map((a) => ({
      file: a.file,
      name: String(a.name || a.file),
      url: String(a.url || ''),
      mime: String(a.mime || ''),
    }));
}

/**
 * Чат в том виде, в каком он едет на сервер: без рантайм-полей (sending/error/steps).
 * Пустые вложения черновика не пишем — запись чата без черновика не меняется.
 */
function slimOf(s) {
  return {

    workdir: s.workdir,
    workdirState: s.workdirState,

    id: s.id,
    taskId: s.taskId,
    title: s.title,
    model: s.model,
    modelRef: s.modelRef || null,
    // Служебные рабочие чаты (например Debug) остаются обычными пользовательскими
    // чатами, но эта устойчивая метка позволяет повторной кнопке открыть тот же
    // разговор вместо размножения сессий. По заголовку связывать нельзя — он редактируемый.

    purpose: s.purpose || '',
    sourceChatId: s.sourceChatId || null,

    ...(s.logicalIdentity ? { logicalIdentity: s.logicalIdentity } : {}),

    schema: s.schema,
    surface: s.surface,
    revision: s.revision,

    effort: s.effort,
    mode: s.mode || '',

    messages: s.messages,
    sessionId: s.sessionId,
    contextTokens: s.contextTokens,

    contextWindow: s.contextWindow || 0,
    contextMetric: s.contextMetric || '',

    contextIsEstimate: !!s.contextIsEstimate,

    totalInputTokens: s.totalInputTokens || 0,
    cachedInputTokens: s.cachedInputTokens || 0,

    contextCache: normalizeContextCache(s.contextCache),
    // Выжимка после сжатия у исполнителя без родного компакта: ждёт следующего
    // сообщения, чтобы уехать первой в новую сессию. Обязана переживать F5 — иначе
    // сжатие превратилось бы в потерю памяти агента.

    pendingSeed: s.pendingSeed || '',

    compactedAt: s.compactedAt || 0,

    draft: s.draft || '',
    ...(s.draftAttachments?.length ? { draftAttachments: s.draftAttachments } : {}),
    unread: !!s.unread,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,

  };
}

// Лента шагов хода, переехавшая в сообщение (`msg.steps`), занимает основную часть
// большой истории. Всё, что сериализуется на каждое сохранение, обязано считаться
// БЕЗ неё, иначе главный поток встаёт на сотни
// миллисекунд — в том числе прямо во время набора текста (черновик сохраняется тем же
// путём). На сервер шаги при этом едут как обычно: экономим на служебных копиях, не на
// самих данных.
function stripSteps(chat) {
  const messages = (chat.messages || []).map((m) => {
    if (!m?.steps) return m;
    const { steps, ...rest } = m;
    return rest;
  });
  return { ...chat, messages };
}

/**
 * Отпечаток чата — ответ на единственный вопрос: «эта версия уже уехала на сервер?».
 * Шаги заменены своим числом; замены массивов ловит отдельная dirty-сигнатура ссылок и версий.
 * Неизменяемые исторические тела не обходятся при служебном сравнении. Полный
 * `JSON.stringify` большой истории заметно блокировал КАЖДОЕ сохранение и держал вторую
 * копию тех же строк в карте `sentChats`.
 */
function fingerprintOf(chat) {
  const messages = (chat.messages || []).map((m) => (m?.steps?.length
    ? { ...m, steps: m.steps.length }
    : m));
  return JSON.stringify({ ...chat, messages });
}

function applySaveAck(session, response) {
  if (!session || !response) return;
  if (Number.isSafeInteger(response.revision)) session.revision = response.revision;
  if (Number.isSafeInteger(response.schema)) session.schema = response.schema;
  if (response.surface) session.surface = response.surface;
  if (response.modelRef) session.modelRef = response.modelRef;
  if (response.modelRefState) session.modelRefState = response.modelRefState;

  for (const key of ['workdir', 'taskId', 'workdirState', 'sessionId', 'pendingSeed']) {
    if (Object.hasOwn(response, key)) {
      session[key] = response[key];
    }
  }
}

function selectedModel(session) {
  return session?.modelRef || session?.model || '';
}

const CODEX_CONTEXT_METRIC = 'active-input-v1';

function metricNumber(value, { positive = false } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < 0 || (positive && value <= 0)) {
    return null;
  }

  return value;
}

/**
 * Живые поля не записываем в историю. Цифра, окно и достоверность меняются вместе,
 * а событие только со счётчиком вывода оставляет снимок последнего запроса на месте.
 */
function applyLiveContextUsage(session, payload) {
  const usage = normalizeContextUsage(payload);

  if (Object.keys(usage).length) {
    session.liveContextUsage = { ...session.liveContextUsage, ...usage };
    if (usage.contextTokens !== undefined) {
      session.liveContext = usage.contextTokens;
    }
  }
  if (Object.hasOwn(payload, 'contextCache')) {
    session.liveContextCache = normalizeContextCache(payload.contextCache);
  }
}

function isCodexChat(session) {
  return session?.modelRef?.provider === 'codex'
    || /^(?:gpt-|codex-)/i.test(String(session?.model || ''));
}

/** Одна точка применения метрик: обычный ответ и orphan после обрыва не расходятся. */
function applyContextUsage(session, payload) {
  if (!session || !payload) return;
  Object.assign(session, normalizeContextUsage(payload));
  const total = metricNumber(payload.totalInputTokens);
  if (total !== null) session.totalInputTokens = total;
  const cached = metricNumber(payload.cachedInputTokens);
  if (cached !== null) session.cachedInputTokens = cached;
  if (Object.hasOwn(payload, 'contextCache')) {
    session.contextCache = normalizeContextCache(payload.contextCache);
  }
}

// Итог удавшегося сжатия — один и тот же, откуда бы он ни приехал: ответом на свой
// запрос или через pending, если окно перезагрузили посреди сжатия. Два пути (какой —
// решает исполнитель на сервере):
//   native  — CLI сжал разговор сам, сессия та же, ничего больше делать не надо;
//   summary — сервер вернул выжимку; сессию обнуляем, выжимка ждёт в pendingSeed и
//             уедет первой в новую сессию вместе со следующим сообщением.
// Точный размер контекста после сжатия не знает никто: ход сжатия читал ещё СТАРУЮ
// переписку. Поэтому обнуляем счётчик и ждём следующего обычного хода — он измерит.
function applyCompactResult(session, result, before) {
  if (result.compact?.kind === 'summary') {
    if (!result.compact.seed) throw new Error('Сервер не вернул выжимку — контекст не сжат.');
    session.pendingSeed = result.compact.seed;
    session.sessionId = null;
  }
  session.contextTokens = 0;
  session.contextWindow = 0;
  session.contextMetric = '';
  session.contextIsEstimate = false;
  session.totalInputTokens = 0;
  session.cachedInputTokens = 0;
  session.contextCache = normalizeContextCache(null);
  session.liveContextUsage = null;
  session.liveContextCache = null;
  session.compactedAt = Date.now();
  session.messages.push({
    role: 'note',
    text: `🗜 Контекст сжат — было ${before.toLocaleString('ru')} токенов.`,
  });
}

/** Обнулить provider session и её метрики. Выжимку выбрасываем только при явном reset:
 * после аварийного сброса/stop она всё ещё нужна следующей чистой сессии. */
function clearSessionContext(session, { discardSeed = false } = {}) {
  if (!session) return;
  session.sessionId = null;
  session.contextTokens = 0;
  session.contextWindow = 0;
  session.contextMetric = '';
  session.contextIsEstimate = false;
  session.totalInputTokens = 0;
  session.cachedInputTokens = 0;
  session.contextCache = normalizeContextCache(null);
  session.liveContext = 0;
  session.liveContextUsage = null;
  session.liveContextCache = null;
  if (discardSeed) {
    session.pendingSeed = '';
    session.compactedAt = 0;
  }
}

// Архив сохраняем тем же узким снимком, что и активный чат, плюс момент закрытия.
// Сам объект в памяти может продолжать получать ответ агента уже после архивирования,
// но рантайм-поля (sending/error/steps) в файл истории попадать не должны.
function archivedSlimOf(s) {
  return { ...slimOf(s), closedAt: s.closedAt || s.updatedAt || s.createdAt || Date.now() };
}

// ── Страховочный снимок истории в браузере ────────────────────────────────────
// Сервер пишет историю в файлы, но между «ответ пришёл» и «PUT долетел» есть окно:
// если в него попадает рестарт сервера, последний ответ пропадает. Снимок закрывает
// именно это окно — при загрузке берём его, если он свежее серверного.
const SNAP_KEY = 'cockpit-chat-snapshot';
// Сколько последних чатов оставляем, когда снимок целиком не влез в квоту.
const SNAP_FALLBACK_CHATS = 20;

// Снимок страхует ПОСЛЕДНИЙ ОТВЕТ, а не архив лент шагов, поэтому шаги в него не идут:
// без них большая история уменьшается на порядок и помещается в квоту localStorage.
// До этой правки обе попытки записи падали с QuotaExceededError — то есть страховки не
// существовало вовсе, а платили за неё сотнями миллисекунд блокировки главного потока.
/**
 * Полный страховочный снимок переиспользует JSON неизменённых чатов без обхода их сообщений.
 * При нехватке квоты сохраняется прежний fallback: двадцать последних разговоров целиком.
 */
function writeSnapshot(payload, projections) {
  const sessions = projections.sessions.map((entry) => entry.snapshot.value);
  const archived = projections.archived.map((entry) => entry.snapshot.value);

  try {
    localStorage.setItem(SNAP_KEY, stringifyChatStoreSnapshot(payload, sessions, archived));
  } catch {
    // Не влезло — оставляем последние чаты целиком. По СООБЩЕНИЯМ резать бесполезно:
    // типичная история короче такого лимита, поэтому прежний `slice(-30)` почти не
    // уменьшал снимок и вторая попытка падала ровно там же, где первая.
    try {
      const recent = (payload.sessions || []).map((chat, index) => ({ chat, index }))
        .sort((a, b) => (b.chat.updatedAt || 0) - (a.chat.updatedAt || 0))
        .slice(0, SNAP_FALLBACK_CHATS);
      const json = stringifyChatStoreSnapshot(payload, recent.map(({ index }) => sessions[index]), []);

      localStorage.setItem(SNAP_KEY, json);
    } catch {
      // localStorage недоступен — работаем без страховки.
    }
  }
}

function readSnapshot() {
  try { return JSON.parse(localStorage.getItem(SNAP_KEY) || 'null'); } catch { return null; }
}

/**
 * «Возраст» состояния — самое свежее изменение среди чатов. По нему решаем,
 * кто новее: серверная копия или локальный снимок (в другом окне могли писать).
 */
function stampOf(store) {
  return Math.max(0, ...(store?.sessions || []).map((s) => s.updatedAt || 0));
}
let permOff = null; // отписка от общего SSE (подписка одна на окно)
// «Разрешать до конца сессии»: chatKey → Set(инструментов). Только в памяти —
// умирает с перезагрузкой страницы, в allowlist навсегда ничего не попадает.
const permAutoAllow = {};

/** Внешняя страница всегда требует отдельного ручного завершения и не запоминается. */
function canRememberPermission(req) {
  return req?.canRemember !== false && req?.input?.kind !== 'external_url';
}

export const useChatStore = defineStore('chat', {
  // pending — ВСЕ висящие спросы агентов, pid → запрос: `kind: 'perm'` (разрешение на
  // действие) либо `kind: 'question'` (вопрос по существу, AskUserQuestion). Карта, а не
  // одно поле: агенты работают в нескольких чатах сразу, и новый спрос не должен затирать
  // предыдущий — каждый висит, пока на него не ответят.
  // saveError — история не пишется на сервер (см. _saveFailed). В чате НЕ рисуется:
  // состояние общее, а плашка в открытом чате висела бы в каждом. Наружу идёт разовым
  // оповещением, текст ошибки хранится здесь.
  // compactWindow — порог сжатия контекста из настроек сервера (0 = «не вмешиваться»).
  // Держим в сторе, а не в компоненте: по нему кольцо контекста красится в каждом чате.
  // turnProtocol — сервер принимает ходы по turnId (0 — старый синхронный запуск).
  // deliveries — turnId → { chatId, state, attempt }: доставка реплик, приём которых сервер
  // ещё не подтвердил. posting — POST летит, retrying — связи нет, повторяем тем же id,
  // lost — сервер этот ход не знает (F5 до приёма, повторы кончились): нужна кнопка.
  // Только для рендера этого окна: в историю едет лишь `delivery` у самой реплики.
  state: () => ({
    ...pickStore(null),
    loaded: false,
    revealRequest: '',
    pending: {},
    saveError: null,
    compactWindow: 0,
    speech: normalizeSpeechSnapshot(null),
    turnProtocol: 0,
    workdirProtocol: 0,
    historyStepReuseProtocol: 0,
    deliveries: {},
    inTurnProtocol: 0,
    inTurnRuns: {},
    runtimeRuns: {},
    runRevisions: {},
    activeRequest: 0,
    inTurnAttempts: {},
    inTurnError: '',
  }),
  getters: {
    // На странице «Чаты» можно открыть архивный разговор для чтения, не возвращая
    // его в активные. Поэтому выбранный чат и поиск по id смотрят в оба списка;
    // принадлежность к архиву по-прежнему задаётся только самим списком.
    active: (s) => s.sessions.find((x) => x.id === s.activeId)
      || (s.archived || []).find((x) => x.id === s.activeId)
      || null,
    session: (s) => (id) => s.sessions.find((x) => x.id === id)
      || (s.archived || []).find((x) => x.id === id)
      || null,
    inTurnFor: (s) => (id) => s.inTurnRuns[id] || null,
    runtimeFor: (s) => (id) => s.runtimeRuns[id] || null,
    isArchived: (s) => (id) => (s.archived || []).some((x) => x.id === id),
    // Заголовок вкладки: название задачи → #номер → «Новый чат».
    tabLabel: () => (sess) => sess.title || (sess.taskId ? `#${sess.taskId}` : 'Новый чат'),
    // Непрочитанные: агент ответил, а мы на этот чат ещё не смотрели. Считаем и архивные —
    // чат могли закрыть, пока агент думал, и ответ приехал уже в архив.
    unreadCount: (s) => s.sessions.filter((x) => x.unread).length
      + (s.archived || []).filter((x) => x.unread).length,
    // ── «Требуют вмешательства» ──
    // Агент стоит и ждёт человека: без ответа ход не двинется. Это сильнее «непрочитанного»
    // (там просто не смотрели), поэтому считается и показывается отдельно.
    waitingChats: (s) => new Set(Object.values(s.pending).map((p) => p.chatKey || '')),
    // Сколько чатов ждут меня — цифра для чипа в навигации и на кнопке чата.
    waitingCount() { return this.waitingChats.size; },
    // Спрос, адресованный конкретному чату. Запрос без chatKey (старый сервер) показываем
    // в любом открытом чате — иначе он не показался бы нигде.
    permFor: (s) => (chatKey) => Object.values(s.pending)
      .find((p) => p.kind === 'perm' && (!p.chatKey || p.chatKey === chatKey)) || null,
    questionFor: (s) => (chatKey) => Object.values(s.pending)
      .find((p) => p.kind === 'question' && (!p.chatKey || p.chatKey === chatKey)) || null,
    // Список чатов для телеграм-сайдбара: обычный режим показывает открытые чаты,
    // режим архива — только архивные. Без запроса показываем сниппет последнего
    // сообщения; с запросом фильтруем по названию и тексту переписки.
    list(s) { return (q, showArchived = false) => {
      historyPersistenceFor(this);

      let previews = previewCaches.get(this);

      if (!previews) {
        previews = createChatListPreviewCache(mdToText);
        previewCaches.set(this, previews);
      }

      const t = q.trim().toLowerCase();
      const waiting = this.waitingChats;
      const row = (sess, archived) => {
        const title = sess.title || (sess.taskId ? `#${sess.taskId}` : 'Новый чат');
        const msgs = sess.messages || [];
        let snippet = '';
        if (t) {
          const m = msgs.find((x) => (x.text || '').toLowerCase().includes(t));
          if (!title.toLowerCase().includes(t) && !m) return null;
          if (m) {
            const i = m.text.toLowerCase().indexOf(t);
            snippet = (i > 24 ? '…' : '') + m.text.slice(Math.max(0, i - 24), i + 72);
          }
        } else if ((sess.draft || '').trim()) {
          // Неотправленный текст показываем вместо последнего сообщения — как в телеграме.
          snippet = sess.draft;
        } else if (sess.draftAttachments?.length) {
          snippet = `📎 ${sess.draftAttachments.map((a) => a.name).join(', ')}`;
        } else if (msgs.length) {
          const last = msgs[msgs.length - 1];
          snippet = (last.role === 'user' ? 'Ты: ' : last.role === 'error' ? '⚠ ' : '') + last.text;
        }

        return {
          id: sess.id,
          title,
          snippet: previews.get(sess.id, snippet),
          archived,
          draft: !t && (!!(sess.draft || '').trim() || !!sess.draftAttachments?.length),
          // Модель чата — для иконки исполнителя и подписи в строке списка.
          model: sess.model || sess.modelRef?.model || '',
          modelRef: sess.modelRef || null,
          // Сжатие для списка — такая же занятость чата, как обычный ход: строке нужен
          // тот же живой аватар, отличается только подсказка.
          taskId: sess.taskId,
          sending: !!sess.sending || !!sess.compacting,
          compacting: !!sess.compacting,
          unread: !!sess.unread,
          // Агент в этом чате упёрся в вопрос и стоит — строке нужен чип «ждёт ответа».
          waiting: waiting.has(sess.id),
          // В архиве важнее момент архивирования: только что убранный старый разговор
          // должен оказаться сверху, а не провалиться к дате последнего сообщения.
          ts: archived ? (sess.closedAt || sess.updatedAt || 0) : (sess.updatedAt || 0),
        };
      };
      const out = [];
      const source = showArchived ? (s.archived || []) : s.sessions;
      source.forEach((x) => {
        const h = row(x, showArchived);
        if (h) out.push(h);
      });
      // Ждущие ответа — наверх: пока не ответишь, работа в них стоит.
      out.sort((a, b) => (b.waiting - a.waiting) || (b.ts - a.ts));
      return out;
    }; },
  },
  actions: {
    /**
     * Любое принятое изменение запуска инвалидирует летящий снимок active.
     * Счётчик живёт вне истории и не запускает её сохранение.
     */
    _touchRun(chatKey) {
      this.runRevisions[chatKey] = (this.runRevisions[chatKey] || 0) + 1;

      return this.runRevisions[chatKey];
    },
    /**
     * Старт и восстановление хранят параметры конкретного исполнения целиком.
     * Старый API остаётся активностью с неизвестными параметрами, без догадок по селекту.
     */
    _setRuntimeRun(chatKey, data) {
      const snapshot = normalizeChatRunSnapshot(data.snapshot);

      this.runtimeRuns[chatKey] = {
        runId: data.runId || '',
        turnId: data.turnId || '',
        active: true,
        compact: !!data.compact,
        source: data.source === 'background' ? 'background' : 'managed',
        snapshot: snapshot?.chatKey === chatKey && snapshot.runId === data.runId ? snapshot : null,
      };
      this._touchRun(chatKey);
    },
    /**
     * События управляемого запуска относятся только к текущему активному run.
     * Без runId сохраняется совместимость фонового потока и старого сервера.
     */
    _ownsRunEvent(data) {
      const current = this.runtimeRuns[data.chatKey];

      if (data.runId) {
        return current?.active && current.runId === data.runId;
      }

      return !current?.active || !current.runId;
    },
    /**
     * Запуск окончен: его недописанные черновики помечаются оборванными в этом окне.
     * Без runId ничего не делаем — чужой или старый chat-done не трогает идущий ход.
     */
    _closeInTurnDrafts(chatKey, runId) {
      const run = this.inTurnRuns[chatKey];

      if (runId && run?.runId === runId) {
        closeOpenDrafts(run);
      }
    },
    /**
     * Канал привязан к запуску, поэтому новый run заменяет прежний целиком.
     * Поздние события сверяются с runId и не переоткрывают старый канал.
     */
    _ensureInTurn(chatKey, runId, parentTurnId = '') {
      if (!chatKey || !runId) {
        return null;
      }

      const old = this.inTurnRuns[chatKey];

      if (old?.runId === runId) {
        return old;
      }
      if (old) {
        old.active = false;
      }

      const run = newChatInTurnRun(chatKey, runId);

      run.parentTurnId = parentTurnId;
      this.inTurnRuns[chatKey] = run;

      return run;
    },
    /**
     * Снимок активного хода объединяет готовность канала и первую страницу сообщений.
     * Ревизии защищают оба вида данных от отката поздним ответом другого запроса.
     */
    _mergeInTurnSnapshot(chatKey, runId, snapshot, parentTurnId = '') {
      const run = this._ensureInTurn(chatKey, runId, parentTurnId);

      if (!run || !snapshot) {
        return;
      }
      if (parentTurnId) {
        run.parentTurnId = parentTurnId;
      }

      mergeInTurnAvailability(run, snapshot);
      mergeInTurnPage(run, snapshot);
      this._materializeInTurn(run);
    },
    /**
     * Проекция канонических записей отделена от побочных эффектов Pinia.
     * Сохраняем историю только после изменения видимой группы запуска.
     */
    _materializeInTurn(run) {
      const session = this._find(run.chatKey);

      if (!session) {
        return;
      }

      const previous = session.messages || [];
      const messages = materializeInTurnMessages(previous, run);

      if (messages === previous) {
        return;
      }

      session.messages = messages;
      session.updatedAt = Date.now();
      this._persist();
    },
    /**
     * Страницы читаются до зафиксированной границы sequence, даже если ход ещё идёт.
     * Только полный проход разрешает удалить pending после сохранения истории.
     */
    async _reconcileInTurn(chatKey, runId) {
      if (!chatKey || !runId) {
        return false;
      }

      const current = this.inTurnRuns[chatKey];
      const historical = current && current.runId !== runId;
      const run = historical ? newChatInTurnRun(chatKey, runId) : this._ensureInTurn(chatKey, runId);

      if (historical) {
        run.active = false;
      }

      let afterSequence = 0;
      let throughSequence = 0;

      for (let pages = 0; pages < 100; pages += 1) {
        let page;

        try {
          page = await api.get(`/api/chat/in-turn?chatKey=${encodeURIComponent(chatKey)}`
            + `&runId=${encodeURIComponent(runId)}&afterSequence=${afterSequence}`
            + (throughSequence ? `&throughSequence=${throughSequence}` : ''));
        } catch (error) {
          return error?.status === 404 && !run.entries.length;
        }

        if (!throughSequence) {
          throughSequence = page.throughSequence || 0;
        }

        mergeInTurnAvailability(run, page.availability);
        mergeInTurnPage(run, page);
        this._materializeInTurn(run);

        if (page.nextAfterSequence === null) {
          return true;
        }
        if (!Number.isSafeInteger(page.nextAfterSequence)
          || page.nextAfterSequence <= afterSequence) {
          return false;
        }

        afterSequence = page.nextAfterSequence;
      }

      return false;
    },
    /**
     * Обычный POST и восстановление его потерянного ответа завершают одну попытку.
     * Полученный receipt материализуется до удаления сохранённого id отправки.
     */
    _confirmInTurnReceipt(run, receipt) {
      mergeInTurnEntry(run, receipt);
      this._materializeInTurn(run);
      delete this.inTurnAttempts[run.chatKey];

      return true;
    },
    /**
     * Повтор текста в том же запуске использует прежний id, пока исход не подтверждён.
     * При потере ответа POST сначала ищем receipt, чтобы не отправить второй экземпляр.
     * Картинки входят в отпечаток попытки: тот же текст с другим файлом — новая реплика.
     */
    async sendInTurn(chatKey, text, attachments = []) {
      const run = this.inTurnRuns[chatKey];
      const value = String(text || '').trim();
      const files = attachments.map((a) => ({ file: a.file, name: a.name }));
      const filesKey = files.map((a) => a.file).join('\n');

      if (this.inTurnProtocol !== IN_TURN_PROTOCOL || !run?.active
        || !run.availability?.available || (!value && !files.length)
        || utf8Bytes(value) > IN_TURN_TEXT_LIMIT_BYTES) {
        return false;
      }

      const prior = this.inTurnAttempts[chatKey];
      const attempt = prior?.runId === run.runId && prior?.text === value
        && (prior.filesKey || '') === filesKey
        ? prior
        : {
          runId: run.runId,
          text: value,
          filesKey,
          messageId: newTurnId(),
          sentAt: Date.now(),
        };

      this.inTurnAttempts[chatKey] = attempt;

      try {
        const receipt = await api.post('/api/chat/in-turn', {
          chatKey,
          targetRunId: run.runId,
          messageId: attempt.messageId,
          text: value,
          ...(files.length ? { attachments: files } : {}),
          sentAt: attempt.sentAt,
        });

        return this._confirmInTurnReceipt(run, receipt);
      } catch (error) {
        // POST мог дойти, а ответ потеряться. Сверяем тот же id; новую реплику не создаём.
        try {
          const found = await api.get(`/api/chat/in-turn?chatKey=${encodeURIComponent(chatKey)}`
            + `&ids=${encodeURIComponent(attempt.messageId)}`);
          const receipt = found?.messages?.[attempt.messageId];

          if (receipt) {
            return this._confirmInTurnReceipt(run, receipt);
          }
        } catch {
          // Исход передачи всё ещё неизвестен; тот же id сохранён для ручного повтора.
        }

        this.inTurnError = error?.data?.message || error?.message || 'Не удалось отправить уточнение.';

        return false;
      }
    },
    // Загрузка истории с сервера (однократно). Если серверный файл пуст, а в localStorage
    // осталась история со старой схемы хранения — мигрируем её и чистим браузер.
    async _load() {
      if (this.loaded) return;
      if (!loadPromise) {
        historyPersistenceFor(this).clear();
        persistenceProjections.get(this)?.clear();
        previewCaches.get(this)?.clear();

        loadPromise = (async () => {
          let j = null;
          try { j = await api.get('/api/chat/store'); } catch { j = null; }
          // Порог сжатия читаем из ответа сервера СРАЗУ — до возможной подмены снимком:
          // снимок в браузере хранит только историю, настроек в нём нет.
          this.compactWindow = Math.max(0, Number(j?.compactWindow) || 0);
          // Возможность сервера — тоже только из его ответа: снимок в браузере её не знает.
          this.turnProtocol = Number(j?.turnProtocol) === TURN_PROTOCOL ? TURN_PROTOCOL : 0;
          this.workdirProtocol = Number(j?.workdirProtocol) === 1 ? 1 : 0;
          this.historyStepReuseProtocol = j?.historyStepReuseProtocol === 1 ? 1 : 0;

          let fromServer = !!j;
          // Настройки речи — такой же server-owned snapshot. Страховочная browser-копия
          // содержит только историю и не вправе подменять приватностный выбор движка.
          const speech = normalizeSpeechSnapshot(j?.speech, this.speech);
          // Снимок свежее серверной копии — значит сервер не успел записать последнее
          // (например, его перезапустили сразу после ответа агента): восстанавливаем из него.
          const snap = readSnapshot();
          const restored = snap && stampOf(snap) > stampOf(j);
          if (restored) j = snap;
          if (!(j?.sessions?.length || j?.archived?.length)) {
            try {
              const ls = JSON.parse(localStorage.getItem(LS_KEY) || 'null');

              if (ls?.sessions?.length || ls?.archived?.length) {
                j = ls;
                fromServer = false;
                localStorage.removeItem(LS_KEY);
              }
            } catch { /* битый localStorage — начинаем с пустого */ }
          }
          const picked = pickStore(j);
          this._normalize(picked.sessions);
          this._normalize(picked.archived);
          Object.assign(this, picked);
          this.speech = speech;
          this.loaded = true;
          storeSyncedAt = Date.now();
          // Снимок оказался свежее серверной копии — немедленно возвращаем расхождение
          // на сервер. Если же стор пришёл с сервера как есть, слать нечего: запоминаем
          // слепки, чтобы дальше уезжали только реальные изменения.
          if (restored) {
            this._persist(true);
          } else {
            this._markSent({ fromServer });
          }
          // Ответы, доехавшие пока страница была закрыта/перезагружалась.
          await this._collectPending();
          // Спросы агентов, висящие прямо сейчас: после F5 их некому было показать.
          await this._loadWaiting();
          // Агенты, работающие прямо сейчас: восстанавливаем «думает…» после F5.
          await this._loadActive();
          // Реплики, приём которых окно до F5 не успело подтвердить: сверка с сервером.
          await this._reconcileDeliveries();
        })();
      }
      await loadPromise;
    },
    /**
     * Недоставленные ответы (chats/pending на сервере): раскладываем по чатам, dedup по
     * pid в сообщении, подтверждаем удалением. Проход один за раз: повторные hello и
     * chat-orphan во время прохода дают ещё один проход после него, а не гонку двух.
     */
    _collectPending() {
      if (collectJob) {
        collectAgain = true;

        return collectJob;
      }

      collectJob = (async () => {
        do {
          collectAgain = false;
          await this._collectPendingOnce();
        } while (collectAgain);
      })().finally(() => {
        collectJob = null;
      });

      return collectJob;
    },
    /**
     * Один проход по pending. Запись подтверждается (DELETE) только после того, как
     * ответ устойчиво лёг в историю на сервере: раньше подтверждение уходило сразу, а
     * запись — дебаунсом, и закрытие вкладки между ними теряло ответ насовсем. Запись
     * чата, которого в окне нет, не удаляется: её подберёт окно, где этот чат есть.
     */
    async _collectPendingOnce() {
      let j = null;
      try { j = await api.get('/api/chat/pending'); } catch { return; }

      const entries = Array.isArray(j?.pending) ? j.pending : [];

      if (!entries.length) {
        return;
      }

      const settled = new Map();

      for (const p of entries) {
        if (!p?.id) {
          continue;
        }

        const place = await this._chatForPending(p.chatKey);

        if (place === 'gone') {
          // Чата нет и на сервере — ответ класть некуда, запись только копилась бы.
          await api.del(`/api/chat/pending/${p.id}`).catch(() => { /* подберём в следующий раз */ });
          continue;
        }
        if (!place) {
          continue;
        }

        // Даже уже видимый pid не доказывает, что страницы уточнений этого run записаны.
        // Пока сверка не закончилась, pending остаётся на сервере как страховка.
        if (p.runId && p.source !== 'background' && !await this._reconcileInTurn(place.id, p.runId)) {
          continue;
        }

        this._applyPending(place, p);

        if (!settled.has(place.id)) {
          settled.set(place.id, []);
        }

        settled.get(place.id).push(p.id);
      }
      for (const [chatId, ids] of settled) {
        try {
          await this._writeChat(chatId);
        } catch {
          // Запись истории не прошла — подтверждать нечем, pending подождёт.
          this._persist();
          continue;
        }

        for (const id of ids) {
          await api.del(`/api/chat/pending/${id}`).catch(() => { /* подберём в следующий раз */ });
        }
      }
    },
    /**
     * Чат для записи pending. Если в окне его нет, он мог появиться на другом устройстве
     * за время разрыва — тянем с сервера. 'gone' — сервер такого чата не знает.
     */
    async _chatForPending(chatKey) {
      const local = this._find(chatKey);

      if (local) {
        return local;
      }
      if (!chatKey) {
        return 'gone';
      }

      try {
        const { chat } = await api.get(`/api/chat/store/chat/${chatKey}`);

        if (!chat?.id) {
          return 'gone';
        }

        this._applyRemoteChat(chat, !!chat.archived, { notifyReply: false });

        return this._find(chatKey);
      } catch (error) {
        return error?.status === 404 ? 'gone' : null;
      }
    },
    /**
     * Разложить одну запись pending в чат. Повторный вызов с той же записью ничего не
     * меняет (dedup по pid), поэтому проход можно безопасно повторять.
     */
    _applyPending(s, p) {
      // Ответ мог прийти после F5: применяем семантическое имя, только если человек
      // не заменил временный заголовок вручную, пока агент работал.
      // Сервер помнит весь текст запроса, а человек писал только то, что после
      // блока выжимки: сравниваем и восстанавливаем видимую часть, иначе выжимка
      // всплывала бы в переписке отдельным «сообщением пользователя».
      const userText = stripSeed(p.userText);
      const current = this.runtimeRuns[s.id];
      const ownsRuntime = !current?.active || (!!p.runId && p.runId === current.runId);

      if (p.title) {
        const provisional = provisionalChatTitle(userText, { hasAttachments: !!p.hadAttachments });

        applyGeneratedChatTitle(s, p.title, provisional);
      }
      // Итог принятого хода: его реплика больше не ждёт ни приёма, ни очереди.
      if (p.turnId) {
        this._settleTurnMessage(s, p.turnId, { finished: true });
      }

      const seen = (s.messages || []).some((m) => m.pid === p.id);

      if (seen) {
        return;
      }
      if (p.compact && !ownsRuntime) {
        return;
      }
      if (p.compact) {
        // Окно перезагрузили посреди сжатия: его итог — не ответ агента, а семя новой
        // сессии. Потерять его — значит потерять память после сжатия, а старый id
        // сессии увёл бы следующий ход обратно в полный контекст.
        try {
          applyCompactResult(s, p, s.contextTokens || 0);
        } catch (e) {
          s.messages.push({ role: 'error', text: `Сжать контекст не удалось: ${e.message}` });
        }

        s.messages.at(-1).pid = p.id;
        s.compacting = false;
        s.sending = false;
        s.offline = false;
        s.updatedAt = p.at || Date.now();

        return;
      }
      // Гонка last-write-wins могла затереть сам вопрос — восстанавливаем его перед ответом.
      const restored = p.turnId
        ? (s.messages || []).some((m) => m.role === 'user' && m.turnId === p.turnId)
        : (s.messages || []).slice(-12).some((m) => m.role === 'user' && m.text === userText);

      if (userText && !restored) {
        const sentAt = messageSentAt(p.userSentAt);

        s.messages.push({
          role: 'user',
          text: userText,
          pid: `${p.id}:u`,
          ...(p.turnId ? { turnId: p.turnId } : {}),
          ...(sentAt ? { sentAt } : {}),
        });
      }

      const role = p.role || 'assistant';

      applyAssistantFinal(s.messages, p, {
        role,
        text: p.reply || '(пусто)',
        cost: p.cost ?? null,
        pid: p.id,
        steps: p.steps || [],
        model: p.model || '',
        actualModel: p.actualModel || '',
        effort: p.effort || '',
        // Как и в send(): остановленный ход помечаем для серверного досье.
        ...(p.stopped ? { stopped: true } : {}),
        // Прерван перезапуском сервера или обрывом CLI: по метке чат предложит продолжить ход.
        ...(p.interruptedBy ? { interruptedBy: p.interruptedBy } : {}),
      });
      // Выжимка ушла вместе с этим ходом. Если он её не донёс (сессия сброшена, ход
      // упал), она снова ждёт следующего сообщения — как это делал send() в своём окне.
      const seed = p.turnId && (p.sessionReset || role === 'error') ? seedOf(p.userText) : '';

      if (seed && !s.pendingSeed) {
        s.pendingSeed = seed;
      }
      if (ownsRuntime && p.sessionReset) {
        clearSessionContext(s);
        s.sessionResetFailed = false;
      } else if (ownsRuntime) {
        if (p.sessionId) {
          s.sessionId = p.sessionId;
        }

        applyContextUsage(s, p);

        if (p.sessionResetFailed) {
          s.sessionResetFailed = true;
        }
      }
      if (role === 'error' && p.turnId) {
        s.error = p.reply || '';
      }
      // Как и в send(): слайдер под реальный эффорт, дефолт новых чатов не трогаем.
      if (ownsRuntime && p.effort && p.effort !== s.effort) {
        s.effort = p.effort;
      }
      // Строку хода старого синхронного запуска снимаем здесь. У принятого хода её
      // снимает chat-done или сверка активных ходов: в очереди чата мог стартовать
      // следующий ход, и ответ предыдущего не должен гасить его «думает…».
      if (!p.turnId && p.source !== 'background' && ownsRuntime) {
        s.sending = false;
      }
      // Ответ оборванного хода забран — плашка «связь прервалась» своё отслужила.
      s.offline = false;
      s.updatedAt = p.at || Date.now();
      this._notifyReply(s, p.reply || '(пусто)', `${p.chatKey}:pid:${p.id}`);
    },
    // Сохранение на сервер с дебаунсом — вызовы дискретные, но склеиваем всплески.
    // flush=true — писать немедленно (критичные моменты: только что добавленное
    // сообщение пользователя не должно потеряться из-за гонки окон/перезагрузки).
    // snapshot=false — сохранение, ради которого страховочный снимок не нужен (черновик:
    // он не ответ агента, терять при рестарте сервера там нечего). Флаг накапливается, а не
    // берётся у последнего вызова: иначе правка черновика, пришедшая в те же 300 мс дебаунса,
    // отменила бы снимок только что полученного ответа.
    _persist(flush = false, { snapshot = true } = {}) {
      clearTimeout(persistTimer);
      if (snapshot) needSnapshot = true;

      /**
       * Снимок и dirty-проверка переиспользуют проекции неизменённых реактивных чатов.
       * Очереди берут свежие данные отдельно, а страховка сохраняется до отправки запросов.
       */
      const write = () => {
        const state = historyPersistenceFor(this);

        const cache = persistenceProjections.get(this);
        const projections = {
          sessions: this.sessions.map((chat) => cache.get(chat)),
          archived: (this.archived || []).map((chat) => cache.get(chat, true)),
        };
        const slim = this.sessions.map(slimOf);
        const archivedSlim = (this.archived || []).map(archivedSlimOf);
        const payload = {

          sessions: slim,
          archived: archivedSlim,
          activeId: this.activeId,

          defModel: this.defModel,
          defModelRef: this.defModelRef,

          defEffort: this.defEffort,
          defMode: this.defMode,

          defWorkdir: this.defWorkdir,
          recentWorkdirs: this.recentWorkdirs,

        };
        // Страховочный снимок в браузере: переживает падение и перезапуск сервера.
        // Без него ответ, пришедший последним, терялся насовсем — «следующего изменения»,
        // на котором он бы сохранился, могло и не быть.
        if (needSnapshot) {
          writeSnapshot(payload, projections);
          needSnapshot = false;
        }
        // Каждый чат — свой запрос, и только если он реально изменился.
        const jobs = [];
        const alive = new Set();
        // Чат, которого нет на сервере в этом виде, ставится в очередь записи; чаты,
        // попавшие в alive, переживут сверку удалённых ниже.
        const push = (c, projection) => {
          if (!c?.id) {
            return;
          }

          alive.add(c.id);

          if (state.isSent(c, projection.fingerprint.value)) {
            return;
          }
          // Очередь чата сама возьмёт свежий снимок в момент отправки и не пошлёт
          // тот же снимок второй раз, пока предыдущий PUT ждёт ответа.
          if (flush) {
            jobs.push(this._writeChat(c.id));

            return;
          }

          // Страховка уже записана: обычный PUT получает отдельную задачу браузера.
          // Очередь заново читает чат; dispose отменяет ещё не начатую запись этого экземпляра.
          const send = new Promise((resolve) => setTimeout(resolve, 0)).then(() => (
            historyPersistence.get(this) === state ? this._writeChat(c.id) : null
          ));

          jobs.push(send);
        };

        slim.forEach((c, index) => push(c, projections.sessions[index]));
        archivedSlim.forEach((c, index) => push(c, projections.archived[index]));
        cache.prune([...this.sessions, ...(this.archived || [])]);
        // Чат исчез из стора (удалили, вытеснили из архива) — убираем и на сервере.
        for (const id of [...historyPersistenceFor(this).sentChats.keys()]) {
          if (alive.has(id)) continue;

          jobs.push(api.del(`/api/chat/store/chat/${id}?origin=${WINDOW_ID}`)
            .then(() => {
              historyPersistenceFor(this).forget(id);
            }));
        }

        const meta = {

          activeId: this.activeId,

          defModel: this.defModel,

          defModelRef: this.defModelRef,

          defEffort: this.defEffort,

          defMode: this.defMode,

          defWorkdir: this.defWorkdir,
          recentWorkdirs: this.recentWorkdirs,

        };
        const metaJson = JSON.stringify(meta);
        if (metaJson !== sentMeta) {
          jobs.push(api.put('/api/chat/store/meta', { ...meta, origin: WINDOW_ID })
            .then(() => { sentMeta = metaJson; }));
        }
        if (!jobs.length) return;
        Promise.all(jobs)
          .then(() => { retryDelay = 0; this._saveFailed(false); })
          .catch((e) => {
            // Сервер недоступен (перезапускается) — повторяем с нарастающей паузой.
            // Успевшие запросы уже отметились в sentChats, повтор их не тронет.
            retryDelay = Math.min(retryDelay ? retryDelay * 2 : 1000, 15000);
            clearTimeout(retryTimer);
            retryTimer = setTimeout(write, retryDelay);
            this._saveFailed(true, e?.message || '');
          });
      };
      if (flush) write();
      else persistTimer = setTimeout(write, 300);
    },
    /**
     * Барьер перед запуском executor-а: server-owned record с modelRef должен быть
     * durable раньше POST /api/chat. Иначе быстрый запрос мог обогнать debounce истории.
     * Пишет через общую очередь чата: летящий PUT того же чата сначала получает ответ,
     * и CAS-база барьера — уже его ревизия, а не устаревшая копия.
     */
    async _saveChatNow(session) {
      if (!session?.id) {
        throw new Error('чат не выбран');
      }

      clearTimeout(persistTimer);
      // Именно эту модель человек видел в отправляющем окне. stale-ack сообщает
      // server-owned модель чужой ревизии; принять её и продолжить означало бы
      // незаметно запустить не того исполнителя. На повторном CAS сохраняем свой выбор.
      const intendedWorkdir = session.workdir;
      const intendedTask = session.taskId || null;
      const intendedEpoch = session.workdirState?.epoch || 0;
      const intendedModel = session.model;
      const intendedModelRef = session.modelRef ? { ...session.modelRef } : session.modelRef;

      for (let attempt = 0; attempt < CHAT_SAVE_ATTEMPTS; attempt += 1) {
        const response = await this._writeChat(session.id, { force: true });

        if (response?.stale) {
          if (!sameChatWorkdir(intendedWorkdir, session.workdir)
            || intendedTask !== (session.taskId || null)
            || intendedEpoch !== (session.workdirState?.epoch || 0)) {
            throw new Error('Рабочая папка изменена в другом окне. Проверьте её перед отправкой.');
          }
          // revision из ack — новая CAS-база. Сервер уже слил сообщения, поэтому
          // повтор того же снимка их не удалит (mergeChat восстановит серверный хвост).
          session.model = intendedModel;
          session.modelRef = intendedModelRef ? { ...intendedModelRef } : intendedModelRef;

          if (attempt + 1 < CHAT_SAVE_ATTEMPTS) {
            continue;
          }
          throw chatRevisionConflict();
        }

        return response;
      }
      throw chatRevisionConflict();
    },
    /**
     * Запись одного чата по очереди. Пока летит PUT, новые просьбы о записи этого чата
     * склеиваются в одну следующую, и снимок для неё берётся в момент отправки: правка,
     * сделанная во время полёта, не теряется, а одинаковый снимок второй раз не уходит.
     * force — барьер перед запуском хода: писать, даже если сервер уже видел этот
     * снимок, потому что нужен сам ответ (stale и ревизия для CAS).
     */
    _writeChat(id, { force = false } = {}) {
      let slot = chatSaves.get(id);
      const release = (run) => {
        run.catch(() => {}).then(() => {
          if (chatSaves.get(id) === slot && slot.tail === run && !slot.next) {
            chatSaves.delete(id);
          }
        });
      };

      if (!slot) {
        // Записи этого чата нет в полёте — PUT уходит сразу, без круга по очереди.
        slot = {
          tail: null,
          next: null,
          force: false,
        };
        chatSaves.set(id, slot);

        const run = this._putChat(id, force);

        slot.tail = run;
        release(run);

        return run;
      }
      if (force) {
        slot.force = true;
      }
      if (slot.next) {
        return slot.next;
      }

      const run = slot.tail.catch(() => {}).then(() => {
        slot.next = null;

        const forced = slot.force;

        slot.force = false;

        return this._putChat(id, forced);
      });

      slot.next = run;
      slot.tail = run;
      release(run);

      return run;
    },
    /**
     * Один PUT чата: снимок берётся в момент отправки, уже записанный без force не
     * уходит. Ответ сервера (ревизия, модель) применяется и к живому чату, и к отпечатку:
     * иначе следующий снимок считался бы отличным от сервера и уехал бы повторно.
     */
    async _putChat(id, force) {
      const live = this._find(id);

      if (!live) {
        return null;
      }

      if (this.workdirProtocol && live.workdirInitializing) {
        await this._initializeWorkdir(live);
      }

      const archived = (this.archived || []).some((item) => item.id === id);
      const state = historyPersistenceFor(this);
      const snapshot = captureChatHistorySnapshot(archived ? archivedSlimOf(live) : slimOf(live));

      if (live.revision && !normalizeChatWorkdir(snapshot.workdir)) {
        delete snapshot.workdir;
      }

      const fingerprint = fingerprintOf(snapshot);
      const steps = state.signature(snapshot);
      const generation = state.generation(id);

      if (!force && state.isSent(snapshot, fingerprint)) {
        return null;
      }

      const request = state.request(snapshot, this.historyStepReuseProtocol, live.steps);
      let response;

      try {
        response = await api.put(request.route, {
          chat: request.chat,
          archived,
          origin: WINDOW_ID,
          ...(request.reuseSteps ? { reuseSteps: request.reuseSteps } : {}),
        });
      } catch (error) {
        if (!request.reuseSteps || !mayRetryFullHistory(error)) {
          throw error;
        }

        state.resetBase(id);

        if (error.status === 404 || error.status === 405) {
          this.historyStepReuseProtocol = 0;
          state.clearBases();
        }

        // Полный retry использует тот же логический снимок и прежнюю CAS-revision.
        // Поздняя правка истории не меняет fallback и остаётся для следующей записи.
        response = await api.put('/api/chat/store/chat', {
          chat: snapshot,
          archived,
          origin: WINDOW_ID
        });
      }

      const current = this._find(id);

      if (!current || state.generation(id) !== generation
        || (Number.isSafeInteger(response?.revision) && (current.revision || 0) > response.revision)) {
        return response;
      }

      applySaveAck(current, response);

      const acknowledged = { ...snapshot };

      applySaveAck(acknowledged, response);

      // Отпечаток — только полей снимка. Поле ответа, которого снимок не несёт (например,
      // modelRefState), навсегда делало чат «несохранённым», и каждая следующая запись
      // отправляла его целиком заново.
      for (const key of Object.keys(acknowledged)) {
        if (!Object.hasOwn(snapshot, key)) {
          delete acknowledged[key];
        }
      }

      state.markSent(acknowledged, fingerprintOf(acknowledged), steps);

      if (this.historyStepReuseProtocol === 1) {
        state.acceptAck(snapshot, response, steps);
      } else {
        state.resetBase(id);
      }

      return response;
    },
    /**
     * Стор совпал с серверным — запоминаем слепки, чтобы первое же сохранение
     * не гнало всю историю заново.
     */
    _markSent({ fromServer = false } = {}) {
      const state = historyPersistenceFor(this);

      state.clear();

      for (const [sessions, archived] of [[this.sessions, false], [this.archived || [], true]]) {
        for (const session of sessions) {
          const snapshot = archived ? archivedSlimOf(session) : slimOf(session);

          state.markSent(snapshot, fingerprintOf(snapshot));

          if (fromServer) {
            state.acceptLoaded(session);
          }
        }
      }

      sentMeta = JSON.stringify({

        activeId: this.activeId,
        defModel: this.defModel,
        defModelRef: this.defModelRef,

        defEffort: this.defEffort,
        defMode: this.defMode,

        defWorkdir: this.defWorkdir,
        recentWorkdirs: this.recentWorkdirs,

      });
    },
    /**
     * История не сохраняется. Раньше клиент ретраил молча, и человек узнавал о потере
     * только после перезагрузки страницы — уже пустой. Поэтому о беде сообщаем —
     * но РОВНО ОДИН РАЗ, оповещением, пока не восстановится: постоянная плашка в чате
     * ходила за человеком по всем чатам и превращалась в шум.
     */
    _saveFailed(bad, msg = '') {
      if (!bad) {
        this.saveError = null;
        saveWarned = false;
        dismissAlert('chat-save-error');

        return;
      }
      this.saveError = msg || 'сервер не принял запись';

      if (saveWarned) {
        return;
      }

      saveWarned = true;
      alertUser({
        id: 'chat-save-error',
        tone: 'danger',
        sticky: true,
        title: 'История чата не сохраняется',
        body: `${this.saveError}. Не закрывай вкладку — идут повторные попытки.`,
      });
    },
    _get(id) { return this.sessions.find((s) => s.id === id) || null; },
    _find(id) { return this._get(id) || (this.archived || []).find((s) => s.id === id) || null; },

    /**
     * Чат из истории мог прийти без части полей (запись старой версии, ручная правка
     * файла, чужой источник) — дозаполняем, иначе рендер падает на первом же обращении.
     */
    _normalize(list) {
      for (const s of list || []) {
        s.messages ||= [];
        s.modelRef ||= null;
        s.revision ??= 0;
        s.contextTokens ??= 0;
        s.contextWindow ??= 0;
        s.contextMetric ??= '';
        s.contextIsEstimate ??= false;
        s.totalInputTokens ??= 0;
        s.cachedInputTokens ??= 0;
        s.contextCache = normalizeContextCache(s.contextCache);
        // До active-input-v1 Cockpit сохранял cumulative input как «контекст».
        // Старые миллионы переносим в расход и гасим кольцо до следующего точного хода.
        if (s.sessionId && isCodexChat(s) && s.contextMetric !== CODEX_CONTEXT_METRIC) {
          s.totalInputTokens = Math.max(s.totalInputTokens, s.contextTokens);
          s.contextTokens = 0;
          s.contextWindow = 0;
          s.contextMetric = 'legacy-unavailable';
          s.contextIsEstimate = true;
        }
        s.sending = false;
        s.error ??= null;
        s.steps ||= [];
        s.draft ??= '';
        s.draftAttachments = draftAttachmentsOf(s.draftAttachments);
        s.pendingSeed ??= '';

        if (s.workdir === undefined) {
          s.workdir = { kind: 'cockpit' };
        }

        s.compactedAt ??= 0;
        s.compacting = false;
        s.sessionResetting = false;
        s.sessionResetFailed ??= false;
      }
      return list;
    },
    /** Один exact-контракт для page/bubble и уведомлений; route/CSS здесь не угадываем. */
    _visible(id) {
      return chatVisibility.isVisible(id);
    },
    registerSurface(owner, initial = {}) {
      return chatVisibility.register(owner, initial);
    },
    /**
     * Видимая поверхность гасит оповещения чата даже без метки непрочитанного.
     * Скрытый, но смонтированный чат не меняет ни тосты, ни unread.
     */
    markRead(id) {
      if (!this._visible(id)) {
        return;
      }

      dismissAlertScope(`chat:${id}`);

      const s = this._get(id) || this.archived.find((x) => x.id === id);

      if (!s?.unread) {
        return;
      }
      s.unread = false;
      this._persist();
    },

    /**
     * Единая точка оповещения об ответе. Нужна не только send(): мобильная PWA часто
     * теряет длинный HTTP-запрос в фоне, а готовый ответ потом забирает из pending или
     * общей истории. Раньше эти два пути обновляли сообщения, но вообще не звонили.
     */
    _notifyReply(s, text, noticeKey = '') {
      if (!s || this._visible(s.id)) return false;
      const key = noticeKey
        || messageNoticeKey(s.id, { role: 'assistant', text }, (s.messages || []).length - 1);
      if (!rememberReplyNotice(key)) return false;
      s.unread = true;
      alertUser({
        id: `chat-${s.id}`,
        scope: `chat:${s.id}`,
        tone: 'accent',
        title: `Агент ответил — ${this.tabLabel(s)}`,
        body: String(text || '').slice(0, 120),
        target: { kind: 'chat', chatId: s.id },
      });
      return true;
    },

    newSession(opts = {}) {
      if (opts.purpose === 'companion') {
        throw new Error('Companion-чат создаётся только атомарно на сервере.');
      }

      const s = {

        id: uid(),
        taskId: opts.taskId ? String(opts.taskId) : null,
        title: opts.title || '',

        workdir: opts.workdir === undefined ? this.defWorkdir || { kind: 'cockpit' } : opts.workdir,

        workdirInitializing: true,

        workdirImplicit: opts.workdir === undefined,

        purpose: opts.purpose || '',
        sourceChatId: opts.sourceChatId || null,
        // Пустая модель = «по умолчанию»: конкретный id подставится из реестра при показе
        // и отправке. Фиксировать здесь нельзя — реестр к этому моменту может не загрузиться.

        model: this.defModel,
        modelRef: this.defModelRef,
        effort: this.defEffort,
        mode: this.defMode,

        schema: 2,
        revision: 0,

        createdAt: Date.now(),
        updatedAt: Date.now(),

        messages: [],
        sessionId: null,
        contextTokens: 0,
        contextWindow: 0,

        contextMetric: '',
        contextIsEstimate: false,
        totalInputTokens: 0,
        cachedInputTokens: 0,

        contextCache: normalizeContextCache(null),

        sending: false,
        error: null,
        draft: opts.draft || '',
        draftAttachments: [],
        pendingSeed: '',
        compactedAt: 0,

      };
      this.sessions.push(s);
      this.activeId = s.id;
      this._persist();
      return s.id;
    },
    // ── Всплывашка разрешений: агент просит выполнить действие (Bash/правка) ──
    // Сервер шлёт SSE `chat-permission`, ответ уходит POST'ом; `chat-permission-done`
    // (ответили в другом окне, «стоп», конец хода) закрывает всплывашку везде.
    // Таймаута у спроса нет: без ответа человека агент стоит и ждёт.
    initPerms() {
      if (permOff) return;
      // Общий EventSource вкладки (useSse) — свой открывать НЕЛЬЗЯ: лимит браузера
      // 6 соединений на хост, лишние SSE душат все fetch (см. composables/useSse.js).
      permOff = sseSubscribe((name, d) => {
        if (!d && name !== 'chat-orphan') return;
        if (name === 'chat-permission') {
          // «Разрешать до конца сессии»: инструмент уже одобрен — отвечаем сами, без всплывашки.
          if (canRememberPermission(d) && d.chatKey && permAutoAllow[d.chatKey]?.has(d.tool)) {
            api.post(`/api/chat/permission/${d.pid}`, { allow: true }).catch(() => {});
            return;
          }
          this._addPending({ ...d, kind: 'perm' });
        } else if (name === 'ssh-permission' || name === 'db-permission') {
          // Надзорные запросы всегда решает человек. Событие — лишь сигнал перечитать единую
          // серверную очередь; DTO команды не размножаем по двум источникам.
          this._loadWaiting();
        } else if (name === 'chat-question') {
          // Вопрос агента (AskUserQuestion): не разрешение, а диалог с вариантами ответа.
          this._addPending({ ...d, kind: 'question' });
        } else if (name === 'chat-permission-done') {
          this._dropPending(d.pid);
        } else if (name === 'hello') {
          // Связь восстановилась (в т.ч. после рестарта сервера) — пока её не было,
          // спросы и ходы могли и появиться, и умереть: сверяем списки целиком.
          // Точечные `chat-store` за время разрыва прошли мимо, поэтому историю тоже
          // сверяем — но не сразу после загрузки: первое `hello` приходит следом за ней.
          // Заодно снимаем плашки «связь прервалась»: раз событие дошло — связь есть,
          // а что стало с самими ходами, сейчас расскажет _loadActive().
          for (const c of [...this.sessions, ...(this.archived || [])]) if (c.offline) c.offline = false;

          if (this.loaded) {
            this._loadWaiting();
            this._resyncSpeech();
            // История, pending, живые ходы и доставки — строго по порядку (см. _afterReconnect).
            this._afterReconnect();
          }
        } else if (name === 'chat-store') {
          // Историю изменило другое окно/устройство. Своё эхо пропускаем: изменение
          // и так в сторе, а перечитывать его — гонка с ещё не уехавшими правками.
          if (d.origin === WINDOW_ID || !this.loaded) return;
          if (d.gone) this._dropRemoteChat(d.id);
          else this._pullChat(d.id, !!d.archived);
        } else if (name === 'chat-store-meta') {
          // Дефолты новых чатов общие, а вот activeId НЕ применяем: у каждого устройства
          // своя открытая вкладка, и подменять её на чужую — забрать разговор из-под рук.
          if (d.origin === WINDOW_ID || !this.loaded) return;
          const m = d.meta || {};
          if (m.defModel !== undefined) this.defModel = m.defModel || '';
          if (m.defModelRef !== undefined) this.defModelRef = m.defModelRef || null;
          if (m.defEffort !== undefined) this.defEffort = m.defEffort || '';
          if (m.defMode !== undefined) this.defMode = m.defMode || '';
          if (m.defWorkdir !== undefined) {
            this.defWorkdir = normalizeChatWorkdir(m.defWorkdir);
          }
          if (m.recentWorkdirs !== undefined) {
            this.recentWorkdirs = normalizeRecentWorkdirs(m.recentWorkdirs);
          }
        } else if (name === 'speech-settings') {
          // Настройка общая для всех окон/устройств. Revision позволяет компоненту
          // отличить реальную смену от собственного SSE-эха, но snapshot применяем весь.
          this.setSpeechSnapshot(d);
        } else if (name === 'chat-step') {
          // Шаг хода агента (инструмент/размышление/результат) — живая лента в чате.
          const s = this._find(d.chatKey);

          if (s && d.step && this._ownsRunEvent(d)) {
            this._touchRun(d.chatKey);
            pushStep((s.steps ||= []), d.step);
          }
        } else if (name === 'chat-in-turn') {
          if (d.kind === 'ready') {
            const run = this.inTurnRuns[d.chatKey];

            if (run?.runId === d.runId) {
              this._reconcileInTurn(d.chatKey, d.runId);
            }
          } else if (d.chatKey && d.runId) {
            this._reconcileInTurn(d.chatKey, d.runId);
          }
        } else if (name === 'chat-assistant-message') {
          const run = this.inTurnRuns[d.chatKey];

          if (run?.runId === d.runId && d.block) {
            const changed = mergeInTurnEntry(run, d.block);

            if (changed && d.block.complete) {
              this._materializeInTurn(run);
            }
          } else if (d.chatKey && d.runId) {
            this._reconcileInTurn(d.chatKey, d.runId);
          }
        } else if (name === 'chat-orphan') {
          // Ответ остался без адресата (то окно умерло) — подбираем в этом окне.
          this._collectPending();
        } else if (name === 'chat-progress') {
          // Живой расход хода «Думаю… · N ток.». Прогресс = агент точно работает:
          // восстанавливаем и sending (окно могло перезагрузиться посреди хода).
          // Кроме сжатия: там работу показывает кольцо, а счётчик только спорил бы с ним.
          const s = this._find(d.chatKey);

          if (s && !s.compacting && this._ownsRunEvent(d)) {
            if (!d.runId) {
              this.runtimeRuns[d.chatKey] = {
                runId: '',
                active: true,
                source: 'background',
                snapshot: null,
              };
            }

            this._touchRun(d.chatKey);
            s.sending = true; s.progressTokens = d.tokens;
            // «≈» — только для оценки (Claude и DeepSeek считают вывод по символам);
            // отсутствие флага значит замер.
            s.progressTokensEstimate = d.tokensIsEstimate === true;
            // Заполненность контекста ПРЯМО СЕЙЧАС (её сообщает не каждый исполнитель).
            // В историю не пишем: это рантайм-поле, а иначе каждое обращение к модели
            // стоило бы записи всего чата на сервер (см. slimOf и дебаунс _persist).
            applyLiveContextUsage(s, d);
          }
        } else if (name === 'chat-run-metadata') {
          const current = this.runtimeRuns[d.chatKey];
          const snapshot = normalizeChatRunSnapshot(d.snapshot);

          if (current?.active && current.runId === d.runId
            && snapshot?.chatKey === d.chatKey && snapshot.runId === d.runId) {
            current.snapshot = snapshot;
            this._touchRun(d.chatKey);
          }
        } else if (name === 'chat-turn-start') {
          // Со дна очереди пошёл следующий ход: снимаем «ждёт очереди» с самого раннего
          // ожидающего сообщения — теперь оно в работе, а не в списке ожидания.
          const s = this._find(d.chatKey);

          const previousRunId = this.runtimeRuns[d.chatKey]?.runId;

          this._setRuntimeRun(d.chatKey, d);

          if (d.source === 'background') {
            if (this.inTurnRuns[d.chatKey]) {
              this.inTurnRuns[d.chatKey].active = false;
            }
            if (!s) {
              this._pullChat(d.chatKey, false);

              return;
            }

            s.compacting = false;
            // «Стоп» относился к прошлому ходу: фоновый ход начинается со свободной кнопкой,
            // иначе она висела бы в «Останавливаю…» до его конца.
            s.stopping = false;
            this._hydrateLiveRun(s, d, previousRunId);
            s.turnStartedAt = typeof d.elapsedMs === 'number'
              ? turnStartFromElapsed(d.elapsedMs)
              : Date.now();

            return;
          }

          if (d.runId) {
            this._mergeInTurnSnapshot(d.chatKey, d.runId, d.inTurn, d.turnId);
            this._reconcileInTurn(d.chatKey, d.runId);
          }
          // Чат завели в другом окне и сразу отправили — его копия к нам ещё едет.
          // Тянем сейчас, чтобы разговор появился с работающим агентом, а не после F5.
          if (!s) { this._pullChat(d.chatKey, false); return; }
          // Принятый ход называет себя turnId: метку снимаем ровно с его реплики. Старый
          // синхронный — с самой ранней ожидающей, как раньше.
          const m = d.turnId
            ? (s.messages || []).find((x) => x.role === 'user' && x.turnId === d.turnId)
            : (s.messages || []).find((x) => x.queued);
          if (m) delete m.queued;
          // Ход стартовал — значит сервер его принял, даже если ответ на приём ещё в пути.
          if (d.turnId) {
            this._settleTurnMessage(s, d.turnId);
          }
          // Сжатие — служебный ход: во ВСЕХ окнах это вертящееся кольцо и заморозка ввода,
          // а не живая строка хода. Раньше признак жил только в затеявшем окне, и на втором
          // устройстве сжатие не отображалось ничем.
          if (d.compact) {
            s.compacting = true; s.sending = false;
            s.progressTokens = 0; s.progressTokensEstimate = false; s.turnStartedAt = 0;
          } else {
            s.sending = true; s.steps = []; s.progressTokens = 0; s.progressTokensEstimate = false;
            // Начало хода — по ЧАСАМ ЭТОГО ОКНА: серверное `at` приходит с другой машины,
            // и разница часов превратила бы «сколько идёт ход» в выдуманное число.
            s.turnStartedAt = Date.now();
            s.liveContext = 0;
            s.liveContextUsage = null;
            s.liveContextCache = null;
          }
        } else if (name === 'chat-session') {
          // Id сессии известен с первого события хода — сохраняем сразу, а не по ответу:
          // иначе перезапуск сервера посреди первого хода оставлял чат без сессии, и
          // следующее сообщение начинало разговор с нуля. Только идущему ходу: поздний
          // id завершённого хода не должен перебить сброс сессии после сжатия.
          const s = this._find(d.chatKey);

          if (s && d.sessionId && this._ownsRunEvent(d)
            && (s.sending || s.compacting) && s.sessionId !== d.sessionId) {
            s.sessionId = d.sessionId;
            this._persist();
          }
        } else if (name === 'chat-done') {
          // Ход завершён — снять живую строку/кольцо во всех окнах (ответ доставляется
          // ожидавшему окну или через pending). Но если из этого окна ушли ещё сообщения
          // и они ждут очереди, агент продолжит работу: индикатор оставляем.
          const s = this._find(d.chatKey);
          const current = this.runtimeRuns[d.chatKey];
          const inTurn = this.inTurnRuns[d.chatKey];

          // Конец своего запуска закрывает его черновики раньше ранних выходов: сверка
          // страницей может не пройти, а повторного chat-done не будет.
          this._closeInTurnDrafts(d.chatKey, d.runId);

          if (current?.active && (d.runId ? current.runId !== d.runId : !!current.runId)) {
            if (d.turnId) {
              this._collectPending();
            }

            return;
          }
          if (d.runId && current?.runId !== d.runId) {
            return;
          }

          if (current?.finishing) {
            return;
          }

          const delayed = !!d.turnId || d.source === 'background';
          const revision = this._touchRun(d.chatKey);

          if (current) {
            if (delayed) {
              current.finishing = true;
            } else {
              current.active = false;
            }

            current.queuedCount = Number(d.queued) || 0;
          }
          if (inTurn?.active && (!d.runId || inTurn.runId === d.runId)) {
            inTurn.active = false;
            this._reconcileInTurn(d.chatKey, inTurn.runId);
          }
          // Событие дошло — связь с сервером есть, даже если рвался длинный POST хода.
          if (s?.offline) s.offline = false;

          // Снять строку хода и кольцо. queued — принятые ходы этого чата, ещё ждущие
          // очереди: пока они есть, работа продолжается и «думает…» остаётся.
          const finish = () => {
            if (delayed && current) {
              if (this.runtimeRuns[d.chatKey] !== current || !current.finishing) {
                return;
              }

              current.active = false;
              delete current.finishing;
              this._touchRun(d.chatKey);
            } else if (this.runRevisions[d.chatKey] !== revision) {
              return;
            }

            if (s && !s.inflight && !(Number(d.queued) > 0)) {
              s.sending = false;
              s.stopping = false;
              s.liveContextCache = null;
              s.progressTokens = 0;
              s.progressTokensEstimate = false;
              s.turnStartedAt = 0;
            }
            // Своё сжатие разморозит его собственный ответ (он ещё едет и правит счётчики);
            // чужому окну ждать нечего — снимаем кольцо здесь.
            if (s && !compactInflight.has(s.id)) {
              s.compacting = false;
            }
          };
          // Итог принятого хода уже лежит в pending: строку хода снимаем, когда ответ
          // встал в переписку, иначе между ними мелькала бы пустота.
          if (delayed) {
            this._collectPending().finally(finish);
          }
          else {
            finish();
          }
        }
      });
    },
    /**
     * Снимает общий запрос и связанное оповещение одним действием.
     * Этот путь одинаков для своего ответа и события из другого окна.
     */
    _dropPending(pid) {
      delete this.pending[pid];
      dismissAlert(`chat-ask-${pid}`);
    },
    /**
     * Новый спрос агента. Оповещаем, если на этот чат сейчас не смотрят: агент СТОИТ,
     * пока не ответят, — пропустить такое дороже, чем пропустить обычный ответ.
     */
    _addPending(req) {
      this.pending[req.pid] = req;

      if (this._visible(req.chatKey)) {
        return;
      }

      const s = this._find(req.chatKey);
      const who = s ? this.tabLabel(s) : 'чат';
      const what = req.kind === 'question'
        ? (req.prompt || req.questions?.[0]?.question || 'Агент задал вопрос')
        : (req.input?.kind === 'external_url'
          ? (req.input?.description || 'Сервис просит завершить действие на внешней странице')
          : `Агент просит разрешение: ${req.tool || 'действие'}`);
      const quick = quickPermission(req);
      const actions = quick ? [
        {
          id: 'allow',
          label: 'Разрешить',
          tone: 'success',
          variant: 'solid',
          run: () => this.answerPerm(req.pid, true),
        },
        {
          id: 'deny',
          label: 'Отклонить',
          tone: 'danger',
          variant: 'outline',
          run: () => this.answerPerm(req.pid, false),
        },
      ] : [];

      alertUser({
        id: `chat-ask-${req.pid}`,
        scope: req.chatKey ? `chat:${req.chatKey}` : '',
        tone: 'warning',
        sticky: true,
        title: `Нужен твой ответ — ${who}`,
        body: what.slice(0, 120),
        detail: quick?.detail || '',
        target: req.chatKey ? { kind: 'chat', chatId: req.chatKey } : undefined,
        actions,
      });
    },
    /**
     * Спросы, которые уже висели: SSE доставляет событие один раз, поэтому после F5
     * (и во втором окне) поднимаем их отдельным запросом — иначе агент ждёт ответа,
     * а показать его некому.
     */
    async _loadWaiting() {
      let waiting;
      try { ({ waiting } = await api.get('/api/chat/waiting?include=ssh,db')); }
      catch { return; /* сервер старый/недоступен — обойдёмся SSE */ }
      // Сверяемся ПОЛНОСТЬЮ, а не дозаливаем: после рестарта сервера запросы умирают
      // вместе с процессами агентов, и наши всплывашки стали бы фантомами.
      const fresh = {};
      for (const w of waiting || []) {
        fresh[w.pid] = this.pending[w.pid] || { ...w, kind: w.questions ? 'question' : 'perm' };
      }
      for (const pid of Object.keys(this.pending)) {
        if (!fresh[pid]) {
          dismissAlert(`chat-ask-${pid}`);
        }
      }

      this.pending = fresh;
    },
    /**
     * SSE и сверка active восстанавливают одинаковые метрики живого запуска.
     * Новый run заменяет ленту целиком, прежний принимает лишь более полный или свежий снимок.
     */
    _hydrateLiveRun(s, a, previousRunId) {
      s.compacting = false;
      s.sending = true;
      s.progressTokens = a.tokens || 0;
      s.progressTokensEstimate = a.tokensIsEstimate === true;
      s.liveContext = 0;
      s.liveContextUsage = null;
      s.liveContextCache = null;
      applyLiveContextUsage(s, a);

      if (a.runId && a.runId !== previousRunId) {
        s.steps = Array.isArray(a.steps) ? a.steps : [];

        return;
      }

      const mine = s.steps?.length || 0;
      const theirs = a.steps?.length || 0;
      const myLast = s.steps?.[mine - 1]?.at || 0;
      const theirLast = a.steps?.[theirs - 1]?.at || 0;

      if (theirs > mine || theirLast > myLast) {
        s.steps = a.steps;
      }
    },
    /**
     * Ходы, идущие ПРЯМО СЕЙЧАС, — по данным сервера. Правда о работе агента живёт в
     * процессе сервера (activeRuns), а не в окне: иначе второе устройство не знает ни
     * что чат занят, ни чем именно. Зовём при загрузке (после F5) и на восстановление
     * связи (SSE доставляет `chat-turn-start` один раз — кто в этот момент был в офлайне
     * или ещё не открыт, тот его не увидит; у сжатия догнать нечем — ни шагов, ни
     * прогресса по нему не идёт).
     * Сверяемся ПОЛНОСТЬЮ, как со спросами: после рестарта сервера ходы умирают, и
     * оставленное «думает…»/кольцо крутились бы вечно. Не трогаем только то, по чему
     * из этого окна висит свой незакрытый запрос: его судьбу решит его же ответ.
     */
    async _loadActive() {
      const request = ++this.activeRequest;
      const revisions = { ...this.runRevisions };
      let active;
      let queued;
      let protocol;

      try {
        const response = await api.get('/api/chat/active');

        active = response.active;
        queued = response.queued;
        protocol = response.protocol;
      } catch {
        return; // Сервер старый или недоступен — обойдёмся SSE.
      }

      if (request !== this.activeRequest) {
        return;
      }

      this.inTurnProtocol = protocol || 0;

      const byKey = new Map((active || []).map((a) => [a.chatKey, a]));
      // Принятые ходы, ждущие очереди: их чат занят, а реплики честно «ждут очереди».
      const waitingTurns = new Map();

      for (const item of Array.isArray(queued) ? queued : []) {
        if (!item?.chatKey || !item.turnId) {
          continue;
        }
        if (!waitingTurns.has(item.chatKey)) {
          waitingTurns.set(item.chatKey, []);
        }

        waitingTurns.get(item.chatKey).push(item.turnId);
      }

      const accepted = [];
      // Запуски, пропавшие из ответа сервера: их черновики сверяются страницей журнала.
      const vanished = [];

      for (const s of [...this.sessions, ...(this.archived || [])]) {
        if ((this.runRevisions[s.id] || 0) !== (revisions[s.id] || 0)) {
          continue;
        }

        const a = byKey.get(s.id);
        const previous = this.runtimeRuns[s.id];
        const previousRunId = previous?.runId;

        if (previous?.finishing && (!a || a.runId === previous.runId)) {
          continue;
        }

        const waiting = waitingTurns.get(s.id) || [];

        if (a) {
          this._setRuntimeRun(s.id, a);
          accepted.push(a);
        } else if (this.runtimeRuns[s.id]) {
          this.runtimeRuns[s.id].active = false;
          this._touchRun(s.id);
        }

        if (a?.runId && a.source !== 'background') {
          this._mergeInTurnSnapshot(s.id, a.runId, a.inTurn, a.turnId);
        } else if (this.inTurnRuns[s.id]) {
          if (this.inTurnRuns[s.id].active) {
            vanished.push([s.id, this.inTurnRuns[s.id].runId]);
          }

          this.inTurnRuns[s.id].active = false;
        }

        for (const turnId of waiting) {
          const m = (s.messages || []).find((x) => x.role === 'user' && x.turnId === turnId);

          this._settleTurnMessage(s, turnId);

          if (m) {
            m.queued = true;
          }
        }

        if (a?.turnId) {
          const m = (s.messages || []).find((x) => x.role === 'user' && x.turnId === a.turnId);

          this._settleTurnMessage(s, a.turnId);

          if (m) {
            delete m.queued;
          }
        }
        if (a?.compact) {
          // Сжатие: живой строки хода нет — её место занимает вертящееся кольцо.
          s.compacting = true; s.sending = false;
          s.progressTokens = 0; s.progressTokensEstimate = false; s.turnStartedAt = 0;
        } else if (a) {
          this._hydrateLiveRun(s, a, previousRunId);
          // Длительность сервера переносим на часы окна, не сравнивая абсолютные даты.
          s.turnStartedAt = turnStartFromElapsed(a.elapsedMs);
        } else if (waiting.length) {
          // Предыдущий ход только что кончился, следующий вот-вот стартует: чат занят.
          s.sending = true;
        } else if (!s.inflight && !compactInflight.has(s.id)) {
          s.sending = false; s.stopping = false; s.compacting = false;
          s.progressTokens = 0; s.progressTokensEstimate = false; s.turnStartedAt = 0;
          s.liveContext = 0;
          s.liveContextUsage = null;
          s.liveContextCache = null;
        }
      }

      // Пропавший запуск сервер больше не ведёт: правду о черновиках даёт страница журнала.
      // Локальная отметка обрыва — только если сверка не удалась, иначе она спорила бы с ответом.
      await Promise.all(vanished.map(async ([chatKey, runId]) => {
        if (!await this._reconcileInTurn(chatKey, runId)) {
          this._closeInTurnDrafts(chatKey, runId);
        }
      }));

      await Promise.all(accepted.filter((a) => a?.runId && a.source !== 'background')
        .map((a) => this._reconcileInTurn(a.chatKey, a.runId)));
    },
    /**
     * В окне есть изменения, которых сервер ещё не видел (дебаунс `_persist`, неудачная
     * запись). Такой чат чужой копией НЕ перетираем: наша запись всё равно уедет следом
     * и победит, а принятая сейчас серверная версия стёрла бы набранное.
     */
    _dirty(chat) {
      const archived = (this.archived || []).some((c) => c.id === chat.id);
      const snapshot = archived ? archivedSlimOf(chat) : slimOf(chat);

      return !historyPersistenceFor(this).isSent(snapshot, fingerprintOf(snapshot));
    },
    /**
     * Чат изменили в другом окне (в т.ч. на другом устройстве) — забираем именно его.
     * Тянем по одному чату, а не всю историю: меняется всегда один, а история растёт.
     */
    async _pullChat(id, archived) {
      if (!id) return;
      const local = this._find(id);
      let chat = null;
      try { ({ chat } = await api.get(`/api/chat/store/chat/${id}`)); }
      catch { return; /* чат уже успели удалить — придёт отдельным событием */ }
      if (!chat?.id) return;
      if (local && this._dirty(local)) {
        historyPersistenceFor(this).resetBase(chat.id);

        // Набранный текст остаётся локальным, но server-owned execution-состояние
        // нельзя откладывать: другая вкладка могла уже перенести разговор.
        for (const key of ['workdir', 'taskId', 'workdirState']) {
          if (Object.hasOwn(chat, key)) {
            local[key] = chat[key];
          }
        }

        return;
      }
      this._applyRemoteChat(chat, archived);
      // Чат появился в окне впервые — в нём может уже идти ход (его завели и сразу
      // отправили сообщение на другом устройстве). Своих SSE-событий мы не видели,
      // поэтому живое состояние берём у сервера.
      if (!local) await this._loadActive();
    },
    /**
     * Серверная копия чата встаёт на место своей: поля переписки берём у неё, рантайм —
     * у окна (идущий ход не должен погаснуть от чужой правки). Чат мог и переехать между
     * открытыми и архивом — тогда переносим его между списками.
     */
    _applyRemoteChat(chat, archived, { notifyReply = true } = {}) {
      this.archived ||= [];
      const localBefore = this._find(chat.id);
      const knownMessages = new Set((localBefore?.messages || [])
        .map((message, index) => messageNoticeKey(chat.id, message, index)));
      const target = archived ? this.archived : this.sessions;
      const source = archived ? this.sessions : this.archived;
      const next = { ...chat };
      delete next.archived; // принадлежность к архиву — это список, а не поле чата
      this._normalize([next]);
      const si = source.findIndex((c) => c.id === chat.id);
      const moved = si >= 0 ? source.splice(si, 1)[0] : null;
      const i = target.findIndex((c) => c.id === chat.id);
      // Объект чата НЕ подменяем, а обновляем на месте: ссылку на него держат и
      // компоненты, и идущий прямо сейчас send() — подмена оставила бы ход писать
      // ответ в отцепленный объект, то есть потеряла бы его целиком.
      const live = i >= 0 ? target[i] : moved;
      if (live) {
        Object.assign(live, next, runtimeOf(live));
        if (i < 0) insertByCreated(target, live);
      } else {
        insertByCreated(target, next);
      }
      // Копия пришла с сервера — значит она там и лежит: помечаем отправленной, иначе
      // ближайший persist погнал бы её обратно и разбудил остальные окна вхолостую.
      const applied = live || next;
      // В чужой копии мог появиться готовый ответ. Берём только последний НОВЫЙ ответ:
      // при восстановлении связи несколько старых сообщений не должны высыпаться пачкой.
      const freshReply = (applied.messages || [])
        .map((message, index) => ({ message, key: messageNoticeKey(applied.id, message, index) }))
        .filter(({ message, key }) => message.role === 'assistant' && !isIntermediateReply(message)
          && !knownMessages.has(key))
        .at(-1);
      if (freshReply && notifyReply) this._notifyReply(applied, freshReply.message.text, freshReply.key);

      const appliedSnapshot = archived ? archivedSlimOf(applied) : slimOf(applied);
      const state = historyPersistenceFor(this);

      state.markSent(appliedSnapshot, fingerprintOf(appliedSnapshot));
      state.acceptLoaded(applied);
      // Реплику с неподтверждённым приёмом отправляет другое окно. Если оно умерло до
      // подтверждения, это окно само покажет «не доставлено» — после паузы на ответ.
      const foreign = (applied.messages || [])
        .some((m) => m?.role === 'user' && m.turnId && m.delivery === 'sending' && !outgoing.has(m.turnId));

      if (foreign && this.turnProtocol === TURN_PROTOCOL && !reconcileTimer) {
        reconcileTimer = setTimeout(() => {
          reconcileTimer = null;
          this._reconcileDeliveries();
        }, FOREIGN_DELIVERY_GRACE_MS);
        reconcileTimer?.unref?.();
      }
    },
    /**
     * Чат удалили в другом окне: освобождаем историю, превью и подтверждения записи.
     * Поздний ACK удалённого чата не должен создать подтверждённую базу заново.
     */
    _dropRemoteChat(id) {
      if (!id) return;
      for (const list of [this.sessions, this.archived || []]) {
        const i = list.findIndex((c) => c.id === id);
        if (i >= 0) list.splice(i, 1);
      }

      historyPersistenceFor(this).forget(id);
      persistenceProjections.get(this)?.remove(id);
      previewCaches.get(this)?.remove(id);
      if (this.activeId === id) this.activeId = this.sessions[0]?.id || this.archived[0]?.id || null;
    },
    /**
     * Speech SSE не имеет replay-буфера: после reconnect всегда сверяем
     * полный server-owned snapshot. Ошибка не ломает остальной reconnect.
     */
    _resyncSpeech() {
      if (speechSyncPromise) return speechSyncPromise;
      const requestedAtEpoch = speechSnapshotEpoch;
      speechSyncPromise = api.get('/api/settings/speech')
        .then((snapshot) => (
          requestedAtEpoch === speechSnapshotEpoch
            ? this.setSpeechSnapshot(snapshot)
            : this.speech
        ))
        .catch(() => null)
        .finally(() => { speechSyncPromise = null; });
      return speechSyncPromise;
    },
    /**
     * Полная сверка истории с сервером — на восстановление связи. Точечные `chat-store`
     * закрывают обычную жизнь, но пока планшет спал (или пока сервер перезапускали),
     * событий никто не слышал: без сверки чат, заведённый в это время, снова ждал бы F5.
     */
    async _resyncStore() {
      let j = null;
      try { j = await api.get('/api/chat/store'); }
      catch { return; }
      if (!j?.sessions && !j?.archived) return;
      storeSyncedAt = Date.now();
      // Сервер мог смениться за время разрыва (перезапуск с новой версией).
      this.turnProtocol = Number(j?.turnProtocol) === TURN_PROTOCOL ? TURN_PROTOCOL : 0;
      this.workdirProtocol = Number(j?.workdirProtocol) === 1 ? 1 : 0;
      this.historyStepReuseProtocol = j?.historyStepReuseProtocol === 1 ? 1 : 0;

      if (!this.historyStepReuseProtocol) {
        historyPersistenceFor(this).clearBases();
      }

      const onServer = new Set();
      for (const [list, archived] of [[j.sessions || [], false], [j.archived || [], true]]) {
        for (const chat of list) {
          if (!chat?.id) continue;
          onServer.add(chat.id);
          const local = this._find(chat.id);

          if (local && this._dirty(local)) {
            historyPersistenceFor(this).resetBase(chat.id);

            continue;
          }
          const next = { ...chat };
          delete next.archived;
          // Ровно это у нас и лежит — не трогаем объект, иначе каждое переподключение
          // подменяло бы массивы сообщений и перерисовывало открытый чат на ровном месте.
          const same = historyPersistenceFor(this).sentChats.get(chat.id)
            === fingerprintOf(archived ? archivedSlimOf(next) : slimOf(next));

          if (local && same && (!this.historyStepReuseProtocol
            || historyPersistenceFor(this).hasBase(local))) {
            continue;
          }
          this._applyRemoteChat(chat, archived);
        }
      }
      // Чата нет на сервере, хотя мы его туда писали — значит его стёрли на другом
      // устройстве. Тот, которого сервер и не видел (новый, ещё не уехал), — оставляем.
      for (const list of [this.sessions, this.archived || []]) {
        for (const c of [...list]) {
          if (onServer.has(c.id) || !historyPersistenceFor(this).sentChats.has(c.id) || this._dirty(c)) {
            continue;
          }
          this._dropRemoteChat(c.id);
        }
      }
    },
    async answerPerm(pid, allow, remember = false, comment = '', choice = '') {
      const p = this.pending[pid];
      if (!p) return;
      if (p.origin === 'ssh') {
        try {
          await api.post(`/api/ssh/approvals/${p.pid}`, { allow, comment: String(comment || '') });
          this._dropPending(pid);
        } catch {
          // Ответ мог принять другое окно. Истина — общая очередь сервера; при
          // сетевой ошибке _loadWaiting оставит карточку на месте.
          await this._loadWaiting();
        }
        return;
      }
      if (p.origin === 'db') {
        try {
          await api.post(`/api/db/approvals/${p.pid}`, { allow });
          this._dropPending(pid);
        } catch {
          await this._loadWaiting();
        }
        return;
      }

      this._dropPending(pid);

      const mayRemember = canRememberPermission(p);
      if (allow && remember && mayRemember && p.chatKey && p.tool) {
        (permAutoAllow[p.chatKey] ||= new Set()).add(p.tool);
      }
      // План оставляем в переписке: всплывашка закроется, а решение принималось по нему —
      // потом нужно видеть, что именно утвердили (или что ушло на доработку и с каким пояснением).
      // Признак — сам план в запросе, а не имя инструмента: у Claude это ExitPlanMode,
      // у Kimi — обычный запрос разрешения с вариантами plan_*.
      if (p.input?.plan) {
        const s = this._find(p.chatKey);
        if (s) {
          s.messages.push({
            role: 'assistant',
            text: `**План — ${allow ? 'утверждён' : 'на доработку'}**\n\n${p.input.plan}`
              + (!allow && comment ? `\n\n**Пояснение:** ${comment}` : ''),
          });
          s.updatedAt = Date.now();
          this._persist();
        }
      }
      let res = null;
      try {
        res = await api.post(`/api/chat/permission/${p.pid}`, {
          allow,
          // «до конца сессии» — не только политика вкладки: у ACP это отдельный
          // вариант ответа (allow_always), и без передачи Kimi спрашивал снова.
          ...(remember && mayRemember ? { remember: true } : {}),
          // Кнопка плана: у Kimi вариантов ответа больше двух (доработать, выйти).
          ...(choice ? { choice } : {}),
          ...(comment ? { comment } : {}),
        });
      } catch { /* запрос уже протух (таймаут/другое окно) */ }
      // Kimi (ACP) не умеет текст в отказе: сервер отвечает commentDelivered:false,
      // и пояснение едет обычным сообщением — встанет в очередь чата.
      if (!allow && comment && res?.commentDelivered === false) await this.send(p.chatKey, comment);
    },
    // Legacy-вопрос получает массив, structured-форма — `{ action, answers }` с raw values.
    async answerQuestion(pid, payload) {
      const p = this.pending[pid];
      if (!p) return;
      const structured = p.structured === true;
      const answers = Array.isArray(payload)
        ? payload
        : (Array.isArray(payload?.answers) ? payload.answers : []);
      const action = typeof payload?.action === 'string' ? payload.action : '';
      const body = {
        answers,
        ...(structured && action ? { action } : {}),
      };
      let res = null;
      if (structured) {
        // Невалидную форму сервер не снимает. При сетевой неоднозначности перечитываем
        // общую очередь, чтобы не потерять карточку принятого или непринятого ответа.
        try {
          res = await api.post(`/api/chat/permission/${pid}`, body);
          this._dropPending(pid);
        } catch {
          await this._loadWaiting();
        }
      } else {
        this._dropPending(pid);
        try { res = await api.post(`/api/chat/permission/${pid}`, body); }
        catch { /* запрос уже снят (стоп/конец хода/другое окно) */ }
      }
      // Свой текст доезжает не по всякому каналу (ACP-мост Kimi несёт только выбранный
      // вариант). Сервер честно говорит textDelivered:false — досылаем обычным
      // сообщением, как и пояснение к отказу.
      const text = (answers || []).map((a) => a?.text || '').find(Boolean) || '';
      if (!structured && text && res?.textDelivered === false) await this.send(p.chatKey, text);
    },

    async ensure() {
      await this._load();
      this.initPerms();
      // AppShell мог открыть общий EventSource и получить initial hello, пока _load()
      // ещё читал историю. Не полагаемся на повторный hello: сразу сверяем cold
      // publicSnapshot с полной runtime readiness, не задерживая показ чатов.
      void this._resyncSpeech();
      // sending/error не персистятся — восстанавливаем поля.
      this.sessions.forEach((s) => { if (s.sending === undefined) s.sending = false; if (s.error === undefined) s.error = null; });
      // Миграция: алиаса «fable» в CLI нет — только полный ID.
      this.sessions.forEach((s) => { if (s.model === 'fable') s.model = 'claude-fable-5'; });
      if (this.defModel === 'fable') this.defModel = 'claude-fable-5';
      if (!this.sessions.length && !this.archived.length) this.newSession();
      else if (!this._find(this.activeId)) this.activeId = this.sessions[0]?.id || this.archived[0]?.id || null;
    },
    setSpeechSnapshot(payload) {
      this.speech = normalizeSpeechSnapshot(payload, this.speech);
      speechSnapshotEpoch += 1;
      return this.speech;
    },
    /**
     * Унести активный чат в архив. keepEmpty=true используется явным действием
     * «удалить»: пользователь попросил сохранить в архиве даже пустой разговор.
     * Обычное закрытие пустой вкладки по-прежнему просто убирает её.
     */
    _archiveSession(id, keepEmpty = false) {
      const i = this.sessions.findIndex((s) => s.id === id);
      if (i < 0) return false;
      const [s] = this.sessions.splice(i, 1);
      // Черновик — тоже содержимое: закрытие вкладки не должно молча его терять.
      if (keepEmpty || s.messages?.length || (s.draft || '').trim() || s.draftAttachments?.length) {
        delete s.archived;
        s.closedAt = Date.now();
        this.archived.unshift(s);
      }
      if (this.activeId === id) this.activeId = this.sessions[Math.max(0, i - 1)]?.id || null;
      if (!this.sessions.length) this.newSession();
      this._persist();
      return true;
    },
    closeSession(id) { this._archiveSession(id); },
    // Вернуть чат из архива в открытые вкладки.
    restoreArchived(id) {
      const i = this.archived.findIndex((s) => s.id === id);
      if (i < 0) return;
      const [a] = this.archived.splice(i, 1);
      delete a.archived;
      delete a.closedAt;
      a.sending ??= false;
      a.error ??= null;
      this.sessions.push(a);
      this.activeId = a.id;
      this._persist();
    },
    setActive(id) { if (this._get(id)) { this.activeId = id; this._persist(); } },
    setTitle(id, title) { const s = this._find(id); if (!s) return; s.title = title; this._persist(); },
    // Выбор чата из сайдбара ничего не говорит о его месте хранения: архивный
    // открываем для чтения на месте. Вернуть его можно явной кнопкой или отправкой.
    /**
     * Сначала загружает историю, затем выбирает существующий чат по ссылке.
     * Запрос показа отделён от activeId: на телефоне выбранный чат может быть скрыт списком.
     */
    async revealChat(id) {
      await this._load();

      if (!this._find(id)) {
        return false;
      }

      this.selectChat(id);
      this.revealRequest = id;

      return true;
    },
    consumeReveal() {
      this.revealRequest = '';
    },
    selectChat(id) {
      if (!this._find(id)) return;
      this.activeId = id;
      this._persist();
    },
    // Переименование из сайдбара — работает и для открытых, и для архивных.
    renameChat(id, title) {
      const s = this._find(id);
      if (!s) return;
      s.title = title;
      this._persist();
    },
    // Двухступенчатое удаление: активный чат сначала уходит в архив; только повторное
    // удаление из архива стирает его безвозвратно (и серверный файл — через _persist).
    deleteChat(id) {
      if (this._get(id)) return this._archiveSession(id, true) ? 'archived' : null;
      const j = this.archived.findIndex((x) => x.id === id);
      if (j < 0) return null;
      this.archived.splice(j, 1);
      previewCaches.get(this)?.remove(id);
      historyPersistenceFor(this).resetBase(id);
      if (this.activeId === id) this.activeId = this.sessions[0]?.id || this.archived[0]?.id || null;
      this._persist();
      return 'deleted';
    },

    /**
     * Задача меняет эффективную папку и проходит тот же переход памяти; её название чат
     * получает после подтверждения. Отказ без окна выбора пишется в разговор: иначе селект
     * молча вернулся бы к прежней задаче. Старый сервер — прежний путь без перехода.
     */
    setTask(id, taskId, title) {
      const session = this._find(id);

      if (!session || session.purpose === 'companion') {
        return false;
      }
      if (!this.workdirProtocol) {
        session.taskId = taskId ? String(taskId) : null;
        session.title = title || '';
        this._persist();

        return true;
      }

      const candidate = {
        taskId: taskId ? String(taskId) : null,
        workdir: session.workdir,
      };

      session.error = null;

      return this.proposeWorkdir(id, candidate, false, { title: title || '' }).then((done) => {
        const live = this._find(id);

        if (!done && live?.error && !live.workdirProposal) {
          live.messages.push({ role: 'error', text: `Сменить задачу не удалось: ${live.error}` });
          this._persist();
        }

        return done;
      });
    },
    /**
     * Пропавшая папка по умолчанию заменяется до первого сохранения нового чата.
     * Явный выбор и уже сохранённые разговоры не получают молчаливого fallback.
     */
    async _initializeWorkdir(session) {
      if (!this.workdirProtocol || !session.workdirInitializing) {
        return;
      }

      try {
        await api.post('/api/chat/workdir/preview', {
          modelRef: session.modelRef,
          candidate: { taskId: session.taskId || null, workdir: session.workdir },
        });
      } catch (error) {
        const unavailableDefault = [
          'workdir_missing', 'workdir_unavailable', 'workdir_archived_project',
          'workdir_unknown_project', 'workdir_unknown_repo', 'workdir_no_repositories', 'bad_workdir',
        ].includes(error.data?.error);

        if (!session.workdirImplicit || !unavailableDefault || session.taskId) {
          throw error;
        }

        session.workdir = { kind: 'cockpit' };
        session.error = 'Папка по умолчанию недоступна. Для нового чата выбран Кокпит.';
      }

      session.workdirInitializing = false;
    },
    /**
     * Предпросмотр читает запись сервера, поэтому до него уходят только несохранённые
     * правки этого чата: чистый чат повторно целиком не отправляется. Данные пути и
     * способ переноса приходят только от сервера.
     */
    async previewWorkdir(id, candidate) {
      const session = this._find(id);

      if (!session || !this.workdirProtocol) {
        return null;
      }

      await this._writeChat(id);

      const preview = await api.post('/api/chat/workdir/preview', {
        chatKey: id,
        ...(candidate ? { candidate } : {}),
      });

      if (!candidate) {
        session.workdirPreview = preview;
      }

      return preview;
    },
    /**
     * Выбор задачи и папки проходят один поток переноса памяти. Окно выбора открывается,
     * только когда исполнитель требует решения человека (выжимка или сброс памяти):
     * resume и чат без памяти переходят сразу. Та же папка без переноса — не переход.
     */
    async proposeWorkdir(id, candidate, remember = false, { title } = {}) {
      const session = this._find(id);

      const companionRebind = session?.purpose === 'companion'
        && ((candidate.taskId || null) !== (session.taskId || null)
          || !sameChatWorkdir(candidate.workdir, session.workdir));

      if (!session || companionRebind || session.sending || session.compacting
        || session.sessionResetting || session.workdirChanging || session.workdirProposal
        || Object.values(this.deliveries).some((item) => item.chatId === id && item.state !== 'lost')) {
        return false;
      }

      session.workdirChanging = true;
      session.error = null;

      try {
        const preview = await this.previewWorkdir(id, candidate);

        if (!preview) {
          throw new Error('Сервер ещё не поддерживает выбор папки.');
        }

        const proposal = {
          candidate,
          remember,
          preview,
          operationId: newTurnId(),
          ...(title === undefined ? {} : { title }),
        };

        if (preview.transfer === 'reseed' || preview.transfer === 'unavailable') {
          session.workdirProposal = proposal;

          return false;
        }
        if (preview.transfer === 'none' && (candidate.taskId || null) === (session.taskId || null)
          && sameChatWorkdir(candidate.workdir, session.workdir)) {
          this._rememberWorkdir(session, proposal);
          this._persist();

          return true;
        }

        return await this.commitWorkdir(id, 'resume', proposal);
      } catch (error) {
        session.error = error.message;

        return false;
      } finally {
        session.workdirChanging = false;
      }
    },
    /**
     * Явный выбор папки свободного чата становится умолчанием новых чатов и первой
     * строкой недавних. Папка задачи и снятие задачи предпочтений не меняют.
     */
    _rememberWorkdir(session, proposal) {
      if (!proposal.remember || session.taskId) {
        return;
      }

      this.defWorkdir = session.workdir;
      this.recentWorkdirs = normalizeRecentWorkdirs([session.workdir, ...this.recentWorkdirs]);
    },
    /**
     * Новый выбор применяется после серверного commit, вместе с плашкой и памятью.
     * Черновик, набранный пока сервер делал выжимку, остаётся в этом окне. Прямой переход
     * без окна выбора (`direct`) открывает окно только после сбоя — для повтора.
     */
    async commitWorkdir(id, transfer, direct = null) {
      const session = this._find(id);
      const proposal = direct || session?.workdirProposal;

      if (!session || !proposal) {
        return false;
      }

      session.workdirChanging = true;
      session.error = null;

      try {
        proposal.transfer ||= transfer;

        const result = await api.post('/api/chat/workdir/change', {
          chatKey: id,
          operationId: proposal.operationId,
          expectedRevision: proposal.preview.revision,
          expectedWorkspaceKey: proposal.preview.workspaceKey,
          ...proposal.candidate,
          transfer: proposal.transfer,
        });
        const transition = result.chat?.workdirState?.transition;
        const draft = session.draft;
        const draftAttachments = session.draftAttachments;

        this._applyRemoteChat(result.chat, false, { notifyReply: false });
        session.draft = draft;
        session.draftAttachments = draftAttachments;
        session.workdirPreview = null;
        session.workdirProposal = null;

        if (transition?.phase !== 'done') {
          session.error = transition?.error || 'Перенос не завершён.';

          return false;
        }
        if (proposal.title !== undefined) {
          session.title = proposal.title;
        }

        this._rememberWorkdir(session, proposal);
        this._persist(true);

        return true;
      } catch (error) {
        session.error = error.message;
        session.workdirProposal = await this._workdirRetry(id, proposal, error);

        return false;
      } finally {
        session.workdirChanging = false;
      }
    },
    /**
     * Что остаётся после сбоя commit. Определённый отказ сервера закрывает переход.
     * Потерянный ответ сохраняет прежний operationId: повтор идемпотентен. Если сервер
     * записал failed, reseed получает новый выбор стратегии, а прямой переход закрывается.
     */
    async _workdirRetry(id, proposal, error) {
      if (error.status === 409 || error.data?.error === 'stale_chat_workdir') {
        return null;
      }
      if (!error.status) {
        return proposal;
      }

      try {
        const remote = await api.get(`/api/chat/store/chat/${id}`);
        const transition = remote.chat?.workdirState?.transition;

        if (transition?.id !== proposal.operationId || transition.phase !== 'failed') {
          return proposal;
        }
        if (!['reseed', 'unavailable'].includes(proposal.preview.transfer)) {
          return null;
        }

        return {
          ...proposal,
          operationId: newTurnId(),
          transfer: null,
          preview: await this.previewWorkdir(id, proposal.candidate),
        };
      } catch {
        // Исход пока неизвестен: повтор тем же operationId остаётся идемпотентным.
        return proposal;
      }
    },
    /**
     * Отправка закрепляет workspace в outbox, чтобы F5 не поменял цель повтора.
     * Внешняя смена корней требует отдельного явного переноса, а не запуска по новому preview.
     */
    async prepareWorkdirSend(session, message) {
      if (!this.workdirProtocol) {
        return;
      }

      const preview = await api.post('/api/chat/workdir/preview', { chatKey: session.id });

      session.workdirPreview = preview;

      if (preview.transfer === 'reseed' || preview.transfer === 'unavailable') {
        throw new Error('Рабочие папки изменились. Откройте выбор папки и подтвердите перенос разговора.');
      }
      if (message) {
        message.outbox ||= {};
        message.outbox.workspaceKey = preview.workspaceKey;
        message.outbox.workdir = session.workdir;
        message.outbox.taskId = session.taskId || null;
        await this._saveChatNow(session);
      }
    },
    /**
     * Режим прав чата (вручную / авто / план …). Запоминаем и как дефолт новых чатов —
     * выбор режима обычно про привычку работы, а не про конкретный разговор.
     */
    setMode(id, m) { const s = this._find(id); if (!s) return; s.mode = m; this.defMode = m; this._persist(); },
    setModel(id, m) {
      const s = this._find(id); if (!s) return;
      const resolved = useProvidersStore().modelOf(m);
      s.model = resolved.id || m;
      s.modelRef = resolved.provider && resolved.model
        ? { provider: resolved.provider.id, model: resolved.model.id }
        : null;
      this.defModel = s.model;
      this.defModelRef = s.modelRef;
      this._persist();
    },
    /**
     * Черновик неотправленного сообщения. Живёт в чате (и на сервере), поэтому
     * переключение чатов и перезагрузка страницы его не теряют — как в телеграме.
     * updatedAt НЕ трогаем: набор текста не должен поднимать чат в списке.
     */
    setDraft(id, text) {
      const s = this._find(id);
      if (!s || (s.draft || '') === text) return;
      s.draft = text;
      // Черновик сохраняется на каждую паузу в наборе, поэтому этот путь обязан быть
      // дешёвым: снимок здесь не нужен (терять при рестарте сервера нечего — текст
      // на экране и так перед глазами), а именно он и подвешивал ввод.
      this._persist(false, { snapshot: false });
    },
    /**
     * Вложения черновика живут в чате рядом с его текстом: компонент чата пересоздаётся
     * при переключении, и локальный список пропадал вместе с ним. Сохраняются тем же
     * дешёвым путём без снимка, что и текст.
     */
    setDraftAttachments(id, list) {
      const s = this._find(id);

      if (!s) {
        return;
      }

      s.draftAttachments = draftAttachmentsOf(list);
      this._persist(false, { snapshot: false });
    },
    /**
     * Загрузка файла заканчивается асинхронно: к этому моменту человек мог уйти в другой
     * чат. Вложение дописывается туда, где его начали прикладывать, а не в открытый чат.
     */
    addDraftAttachment(id, attachment) {
      const s = this._find(id);

      if (!s) {
        return;
      }

      this.setDraftAttachments(id, [...(s.draftAttachments || []), attachment]);
    },
    setEffort(id, e) {
      const s = this._find(id); if (!s) return;
      s.effort = e; this.defEffort = e; this._persist();
    },
    /**
     * Осознанная очистка записывается полным PUT с прежними правилами CAS.
     * Подтверждения старых лент больше не принадлежат пустой истории.
     */
    clearChat(id) {
      const session = this._find(id);

      if (!session) {
        return;
      }

      session.messages = [];
      session.error = null;
      historyPersistenceFor(this).resetBase(id);
      this._persist();
    },
    /**
     * Сброс памяти агента: следующее сообщение уйдёт БЕЗ --resume, то есть в чистую
     * сессию. Переписка на экране остаётся (история кокпита к сессии CLI не привязана),
     * поэтому визуально «ничего не произошло» — это ловушка, из-за которой сброс легко
     * спутать со сжатием. Ждущую выжимку тоже гасим: раз память сбрасывают осознанно,
     * подсовывать агенту старое состояние нельзя.
     * note: false — не оставлять плашку (зовёт `/clear`, где историю только что вычистили
     * и единственной записью осталось бы наше же сообщение о сбросе).
     */
    resetContext(id, { note = true } = {}) {
      const s = this._find(id);
      if (!s) return Promise.resolve(false);
      const inflight = sessionResetJobs.get(id);
      if (inflight) return inflight;

      // Важен ref ДО возможной смены provider в селекте. Для executor-а с server-owned
      // binding сначала инвалидируем старую provider-session, затем меняем модель.
      const modelRef = s.modelRef ? { ...s.modelRef } : null;
      const bindingProvider = modelRef
        ? useProvidersStore().modelOf(modelRef).provider?.sessionBinding === true
        : false;
      // Сброс подтверждает сервер, а не только окно — для любого исполнителя. Живая
      // сессия помнит разговор внутри своего процесса, и одного `sessionId = null` в окне
      // мало: следующий ход поднял бы тот же процесс, и агент помнил бы всё, что окно
      // «забыло». Несохранённому чату (revision 0) гасить на сервере нечего.
      const resetOnServer = s.revision > 0 || (bindingProvider && !!s.sessionId);
      s.sessionResetting = true;
      s.sessionResetFailed = false;
      s.error = null;

      const job = (async () => {
        // Даём положить Promise в карту до любого синхронного локального reset.
        await Promise.resolve();
        try {
          if (resetOnServer) {
            await api.post('/api/chat/session/reset', { chatKey: id, modelRef });
          }
          const live = this._get(id) || s;
          clearSessionContext(live, { discardSeed: true });
          live.sessionResetFailed = false;
          if (note) {
            live.messages.push({ role: 'note', text: '🧹 Память агента сброшена — следующее сообщение начнёт разговор с нуля.' });
          }
          return true;
        } catch (error) {
          const live = this._get(id) || s;
          live.sessionResetFailed = true;
          live.error = error.message;
          live.messages.push({
            role: 'error',
            text: `Сбросить память агента не удалось: ${error.message}. Повтори сброс перед следующим сообщением.`,
          });
          return false;
        } finally {
          const live = this._get(id) || s;
          live.sessionResetting = false;
          live.updatedAt = Date.now();
          sessionResetJobs.delete(id);
          this._persist();
        }
      })();
      sessionResetJobs.set(id, job);
      return job;
    },

    /**
     * Сжатие контекста: полноценный ход агента, поэтому идёт той же серверной очередью,
     * что и сообщения, и так же занимает индикатор хода. Итог применяет
     * applyCompactResult — он же подбирает сжатие, доехавшее через pending.
     */
    async compact(id) {
      const s = this._find(id);
      if (!s || s.compacting || s.sending || !s.sessionId) return;
      // Сообщение этого чата ещё доставляется: сжатие обогнало бы его в очереди сервера.
      if (Object.values(this.deliveries).some((d) => d.chatId === id && d.state !== 'lost')) {
        return;
      }
      const before = s.contextTokens || 0;
      s.compacting = true;
      s.error = null;
      // Пометка «сжатие затеяли здесь»: пока свой запрос не вернулся, ни `chat-done`,
      // ни сверка активных ходов заморозку не снимают — её снимет ответ ниже.
      compactInflight.add(id);
      try {
        const url = s.taskId ? `/api/tasks/${s.taskId}/compact` : '/api/chat/compact';
        const provStore = useProvidersStore();
        const resolvedModel = provStore.modelOf(selectedModel(s));
        const effortLevels = resolvedModel.model?.efforts || [];
        if (!resolvedModel.provider || !resolvedModel.model) throw new Error('Выбранная модель недоступна в реестре.');
        s.model = resolvedModel.id;
        s.modelRef = { provider: resolvedModel.provider.id, model: resolvedModel.model.id };
        await this._saveChatNow(s);
        await this.prepareWorkdirSend(s);

        const r = await api.post(url, {

          model: resolvedModel.id,
          modelRef: s.modelRef,

          effort: effortLevels.includes(s.effort) ? s.effort : '',

          mode: s.mode || '',
          sessionId: s.sessionId,
          chatKey: id,

          ...(this.workdirProtocol ? {
            workdir: s.workdir,
            workspaceKey: s.workdirPreview.workspaceKey,
          } : {}),

        });
        // Сжатие оборвали кнопкой «стоп»: ход вернулся обычным ответом, но контекст
        // остался прежним. Обнулить счётчик здесь значило бы соврать кольцу и человеку.
        if (r.stopped) {
          if (r.sessionReset) {
            clearSessionContext(s);
            s.sessionResetFailed = false;
            s.messages.push({ role: 'note', text: '⏹ Сжатие прервано — сессия Kimi сброшена, следующий ход начнётся с нуля.' });
          } else {
            s.messages.push({ role: 'note', text: '⏹ Сжатие прервано — контекст остался прежним.' });
          }
          return;
        }
        applyCompactResult(s, r, before);
      } catch (e) {
        if (e.data?.sessionReset) {
          clearSessionContext(s);
          s.sessionResetFailed = false;
        }
        if (e.data?.sessionResetFailed) s.sessionResetFailed = true;
        s.error = e.message;
        s.messages.push({ role: 'error', text: `Сжать контекст не удалось: ${e.message}` });
      } finally {
        compactInflight.delete(id);
        s.compacting = false;
        s.updatedAt = Date.now();
        this._persist();
      }
    },

    /**
     * Стоп работающего (или зависшего) агента: сервер убивает процесс CLI, ход
     * возвращается как обычный ответ «⏹ Ход остановлен» с уже показанной лентой.
     * Флаг sending снимет сам ответ запроса send(), поэтому здесь его не трогаем.
     */
    async stop(id) {
      const s = this._find(id);
      // Сжатие останавливается так же, как обычный ход: это тот же процесс CLI в activeRuns.
      if (!s?.sending && !s?.compacting) return;
      s.stopping = true;
      try { await api.post('/api/chat/stop', { chatKey: id }); } catch { /* ход мог уже кончиться */ }
    },

    async send(id, text, attachments = [], opts = {}) {
      let s = this._find(id); if (!s) return;
      if (!text.trim() && !attachments.length) return;
      const resetJob = sessionResetJobs.get(id);
      if (resetJob && !await resetJob) return false;
      // После отклонённого reset нельзя молча продолжить старую Kimi session: UI уже
      // обещал чистый разговор. Текст остаётся в поле ввода (см. ChatSession.submit).
      if (s.sessionResetFailed) return false;
      // Само открытие архивного разговора — только просмотр. Новое сообщение является
      // осознанным продолжением: перед durable save переносим тот же объект в активные,
      // чтобы запрос и последующие SSE уже однозначно относились к открытому чату.
      if (this.isArchived(id)) {
        this.restoreArchived(id);
        s = this._get(id);
        if (!s) return false;
      }
      // Служебный ход провайдерской слэш-команды (меню «/»): исполняется CLI локально,
      // автоназвание по её тексту не нужно — ни серверный хук, ни provisional-заголовок.
      const slashCommand = typeof opts.slashCommand === 'string' && opts.slashCommand.startsWith('/')
        ? opts.slashCommand
        : '';
      // Cockpit просит семантическое имя только в первом ходе безымянного чата.
      // Пока агент работает, мгновенно показываем локальный запасной вариант.
      const requestTitle = slashCommand ? false : shouldRequestChatTitle(s);
      const autoTitle = slashCommand ? '' : firstMessageTitle(s, text, attachments);
      if (autoTitle) s.title = autoTitle;
      // Писать во время хода МОЖНО: человек готовит следующее сообщение, пока агент работает.
      // Сервер выстроит ходы в очередь (см. modules/chat: два CLI на одну сессию не живут),
      // а здесь помечаем сообщение «ждёт очереди», чтобы было видно — оно принято, но ещё не в работе.
      const queued = !!s.sending;
      // Вложения в истории — только ссылки на серверные файлы (file/name/url/mime).
      const atts = attachments.map((a) => ({ file: a.file, name: a.name, url: a.url, mime: a.mime }));
      // Фиксируем именно момент отправки запроса. updatedAt всего чата для этого не
      // годится: он ещё несколько раз изменится, пока агент ответит и история сохранится.
      const sentAt = Date.now();
      // Сервер принимает ходы по turnId — короткий приём вместо POST на весь ход.
      if (this.turnProtocol === TURN_PROTOCOL) {
        return this._sendTurn(s, {
          text,
          atts,
          sentAt,
          queued,
          slashCommand,
          requestTitle,
        });
      }

      s.messages.push({
        role: 'user', text, sentAt,
        ...(atts.length ? { attachments: atts } : {}),
        ...(queued ? { queued: true } : {}),
      });
      // Счётчик незакрытых отправок: «думает…» гасим, только когда закончилась ПОСЛЕДНЯЯ,
      // иначе ответ первого хода снимал бы индикатор у ещё работающего второго.
      s.inflight = (s.inflight || 0) + 1;
      s.sending = true; s.error = null; s.offline = false;
      // лента предыдущего хода уже уехала в своё сообщение, а живой размер контекста
      // прошлого хода к новому отношения не имеет: до первого замера кольцо показывает
      // сохранённую цифру.
      if (!queued) {
        s.progressTokens = 0;
        s.progressTokensEstimate = false;
        // Ход начинается прямо сейчас, в этом окне: от этой отметки считается «сколько идёт».
        s.turnStartedAt = sentAt;
        s.steps = [];
        s.liveContext = 0;
        s.liveContextUsage = null;
        s.liveContextCache = null;
      }
      s.updatedAt = sentAt;
      // После сжатия «выжимкой» сессии ещё нет: агент увидит состояние работы первым
      // блоком этого сообщения. В переписку на экране блок не попадает — там уже есть и
      // вся история, и плашка о сжатии. Снимаем семя ДО запроса (иначе гонка со вторым
      // окном засеяла бы сессию дважды), при провале возвращаем на место.
      const seed = this.workdirProtocol ? '' : s.pendingSeed || '';
      if (seed) s.pendingSeed = '';
      // До этой границы любой сбой означает «агент точно НЕ стартовал». После начала
      // POST сетевой исход неоднозначен: сервер мог принять запрос и продолжить ход уже
      // без окна — только тогда уместна плашка offline и ожидание chats/pending.
      let modelRequestStarted = false;
      // Durable save выполняется ниже после разрешения modelRef и до запуска executor-а.
      try {
        const url = s.taskId ? `/api/tasks/${s.taskId}/chat` : '/api/chat';
        // Контекст страницы фиксируется здесь ровно один раз перед durable save/model POST.
        const context = useUiContextStore().capture(router.currentRoute.value).promptContext;
        // Модель: сохранённый алиас резолвим в конкретную (что показано в селекте, то и считает),
        // пустое значение — модель по умолчанию из реестра.
        const provStore = useProvidersStore();
        const resolvedModel = provStore.modelOf(selectedModel(s));
        const effortLevels = resolvedModel.model?.efforts || [];
        if (!resolvedModel.provider || !resolvedModel.model) throw new Error('Выбранная модель недоступна в реестре.');
        s.model = resolvedModel.id;
        s.modelRef = { provider: resolvedModel.provider.id, model: resolvedModel.model.id };
        // Пока реестр не сообщил уровни или старый выбор исчез из свежего каталога,
        // явный effort не отправляем: CLI применит собственный актуальный дефолт.
        const requestEffort = effortLevels.includes(s.effort) ? s.effort : '';
        await this._saveChatNow(s);
        await this.prepareWorkdirSend(s);
        modelRequestStarted = true;

        const r = await api.post(url, {

          ...(this.workdirProtocol ? {
            workdir: s.workdir, workspaceKey: s.workdirPreview?.workspaceKey,
          } : {}),

          message: withSeed(seed, text),

          model: resolvedModel.id,
          modelRef: s.modelRef,

          effort: requestEffort,

          mode: s.mode || '',

          sessionId: s.sessionId,
          context,
          chatKey: id,
          requestTitle,
          sentAt,

          ...(slashCommand ? { slashCommand } : {}),

          ...(atts.length ? { attachments: atts.map((a) => ({ file: a.file, name: a.name })) } : {}),

        });
        // Сервер вырезал служебный маркер из ответа и вернул готовое трёхсловное имя.
        // Ручное переименование, сделанное во время хода, не перетираем.
        if (requestTitle) applyGeneratedChatTitle(s, r.title, autoTitle);
        // Пустой id не затираем: у оборванного хода («стоп», лимит) его может не быть,
        // а прежняя сессия жива — иначе следующий вопрос уйдёт без --resume и агент
        // не вспомнит ничего из разговора.
        if (r.sessionReset) {
          if (seed && !s.pendingSeed) s.pendingSeed = seed;
          clearSessionContext(s);
          s.sessionResetFailed = false;
        } else {
          if (r.sessionId) s.sessionId = r.sessionId;
          applyContextUsage(s, r);
        }
        // Лента хода переезжает в сообщение (серверная копия полнее: SSE мог что-то не донести),
        // actualModel/effort — чем CLI отработал на самом деле (алиасы он резолвит сам).
        // Плашка note — подтверждение служебной команды без вывода: не ответ агента,
        // ленту шагов и подпись модели ей не приклеиваем.
        if (r.note) {
          s.messages.push({ role: 'note', text: r.reply });
        } else {
          const responseSteps = (r.steps?.length ? r.steps : s.steps) || [];

          applyAssistantFinal(s.messages, r, {
            // Сбой доставки (CLI не достучался до API) — не ответ агента: показываем
            // плашкой ошибки, но с лентой и сессией, чтобы ход можно было продолжить.
            role: r.deliveryFailure ? 'error' : 'assistant', text: r.reply || '(пусто)', cost: r.cost,
            steps: responseSteps,
            model: r.model || s.model, actualModel: r.actualModel || '',
            effort: Object.hasOwn(r, 'effort') ? (r.effort || '') : requestEffort,
            // Метка остановленного хода: по ней сервер соберёт досье для новой
            // Kimi-сессии, чтобы агент знал, что успел сделать оборванный ход.
            ...(r.stopped ? { stopped: true } : {}),
            // Прерван перезапуском сервера или обрывом CLI: по метке чат предложит продолжить ход.
            ...(r.interruptedBy ? { interruptedBy: r.interruptedBy } : {}),
          });
        }
        // Сервер мог подменить эффорт (модель не тянет выбранный уровень) — подтягиваем
        // слайдер под реальность, чтобы UI не врал. Пишем в сессию напрямую, НЕ через
        // setEffort: вынужденный откат не должен становиться дефолтом для новых чатов.
        if (r.effort && r.effort !== s.effort) s.effort = r.effort;
        s.steps = [];
        // Пользователь не смотрит на этот exact chat на зарегистрированной поверхности —
        // ставим метку «непрочитано» и показываем оповещение.
        this._notifyReply(s, r.reply || '(пусто)');
      } catch (e) {
        if (e.data?.sessionReset) {
          if (seed && !s.pendingSeed) s.pendingSeed = seed;
          clearSessionContext(s);
          s.sessionResetFailed = false;
        }
        if (e.data?.sessionResetFailed) s.sessionResetFailed = true;
        if (!e.data?.sessionReset) applyContextUsage(s, e.data);
        s.error = e.message;
        // Сетевой обрыв ПОСЛЕ начала model POST — не провал хода: сервер мог принять
        // запрос, агент живёт в его процессе, а ответ доедет через chats/pending.
        // Ошибка до POST (включая stale/CAS и сеть на durable save) однозначна: агент
        // не стартовал. Её показываем как обычную ошибку и не оставляем вечное «думает…».
        if (modelRequestStarted && isConnectionError(e)) s.offline = true;
        else {
          s.offline = false;
          // Упавший ход всё равно нёс работу: агент успел прочитать файлы и что-то
          // поправить, и это уже на диске. Раньше лента такого хода пропадала целиком
          // (сервер шлёт при ошибке только текст), и разобраться, докуда он дошёл,
          // было не по чему. Переносим в сообщение то, что доехало по SSE.
          const failedSteps = s.steps?.length ? [...s.steps] : [];
          s.messages.push({
            role: 'error',
            text: e.message,
            ...(failedSteps.length ? { steps: failedSteps } : {}),
          });
          s.steps = [];
        }
        // Ход не дошёл — выжимку возвращаем в ожидание, иначе повтор сообщения ушёл бы
        // в пустую сессию и агент потерял бы всё, что помнил до сжатия.
        if (seed && !s.pendingSeed) s.pendingSeed = seed;
      } finally {
        s.inflight = Math.max(0, (s.inflight || 1) - 1);
        // Ещё есть незакрытые отправки этого чата — ход продолжается, «думает…» не снимаем.
        // Оборванная связь — тоже не повод его снимать: агент работает дальше, а правду о
        // нём вернут SSE (`chat-done`) и сверка активных ходов при восстановлении связи.
        if (!s.inflight && !s.offline && !this.runtimeRuns[s.id]?.active) {
          s.sending = false; s.stopping = false;
          s.progressTokens = 0; s.progressTokensEstimate = false; s.turnStartedAt = 0;
        }
        s.updatedAt = Date.now(); this._persist();
      }
      return true;
    },

    /**
     * Отправка по протоколу приёма. Реплика уходит в историю вместе с turnId и отметкой
     * «приём не подтверждён» ДО запроса: F5 в любой момент оставляет честный след, по
     * которому окно сверится с сервером. Сам POST короткий — сервер подтверждает приём,
     * итог хода приходит через pending, а повтор тем же turnId исполнителя не будит.
     */
    async _sendTurn(s, {
      text, atts, sentAt, queued, slashCommand, requestTitle,
    }) {
      const turnId = newTurnId();
      const seed = this.workdirProtocol ? '' : s.pendingSeed || '';
      // Всё, без чего повтор после F5 не совпал бы с исходной отправкой, лежит у самой
      // реплики до подтверждения приёма и снимается вместе с отметкой доставки.
      const outbox = {
        ...(seed ? { seed } : {}),
        ...(slashCommand ? { slashCommand } : {}),
        ...(requestTitle ? { requestTitle: true } : {}),
      };
      const message = {
        role: 'user',
        text,
        sentAt,
        turnId,
        delivery: 'sending',
        ...(Object.keys(outbox).length ? { outbox } : {}),
        ...(atts.length ? { attachments: atts } : {}),
        ...(queued ? { queued: true } : {}),
      };
      // Выжимка уезжает вместе с репликой: второе окно её уже не возьмёт, а F5 до приёма
      // её не потеряет — повтор отправки возьмёт её из outbox.
      if (seed) {
        s.pendingSeed = '';
      }

      s.messages.push(message);
      s.error = null;
      s.offline = false;
      s.updatedAt = sentAt;
      this.deliveries[turnId] = deliveryOf(s.id, 'posting', 0);
      // Контекст страницы фиксируется один раз: автоматический повтор несёт тот же.
      outgoing.set(turnId, {
        context: useUiContextStore().capture(router.currentRoute.value).promptContext,
      });

      try {
        // Модель: что показано в селекте, то и считает; пустое значение — модель по
        // умолчанию из реестра. Сохраняется в чат ДО durable save.
        const resolvedModel = useProvidersStore().modelOf(selectedModel(s));

        if (!resolvedModel.provider || !resolvedModel.model) {
          throw new Error('Выбранная модель недоступна в реестре.');
        }

        s.model = resolvedModel.id;
        s.modelRef = { provider: resolvedModel.provider.id, model: resolvedModel.model.id };
        await this._saveChatNow(s);
        await this.prepareWorkdirSend(s, message);
      } catch (e) {
        // Реплика не записана или модель не разрешилась — агент точно не стартовал.
        this._refuseTurn(s, message, e);

        return true;
      }

      await this._deliverTurn(s.id, turnId);

      return true;
    },
    /**
     * Тело POST приёма по реплике — и для первой попытки, и для повтора после F5. Текст,
     * выжимка, слэш-команда и вложения берутся у самой реплики, модель и режим — у чата.
     */
    _turnRequest(s, m) {
      const resolvedModel = useProvidersStore().modelOf(selectedModel(s));

      if (!resolvedModel.provider || !resolvedModel.model) {
        throw new Error('Выбранная модель недоступна в реестре.');
      }
      // Пока реестр не сообщил уровни или старый выбор исчез из свежего каталога,
      // явный effort не отправляем: CLI применит собственный актуальный дефолт.
      const effortLevels = resolvedModel.model?.efforts || [];
      const context = outgoing.get(m.turnId)?.context
        || useUiContextStore().capture(router.currentRoute.value).promptContext;

      return {
        url: (Object.hasOwn(m.outbox || {}, 'taskId') ? m.outbox.taskId : s.taskId)
          ? `/api/tasks/${Object.hasOwn(m.outbox || {}, 'taskId') ? m.outbox.taskId : s.taskId}/chat`
          : '/api/chat',
        body: {
          ...(m.outbox?.workspaceKey ? {
            workspaceKey: m.outbox.workspaceKey, workdir: m.outbox.workdir,
          } : {}),
          message: withSeed(m.outbox?.seed || '', m.text),
          model: resolvedModel.id,
          modelRef: { provider: resolvedModel.provider.id, model: resolvedModel.model.id },
          effort: effortLevels.includes(s.effort) ? s.effort : '',
          mode: s.mode || '',
          sessionId: s.sessionId,
          context,
          chatKey: s.id,
          requestTitle: !!m.outbox?.requestTitle,
          sentAt: m.sentAt,
          turnId: m.turnId,
          ...(m.outbox?.slashCommand ? { slashCommand: m.outbox.slashCommand } : {}),
          ...(m.attachments?.length
            ? { attachments: m.attachments.map((a) => ({ file: a.file, name: a.name })) }
            : {}),
        },
      };
    },
    /**
     * Одна попытка доставить приём хода. Однозначных исходов два: сервер подтвердил приём
     * (в том числе повтор — duplicate) или явно отказал. Обрыв и таймаут неоднозначны:
     * запрос мог дойти, поэтому повторяем ТЕМ ЖЕ turnId — старый POST вслепую не шлём.
     */
    async _deliverTurn(chatId, turnId) {
      clearTimeout(redeliveryTimers.get(turnId));
      redeliveryTimers.delete(turnId);

      const s = this._find(chatId);
      const m = (s?.messages || []).find((x) => x.role === 'user' && x.turnId === turnId);

      if (!s || !m || m.delivery !== 'sending') {
        this._forgetDelivery(turnId);

        return 'settled';
      }
      if (postingTurns.has(turnId)) {
        return 'posting';
      }

      const attempt = (this.deliveries[turnId]?.attempt || 0) + 1;

      this.deliveries[turnId] = deliveryOf(chatId, 'posting', attempt);

      let request;

      try {
        request = this._turnRequest(s, m);
      } catch (e) {
        this._refuseTurn(s, m, e);

        return 'refused';
      }

      postingTurns.add(turnId);

      try {
        const r = await api.post(request.url, request.body, { timeoutMs: ACCEPT_TIMEOUT_MS });

        postingTurns.delete(turnId);
        this._markAccepted(s, m, r);

        return 'accepted';
      } catch (e) {
        postingTurns.delete(turnId);

        if (isConnectionError(e)) {
          this._scheduleRedelivery(chatId, turnId, attempt);

          return 'retrying';
        }

        this._refuseTurn(s, m, e);

        return 'refused';
      }
    },
    /**
     * Сервер подтвердил приём. started — ход пошёл сразу, queued — ждёт очереди чата,
     * running/done — это повтор уже принятого хода (итог придёт или уже лежит в pending).
     */
    _markAccepted(s, m, r) {
      const state = String(r?.state || '');
      // Ответ на приём и события SSE идут разными соединениями. Если сервер уже сообщил о
      // ходе (старт, конец, итог), отметку доставки сняли они, и живым состоянием дальше
      // управляют события: запоздавший ответ не вернёт «думает…» законченному ходу.
      const observed = m.delivery !== 'sending';

      this._settleTurnMessage(s, m.turnId);

      if (observed) {
        return;
      }
      if (state === 'queued') {
        m.queued = true;
      } else {
        delete m.queued;
      }
      if (state === 'done') {
        // Ход закончился, пока окно не знало о приёме: ответ ждёт в pending.
        this._collectPending();
      } else {
        s.sending = true;
        // Строку хода начинаем здесь: chat-turn-start сюда ещё не дошёл.
        if (state === 'started') {
          s.progressTokens = 0;
          s.progressTokensEstimate = false;
          s.turnStartedAt = Date.now();
          s.steps = [];
          s.liveContext = 0;
          s.liveContextUsage = null;
          s.liveContextCache = null;
        }
      }

      s.updatedAt = Date.now();
      this._persist();
    },
    /**
     * Сервер явно отказал (или отправка не дошла до записи истории): агент точно не
     * стартовал. Реплика остаётся с ошибкой рядом, выжимка возвращается в ожидание.
     */
    _refuseTurn(s, m, e) {
      const seed = m.outbox?.seed || '';

      this._forgetDelivery(m.turnId);
      delete m.delivery;
      delete m.outbox;
      delete m.queued;

      if (seed && !s.pendingSeed) {
        s.pendingSeed = seed;
      }
      if (e?.data?.sessionReset) {
        clearSessionContext(s);
        s.sessionResetFailed = false;
      }
      if (e?.data?.sessionResetFailed) {
        s.sessionResetFailed = true;
      }

      s.error = e?.message || 'Сервер не принял сообщение';
      s.messages.push({ role: 'error', text: s.error });
      s.updatedAt = Date.now();
      this._persist();
    },
    /**
     * Следующая автоматическая попытка того же turnId. Паузы растут до 15 с; когда они
     * кончились, реплика становится «не доставлено» и ждёт кнопки или связи (hello).
     */
    _scheduleRedelivery(chatId, turnId, attempt) {
      const delay = REDELIVERY_DELAYS_MS[attempt - 1];

      if (delay === undefined) {
        this.deliveries[turnId] = deliveryOf(chatId, 'lost', attempt);

        return;
      }

      this.deliveries[turnId] = deliveryOf(chatId, 'retrying', attempt);

      const timer = setTimeout(() => {
        this._deliverTurn(chatId, turnId);
      }, delay);

      timer?.unref?.();
      redeliveryTimers.set(turnId, timer);
    },
    /**
     * Приём хода подтверждён любым путём (ответ на POST, chat-turn-start, журнал сервера,
     * итог в pending): снимаем с реплики отметку доставки и то, что ждало повтора.
     */
    _settleTurnMessage(s, turnId, { finished = false } = {}) {
      this._forgetDelivery(turnId);

      const m = (s?.messages || []).find((x) => x.role === 'user' && x.turnId === turnId);
      // Итог хода (даже отказ из очереди при остановке сервера) снимает и «ждёт очереди».
      const queued = finished && !!m?.queued;

      if (!m?.delivery && !m?.outbox && !queued) {
        return;
      }

      delete m.delivery;
      delete m.outbox;

      if (queued) {
        delete m.queued;
      }

      this._persist();
    },
    /**
     * Забыть доставку в этом окне: таймер повтора, контекст отправки и строку состояния.
     * Отметку `delivery` у самой реплики не трогает — её снимает только подтверждение.
     */
    _forgetDelivery(turnId) {
      clearTimeout(redeliveryTimers.get(turnId));
      redeliveryTimers.delete(turnId);
      outgoing.delete(turnId);

      if (this.deliveries[turnId]) {
        delete this.deliveries[turnId];
      }
    },
    /**
     * «Отправить ещё раз» у реплики, приём которой сервер не подтвердил. Тот же turnId:
     * если прежний запрос всё-таки дошёл, сервер узнает его и второго запуска не будет.
     */
    async retryDelivery(chatId, turnId) {
      const s = this._find(chatId);
      const m = (s?.messages || []).find((x) => x.role === 'user' && x.turnId === turnId);

      if (!m || m.delivery !== 'sending' || postingTurns.has(turnId)) {
        return false;
      }
      if (this.deliveries[turnId]) {
        delete this.deliveries[turnId];
      }

      return (await this._deliverTurn(chatId, turnId)) === 'accepted';
    },
    /**
     * Реплики с неподтверждённым приёмом, которые не отправляет это окно (F5, другое
     * устройство, долгий обрыв): сверяем с журналом сервера. Известный ход — снимаем
     * отметку; неизвестный — «не доставлено» с кнопкой повтора того же turnId.
     */
    async _reconcileDeliveries() {
      if (this.turnProtocol !== TURN_PROTOCOL) {
        return;
      }

      const open = [];

      for (const s of [...this.sessions, ...(this.archived || [])]) {
        for (const m of s.messages || []) {
          if (m?.role !== 'user' || !m.turnId || m.delivery !== 'sending') {
            continue;
          }
          if (postingTurns.has(m.turnId) || redeliveryTimers.has(m.turnId)) {
            continue;
          }
          // Ответ уже в переписке — ход точно был принят.
          if ((s.messages || []).some((x) => x.pid === m.turnId)) {
            this._settleTurnMessage(s, m.turnId);
            continue;
          }

          open.push({ s, m });
        }
      }
      for (let index = 0; index < open.length; index += TURN_STATUS_BATCH) {
        const batch = open.slice(index, index + TURN_STATUS_BATCH);
        let turns;

        try {
          ({ turns } = await api.get(`/api/chat/turns?ids=${batch.map(({ m }) => m.turnId).join(',')}`));
        } catch {
          return;
        }

        for (const { s, m } of batch) {
          // За время запроса реплику могли подтвердить или начать повтор.
          if (m.delivery !== 'sending' || postingTurns.has(m.turnId)) {
            continue;
          }

          const known = turns?.[m.turnId];

          if (known?.state === 'accepting') {
            continue;
          }
          if (known) {
            this._settleTurnMessage(s, m.turnId);
            continue;
          }

          this.deliveries[m.turnId] = deliveryOf(s.id, 'lost', this.deliveries[m.turnId]?.attempt || 0);
        }
      }
    },
    /**
     * Связь вернулась: свои повторы доставки уходят сразу, не дожидаясь таймера. Свои —
     * это отправленные из этого окна; чужие «не доставлено» ждут кнопки человека.
     */
    _redeliverNow() {
      for (const [turnId, delivery] of Object.entries(this.deliveries)) {
        const own = outgoing.has(turnId);

        if (delivery.state === 'retrying' || (delivery.state === 'lost' && own)) {
          this._deliverTurn(delivery.chatId, turnId);
        }
      }
    },
    /**
     * Восстановление связи. Порядок существенен: сначала история (за время разрыва мог
     * появиться сам чат), затем pending (ответ кладётся в известный чат и пишется в
     * историю до подтверждения), затем живые ходы и сверка неподтверждённых отправок;
     * свои повторы доставки уходят сразу. Повторный hello во время прохода — ещё проход.
     */
    _afterReconnect() {
      if (reconnectJob) {
        reconnectAgain = true;

        return reconnectJob;
      }

      reconnectJob = (async () => {
        do {
          reconnectAgain = false;

          if (Date.now() - storeSyncedAt > 2000) {
            await this._resyncStore();
          }

          await this._collectPending();
          await this._loadActive();
          await this._reconcileDeliveries();
          this._redeliverNow();
        } while (reconnectAgain);
      })().finally(() => {
        reconnectJob = null;
      });

      return reconnectJob;
    },
  },
});
