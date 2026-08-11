// Чат с агентами — МУЛЬТИСЕССИИ (вкладки, как в VS Code).
// Каждая сессия: своя задача (опционально), модель, усилие, история, sessionId (--resume),
// размер контекста. История хранится НА СЕРВЕРЕ (файл в .state кокпита) — общая для всех
// окон/устройств и переживает чистку браузера. Один стор питает и плавающую панель
// (ChatPanel), и страницу «Агенты» (AgentsView) — компоненты переиспользуются.
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';
import { router } from '../router.js';
import { useUiContextStore } from './ui-context.js';
import { useProvidersStore } from './providers.js';
import { notify } from '../shared/notify.js';
import { sseSubscribe } from '../composables/useSse.js';
import { mdToText } from '../shared/md.js';
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
const sentChats = new Map();
let sentMeta = '';
let saveWarned = false;

// Перед model POST чат сохраняется с CAS-revision. Другое окно может успеть записать
// черновик/ответ между нашим чтением и PUT — сервер сольёт историю, вернёт свежую
// revision и stale=true. Повторяем только безопасный PUT, сам ход агента здесь ещё
// не начинался. Бесконечно спорить с постоянно пишущим окном нельзя.
const CHAT_SAVE_ATTEMPTS = 3;

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

// Явный reset Kimi меняет server-owned binding и потому является асинхронным.
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

// Рантайм-поля чата: живут только в окне и на сервер не едут (см. slimOf). При замене
// чата серверной копией их надо сохранить — иначе принятое чужое изменение погасило бы
// «думает…»/кольцо и стёрло ленту шагов идущего прямо сейчас хода.
const RUNTIME_KEYS = [
  'sending', 'compacting', 'stopping', 'progressTokens', 'steps', 'error', 'inflight', 'offline',
  'sessionResetting', 'sessionResetFailed', 'liveContext',
];
function runtimeOf(s) {
  const out = {};
  for (const k of RUNTIME_KEYS) if (s?.[k] !== undefined) out[k] = s[k];
  return out;
}

// Порядок чатов в сторе — как у сервера (по времени создания): иначе вкладки прыгали бы
// в зависимости от того, каким путём чат попал в окно — загрузкой или досинхронизацией.
function insertByCreated(list, chat) {
  const at = chat.createdAt || 0;
  const i = list.findIndex((c) => (c.createdAt || 0) > at);
  if (i < 0) list.push(chat); else list.splice(i, 0, chat);
}

// Чат в том виде, в каком он едет на сервер: без рантайм-полей (sending/error/steps).
function slimOf(s) {
  return {
    id: s.id, taskId: s.taskId, title: s.title, model: s.model, modelRef: s.modelRef || null,
    // Служебные рабочие чаты (например Debug) остаются обычными пользовательскими
    // чатами, но эта устойчивая метка позволяет повторной кнопке открыть тот же
    // разговор вместо размножения сессий. По заголовку связывать нельзя — он редактируемый.
    purpose: s.purpose || '', sourceChatId: s.sourceChatId || null,
    schema: s.schema, surface: s.surface, revision: s.revision,
    effort: s.effort, mode: s.mode || '',
    messages: s.messages, sessionId: s.sessionId, contextTokens: s.contextTokens,
    contextWindow: s.contextWindow || 0, contextMetric: s.contextMetric || '',
    contextIsEstimate: !!s.contextIsEstimate,
    totalInputTokens: s.totalInputTokens || 0, cachedInputTokens: s.cachedInputTokens || 0,
    // Выжимка после сжатия у исполнителя без родного компакта: ждёт следующего
    // сообщения, чтобы уехать первой в новую сессию. Обязана переживать F5 — иначе
    // сжатие превратилось бы в потерю памяти агента.
    pendingSeed: s.pendingSeed || '',
    compactedAt: s.compactedAt || 0,
    draft: s.draft || '', unread: !!s.unread, createdAt: s.createdAt, updatedAt: s.updatedAt,
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
 * Шаги заменены своим числом: они append-only и появляются вместе с сообщением, которому
 * принадлежат, поэтому счётчика достаточно, а сериализовать мегабайты не нужно. Полный
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
}

function selectedModel(session) {
  return session?.modelRef || session?.model || '';
}

const CODEX_CONTEXT_METRIC = 'active-input-v1';

function metricNumber(value, { positive = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (positive && number <= 0)) return null;
  return number;
}

function isCodexChat(session) {
  return session?.modelRef?.provider === 'codex'
    || /^(?:gpt-|codex-)/i.test(String(session?.model || ''));
}

/** Одна точка применения метрик: обычный ответ и orphan после обрыва не расходятся. */
function applyContextUsage(session, payload) {
  if (!session || !payload) return;
  const metric = typeof payload.contextMetric === 'string' ? payload.contextMetric : '';
  const context = metricNumber(payload.contextTokens);
  // Ноль осмыслен только с новым контрактом: это честное «после компакта/нет запроса».
  if (context !== null && (context > 0 || metric)) session.contextTokens = context;
  const window = metricNumber(payload.contextWindow, { positive: true });
  if (window !== null) session.contextWindow = window;
  if (metric) session.contextMetric = metric;
  if (Object.hasOwn(payload, 'contextIsEstimate')) {
    session.contextIsEstimate = !!payload.contextIsEstimate;
  }
  const total = metricNumber(payload.totalInputTokens);
  if (total !== null) session.totalInputTokens = total;
  const cached = metricNumber(payload.cachedInputTokens);
  if (cached !== null) session.cachedInputTokens = cached;
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
function snapshotPayload(payload) {
  return {
    ...payload,
    sessions: (payload.sessions || []).map(stripSteps),
    archived: (payload.archived || []).map(stripSteps),
  };
}

function writeSnapshot(payload) {
  const slim = snapshotPayload(payload);
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify(slim));
  } catch {
    // Не влезло — оставляем последние чаты целиком. По СООБЩЕНИЯМ резать бесполезно:
    // типичная история короче такого лимита, поэтому прежний `slice(-30)` почти не
    // уменьшал снимок и вторая попытка падала ровно там же, где первая.
    try {
      const recent = [...(slim.sessions || [])]
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, SNAP_FALLBACK_CHATS);
      localStorage.setItem(SNAP_KEY, JSON.stringify({ ...slim, sessions: recent, archived: [] }));
    } catch { /* localStorage недоступен — работаем без страховки */ }
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
  state: () => ({
    ...pickStore(null), loaded: false, open: false, conveyorIds: [], pending: {}, saveError: null,
    compactWindow: 0, speech: normalizeSpeechSnapshot(null),
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
    isArchived: (s) => (id) => (s.archived || []).some((x) => x.id === id),
    // Заголовок вкладки: название задачи → #номер → «Новый чат».
    tabLabel: () => (sess) => sess.title || (sess.taskId ? `#${sess.taskId}` : 'Новый чат'),
    isOnConveyor: (s) => (taskId) => !!taskId && s.conveyorIds.includes(String(taskId)),
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
        } else if (msgs.length) {
          const last = msgs[msgs.length - 1];
          snippet = (last.role === 'user' ? 'Ты: ' : last.role === 'error' ? '⚠ ' : '') + last.text;
        }
        return {
          id: sess.id, title, snippet: mdToText(snippet), archived,
          draft: !t && !!(sess.draft || '').trim(),
          // Модель чата — для иконки исполнителя и подписи в строке списка.
          model: sess.model || sess.modelRef?.model || '',
          modelRef: sess.modelRef || null,
          // Сжатие для списка — такая же занятость чата, как обычный ход: строке нужен
          // тот же живой аватар, отличается только подсказка.
          taskId: sess.taskId, sending: !!sess.sending || !!sess.compacting,
          compacting: !!sess.compacting, unread: !!sess.unread,
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
    // Загрузка истории с сервера (однократно). Если серверный файл пуст, а в localStorage
    // осталась история со старой схемы хранения — мигрируем её и чистим браузер.
    async _load() {
      if (this.loaded) return;
      if (!loadPromise) {
        loadPromise = (async () => {
          let j = null;
          try { j = await api.get('/api/chat/store'); } catch { j = null; }
          // Порог сжатия читаем из ответа сервера СРАЗУ — до возможной подмены снимком:
          // снимок в браузере хранит только историю, настроек в нём нет.
          this.compactWindow = Math.max(0, Number(j?.compactWindow) || 0);
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
          if (restored) this._persist(true);
          else this._markSent();
          // Ответы, доехавшие пока страница была закрыта/перезагружалась.
          await this._collectPending();
          // Спросы агентов, висящие прямо сейчас: после F5 их некому было показать.
          await this._loadWaiting();
          // Агенты, работающие прямо сейчас: восстанавливаем «думает…» после F5.
          await this._loadActive();
        })();
      }
      await loadPromise;
    },
    // Недоставленные ответы (chats/pending на сервере): раскладываем по чатам,
    // dedup по pid в сообщении, подтверждаем удалением.
    async _collectPending() {
      let j = null;
      try { j = await api.get('/api/chat/pending'); } catch { return; }
      if (!j?.pending?.length) return;
      for (const p of j.pending) {
        const s = this._find(p.chatKey);
        // Ответ мог прийти после F5: применяем семантическое имя, только если человек
        // не заменил временный заголовок вручную, пока агент работал.
        if (s && p.title) {
          const provisional = provisionalChatTitle(p.userText, { hasAttachments: !!p.hadAttachments });
          applyGeneratedChatTitle(s, p.title, provisional);
        }
        if (s && !(s.messages || []).some((m) => m.pid === p.id)) {
          // Гонка last-write-wins могла затереть сам вопрос — восстанавливаем его перед ответом.
          if (p.userText && !(s.messages || []).slice(-12).some((m) => m.role === 'user' && m.text === p.userText)) {
            const sentAt = messageSentAt(p.userSentAt);
            s.messages.push({
              role: 'user', text: p.userText, pid: `${p.id}:u`,
              ...(sentAt ? { sentAt } : {}),
            });
          }
          s.messages.push({
            role: p.role || 'assistant', text: p.reply || '(пусто)', cost: p.cost ?? null, pid: p.id,
            steps: p.steps || [], model: p.model || '', actualModel: p.actualModel || '', effort: p.effort || '',
            // Как и в send(): остановленный ход помечаем для серверного досье.
            ...(p.stopped ? { stopped: true } : {}),
          });
          if (p.sessionReset) {
            clearSessionContext(s);
            s.sessionResetFailed = false;
          } else {
            if (p.sessionId) s.sessionId = p.sessionId;
            applyContextUsage(s, p);
            if (p.sessionResetFailed) s.sessionResetFailed = true;
          }
          // Как и в send(): слайдер под реальный эффорт, дефолт новых чатов не трогаем.
          if (p.effort && p.effort !== s.effort) s.effort = p.effort;
          // Ответ доехал, пока мы смотрели в другое место — чат становится непрочитанным.
          s.sending = false;
          // Ответ оборванного хода забран — плашка «связь прервалась» своё отслужила.
          s.offline = false;
          s.updatedAt = p.at || Date.now();
          this._notifyReply(s, p.reply || '(пусто)', `${p.chatKey}:pid:${p.id}`);
        }
        api.del(`/api/chat/pending/${p.id}`).catch(() => { /* подберём в следующий раз */ });
      }
      this._persist();
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
      const write = () => {
        const slim = this.sessions.map(slimOf);
        const archivedSlim = (this.archived || []).map(archivedSlimOf);
        const payload = {
          sessions: slim, archived: archivedSlim, activeId: this.activeId,
          defModel: this.defModel, defModelRef: this.defModelRef,
          defEffort: this.defEffort, defMode: this.defMode,
        };
        // Страховочный снимок в браузере: переживает падение и перезапуск сервера.
        // Без него ответ, пришедший последним, терялся насовсем — «следующего изменения»,
        // на котором он бы сохранился, могло и не быть.
        if (needSnapshot) {
          writeSnapshot(payload);
          needSnapshot = false;
        }
        // Каждый чат — свой запрос, и только если он реально изменился.
        const jobs = [];
        const alive = new Set();
        const push = (c, archived) => {
          if (!c?.id) return;
          alive.add(c.id);
          const mark = fingerprintOf(c);
          if (sentChats.get(c.id) === mark) return;
          jobs.push(api.put('/api/chat/store/chat', { chat: c, archived, origin: WINDOW_ID })
            .then((response) => {
              const live = this._find(c.id);
              applySaveAck(live, response);
              const acknowledged = { ...c };
              applySaveAck(acknowledged, response);
              sentChats.set(c.id, fingerprintOf(acknowledged));
            }));
        };
        slim.forEach((c) => push(c, false));
        archivedSlim.forEach((c) => push(c, true));
        // Чат исчез из стора (удалили, вытеснили из архива) — убираем и на сервере.
        for (const id of [...sentChats.keys()]) {
          if (alive.has(id)) continue;
          jobs.push(api.del(`/api/chat/store/chat/${id}?origin=${WINDOW_ID}`)
            .then(() => { sentChats.delete(id); }));
        }
        const meta = {
          activeId: this.activeId,
          defModel: this.defModel,
          defModelRef: this.defModelRef,
          defEffort: this.defEffort,
          defMode: this.defMode,
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
     */
    async _saveChatNow(session) {
      if (!session?.id) throw new Error('чат не выбран');
      clearTimeout(persistTimer);
      const archived = (this.archived || []).some((item) => item.id === session.id);
      // Именно эту модель человек видел в отправляющем окне. stale-ack сообщает
      // server-owned модель чужой ревизии; принять её и продолжить означало бы
      // незаметно запустить не того исполнителя. На повторном CAS сохраняем свой выбор.
      const intendedModel = session.model;
      const intendedModelRef = session.modelRef ? { ...session.modelRef } : session.modelRef;
      for (let attempt = 0; attempt < CHAT_SAVE_ATTEMPTS; attempt += 1) {
        const snapshot = archived ? archivedSlimOf(session) : slimOf(session);
        const response = await api.put('/api/chat/store/chat', {
          chat: snapshot,
          archived,
          origin: WINDOW_ID,
        });
        applySaveAck(session, response);
        if (response?.stale) {
          // revision из ack — новая CAS-база. Сервер уже слил сообщения, поэтому
          // повтор того же снимка их не удалит (mergeChat восстановит серверный хвост).
          session.model = intendedModel;
          session.modelRef = intendedModelRef ? { ...intendedModelRef } : intendedModelRef;
          if (attempt + 1 < CHAT_SAVE_ATTEMPTS) continue;
          throw chatRevisionConflict();
        }
        const acknowledged = { ...snapshot };
        applySaveAck(acknowledged, response);
        sentChats.set(session.id, fingerprintOf(acknowledged));
        return response;
      }
      throw chatRevisionConflict();
    },
    /**
     * Стор совпал с серверным — запоминаем слепки, чтобы первое же сохранение
     * не гнало всю историю заново.
     */
    _markSent() {
      sentChats.clear();
      this.sessions.forEach((s) => sentChats.set(s.id, fingerprintOf(slimOf(s))));
      (this.archived || []).forEach((c) => sentChats.set(c.id, fingerprintOf(archivedSlimOf(c))));
      sentMeta = JSON.stringify({
        activeId: this.activeId, defModel: this.defModel, defModelRef: this.defModelRef,
        defEffort: this.defEffort, defMode: this.defMode,
      });
    },
    /**
     * История не сохраняется. Раньше клиент ретраил молча, и человек узнавал о потере
     * только после перезагрузки страницы — уже пустой. Поэтому о беде сообщаем —
     * но РОВНО ОДИН РАЗ, оповещением, пока не восстановится: постоянная плашка в чате
     * ходила за человеком по всем чатам и превращалась в шум.
     */
    _saveFailed(bad, msg = '') {
      if (!bad) { this.saveError = null; saveWarned = false; return; }
      this.saveError = msg || 'сервер не принял запись';
      if (saveWarned) return;
      saveWarned = true;
      notify('История чата не сохраняется', `${this.saveError}. Не закрывай вкладку — идут повторные попытки.`, 'chat-save-error');
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
        s.pendingSeed ??= '';
        s.compactedAt ??= 0;
        s.compacting = false;
        s.sessionResetting = false;
        s.sessionResetFailed ??= false;
      }
      return list;
    },
    /**
     * Смотрим ли прямо сейчас именно на этот чат: вкладка ОС активна, открыт раздел
     * «Чаты» или плавающая панель, и это активный чат. Одно правило и для оповещения,
     * и для метки «непрочитано» — чтобы бейдж не спорил с уведомлением.
     */
    _visible(id) {
      return !document.hidden
        && (router.currentRoute.value.path === '/chats' || this.open)
        && this.activeId === id;
    },
    // Чат увидели — гасим метку. Зовёт открытый на экране ChatSession.
    markRead(id) {
      const s = this._get(id) || this.archived.find((x) => x.id === id);
      if (!s?.unread) return;
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
      notify(`Агент ответил — ${this.tabLabel(s)}`, String(text || '').slice(0, 120), `chat-${s.id}`);
      return true;
    },

    newSession(opts = {}) {
      const s = {
        id: uid(), taskId: opts.taskId ? String(opts.taskId) : null, title: opts.title || '',
        purpose: opts.purpose || '', sourceChatId: opts.sourceChatId || null,
        // Пустая модель = «по умолчанию»: конкретный id подставится из реестра при показе
        // и отправке. Фиксировать здесь нельзя — реестр к этому моменту может не загрузиться.
        model: this.defModel, modelRef: this.defModelRef, effort: this.defEffort, mode: this.defMode,
        schema: 2, revision: 0,
        createdAt: Date.now(), updatedAt: Date.now(),
        messages: [], sessionId: null, contextTokens: 0, contextWindow: 0,
        contextMetric: '', contextIsEstimate: false, totalInputTokens: 0, cachedInputTokens: 0,
        sending: false, error: null, draft: opts.draft || '', pendingSeed: '', compactedAt: 0,
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
          if (d.chatKey && permAutoAllow[d.chatKey]?.has(d.tool)) {
            api.post(`/api/chat/permission/${d.pid}`, { allow: true }).catch(() => {});
            return;
          }
          this._addPending({ ...d, kind: 'perm' });
        } else if (name === 'chat-question') {
          // Вопрос агента (AskUserQuestion): не разрешение, а диалог с вариантами ответа.
          this._addPending({ ...d, kind: 'question' });
        } else if (name === 'chat-permission-done') {
          delete this.pending[d.pid];
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
            this._loadActive();
            this._resyncSpeech();
            if (Date.now() - storeSyncedAt > 2000) this._resyncStore();
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
        } else if (name === 'speech-settings') {
          // Настройка общая для всех окон/устройств. Revision позволяет компоненту
          // отличить реальную смену от собственного SSE-эха, но snapshot применяем весь.
          this.setSpeechSnapshot(d);
        } else if (name === 'chat-step') {
          // Шаг хода агента (инструмент/размышление/результат) — живая лента в чате.
          const s = this._find(d.chatKey);
          if (s && d.step) {
            const steps = (s.steps ||= []);
            steps.push(d.step);
            if (steps.length > MAX_STEPS) steps.splice(0, steps.length - MAX_STEPS);
          }
        } else if (name === 'chat-orphan') {
          // Ответ остался без адресата (то окно умерло) — подбираем в этом окне.
          this._collectPending();
        } else if (name === 'chat-progress') {
          // Живой прогресс «думает… · N ток.». Прогресс = агент точно работает:
          // восстанавливаем и sending (окно могло перезагрузиться посреди хода).
          // Кроме сжатия: там работу показывает кольцо, а «думает…» только спорило бы с ним.
          const s = this._find(d.chatKey);
          if (s && !s.compacting) {
            s.sending = true; s.progressTokens = d.tokens;
            // Заполненность контекста ПРЯМО СЕЙЧАС (её сообщает не каждый исполнитель).
            // В историю не пишем: это рантайм-поле, а иначе каждое обращение к модели
            // стоило бы записи всего чата на сервер (см. slimOf и дебаунс _persist).
            if (d.contextTokens) s.liveContext = d.contextTokens;
          }
        } else if (name === 'chat-turn-start') {
          // Со дна очереди пошёл следующий ход: снимаем «ждёт очереди» с самого раннего
          // ожидающего сообщения — теперь оно в работе, а не в списке ожидания.
          const s = this._find(d.chatKey);
          // Чат завели в другом окне и сразу отправили — его копия к нам ещё едет.
          // Тянем сейчас, чтобы разговор появился с работающим агентом, а не после F5.
          if (!s) { this._pullChat(d.chatKey, false); return; }
          const m = (s.messages || []).find((x) => x.queued);
          if (m) delete m.queued;
          // Сжатие — служебный ход: во ВСЕХ окнах это вертящееся кольцо и заморозка ввода,
          // а не «думает…». Раньше признак жил только в затеявшем окне, и на втором
          // устройстве сжатие не отображалось ничем.
          if (d.compact) { s.compacting = true; s.sending = false; s.progressTokens = 0; }
          else { s.sending = true; s.steps = []; s.progressTokens = 0; s.liveContext = 0; }
        } else if (name === 'chat-done') {
          // Ход завершён — снять «думает…»/кольцо во всех окнах (ответ доставляется
          // ожидавшему окну или через pending). Но если из этого окна ушли ещё сообщения
          // и они ждут очереди, агент продолжит работу: индикатор оставляем.
          const s = this._find(d.chatKey);
          // Событие дошло — связь с сервером есть, даже если рвался длинный POST хода.
          if (s?.offline) s.offline = false;
          if (s && !s.inflight) { s.sending = false; s.stopping = false; s.progressTokens = 0; }
          // Своё сжатие разморозит его собственный ответ (он ещё едет и правит счётчики);
          // чужому окну ждать нечего — снимаем кольцо здесь.
          if (s && !compactInflight.has(s.id)) s.compacting = false;
        }
      });
    },
    /**
     * Новый спрос агента. Оповещаем, если на этот чат сейчас не смотрят: агент СТОИТ,
     * пока не ответят, — пропустить такое дороже, чем пропустить обычный ответ.
     */
    _addPending(req) {
      this.pending[req.pid] = req;
      if (this._visible(req.chatKey)) return;
      const s = this._find(req.chatKey);
      const who = s ? this.tabLabel(s) : 'чат';
      const what = req.kind === 'question'
        ? (req.questions?.[0]?.question || 'Агент задал вопрос')
        : `Агент просит разрешение: ${req.tool || 'действие'}`;
      notify(`Нужен твой ответ — ${who}`, what.slice(0, 120), `chat-ask-${req.chatKey || req.pid}`);
    },
    /**
     * Спросы, которые уже висели: SSE доставляет событие один раз, поэтому после F5
     * (и во втором окне) поднимаем их отдельным запросом — иначе агент ждёт ответа,
     * а показать его некому.
     */
    async _loadWaiting() {
      let waiting;
      try { ({ waiting } = await api.get('/api/chat/waiting')); }
      catch { return; /* сервер старый/недоступен — обойдёмся SSE */ }
      // Сверяемся ПОЛНОСТЬЮ, а не дозаливаем: после рестарта сервера запросы умирают
      // вместе с процессами агентов, и наши всплывашки стали бы фантомами.
      const fresh = {};
      for (const w of waiting || []) {
        fresh[w.pid] = this.pending[w.pid] || { ...w, kind: w.questions ? 'question' : 'perm' };
      }
      this.pending = fresh;
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
      let active;
      try { ({ active } = await api.get('/api/chat/active')); }
      catch { return; /* сервер старый/недоступен — обойдёмся SSE */ }
      const byKey = new Map((active || []).map((a) => [a.chatKey, a]));
      for (const s of [...this.sessions, ...(this.archived || [])]) {
        const a = byKey.get(s.id);
        if (a?.compact) {
          // Сжатие: «думает…» не показываем — его место занимает вертящееся кольцо.
          s.compacting = true; s.sending = false; s.progressTokens = 0;
        } else if (a) {
          s.compacting = false; s.sending = true; s.progressTokens = a.tokens || 0;
          // Ход идёт час, а сохранённая цифра контекста — с прошлого хода (у claude она
          // бывает ещё и ДО автокомпакта CLI). Поэтому живой размер тоже восстанавливаем.
          s.liveContext = a.contextTokens || 0;
          // Вместе с «думает…» возвращаем и уже показанную ленту шагов текущего хода.
          // Серверную копию берём, если она полнее ИЛИ свежее нашей: обе стороны держат
          // скользящее окно одного размера, поэтому у отставшего окна (связь рвалась,
          // шаги прошли мимо) длина такая же, а хвост — вчерашний.
          const mine = s.steps?.length || 0;
          const theirs = a.steps?.length || 0;
          const myLast = s.steps?.[mine - 1]?.at || 0;
          const theirLast = a.steps?.[theirs - 1]?.at || 0;
          if (theirs > mine || theirLast > myLast) s.steps = a.steps;
        } else if (!s.inflight && !compactInflight.has(s.id)) {
          s.sending = false; s.stopping = false; s.compacting = false; s.progressTokens = 0;
          s.liveContext = 0;
        }
      }
    },
    /**
     * В окне есть изменения, которых сервер ещё не видел (дебаунс `_persist`, неудачная
     * запись). Такой чат чужой копией НЕ перетираем: наша запись всё равно уедет следом
     * и победит, а принятая сейчас серверная версия стёрла бы набранное.
     */
    _dirty(chat) {
      const archived = (this.archived || []).some((c) => c.id === chat.id);
      return sentChats.get(chat.id) !== fingerprintOf(archived ? archivedSlimOf(chat) : slimOf(chat));
    },
    /**
     * Чат изменили в другом окне (в т.ч. на другом устройстве) — забираем именно его.
     * Тянем по одному чату, а не всю историю: меняется всегда один, а история растёт.
     */
    async _pullChat(id, archived) {
      if (!id) return;
      const local = this._find(id);
      if (local && this._dirty(local)) return;
      let chat = null;
      try { ({ chat } = await api.get(`/api/chat/store/chat/${id}`)); }
      catch { return; /* чат уже успели удалить — придёт отдельным событием */ }
      if (!chat?.id) return;
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
    _applyRemoteChat(chat, archived) {
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
        .filter(({ message, key }) => message.role === 'assistant' && !knownMessages.has(key))
        .at(-1);
      if (freshReply) this._notifyReply(applied, freshReply.message.text, freshReply.key);
      sentChats.set(applied.id, fingerprintOf(archived ? archivedSlimOf(applied) : slimOf(applied)));
    },
    /** Чат удалили в другом окне — убираем и здесь (удаление всегда осознанное действие). */
    _dropRemoteChat(id) {
      if (!id) return;
      for (const list of [this.sessions, this.archived || []]) {
        const i = list.findIndex((c) => c.id === id);
        if (i >= 0) list.splice(i, 1);
      }
      sentChats.delete(id);
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
      const onServer = new Set();
      for (const [list, archived] of [[j.sessions || [], false], [j.archived || [], true]]) {
        for (const chat of list) {
          if (!chat?.id) continue;
          onServer.add(chat.id);
          const local = this._find(chat.id);
          if (local && this._dirty(local)) continue; // своё несохранённое важнее чужой копии
          const next = { ...chat };
          delete next.archived;
          // Ровно это у нас и лежит — не трогаем объект, иначе каждое переподключение
          // подменяло бы массивы сообщений и перерисовывало открытый чат на ровном месте.
          const same = sentChats.get(chat.id)
            === fingerprintOf(archived ? archivedSlimOf(next) : slimOf(next));
          if (local && same) continue;
          this._applyRemoteChat(chat, archived);
        }
      }
      // Чата нет на сервере, хотя мы его туда писали — значит его стёрли на другом
      // устройстве. Тот, которого сервер и не видел (новый, ещё не уехал), — оставляем.
      for (const list of [this.sessions, this.archived || []]) {
        for (const c of [...list]) {
          if (onServer.has(c.id) || !sentChats.has(c.id) || this._dirty(c)) continue;
          this._dropRemoteChat(c.id);
        }
      }
    },
    async answerPerm(pid, allow, remember = false, comment = '', choice = '') {
      const p = this.pending[pid];
      if (!p) return;
      delete this.pending[pid];
      if (allow && remember && p.chatKey && p.tool) {
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
          ...(remember ? { remember: true } : {}),
          // Кнопка плана: у Kimi вариантов ответа больше двух (доработать, выйти).
          ...(choice ? { choice } : {}),
          ...(comment ? { comment } : {}),
        });
      } catch { /* запрос уже протух (таймаут/другое окно) */ }
      // Kimi (ACP) не умеет текст в отказе: сервер отвечает commentDelivered:false,
      // и пояснение едет обычным сообщением — встанет в очередь чата.
      if (!allow && comment && res?.commentDelivered === false) await this.send(p.chatKey, comment);
    },
    // Ответ на вопрос агента: answers = [{ header, question, selected: [метки], text }].
    // Сервер превращает их в текст, который агент читает как результат своего вопроса.
    async answerQuestion(pid, answers) {
      const p = this.pending[pid];
      if (!p) return;
      delete this.pending[pid];
      let res = null;
      try { res = await api.post(`/api/chat/permission/${pid}`, { answers }); }
      catch { /* запрос уже снят (стоп/конец хода/другое окно) */ }
      // Свой текст доезжает не по всякому каналу (ACP-мост Kimi несёт только выбранный
      // вариант). Сервер честно говорит textDelivered:false — досылаем обычным
      // сообщением, как и пояснение к отказу.
      const text = (answers || []).map((a) => a?.text || '').find(Boolean) || '';
      if (text && res?.textDelivered === false) await this.send(p.chatKey, text);
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
      if (keepEmpty || s.messages?.length || (s.draft || '').trim()) {
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
      if (this.activeId === id) this.activeId = this.sessions[0]?.id || this.archived[0]?.id || null;
      this._persist();
      return 'deleted';
    },

    // Плавающая панель.
    async toggle() { await this.ensure(); this.open = !this.open; },
    close() { this.open = false; },
    async openFor(taskId, title) {
      await this.ensure();
      if (taskId) {
        const ex = this.sessions.find((s) => s.taskId === String(taskId));
        if (ex) this.activeId = ex.id;
        else this.newSession({ taskId, title });
      }
      this.open = true;
      this._persist();
    },

    /**
     * Открыть один устойчивый Debug-разговор для песочницы задачи.
     *
     * Кнопка намеренно только ГОТОВИТ черновик: отдельный chatKey не означает
     * отдельный worktree, и автозапуск мог бы начать писать файлы одновременно с
     * Hunt. Человек видит постановку и отправляет её, когда читающий конвейер закончил.
     */
    async openDebugFor({ taskId, taskTitle = '', sourceChatId = '', context = '' } = {}) {
      await this.ensure();
      const task = String(taskId || '');
      if (!task) throw new Error('Debug-чат требует задачу с песочницей');

      const matches = (s) => s?.purpose === 'debug' && String(s.taskId || '') === task;
      let target = this.sessions.find(matches);
      let created = false;
      if (!target) {
        const archived = (this.archived || []).find(matches);
        if (archived) {
          this.restoreArchived(archived.id);
          target = this._get(archived.id);
        }
      }
      if (!target) {
        const excerpt = String(context || '').trim().slice(-3000);
        const draft = [
          `Работай в песочнице задачи #${task} в режиме Debug: воспроизведи описанную ошибку, докажи первопричину, внеси минимальное исправление и выполни релевантные проверки.`,
          'Не начинай менять worktree, пока Hunt или другой читающий конвейер этой задачи ещё выполняется.',
          excerpt ? `\nКонтекст исходного разговора:\n${excerpt}` : '',
        ].filter(Boolean).join('\n');
        const id = this.newSession({
          taskId: task,
          title: `Debug · #${task}${taskTitle ? ` · ${taskTitle}` : ''}`,
          purpose: 'debug',
          sourceChatId: sourceChatId || null,
          draft,
        });
        target = this._get(id);
        created = true;
      }

      this.activeId = target.id;
      this.open = true;
      this._persist(true);
      return { id: target.id, created };
    },

    setTask(id, taskId, title) {
      const s = this._find(id); if (!s) return;
      s.taskId = taskId ? String(taskId) : null;
      s.title = title || '';
      this._persist();
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
    setEffort(id, e) { const s = this._find(id); if (!s) return; s.effort = e; this.defEffort = e; this._persist(); },
    clearChat(id) { const s = this._find(id); if (!s) return; s.messages = []; s.error = null; this._persist(); },
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

      // Важен ref ДО возможной смены provider в селекте. При переходе Kimi → другой
      // исполнитель сначала инвалидируем старый Kimi binding, затем меняем модель.
      const modelRef = s.modelRef ? { ...s.modelRef } : null;
      const resetOnServer = modelRef?.provider === 'kimi' && (s.sessionId || s.revision > 0);
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
     * что и сообщения, и так же занимает индикатор хода. Два пути (какой — решает
     * исполнитель на сервере):
     *   native  — CLI сжал разговор сам, сессия та же, ничего больше делать не надо;
     *   summary — сервер вернул выжимку; сессию обнуляем, выжимка ждёт в pendingSeed и
     *             уедет первой в новую сессию вместе со следующим сообщением.
     * Точный размер контекста после сжатия не знает никто: ход сжатия читал ещё СТАРУЮ
     * переписку. Поэтому обнуляем счётчик и ждём следующего обычного хода — он измерит.
     */
    async compact(id) {
      const s = this._find(id);
      if (!s || s.compacting || s.sending || !s.sessionId) return;
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
        const r = await api.post(url, {
          model: resolvedModel.id, modelRef: s.modelRef,
          effort: effortLevels.includes(s.effort) ? s.effort : '',
          mode: s.mode || '', sessionId: s.sessionId, chatKey: id,
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
        if (r.compact?.kind === 'summary') {
          if (!r.compact.seed) throw new Error('Сервер не вернул выжимку — контекст не сжат.');
          s.pendingSeed = r.compact.seed;
          s.sessionId = null;
        }
        s.contextTokens = 0;
        s.contextWindow = 0;
        s.contextMetric = '';
        s.contextIsEstimate = false;
        s.totalInputTokens = 0;
        s.cachedInputTokens = 0;
        s.compactedAt = Date.now();
        s.messages.push({ role: 'note', text: `🗜 Контекст сжат — было ${before.toLocaleString('ru')} токенов.` });
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
      if (!queued) { s.progressTokens = 0; s.steps = []; s.liveContext = 0; }
      s.updatedAt = sentAt;
      // После сжатия «выжимкой» сессии ещё нет: агент увидит состояние работы первым
      // блоком этого сообщения. В переписку на экране блок не попадает — там уже есть и
      // вся история, и плашка о сжатии. Снимаем семя ДО запроса (иначе гонка со вторым
      // окном засеяла бы сессию дважды), при провале возвращаем на место.
      const seed = s.pendingSeed || '';
      if (seed) s.pendingSeed = '';
      // До этой границы любой сбой означает «агент точно НЕ стартовал». После начала
      // POST сетевой исход неоднозначен: сервер мог принять запрос и продолжить ход уже
      // без окна — только тогда уместна плашка offline и ожидание chats/pending.
      let modelRequestStarted = false;
      // Durable save выполняется ниже после разрешения modelRef и до запуска executor-а.
      try {
        const url = s.taskId ? `/api/tasks/${s.taskId}/chat` : '/api/chat';
        // Снимок UI-контекста: страница + детали от неё (агент понимает «поправь здесь»).
        const route = router.currentRoute.value;
        const ui = useUiContextStore();
        const context = {
          page: route.meta?.title || '',
          path: route.path,
          ...(Object.keys(ui.extra).length ? { details: JSON.parse(JSON.stringify(ui.extra)) } : {}),
        };
        // Модель: сохранённый алиас резолвим в конкретную (что показано в селекте, то и считает),
        // пустое значение — модель по умолчанию из реестра.
        const provStore = useProvidersStore();
        const resolvedModel = provStore.modelOf(selectedModel(s));
        const effortLevels = resolvedModel.model?.efforts || [];
        if (!resolvedModel.provider || !resolvedModel.model) throw new Error('Выбранная модель недоступна в реестре.');
        s.model = resolvedModel.id;
        s.modelRef = { provider: resolvedModel.provider.id, model: resolvedModel.model.id };
        await this._saveChatNow(s);
        // Пока реестр не сообщил уровни или старый выбор исчез из свежего каталога,
        // явный effort не отправляем: CLI применит собственный актуальный дефолт.
        const requestEffort = effortLevels.includes(s.effort) ? s.effort : '';
        modelRequestStarted = true;
        const r = await api.post(url, {
          message: seed ? `[Выжимка предыдущего разговора — продолжаем с этого места]\n${seed}\n[/Выжимка]\n\n${text}` : text,
          model: resolvedModel.id, modelRef: s.modelRef,
          effort: requestEffort, mode: s.mode || '',
          sessionId: s.sessionId, context, chatKey: id, requestTitle, sentAt,
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
          s.messages.push({
            role: 'assistant', text: r.reply || '(пусто)', cost: r.cost,
            steps: (r.steps?.length ? r.steps : s.steps) || [],
            model: r.model || s.model, actualModel: r.actualModel || '',
            effort: Object.hasOwn(r, 'effort') ? (r.effort || '') : requestEffort,
            // Метка остановленного хода: по ней сервер соберёт досье для новой
            // Kimi-сессии, чтобы агент знал, что успел сделать оборванный ход.
            ...(r.stopped ? { stopped: true } : {}),
          });
        }
        // Сервер мог подменить эффорт (модель не тянет выбранный уровень) — подтягиваем
        // слайдер под реальность, чтобы UI не врал. Пишем в сессию напрямую, НЕ через
        // setEffort: вынужденный откат не должен становиться дефолтом для новых чатов.
        if (r.effort && r.effort !== s.effort) s.effort = r.effort;
        s.steps = [];
        // Пользователь не смотрит на этот чат (другая вкладка ОС, другой раздел с закрытой
        // панелью или другой активный чат) — метка «непрочитано» и оповещение.
        this._notifyReply(s, r.reply || '(пусто)');
      } catch (e) {
        if (e.data?.sessionReset) {
          if (seed && !s.pendingSeed) s.pendingSeed = seed;
          clearSessionContext(s);
          s.sessionResetFailed = false;
        }
        if (e.data?.sessionResetFailed) s.sessionResetFailed = true;
        s.error = e.message;
        // Сетевой обрыв ПОСЛЕ начала model POST — не провал хода: сервер мог принять
        // запрос, агент живёт в его процессе, а ответ доедет через chats/pending.
        // Ошибка до POST (включая stale/CAS и сеть на durable save) однозначна: агент
        // не стартовал. Её показываем как обычную ошибку и не оставляем вечное «думает…».
        if (modelRequestStarted && isConnectionError(e)) s.offline = true;
        else {
          s.offline = false;
          s.messages.push({ role: 'error', text: e.message });
        }
        // Ход не дошёл — выжимку возвращаем в ожидание, иначе повтор сообщения ушёл бы
        // в пустую сессию и агент потерял бы всё, что помнил до сжатия.
        if (seed && !s.pendingSeed) s.pendingSeed = seed;
      } finally {
        s.inflight = Math.max(0, (s.inflight || 1) - 1);
        // Ещё есть незакрытые отправки этого чата — ход продолжается, «думает…» не снимаем.
        // Оборванная связь — тоже не повод его снимать: агент работает дальше, а правду о
        // нём вернут SSE (`chat-done`) и сверка активных ходов при восстановлении связи.
        if (!s.inflight && !s.offline) { s.sending = false; s.stopping = false; s.progressTokens = 0; }
        s.updatedAt = Date.now(); this._persist();
      }
      return true;
    },

    // Список номеров задач, уже находящихся на конвейере (для защиты «На конвейер»).
    async loadConveyor() {
      try {
        const { tasks } = await api.get('/api/tasks');
        this.conveyorIds = (tasks || []).map((t) => String(t.task));
      } catch { /* нет данных фабрики */ }
    },
  },
});
