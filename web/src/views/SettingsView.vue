<script setup>
import { computed, nextTick, ref, onMounted, onUnmounted, watch, watchEffect } from 'vue';
import { api } from '../shared/api-client.js';
import { useProvidersStore } from '../stores/providers.js';
import { useUiContextStore } from '../stores/ui-context.js';
import { useToolLauncher } from '../shared/tools/launcher.js';
import ProviderIcon from '../shared/ProviderIcon.vue';
import AccessOverview from './settings/AccessOverview.vue';
import ToggleSwitch from '../shared/ui/ToggleSwitch.vue';
import NumberField from '../shared/ui/NumberField.vue';
import { useAuthStore } from '../stores/auth.js';
import { usePluginsStore } from '../stores/plugins.js';
import { useChatStore } from '../stores/chat.js';
import { usePwaStore } from '../stores/pwa.js';
import {
  blockReasonLabel,
  UPDATE_STAGE_LABELS,
  useCockpitUpdateStore,
} from '../stores/cockpit-update.js';
import { confirmDialog } from '../shared/ui/confirm.js';
import { useSse } from '../composables/useSse.js';
import { FACTORY_DEBUG_LEVELS, factoryDebugPayload } from '../shared/factory-debug.js';

// Настройки сгруппированы по табам — новые разделы добавляются записью в TABS.
const TABS = [
  {
    id: 'app', label: 'Приложение', group: 'Основное', short: 'Экран и PWA',
    description: 'Поведение Cockpit на этом устройстве: экран, установка и локальные возможности браузера.',
    icon: 'M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M9 21h6 M12 17v4',
  },
  {
    id: 'speech', label: 'Речь', group: 'Основное', short: 'Диктовка и приватность',
    description: 'Движок диктовки, место обработки голоса, язык и термины проекта.',
    icon: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v3 M8 22h8',
  },
  {
    id: 'b24', label: 'Битрикс24', group: 'Основное', short: 'Портал и сессия',
    description: 'Подключение к порталу и проверка серверной сессии Битрикс24.',
    icon: 'M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z M8 8h8 M8 12h5 M8 16h3',
  },
  {
    id: 'providers', label: 'Исполнители', group: 'Автоматизация', short: 'ИИ и модели',
    description: 'Состояние CLI-исполнителей, доступные модели, обновления и общие каталоги.',
    icon: 'M12 3v3 M8 6h8a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z M9 12h.01 M15 12h.01 M9.5 16h5',
  },
  {
    id: 'runs', label: 'Запуски', group: 'Автоматизация', short: 'Правила и контекст',
    description: 'Правила подготовки запусков, восстановление конвейеров и диагностика фабрики.',
    icon: 'M8 5v14l11-7z M4 5v14',
  },
  {
    id: 'plugins', label: 'Плагины', group: 'Автоматизация', short: 'Модули Cockpit',
    description: 'Включение системных и пользовательских модулей и их собственные параметры.',
    icon: 'M8 3v4 M16 3v4 M5 7h14v4a7 7 0 0 1-14 0z M12 18v3',
  },
  {
    id: 'server', label: 'Сервер', group: 'Система', short: 'Процесс и рестарт',
    description: 'Состояние процесса Cockpit и безопасное применение серверных обновлений.',
    icon: 'M5 4h14v6H5z M5 14h14v6H5z M8 7h.01 M8 17h.01',
  },
  {
    id: 'access', label: 'Доступ', group: 'Система', short: 'Вход, HTTPS и шлюз',
    description: 'Учётная запись, активные способы подключения и сертификаты для других устройств.',
    icon: 'M7 10V7a5 5 0 0 1 10 0v3 M5 10h14v11H5z M12 14v3',
  },
];
const TAB_GROUPS = ['Основное', 'Автоматизация', 'Система'].map((label) => ({
  label,
  items: TABS.filter((item) => item.group === label),
}));
const savedTab = localStorage.getItem('cockpit-settings-tab');
const tab = ref(TABS.some((item) => item.id === savedTab) ? savedTab : 'app');
const currentTab = computed(() => TABS.find((item) => item.id === tab.value) || TABS[0]);
const settingsNav = ref(null);
function revealTab(id, smooth = true) {
  nextTick(() => {
    const nav = settingsNav.value;
    const button = nav?.querySelector(`[data-settings-tab="${id}"]`);
    if (!nav || !button || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollTo({
      left: button.offsetLeft - (nav.clientWidth - button.offsetWidth) / 2,
      behavior: smooth ? 'smooth' : 'auto',
    });
  });
}
function setTab(id) {
  tab.value = id;
  localStorage.setItem('cockpit-settings-tab', id);
  revealTab(id);
}

// Репортим открытый таб в UI-контекст — чат с агентом знает, что открыто.
const ui = useUiContextStore();
watchEffect(() => ui.set('settings', { tab: TABS.find((t) => t.id === tab.value)?.label || tab.value }));
onUnmounted(() => ui.clear('settings'));

// ── Приложение (настройки именно этого окна/устройства) ──
const pwa = usePwaStore();
const wakeLockNeedsHttps = typeof window !== 'undefined' && window.isSecureContext === false;
const notificationNeedsHttps = typeof window !== 'undefined' && window.isSecureContext === false;

// ── Речь (server-owned выбор + фактическая возможность этого браузера) ──
const chatStore = useChatStore();
const speechLoading = ref(true);
const speechSaving = ref(false);
const speechRefreshing = ref(false);
const speechMsg = ref(null);
const speech = ref({
  engine: 'browser', browserProcessing: 'auto', browserAutoConsent: false,
  language: 'auto', dictionary: '', local: { ready: false, reason: '' }, revision: '',
  quality: 'balanced', videoQuality: 'balanced', model: null, videoModel: null,
  device: 'auto', computeType: null, beamSize: null, vadSilenceMs: 500,
  conditionOnPreviousText: true,
});
const speechCapabilities = ref({
  local: { ready: false, reason: '', checks: [] },
  models: [], cuda: { state: 'probe_failed', reason: '' }, languages: ['ru', 'en', 'auto'],
  lastDictionaryMeasure: null, resident: null, benchmark: null,
});
const browserLocalStatus = ref('unknown');
const browserLocalBusy = ref(false);
const speechAdvanced = ref(false);
const speechJobs = ref({});
const speechStarting = ref({});
const benchmarkResult = ref(null);
const speechJobTimers = new Map();
let speechJobsDestroyed = false;
let speechBaseline = null;
let speechSnapshotEpoch = 0;

const SPEECH_QUALITIES = [
  { id: 'fast', label: 'Быстро', model: 'small', beam: 1, hint: 'Черновик; термины может путать.' },
  { id: 'balanced', label: 'Обычно', model: 'medium', beam: 5, hint: 'Баланс скорости и точности.' },
  { id: 'accurate', label: 'Точно', model: 'large-v3-turbo', beam: 5, hint: 'Точнее; скорость зависит от CPU/GPU и проверяется замером.' },
];
const SPEECH_MODELS = [
  { id: 'small', label: 'Small' },
  { id: 'medium', label: 'Medium' },
  { id: 'large-v3', label: 'Large v3' },
  { id: 'large-v3-turbo', label: 'Large v3 Turbo' },
];
const QUALITY_MODELS = { fast: 'small', balanced: 'medium', accurate: 'large-v3-turbo' };
const COCKPIT_DICTIONARY = 'кокпит\nконвейер\nworktree\nпесочница\nворота\nБитрикс24\nFastify\nPinia\nSSE\nCodex\nKimi\nOllama';
const TERMINAL_SPEECH_JOBS = new Set(['done', 'failed', 'cancelled', 'interrupted']);
const SPEECH_EDITABLE_FIELDS = [
  'engine', 'browserProcessing', 'language', 'dictionary', 'quality', 'videoQuality',
  'model', 'videoModel', 'device', 'computeType', 'beamSize', 'vadSilenceMs',
  'conditionOnPreviousText',
];

function validNullable(value, allowed, fallback = null) {
  return value === null || allowed.includes(value) ? value : fallback;
}

function normalizeSpeechCapabilities(value, fallback = speechCapabilities.value) {
  const raw = value && typeof value === 'object' ? value : {};
  const localRaw = raw.local && typeof raw.local === 'object' ? raw.local : (fallback.local || {});
  const cudaRaw = raw.cuda && typeof raw.cuda === 'object' ? raw.cuda : (fallback.cuda || {});
  return {
    local: {
      ready: localRaw.ready === true,
      reason: typeof localRaw.reason === 'string' ? localRaw.reason : '',
      checks: Array.isArray(localRaw.checks) ? localRaw.checks : [],
    },
    models: Array.isArray(raw.models) ? raw.models
      .filter((model) => model && typeof model === 'object' && typeof model.modelId === 'string')
      .map((model) => ({
        ...model,
        cached: model.cached === true,
        sizeMb: Number.isFinite(Number(model.sizeMb)) ? Number(model.sizeMb) : 0,
      })) : (fallback.models || []),
    cuda: {
      ...cudaRaw,
      state: typeof cudaRaw.state === 'string' ? cudaRaw.state : 'probe_failed',
      reason: typeof cudaRaw.reason === 'string' ? cudaRaw.reason : '',
    },
    languages: Array.isArray(raw.languages) ? raw.languages : (fallback.languages || ['ru', 'en', 'auto']),
    lastDictionaryMeasure: raw.lastDictionaryMeasure ?? fallback.lastDictionaryMeasure ?? null,
    resident: raw.resident ?? fallback.resident ?? null,
    benchmark: raw.benchmark && typeof raw.benchmark === 'object'
      ? { ...raw.benchmark }
      : (fallback.benchmark && typeof fallback.benchmark === 'object' ? { ...fallback.benchmark } : null),
  };
}

function speechCtor() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}
function speechLanguageTag() {
  if (speech.value.language === 'ru') return 'ru-RU';
  if (speech.value.language === 'en') return 'en-US';
  return document.documentElement.lang || navigator.language || 'ru-RU';
}
const browserSpeechReady = computed(() => window.isSecureContext !== false && !!speechCtor());
const browserSpeechReason = computed(() => {
  if (window.isSecureContext === false) return 'Web Speech требует HTTPS или localhost.';
  if (!speechCtor()) return 'Этот браузер не предоставляет SpeechRecognition.';
  if (speech.value.browserProcessing === 'local' && browserLocalStatus.value === 'unavailable') {
    return 'Локальная модель выбранного языка в этом браузере недоступна.';
  }
  return '';
});
const speechEffective = computed(() => {
  if (speech.value.engine === 'whisper') {
    return speech.value.local.ready
      ? 'Whisper на сервере Cockpit'
      : `Недоступно${speech.value.local.reason ? `: ${speech.value.local.reason}` : ''}`;
  }
  if (!browserSpeechReady.value
      || (speech.value.browserProcessing === 'local' && browserLocalStatus.value === 'unavailable')) {
    return speech.value.local.ready
      ? `Whisper (fallback: ${browserSpeechReason.value})`
      : `Недоступно: ${browserSpeechReason.value || speech.value.local.reason || 'нет рабочего движка'}`;
  }
  if (speech.value.browserProcessing === 'local') {
    if (browserLocalStatus.value === 'downloadable') return 'Браузер локально — модель скачается по первому запуску';
    if (browserLocalStatus.value === 'downloading') return 'Браузер локально — модель скачивается';
    return 'Браузер локально на этом устройстве';
  }
  return 'Браузер — способ обработки выбирает сам браузер';
});

function speechSnapshotRevision(payload) {
  const raw = payload?.speech || payload?.settings || payload || {};
  const revision = raw.revision ?? payload?.revision;
  return typeof revision === 'string' ? revision : '';
}

function captureSpeechSnapshotContext() {
  return {
    epoch: speechSnapshotEpoch,
    revision: speechBaseline?.revision || '',
  };
}

function speechSnapshotMatchesCurrent(payload) {
  const revision = speechSnapshotRevision(payload);
  return !!revision && revision === (speechBaseline?.revision || '');
}

function speechSnapshotDisposition(context, payload) {
  if (speechSnapshotEpoch === context.epoch
    && (speechBaseline?.revision || '') === context.revision) return 'apply';
  if (speechSnapshotMatchesCurrent(payload)) return 'current';
  return 'stale';
}

function speechPatch() {
  if (!speechBaseline) return {};
  return Object.fromEntries(SPEECH_EDITABLE_FIELDS
    .filter((field) => !Object.is(speech.value[field], speechBaseline[field]))
    .map((field) => [field, speech.value[field]]));
}

function applySpeechSnapshot(payload, { preserveDirty = true } = {}) {
  const raw = payload?.speech || payload?.settings || payload || {};
  const capabilities = normalizeSpeechCapabilities(payload?.capabilities || raw.capabilities);
  const previous = speechBaseline || speech.value;
  const local = raw.local || capabilities.local || previous.local || {};
  const revision = raw.revision ?? payload?.revision;
  const dirty = new Map();
  if (preserveDirty && speechBaseline) {
    for (const field of SPEECH_EDITABLE_FIELDS) {
      if (!Object.is(speech.value[field], speechBaseline[field])) dirty.set(field, speech.value[field]);
    }
  }
  const serverSnapshot = {
    engine: ['browser', 'whisper'].includes(raw.engine) ? raw.engine : previous.engine,
    browserProcessing: ['auto', 'local'].includes(raw.browserProcessing)
      ? raw.browserProcessing : previous.browserProcessing,
    browserAutoConsent: typeof raw.browserAutoConsent === 'boolean'
      ? raw.browserAutoConsent : previous.browserAutoConsent,
    language: ['ru', 'en', 'auto'].includes(raw.language) ? raw.language : previous.language,
    dictionary: typeof raw.dictionary === 'string' ? raw.dictionary : previous.dictionary,
    quality: ['fast', 'balanced', 'accurate'].includes(raw.quality) ? raw.quality : previous.quality,
    videoQuality: ['fast', 'balanced', 'accurate'].includes(raw.videoQuality) ? raw.videoQuality : previous.videoQuality,
    model: validNullable(raw.model, SPEECH_MODELS.map((model) => model.id), previous.model),
    videoModel: validNullable(raw.videoModel, SPEECH_MODELS.map((model) => model.id), previous.videoModel),
    device: ['auto', 'cpu', 'cuda'].includes(raw.device) ? raw.device : previous.device,
    computeType: validNullable(raw.computeType, ['int8', 'int8_float16', 'float16', 'float32'], previous.computeType),
    beamSize: raw.beamSize === null || (Number.isInteger(raw.beamSize) && raw.beamSize >= 1 && raw.beamSize <= 10)
      ? raw.beamSize : previous.beamSize,
    vadSilenceMs: Number.isInteger(raw.vadSilenceMs) && raw.vadSilenceMs >= 100 && raw.vadSilenceMs <= 5000
      ? raw.vadSilenceMs : previous.vadSilenceMs,
    conditionOnPreviousText: typeof raw.conditionOnPreviousText === 'boolean'
      ? raw.conditionOnPreviousText : previous.conditionOnPreviousText,
    local: { ready: local.ready === true, reason: typeof local.reason === 'string' ? local.reason : '' },
    revision: typeof revision === 'string' && revision ? revision : (previous.revision || ''),
  };
  const previousFingerprint = speechBaseline && JSON.stringify(speechBaseline);
  speechBaseline = { ...serverSnapshot, local: { ...serverSnapshot.local } };
  if (!previousFingerprint || previousFingerprint !== JSON.stringify(speechBaseline)) speechSnapshotEpoch++;
  const formSnapshot = { ...serverSnapshot, local: { ...serverSnapshot.local } };
  for (const [field, value] of dirty) formSnapshot[field] = value;
  speech.value = formSnapshot;
  speechCapabilities.value = capabilities;
  const storeSnapshot = { settings: serverSnapshot, revision: serverSnapshot.revision, capabilities };
  if (typeof chatStore.setSpeechSnapshot === 'function') chatStore.setSpeechSnapshot(storeSnapshot);
  else chatStore.speech = serverSnapshot;
  return serverSnapshot;
}

watch(() => chatStore.speech, (next) => {
  if (!next || next.revision === speechBaseline?.revision) return;
  applySpeechSnapshot({ settings: next, revision: next.revision, capabilities: next.capabilities });
}, { flush: 'sync', immediate: true });

async function probeBrowserSpeech() {
  const Ctor = speechCtor();
  if (!browserSpeechReady.value || !Ctor) { browserLocalStatus.value = 'unavailable'; return; }
  if (!(typeof Ctor.available === 'function' && 'processLocally' in Ctor.prototype)) {
    browserLocalStatus.value = 'unavailable';
    return;
  }
  browserLocalBusy.value = true;
  try {
    browserLocalStatus.value = await Ctor.available({
      langs: [speechLanguageTag()], processLocally: true,
    });
  } catch {
    browserLocalStatus.value = 'unavailable';
  } finally {
    browserLocalBusy.value = false;
  }
}

async function loadSpeech() {
  speechLoading.value = true;
  speechMsg.value = null;
  const context = captureSpeechSnapshotContext();
  try {
    const response = await api.get('/api/settings/speech');
    const disposition = speechSnapshotDisposition(context, response);
    if (disposition === 'apply') applySpeechSnapshot(response);
    await probeBrowserSpeech();
  } catch (e) {
    speechMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally {
    speechLoading.value = false;
  }
}

async function refreshSpeechCapabilities() {
  if (speechRefreshing.value) return;
  speechRefreshing.value = true;
  speechMsg.value = null;
  const context = captureSpeechSnapshotContext();
  try {
    const response = await api.get('/api/settings/speech?refresh=1');
    const disposition = speechSnapshotDisposition(context, response);
    if (disposition === 'apply') applySpeechSnapshot(response);
    await probeBrowserSpeech();
    speechMsg.value = disposition === 'stale'
      ? { type: 'err', text: 'Настройки речи изменились во время проверки — показан актуальный снимок.' }
      : { type: 'ok', text: 'Окружение и кэши моделей перепроверены.' };
  } catch (error) {
    speechMsg.value = { type: 'err', text: error.data?.message || error.message };
  } finally {
    speechRefreshing.value = false;
  }
}

async function saveSpeech() {
  const patch = speechPatch();
  if (!Object.keys(patch).length) {
    speechMsg.value = { type: 'ok', text: 'Изменений нет.' };
    return;
  }
  speechSaving.value = true;
  speechMsg.value = null;
  const context = captureSpeechSnapshotContext();
  try {
    const response = await api.post('/api/settings/speech', patch);
    const disposition = speechSnapshotDisposition(context, response);
    if (disposition === 'apply') applySpeechSnapshot(response);
    await probeBrowserSpeech();
    speechMsg.value = disposition === 'stale'
      ? { type: 'err', text: 'Настройки речи изменились в другом окне — проверь правки и сохрани ещё раз.' }
      : { type: 'ok', text: 'Настройки диктовки сохранены.' };
  } catch (e) {
    speechMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally {
    speechSaving.value = false;
  }
}

const cudaReady = computed(() => speechCapabilities.value.cuda?.state === 'ready');
// Отсутствие поля означает старый сервер: оставляем кнопку рабочей. Новый сервер
// явно присылает available=false, когда эталонная запись не настроена.
const benchmarkAvailable = computed(() => speechCapabilities.value.benchmark?.available !== false);
const benchmarkReason = computed(() => {
  const capability = speechCapabilities.value.benchmark;
  if (!capability || capability.available !== false) return '';
  return capability.reason || 'Эталонная запись для замера не настроена.';
});
const cudaReason = computed(() => {
  const state = speechCapabilities.value.cuda?.state;
  if (state === 'ready') return 'Готово к инференсу на CUDA.';
  if (state === 'no_device') return 'NVIDIA GPU не обнаружен.';
  if (state === 'missing_library') return 'В media-venv нет CUDA-библиотек.';
  return speechCapabilities.value.cuda?.reason || 'Не удалось проверить CUDA.';
});
const benchmarkDevice = computed(() => {
  if (speech.value.device !== 'auto') return speech.value.device;
  return cudaReady.value ? 'cuda' : 'cpu';
});
const benchmarkComputeType = computed(() => speech.value.computeType
  || (benchmarkDevice.value === 'cuda' ? 'float16' : 'int8'));
const effectiveDictationModel = computed(() => speech.value.model || QUALITY_MODELS[speech.value.quality] || 'medium');
const effectiveVideoModel = computed(() => speech.value.videoModel || QUALITY_MODELS[speech.value.videoQuality] || 'medium');

function setNullableInteger(field, value, min, max) {
  if (value === '') { speech.value[field] = null; return; }
  const number = Number(value);
  if (Number.isInteger(number)) speech.value[field] = Math.max(min, Math.min(max, number));
}
function fillCockpitDictionary() { speech.value.dictionary = COCKPIT_DICTIONARY; }
function speechModelLabel(modelId) {
  return SPEECH_MODELS.find((model) => model.id === modelId)?.label || modelId;
}
function formatModelSize(sizeMb) {
  const value = Number(sizeMb);
  if (!Number.isFinite(value) || value <= 0) return '';
  return value >= 1024 ? `${(value / 1024).toFixed(1)} ГБ` : `${value.toFixed(value >= 100 ? 0 : 1)} МБ`;
}

function normalizeSpeechJob(value, fallback = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  return {
    ...fallback,
    ...raw,
    jobId: typeof raw.jobId === 'string' ? raw.jobId : fallback.jobId,
    kind: typeof raw.kind === 'string' ? raw.kind : fallback.kind,
    modelId: typeof raw.modelId === 'string' ? raw.modelId : fallback.modelId,
    status: typeof raw.status === 'string' ? raw.status : (fallback.status || 'queued'),
    progress: raw.progress && typeof raw.progress === 'object' ? raw.progress : (fallback.progress || null),
    result: raw.result ?? fallback.result ?? null,
    error: raw.error ?? fallback.error ?? null,
  };
}
function rememberSpeechJob(value, fallback = {}) {
  const job = normalizeSpeechJob(value, fallback);
  if (!job.jobId) return null;
  speechJobs.value = { ...speechJobs.value, [job.jobId]: job };
  if (job.kind === 'benchmark' && job.status === 'done') benchmarkResult.value = job.result || {};
  return job;
}
function modelJob(modelId) {
  return Object.values(speechJobs.value).filter((job) => job.modelId === modelId && job.kind !== 'benchmark').at(-1) || null;
}
function benchmarkJob() {
  return Object.values(speechJobs.value).filter((job) => job.kind === 'benchmark').at(-1) || null;
}
function speechJobActive(job) { return !!job && !TERMINAL_SPEECH_JOBS.has(job.status); }
function speechJobPercent(job) {
  const progress = job?.progress;
  if (!progress) return null;
  if (Number.isFinite(Number(progress.percent))) return Math.max(0, Math.min(100, Number(progress.percent)));
  const done = Number(progress.done ?? progress.current);
  const total = Number(progress.total);
  return Number.isFinite(done) && Number.isFinite(total) && total > 0
    ? Math.max(0, Math.min(100, (done / total) * 100)) : null;
}
function speechJobLabel(job) {
  if (!job) return '';
  const labels = {
    queued: 'в очереди', running: 'выполняется', done: 'готово',
    failed: 'ошибка', cancelled: 'отменено', interrupted: 'прервано перезапуском',
  };
  const percent = speechJobPercent(job);
  return `${labels[job.status] || job.status}${percent === null ? '' : ` · ${Math.round(percent)}%`}`;
}
function clearSpeechJobTimer(jobId) {
  const timer = speechJobTimers.get(jobId);
  if (timer) clearTimeout(timer);
  speechJobTimers.delete(jobId);
}
function scheduleSpeechJobPoll(jobId, delay = 900) {
  if (speechJobsDestroyed) return;
  clearSpeechJobTimer(jobId);
  speechJobTimers.set(jobId, setTimeout(() => pollSpeechJob(jobId), delay));
}
async function refreshSpeechSnapshot() {
  const context = captureSpeechSnapshotContext();
  try {
    const snapshot = await api.get('/api/settings/speech');
    if (speechJobsDestroyed) return;
    if (speechSnapshotDisposition(context, snapshot) === 'apply') applySpeechSnapshot(snapshot);
    await probeBrowserSpeech();
  } catch { /* job уже завершён; следующий GET восстановит capabilities */ }
}
async function pollSpeechJob(jobId) {
  clearSpeechJobTimer(jobId);
  if (speechJobsDestroyed) return;
  const previous = speechJobs.value[jobId];
  if (!previous) return;
  try {
    const response = await api.get(`/api/settings/speech/jobs/${encodeURIComponent(jobId)}`);
    if (speechJobsDestroyed) return;
    const job = rememberSpeechJob(response, previous);
    if (!job) return;
    if (TERMINAL_SPEECH_JOBS.has(job.status)) {
      if (job.status === 'done' && job.kind !== 'benchmark') await refreshSpeechSnapshot();
      return;
    }
    scheduleSpeechJobPoll(jobId);
  } catch (error) {
    if (speechJobsDestroyed) return;
    rememberSpeechJob({
      ...previous,
      error: { code: 'job_poll_failed', message: error.message },
    }, previous);
    scheduleSpeechJobPoll(jobId, 1600);
  }
}
async function startSpeechJob(kind, modelId) {
  const key = `${kind}:${modelId || ''}`;
  if (speechStarting.value[key]) return;
  speechStarting.value = { ...speechStarting.value, [key]: true };
  speechMsg.value = null;
  try {
    const path = kind === 'benchmark'
      ? '/api/settings/speech/benchmark'
      : `/api/settings/speech/models/${encodeURIComponent(modelId)}/${kind}`;
    const body = kind === 'benchmark' ? {
      modelId: effectiveDictationModel.value,
      language: speech.value.language,
      device: benchmarkDevice.value,
      computeType: benchmarkComputeType.value,
    } : {};
    const started = await api.post(path, body);
    if (speechJobsDestroyed) return;
    const job = rememberSpeechJob(started, {
      kind,
      modelId: kind === 'benchmark' ? effectiveDictationModel.value : modelId,
      status: 'queued',
    });
    if (!job) throw new Error('Сервер не вернул jobId.');
    await pollSpeechJob(job.jobId);
  } catch (error) {
    if (speechJobsDestroyed) return;
    speechMsg.value = { type: 'err', text: error.data?.message || error.message };
  } finally {
    const next = { ...speechStarting.value };
    delete next[key];
    speechStarting.value = next;
  }
}
async function cancelSpeechJob(job) {
  if (!job?.jobId) return;
  clearSpeechJobTimer(job.jobId);
  try {
    rememberSpeechJob(
      await api.del(`/api/settings/speech/jobs/${encodeURIComponent(job.jobId)}`),
      job,
    );
  } catch (error) {
    speechMsg.value = { type: 'err', text: error.data?.message || error.message };
    if (speechJobActive(job)) scheduleSpeechJobPoll(job.jobId);
  }
}
function startBenchmark() {
  if (!benchmarkAvailable.value || (speech.value.device === 'cuda' && !cudaReady.value)) return;
  benchmarkResult.value = null;
  startSpeechJob('benchmark', effectiveDictationModel.value);
}
function benchmarkText(result) {
  if (!result || typeof result !== 'object') return '';
  const durationMs = Number(result.durationMs ?? result.duration);
  const elapsedSeconds = Number(result.elapsedSec);
  const audioSeconds = Number(result.audioSec ?? result.audioSeconds);
  const factor = Number(result.realtimeFactor);
  const parts = [];
  if (Number.isFinite(audioSeconds)) parts.push(`${audioSeconds.toFixed(1)} с речи`);
  if (Number.isFinite(elapsedSeconds)) parts.push(`${elapsedSeconds.toFixed(2)} с обработки`);
  else if (Number.isFinite(durationMs)) parts.push(`${(durationMs / 1000).toFixed(2)} с обработки`);
  if (Number.isFinite(factor)) parts.push(`RTF ${factor.toFixed(2)}`);
  return parts.join(' · ') || 'Замер завершён.';
}

onUnmounted(() => {
  speechJobsDestroyed = true;
  for (const timer of speechJobTimers.values()) clearTimeout(timer);
  speechJobTimers.clear();
});

// ── Битрикс24 ──
const form = ref({ baseUrl: '', login: '', password: '' });
const configured = ref(false);
const saving = ref(false);
const testing = ref(false);
const msg = ref(null);

async function loadCurrent() {
  try {
    const v = await api.get('/api/settings/b24');
    configured.value = v.configured;
    form.value.baseUrl = v.baseUrl;
    form.value.login = v.login;
  } catch (e) { msg.value = { type: 'err', text: e.message }; }
}
async function save() {
  saving.value = true; msg.value = null;
  try {
    await api.post('/api/settings/b24', { ...form.value });
    configured.value = true;
    form.value.password = '';
    msg.value = { type: 'ok', text: 'Сохранено.' };
    await loadCurrent();
  } catch (e) { msg.value = { type: 'err', text: e.message }; } finally { saving.value = false; }
}
async function testAuth() {
  testing.value = true; msg.value = null;
  try {
    const r = await api.post('/api/settings/b24/test');
    msg.value = r.ok ? { type: 'ok', text: `Авторизация успешна (userId ${r.userId}).` } : { type: 'err', text: `Не удалось: ${r.error}` };
  } catch (e) { msg.value = { type: 'err', text: e.message }; } finally { testing.value = false; }
}

// ── Исполнители (реестр LLM-агентов) ──
const prov = useProvidersStore();
// Кто применяет доверенные каталоги, объявляют сами адаптеры в /api/providers.
// Здесь нет ни id, ни названий конкретных ИИ: новый исполнитель появится в строке
// автоматически, как только включит capability в своём контракте.
const trustedDirectoryProviders = computed(() =>
  prov.providers.filter((provider) => provider.trustedDirectories === true));
const trustedDirectoryProviderNames = computed(() =>
  trustedDirectoryProviders.value.map((provider) => provider.name).join(', '));
const refreshing = ref(false);
async function refreshProv() {
  refreshing.value = true;
  await prov.load(true);
  refreshing.value = false;
}
// Команда установки или авторизации недоступного исполнителя — клик открывает терминал
// с уже введённой командой (выполнение — Enter'ом пользователя).
const { openTerminal } = useToolLauncher();
function installInTerminal(p) {
  openTerminal({ insert: p.setupCommand || p.install });
}

// Свои настройки исполнителя (тумблеры в его плашке): что за ключ — знает сам исполнитель,
// UI только передаёт выбор. Ошибку показываем у той настройки, где кликнули.
const setMsg = ref({});
async function saveProviderSetting(p, s, value) {
  const key = `${p.id}:${s.id}`;
  setMsg.value = { ...setMsg.value, [key]: '' };
  const r = await prov.saveSetting(p.id, s.id, value);
  if (!r.ok) setMsg.value = { ...setMsg.value, [key]: `Не сохранилось: ${r.error}` };
}

// Текстовые/числовые настройки: сохранение по Enter и по уходу фокуса. Enter сразу
// уводит фокус, так что сохранение одно — повторный blur видит то же значение и молчит;
// неизменённое значение тоже не шлём (каждый клик мимо инпута не должен будить сервер).
// Сюда же попадает 'range' без валидного потолка — он рисуется числовым инпутом.
function commitProviderSetting(p, s, event) {
  const el = event?.target;
  if (!el) return;
  if (s.kind === 'number' || s.kind === 'range') {
    const num = Number(el.value);
    if (!Number.isFinite(num)) { el.value = s.value; return; } // мусор → назад к сохранённому
    if (num === s.value) return;
    saveProviderSetting(p, s, num);
    return;
  }
  if (el.value === s.value) return;
  saveProviderSetting(p, s, el.value);
}

// Проверка новых версий CLI. Сервер и сам проверяет раз в 6 часов (индикатор в топбаре),
// эта кнопка — «посмотреть прямо сейчас». Обновление НИКОГДА не запускается само.
const checking = ref(false);
async function checkUpdates() {
  checking.value = true;
  try {
    await api.post('/api/providers/check-updates', {});
    await prov.load(true);
  } catch { /* сеть недоступна — индикатор просто останется прежним */ }
  finally { checking.value = false; }
}

// Обновление CLI исполнителя. Версия CLI и доступ аккаунта определяют набор моделей:
// после обновления Кокпит принудительно перечитывает каталог самого исполнителя.
const updating = ref('');
const updMsg = ref({});
async function updateProvider(p) {
  updating.value = p.id;
  updMsg.value = { ...updMsg.value, [p.id]: null };
  try {
    const r = await api.post(`/api/providers/${p.id}/update`, {});
    updMsg.value = {
      ...updMsg.value,
      [p.id]: r.changed
        ? { type: 'ok', text: `Обновлён: ${r.before || '?'} → ${r.after}. Список моделей пересобран.` }
        : { type: r.ok ? 'ok' : 'err', text: r.ok ? `Уже последняя версия (${r.after || r.before}).` : `Не получилось: ${(r.output || '').slice(-300)}` },
    };
    await prov.load(true);
  } catch (e) {
    updMsg.value = { ...updMsg.value, [p.id]: { type: 'err', text: e.message } };
  } finally { updating.value = ''; }
}

// ── MCP-серверы исполнителя ──
// Что за серверы подключены и живы ли они, знает только сам CLI, и опрос его стоит
// секунд — поэтому блок грузится лениво (открыли вкладку) и обновляется кнопкой.
// Секции — как в расширении: свои (файлы конфигов) отдельно от аккаунтных коннекторов,
// у них разные места починки: первые правятся локально, вторые — на claude.ai.
const MCP_SCOPES = [
  { id: 'user', label: 'Свои' },
  { id: 'project', label: 'Проект' },
  {
    id: 'account',
    label: 'claude.ai',
    hint: 'Коннекторы аккаунта: подключаются и авторизуются на claude.ai, локально их живость '
      + 'не проверяется — CLI о них не отчитывается.',
  },
];
// `remote` — аккаунтный коннектор, который локально не проверить ничем: его состояние
// знает claude.ai. Жёлтый «состояние неизвестно» тут был бы ложной тревогой над рабочим
// коннектором, поэтому у него своя нейтральная подпись и серая точка.
const MCP_STATES = {
  ok: { label: 'Подключён', cls: 'ok' },
  failed: { label: 'Не подключился', cls: 'err' },
  'needs-auth': { label: 'Нужна авторизация', cls: 'warn' },
  remote: { label: 'Включён на claude.ai', cls: 'idle' },
  unknown: { label: 'Состояние неизвестно', cls: 'warn' },
};
function mcpOf(p) { return prov.mcp[p.id] || null; }
function mcpGroups(p) {
  const servers = mcpOf(p)?.servers || [];
  return MCP_SCOPES
    .map((s) => ({ ...s, servers: servers.filter((x) => (x.scope || 'user') === s.id) }))
    .filter((g) => g.servers.length);
}
function mcpState(server) { return MCP_STATES[server.state] || MCP_STATES.unknown; }
function loadMcpFor(p, refresh = false) {
  if (typeof p?.id !== 'string') return;
  prov.loadMcp(p.id, refresh);
}
// Опрашиваем только тех, кто про MCP вообще сообщает (`mcp: true` в реестре).
function loadAllMcp(refresh = false) {
  for (const p of prov.providers) if (p.mcp && p.available) loadMcpFor(p, refresh);
}

// ── Запуски (правила перед стартом триажа/конвейера) ──
const prefs = ref(null);
const prefsMsg = ref(null);
const trustedDirectories = ref([]);
const trustedDirectoryInput = ref('');
const trustedDirectoriesBusy = ref(false);
const trustedDirectoriesMsg = ref(null);
async function loadPrefs() {
  try {
    prefs.value = await api.get('/api/settings/prefs');
    trustedDirectories.value = [...(prefs.value.trustedDirectories || [])];
    syncInitialAccessDetails();
  } catch {
    prefs.value = null;
    trustedDirectories.value = [];
  }
}

function addTrustedDirectory() {
  const value = trustedDirectoryInput.value.trim();
  trustedDirectoriesMsg.value = null;
  if (!value) return true;
  if (!value.startsWith('/')) {
    trustedDirectoriesMsg.value = { type: 'err', text: 'Укажите абсолютный путь, начиная с /.' };
    return false;
  }
  if (!trustedDirectories.value.includes(value)) trustedDirectories.value.push(value);
  trustedDirectoryInput.value = '';
  return true;
}

function removeTrustedDirectory(index) {
  trustedDirectories.value.splice(index, 1);
  trustedDirectoriesMsg.value = null;
}

async function applyTrustedDirectories() {
  if (!addTrustedDirectory()) return;
  trustedDirectoriesBusy.value = true;
  trustedDirectoriesMsg.value = null;
  try {
    const result = await api.post('/api/settings/trusted-directories', {
      directories: trustedDirectories.value,
    });
    trustedDirectories.value = [...result.directories];
    if (prefs.value) prefs.value.trustedDirectories = [...result.directories];
    trustedDirectoriesMsg.value = {
      type: 'ok',
      text: 'Сохранено. Изменение действует со следующего хода.',
    };
  } catch (e) {
    trustedDirectoriesMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally {
    trustedDirectoriesBusy.value = false;
  }
}

async function toggleGitRefresh(v) {
  prefsMsg.value = null;
  try {
    prefs.value = await api.post('/api/settings/prefs', { gitRefreshBeforeRun: v });
    prefsMsg.value = { type: 'ok', text: 'Сохранено.' };
  } catch (e) { prefsMsg.value = { type: 'err', text: e.message }; }
}

// Порог автокомпакта чатов. Правится числом, а не тумблером: подходящее значение
// зависит от того, как человек работает, а 0 — осознанное «не вмешиваться».
const compactWindow = ref(0);
watchEffect(() => { compactWindow.value = Number(prefs.value?.chatAutoCompactWindow) || 0; });
async function saveCompactWindow() {
  prefsMsg.value = null;
  const value = Math.max(0, Math.round(Number(compactWindow.value) || 0));
  try {
    prefs.value = await api.post('/api/settings/prefs', { chatAutoCompactWindow: value });
    // Это одна из границ кольца контекста в открытых чатах — стор получает её при
    // загрузке истории, поэтому новое значение отдаём ему сразу, а не до следующего F5.
    useChatStore().compactWindow = value;
    prefsMsg.value = {
      type: 'ok',
      text: value
        ? `Чаты будут сжиматься при ${value.toLocaleString('ru')} токенах контекста. Применится к новым ходам.`
        : 'Порог снят: у каждого CLI останется свой (у Claude — почти у самого потолка окна модели).',
    };
  } catch (e) { prefsMsg.value = { type: 'err', text: e.message }; }
}
// Тот же порог для этапов конвейера. Своя настройка, а не общая с чатом: сжатие на
// этапе стоит дешевле (нить разговора с человеком там рвать нечего), поэтому значения
// у них расходятся осознанно.
const stageCompactWindow = ref(0);
watchEffect(() => { stageCompactWindow.value = Number(prefs.value?.stageAutoCompactWindow) || 0; });
async function saveStageCompactWindow() {
  prefsMsg.value = null;
  const value = Math.max(0, Math.round(Number(stageCompactWindow.value) || 0));
  try {
    prefs.value = await api.post('/api/settings/prefs', { stageAutoCompactWindow: value });
    prefsMsg.value = {
      type: 'ok',
      text: value
        ? `Этапы конвейера будут сжиматься при ${value.toLocaleString('ru')} токенах контекста. Применится к новым заходам.`
        : 'Порог снят: у CLI на этапах останется свой (он срабатывает почти у потолка окна модели).',
    };
  } catch (e) { prefsMsg.value = { type: 'err', text: e.message }; }
}
// Порог молчания хода конвейера. Секунды в поле показываем минутами: человек мыслит
// «полчаса висит», а не «1800».
const silenceWindowMin = ref(0);
watchEffect(() => {
  silenceWindowMin.value = Math.round((Number(prefs.value?.runSilenceWindow) || 0) / 60);
});
async function saveSilenceWindow() {
  prefsMsg.value = null;
  const value = Math.max(0, Math.round(Number(silenceWindowMin.value) || 0)) * 60;
  try {
    prefs.value = await api.post('/api/settings/prefs', { runSilenceWindow: value });
    prefsMsg.value = {
      type: 'ok',
      text: value
        ? `Позовём, если ход конвейера замолчит дольше ${value / 60} мин.`
        : 'Оповещение о зависших ходах выключено.',
    };
  } catch (e) { prefsMsg.value = { type: 'err', text: e.message }; }
}
async function toggleAutoRecover(v) {
  prefsMsg.value = null;
  try {
    prefs.value = await api.post('/api/settings/prefs', { autoRecoverPipelines: v });
    prefsMsg.value = {
      type: 'ok',
      text: v
        ? 'Автовосстановление включено и применится при следующем запуске Cockpit.'
        : 'Автовосстановление выключено.',
    };
  } catch (e) { prefsMsg.value = { type: 'err', text: e.message }; }
}

// Подробный trace фабрики. Сам файл настроек принадлежит engine writer-у; UI работает
// только через /api/settings/factory-debug.
const factoryDebug = ref(null);
const factoryDebugBusy = ref(false);
const factoryDebugMsg = ref(null);

async function loadFactoryDebug({ keepMessage = false } = {}) {
  try {
    factoryDebug.value = await api.get('/api/settings/factory-debug?scope=global');
    if (!keepMessage) factoryDebugMsg.value = null;
  } catch (e) {
    factoryDebug.value = null;
    factoryDebugMsg.value = { type: 'err', text: e.message };
  }
}

async function saveFactoryDebug(level) {
  factoryDebugBusy.value = true;
  factoryDebugMsg.value = null;
  try {
    factoryDebug.value = await api.post(
      '/api/settings/factory-debug',
      factoryDebugPayload(level),
    );
    factoryDebugMsg.value = {
      type: 'ok',
      text: level === 'off' ? 'Подробное логирование выключено.' : 'Уровень логирования сохранён.',
    };
  } catch (e) {
    factoryDebugMsg.value = { type: 'err', text: e.message };
    await loadFactoryDebug({ keepMessage: true });
  } finally {
    factoryDebugBusy.value = false;
  }
}

// Сколько моделей исполнителя сейчас скрыто из выбора — считаем тем же правилом,
// по которому строится селект в чате (стор providers), а не своей копией условия.
function hiddenCount(p) {
  return (p.models || []).length - prov.visibleModels(p).length;
}

// Показ старых версий моделей в выборе чата. Сохраняем на сервере (настройка общая для всех
// окон) и сразу отражаем в сторе — селект перестраивается без перезагрузки.
const modelsMsg = ref(null);
async function toggleShowAllModels(v) {
  modelsMsg.value = null;
  try {
    prefs.value = await api.post('/api/settings/prefs', { showAllModels: v });
    prov.showAllModels = !!prefs.value.showAllModels;
  } catch (e) { modelsMsg.value = { type: 'err', text: e.message }; }
}

// ── Доступ (вход в кокпит) ──
const auth = useAuthStore();
const acc = ref({ currentPassword: '', login: '', password: '', password2: '' });
const accBusy = ref(false);
const accMsg = ref(null);

async function saveAccount() {
  accMsg.value = null;
  if (acc.value.password.length < 8) { accMsg.value = { type: 'err', text: 'Новый пароль — не короче 8 символов.' }; return; }
  if (acc.value.password !== acc.value.password2) { accMsg.value = { type: 'err', text: 'Пароли не совпадают.' }; return; }
  accBusy.value = true;
  try {
    const r = await api.post('/api/auth/password', {
      currentPassword: acc.value.currentPassword,
      login: acc.value.login,
      password: acc.value.password,
    });
    acc.value = { currentPassword: '', login: acc.value.login, password: '', password2: '' };
    accMsg.value = { type: 'ok', text: `Сохранено. ${r.note || ''}`.trim() };
    await auth.load();
  } catch (e) {
    accMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally { accBusy.value = false; }
}

async function logoutAll() {
  if (!confirm('Разлогинить все устройства, включая это?')) return;
  try { await api.post('/api/auth/logout-all'); } catch { /* всё равно уходим на вход */ }
  auth.authenticated = false;
}

// ── Способы доступа ──
// У LAN и шлюза разная семантика: локальный флаг управляет HTTPS-сокетом на следующем
// старте, а установленный VPS-шлюз отдельным prefs-флагом не выключается вовсе. Поэтому
// одинаковых тумблеров здесь больше нет: один переключатель отвечает только за защиту LAN,
// а панели подробностей раскрываются локально и всегда по одной.
const accessBusy = ref('');
const accessMsg = ref(null);
const activeAccessDetails = ref('');
let accessDetailsTouched = false;

async function toggleAccessDetails(kind) {
  accessDetailsTouched = true;
  activeAccessDetails.value = activeAccessDetails.value === kind ? '' : kind;
  if (kind === 'gateway' && gatewaySetupState.value === 'error') loadGatewaySetup();
  if (!activeAccessDetails.value) return;
  await nextTick();
  // Подробности — единая область после сводки и защиты входа. Переводим к ней фокус
  // и прокрутку: на телефоне иначе клик выглядит безрезультатным, а screen reader не
  // получает явного перехода от disclosure-кнопки к управляемому region.
  const region = document.getElementById(`${kind === 'local' ? 'local-https' : 'gateway'}-settings`);
  region?.focus?.({ preventScroll: true });
  region?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}

async function setLocalHttpsMode(on) {
  if (tls.value?.source === 'env') {
    accessMsg.value = {
      type: 'warn',
      text: 'HTTPS задан переменными окружения сервера. Изменить его можно только в конфигурации системы.',
    };
    return;
  }
  if (!on) {
    const ok = await confirmDialog(
      'Выключить локальный HTTPS? После перезапуска сервера кокпит перестанет слушать порт '
      + `${tls.value?.https?.port || 8143}. В домашней сети останется HTTP на порту `
      + `${tls.value?.httpPort || 8140}: пароль пойдёт без шифрования, PWA ставиться не будет. `
      + 'Localhost и доступ через VPS-шлюз не изменятся; сертификат и корень останутся на месте.',
      { danger: true, okText: 'Выключить' },
    );
    if (!ok) return;
  }
  accessDetailsTouched = true;
  accessBusy.value = 'accessLocalHttps';
  accessMsg.value = null;
  try {
    prefs.value = await api.post('/api/settings/prefs', { accessLocalHttps: on });
    await loadTls();
    if (on) activeAccessDetails.value = 'local';
    else if (activeAccessDetails.value === 'local') activeAccessDetails.value = '';
    if (!tls.value) {
      accessMsg.value = {
        type: 'err',
        text: `Настройка сохранена, но состояние HTTPS не удалось перечитать: ${tlsMsg.value?.text || 'нет ответа сервера'}`,
      };
      return;
    }
    const managedByEnv = tls.value?.source === 'env';
    accessMsg.value = {
      type: 'ok',
      text: managedByEnv
        ? 'Локальная настройка сохранена, но действующий HTTPS задан переменными окружения и этим переключателем не управляется.'
        : (on
          ? (tls.value?.leaf?.exists
            ? 'Локальный HTTPS включён. Сокет поднимется при следующем перезапуске сервера.'
            : 'Локальный HTTPS включён. Теперь выпусти сертификат для адреса домашней сети.')
          : 'Локальный HTTPS выключен. После перезапуска дома останется HTTP; localhost и VPS-шлюз не изменятся.'),
    };
  } catch (e) {
    accessMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally { accessBusy.value = ''; }
}

// ── Локальный HTTPS (свой корневой сертификат) ──
// Без него на планшете нет PWA: `navigator.serviceWorker` существует только в secure context,
// а публичный сертификат на домашний адрес не выпишет никто.
const tls = ref(null);          // ответ /api/settings/tls
const tlsState = ref('loading'); // loading | ready | error — null сам по себе не различает их
const tlsLoadError = ref('');
const tlsPicked = ref([]);      // адреса, отмеченные галками
const tlsBusy = ref(false);
const tlsMsg = ref(null);

async function loadTls({ keepMessage = false } = {}) {
  if (!keepMessage) tlsMsg.value = null;
  tlsState.value = 'loading';
  tlsLoadError.value = '';
  try {
    tls.value = await api.get('/api/settings/tls');
    // По умолчанию отмечаем то, что уже в сертификате, иначе — все адреса машины:
    // дома их один-два, и лишняя галка дешевле, чем «почему не открывается».
    const covered = tls.value.leaf?.addresses || [];
    const all = (tls.value.addresses || []).map((a) => a.address);
    tlsPicked.value = covered.length ? all.filter((a) => covered.includes(a)) : all;
    if (!tlsPicked.value.length) tlsPicked.value = all;
    tlsState.value = 'ready';
    syncInitialAccessDetails();
  } catch (e) {
    tls.value = null;
    tlsState.value = 'error';
    tlsLoadError.value = e.data?.message || e.message;
    tlsMsg.value = { type: 'err', text: tlsLoadError.value };
  }
}

function toggleTlsAddress(addr, on) {
  const set = new Set(tlsPicked.value);
  if (on) set.add(addr); else set.delete(addr);
  tlsPicked.value = [...set];
}

async function generateTls() {
  if (tls.value?.source === 'env') {
    tlsMsg.value = {
      type: 'warn',
      text: 'Системный HTTPS нельзя перевыпустить из Cockpit: измени сертификат в конфигурации сервера.',
    };
    return;
  }
  tlsBusy.value = true; tlsMsg.value = null;
  try {
    const r = await api.post('/api/settings/tls/generate', { addresses: tlsPicked.value });
    tls.value = r.status;
    tlsState.value = 'ready';
    tlsMsg.value = {
      type: 'ok',
      text: `Сертификат выпущен до ${new Date(r.notAfter).toLocaleDateString('ru-RU')}. `
        + (prefs.value?.accessLocalHttps
          ? 'Поставь корень на устройства (QR ниже) и перезапусти сервер — HTTPS включается только при старте.'
          : 'Поставь корень на устройства (QR ниже), затем включи HTTPS в карточке домашней сети и перезапусти сервер.'),
    };
  } catch (e) {
    tlsMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally { tlsBusy.value = false; }
}

// Отдельно от тумблера режима: тот просто не поднимает сокет, а это — стереть выпущенное.
// Нужно редко (сменилась сеть, хочется чистого листа), поэтому и кнопка вторичная.
async function dropTlsCertificate() {
  if (tls.value?.source === 'env') {
    tlsMsg.value = {
      type: 'warn',
      text: 'Системный HTTPS нельзя удалить из Cockpit: им управляет конфигурация сервера.',
    };
    return;
  }
  const ok = await confirmDialog(
    'Удалить выпущенный сертификат? Кокпит с планшета снова откроется только по http, и PWA '
    + 'перестанет ставиться. Корень на устройствах останется — после нового выпуска '
    + 'переустанавливать его не нужно.',
    { danger: true, okText: 'Удалить' },
  );
  if (!ok) return;
  tlsBusy.value = true; tlsMsg.value = null;
  try {
    const r = await api.post('/api/settings/tls/disable', { confirm: true });
    tls.value = r.status;
    tlsState.value = 'ready';
    tlsMsg.value = { type: 'ok', text: 'Сертификат удалён. HTTPS погаснет после перезапуска сервера.' };
  } catch (e) {
    tlsMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally { tlsBusy.value = false; }
}

// Адрес для QR и подсказок — первый из тех, что в сертификате.
const tlsAddress = () => tls.value?.leaf?.addresses?.[0] || '';
const tlsUrl = () => (tlsAddress() && tls.value?.https?.port
  ? `https://${tlsAddress()}:${tls.value.https.port}` : '');

// ── Шлюз наружу: установка формой ──
//
// Секреты живут ТОЛЬКО в памяти вкладки и в теле одного запроса: ни в prefs (те целиком
// уезжают в браузер), ни в слепке установки их нет. После успеха гасим и в памяти —
// держать пароль root во вкладке до конца дня незачем.
const gw = ref({
  domain: '',
  gateway: '',
  sshPort: 22,
  sshUser: 'root',
  sshPassword: '',
  sudoPassword: '',
  useCloudflare: false,
  cloudflareToken: '',
  acmeEmail: '',
  acmeStaging: false,
});
const gwSaved = ref(null); // слепок прошлой установки (без секретов)
const gwJob = ref(null); // снимок идущей или последней установки
const gwPublicDomain = ref(''); // домен, который процесс подхватил при СТАРТЕ
const gwBusy = ref(false);
const gwMsg = ref(null);
const gwProbe = ref(null); // отпечаток ключа хоста + нужен ли пароль
const gwHostOk = ref(false); // человек сверил отпечаток с панелью хостера
const gwChecks = ref(null); // результат кнопки «Проверить связь»
const gatewaySetupState = ref('loading'); // loading | ready | error — не выдаём неизвестность за «не настроен»
const gatewayLoadError = ref('');
let gatewaySetupLoaded = false;

// На первом открытии ведём сразу к незавершённой работе, но после первого клика выбор
// человека не перехватываем поздно приехавшими параллельными GET-запросами.
function syncInitialAccessDetails() {
  if (accessDetailsTouched || !prefs.value || !tls.value || !gatewaySetupLoaded) return;
  if (gwJob.value && ['running', 'failed'].includes(gwJob.value.state)) {
    activeAccessDetails.value = 'gateway';
  } else if (tls.value.source !== 'env' && prefs.value.accessLocalHttps === true
      && (!tls.value.https?.up || tls.value.needsRestart)) {
    activeAccessDetails.value = 'local';
  }
}

const GW_MARK = { wait: '·', run: '…', ok: '✓', fail: '✗', skip: '—' };
const gwRunning = computed(() => gwJob.value?.state === 'running');
const gwJobVerifyState = computed(() => gwJob.value?.steps
  ?.find((step) => step.key === 'verify')?.state || '');
const gwJobConfirmed = computed(() => gwJob.value?.state === 'done'
  && gwJobVerifyState.value === 'ok'
  && !gwJob.value?.needsRestart);
// Пароль требуем, только если сервер и правда не пускает по ключу (повторная установка — пускает).
const gwNeedsPassword = computed(() => gwProbe.value?.passwordNeeded !== false);
const gwCanStart = computed(() => !!gw.value.domain.trim()
  && !!gw.value.gateway.trim()
  && gwHostOk.value
  && (!gw.value.useCloudflare || !!gw.value.cloudflareToken.trim())
  && (!gwNeedsPassword.value || !!gw.value.sshPassword)
  && !gwRunning.value && !gwBusy.value);

/** Успех — единственный момент, когда секреты в памяти вкладки больше не нужны. */
function gwApplyJob(job) {
  const wasDone = gwJob.value?.state === 'done';
  gwJob.value = job || null;
  if (job?.state === 'running' && !accessDetailsTouched) {
    activeAccessDetails.value = 'gateway';
  }
  if (job?.state === 'done' && !wasDone) {
    gw.value.sshPassword = '';
    gw.value.sudoPassword = '';
    gw.value.cloudflareToken = '';
    loadGatewaySetup({ keepJob: true });
  }
}
// Прогресс идёт по общему SSE вкладки: установку начали с компьютера — видно и с планшета.
useSse((name, data) => { if (name === 'gateway-setup') gwApplyJob(data); });

async function loadGatewaySetup({ keepJob = false } = {}) {
  gatewaySetupState.value = 'loading';
  gatewayLoadError.value = '';
  try {
    const r = await api.get('/api/gateway/setup');
    gwSaved.value = r.setup || null;
    gwPublicDomain.value = r.publicDomain || '';
    if (!keepJob) gwJob.value = r.job || null;
    // Поля формы дозаполняем прошлой установкой, но НЕ затираем набранное руками.
    const s = r.setup;
    if (s) {
      if (!gw.value.domain) gw.value.domain = s.domain || '';
      if (!gw.value.gateway) gw.value.gateway = s.gateway || '';
      if (s.sshPort) gw.value.sshPort = s.sshPort;
      if (s.sshUser) gw.value.sshUser = s.sshUser;
      if (s.dns === 'cloudflare') gw.value.useCloudflare = true;
    }
    gatewaySetupState.value = 'ready';
    gatewaySetupLoaded = true;
    syncInitialAccessDetails();
  } catch (e) {
    gatewaySetupState.value = 'error';
    gatewayLoadError.value = e.data?.message || e.message;
    gatewaySetupLoaded = true;
    gwMsg.value = { type: 'err', text: gatewayLoadError.value };
    syncInitialAccessDetails();
  }
}

/** Проба ДО пароля: жив ли сервер и тот ли это сервер. */
async function gwProbeHost() {
  gwBusy.value = true;
  gwMsg.value = null;
  gwProbe.value = null;
  gwHostOk.value = false;
  try {
    gwProbe.value = await api.post('/api/gateway/setup/probe', {
      gateway: gw.value.gateway.trim(),
      sshPort: Number(gw.value.sshPort) || 22,
      sshUser: gw.value.sshUser.trim() || 'root',
    });
    if (!gwProbe.value.passwordNeeded) gw.value.sshPassword = '';
  } catch (e) {
    gwMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally { gwBusy.value = false; }
}

async function gwStart() {
  let dnsPlan = null;
  if (gw.value.useCloudflare) {
    gwBusy.value = true;
    gwMsg.value = null;
    try {
      dnsPlan = await api.post('/api/gateway/setup/dns-plan', {
        domain: gw.value.domain.trim(),
        gateway: gw.value.gateway.trim(),
        useCloudflare: true,
        cloudflareToken: gw.value.cloudflareToken.trim(),
      });
    } catch (e) {
      gwMsg.value = { type: 'err', text: e.data?.message || e.message };
      return;
    } finally {
      gwBusy.value = false;
    }
  }

  const dnsChanges = dnsPlan?.records?.filter((r) => r.action !== 'unchanged') || [];
  const removed = dnsPlan?.removed || [];
  const removedText = removed.length
    ? ` Будут удалены ${removed.length} лишних адресных записей: ${removed.slice(0, 6)
      .map((r) => `${r.type} ${r.name} → ${r.content || 'пусто'}`).join('; ')}${removed.length > 6 ? '; …' : ''}.`
    : '';
  const dnsText = dnsPlan
    ? ` Cloudflare: зона ${dnsPlan.zone.name}; Cockpit управляет только ${dnsPlan.domain} и `
      + `*.${dnsPlan.domain}. Обе записи будут указывать только на ${dnsPlan.ip} `
      + `(DNS-only, TTL 60).${removedText} Остальные имена и служебные записи не меняются.`
    : '';
  const ok = await confirmDialog(
    `Настроить шлюз на ${gw.value.gateway.trim()} и открыть кокпит по адресу `
    + `https://${gw.value.domain.trim()}?\n\n`
    + 'На VPS встанет Caddy и пользователь туннеля, на мозге — юниты обратных туннелей, '
    + 'в .env кокпита допишутся домен и режим за прокси. Пароль уйдёт на сервер один раз '
    + '(положить туда наш ключ) и нигде не сохранится.'
    + dnsText,
    {
      title: 'Установить VPS-шлюз',
      okText: dnsPlan ? 'Синхронизировать и установить' : 'Установить',
      danger: removed.length > 0 || dnsChanges.length > 0,
    },
  );
  if (!ok) return;
  gwBusy.value = true;
  gwMsg.value = null;
  gwChecks.value = null;
  try {
    const r = await api.post('/api/gateway/setup/start', {
      domain: gw.value.domain.trim(),
      gateway: gw.value.gateway.trim(),
      sshPort: Number(gw.value.sshPort) || 22,
      sshUser: gw.value.sshUser.trim() || 'root',
      sshPassword: gw.value.sshPassword,
      sudoPassword: gw.value.sudoPassword,
      useCloudflare: gw.value.useCloudflare,
      cloudflareToken: gw.value.useCloudflare ? gw.value.cloudflareToken.trim() : '',
      cloudflarePlanFingerprint: dnsPlan?.fingerprint || '',
      acmeEmail: gw.value.acmeEmail.trim(),
      acmeStaging: gw.value.acmeStaging,
      hostKeyFingerprint: gwProbe.value?.fingerprint || '',
    });
    gwJob.value = r.job || null;
  } catch (e) {
    gwMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally { gwBusy.value = false; }
}

async function gwVerify() {
  gwBusy.value = true;
  gwMsg.value = null;
  try {
    const body = {};
    if (gw.value.domain.trim() && gw.value.gateway.trim()) {
      body.domain = gw.value.domain.trim();
      body.gateway = gw.value.gateway.trim();
      body.sshPort = Number(gw.value.sshPort) || 22;
      body.sshUser = gw.value.sshUser.trim() || 'root';
    }
    const result = await api.post('/api/gateway/setup/verify', body);
    // Ответ проверки не хранится на сервере. Привязываем его к точной цели в памяти
    // вкладки, чтобы последующая правка формы не красила зелёным другой домен.
    gwChecks.value = {
      ...result,
      domain: body.domain || gwSaved.value?.domain || '',
      gateway: body.gateway || gwSaved.value?.gateway || '',
    };
  } catch (e) {
    gwChecks.value = null;
    gwMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally { gwBusy.value = false; }
}

/** Ручной шаг с командой — в терминал кокпита, без Enter: запуск остаётся за человеком. */
function gwManualToTerminal(entry) {
  if (entry?.command) openTerminal({ insert: entry.command });
}

// ── Плагины ──
const pluginsStore = usePluginsStore();
const plugMsg = ref(null);
async function savePlugin(p) {
  await pluginsStore.saveSettings(p.id, p.values);
  plugMsg.value = p.id;
  setTimeout(() => { if (plugMsg.value === p.id) plugMsg.value = null; }, 2000);
}

// Настройка типа `model` — тот же выбор, что в чате: исполнители группами, внутри их
// модели. Правило видимости общее (`visibleModels`): в кратком списке только свежие
// версии, остальные — под настройкой «показывать все модели».
const modelGroups = computed(() => prov.providers
  .map((p) => ({ ...p, models: prov.visibleModels(p) }))
  .filter((p) => p.models.length));

/** Сохранённая пара → значение опции «исполнитель:модель»; пусто — не выбрана. */
function pluginModelValue(p, key) {
  const saved = p.values?.[key];
  if (!saved || typeof saved !== 'object') return '';
  const provider = String(saved.provider || '');
  const model = String(saved.model || '');
  return provider && model ? `${provider}:${model}` : '';
}

/** Выбор есть, а такой модели в реестре нет — вернём его подписью, иначе `null`. */
function pluginModelLost(p, key) {
  const value = pluginModelValue(p, key);
  if (!value) return null;
  const { provider, model } = prov.modelOf(p.values[key]);
  return provider && model ? null : value;
}

function setPluginModel(p, key, value) {
  // id исполнителя двоеточий не содержит, а id модели содержит сплошь и рядом
  // (`qwen3.6:latest`) — режем по первому.
  const at = String(value || '').indexOf(':');
  p.values[key] = at > 0
    ? { provider: value.slice(0, at), model: value.slice(at + 1) }
    : null;
}

// ── Сервер (режим запуска и перезапуск) ──
const srv = ref(null);          // { systemd, pid, uptimeSec }
const restarting = ref(false);
const srvMsg = ref(null);
const cockpitUpdate = useCockpitUpdateStore();
const cockpitStatus = computed(() => cockpitUpdate.status);
const cockpitJob = computed(() => cockpitStatus.value?.job || null);
const clientBuildVersion = __COCKPIT_VERSION__;
const clientBuildSha = __COCKPIT_SHA__;
let confirmedUpdateJob = null;
const shortSha = (sha) => sha?.slice(0, 7) || '—';
const fmtChecked = (value) => {
  if (!value) return 'ещё не проверялось';
  try { return new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
  catch { return value; }
};

async function activeChatTurns() {
  try { return ((await api.get('/api/chat/active')).active || []).length; }
  catch { return 0; }
}

async function startCockpitAction(kind) {
  const status = cockpitStatus.value;
  if (!status) return;
  const active = await activeChatTurns();
  const warning = active
    ? ` Сейчас идут ходы агентов: ${active} — при рестарте они ОБОРВУТСЯ.`
    : '';
  const isRelease = kind === 'update';
  const action = isRelease
    ? `Установить ${status.latest?.tag} fast-forward-ом на чистую main? Будет применён только commit ${shortSha(status.latest?.sha)}.`
    : `Собрать и применить текущий checkout ${status.checkout.branch || 'detached HEAD'} · ${shortSha(status.checkout.sha)}? Git-ветка и файлы не изменятся.`;
  const details = ' Cockpit ненадолго станет недоступен после успешной сборки.';
  if (!(await confirmDialog(action + details + warning, {
    danger: !!active,
    okText: isRelease ? `Обновить до ${status.latest?.tag}` : 'Применить checkout',
  }))) return;
  const job = isRelease
    ? await cockpitUpdate.installRelease()
    : await cockpitUpdate.applyCheckout();
  if (!job && cockpitUpdate.error) srvMsg.value = { type: 'err', text: cockpitUpdate.error };
}

watchEffect(() => {
  const job = cockpitJob.value;
  if (job?.status !== 'done' || job.id === confirmedUpdateJob) return;
  confirmedUpdateJob = job.id;
  loadServer();
  pwa.checkForUpdate();
});

async function loadServer() { try { srv.value = await api.get('/api/system/server'); } catch { srv.value = null; } }

function fmtUptime(s) {
  if (s >= 86400) return `${Math.floor(s / 86400)}д ${Math.floor((s % 86400) / 3600)}ч`;
  if (s >= 3600) return `${Math.floor(s / 3600)}ч ${Math.floor((s % 3600) / 60)}м`;
  if (s >= 60) return `${Math.floor(s / 60)}м`;
  return `${s}с`;
}

async function restartServer() {
  // Рестарт обрывает идущие ходы агентов в чатах (они — дочерние процессы сервера):
  // честно предупреждаем числом, а не общими словами.
  const active = await activeChatTurns();
  const mode = srv.value?.systemd
    ? 'Сервер выйдет, юнит systemd поднимет его сам.'
    : 'Сервер запущен вручную — перезапустится через bin/restart.';
  const warn = active ? ` Сейчас идут ходы агентов: ${active} — они ОБОРВУТСЯ.` : '';
  if (!(await confirmDialog(`Перезапустить сервер кокпита? ${mode}${warn}`, { danger: !!active, okText: 'Перезапустить' }))) return;
  restarting.value = true; srvMsg.value = null;
  try { await api.post('/api/system/restart'); } catch { /* процесс мог умереть раньше ответа — это норм */ }
  // Ждём возвращения по публичному /api/auth/state (как bin/restart) и перезагружаем
  // страницу — она подтянет свежий бандл; ради применения нового кода кнопка и нужна.
  const t0 = Date.now();
  while (Date.now() - t0 < 40_000) {
    await new Promise((r) => { setTimeout(r, 1000); });
    try { await api.get('/api/auth/state'); location.reload(); return; }
    catch { /* ещё поднимается */ }
  }
  restarting.value = false;
  srvMsg.value = { type: 'err', text: 'Сервер не вернулся за 40 секунд — смотри journalctl --user -u cockpit-server или server/.state/cockpit-server.log.' };
}

// ── Пересборка web-бандла из рабочего дерева (без checkout и рестарта) ──
const rebuilding = ref(false);
async function rebuildWeb() {
  if (!(await confirmDialog(
    'Пересобрать web-бандл из текущего рабочего дерева? В сборку попадут и незакоммиченные правки. '
    + 'Checkout и процесс сервера не трогаем; на время сборки (~минута) рестарт и обновления заблокированы.',
    { okText: 'Пересобрать' },
  ))) return;
  srvMsg.value = null;
  try { await api.post('/api/system/web-rebuild'); }
  catch (e) { srvMsg.value = { type: 'err', text: e.message }; return; }
  rebuilding.value = true;
  const t0 = Date.now();
  // Сборка фоном на сервере — опрашиваем. «idle» после старта = сервер перезапустили
  // в обход блокировки (руками), статус сборки уже неизвестен.
  while (Date.now() - t0 < 12 * 60_000) {
    await new Promise((r) => { setTimeout(r, 2000); });
    let state = null;
    try { state = (await api.get('/api/system/web-rebuild')).rebuild; } catch { continue; }
    if (state?.status === 'running') continue;
    if (state?.status === 'done') {
      srvMsg.value = { type: 'ok', text: 'Web-бандл пересобран. Страница обновится и подтянет новую сборку.' };
      pwa.checkForUpdate();
      setTimeout(() => location.reload(), 1500);
    } else if (state?.status === 'failed') {
      srvMsg.value = { type: 'err', text: state.error?.message || 'Пересборка завершилась ошибкой.' };
    } else {
      srvMsg.value = { type: 'err', text: 'Сервер перезапустился во время сборки — статус неизвестен, проверь web/dist вручную.' };
    }
    rebuilding.value = false;
    return;
  }
  rebuilding.value = false;
  srvMsg.value = { type: 'err', text: 'Пересборка не завершилась за 12 минут — смотри лог сервера.' };
}

// Опрос MCP начинаем, только когда человек открыл вкладку исполнителей: он стоит
// секунд живого health-check, и платить за него при открытии любой другой вкладки
// (или в топбаре) незачем. Повторные заходы гасит минутный кэш сервера.
watchEffect(() => {
  if (tab.value !== 'providers' || !prov.loaded) return;
  loadAllMcp(false);
});

onMounted(() => {
  revealTab(tab.value, false);
  loadCurrent();
  loadSpeech();
  prov.load();
  loadPrefs();
  loadFactoryDebug();
  pluginsStore.load();
  loadServer();
  cockpitUpdate.load();
  loadTls();
  loadGatewaySetup();
  acc.value.login = auth.login || '';
});
</script>

<template>
  <div class="settings">
    <header class="settings-hero">
      <div>
        <p class="eyebrow">Центр управления</p>
        <h2>Настройте Cockpit под свой процесс</h2>
        <p>
          Подключения, исполнители и системные параметры собраны в одном месте.
          Изменения применяются только там, где это явно указано.
        </p>
      </div>
      <div class="hero-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 6h10 M18 6h2 M10 12h10 M4 12h2 M4 18h7 M15 18h5 M14 4v4 M6 10v4 M11 16v4" />
        </svg>
      </div>
    </header>

    <div class="settings-layout">
      <aside class="settings-nav-wrap">
        <nav ref="settingsNav" class="settings-nav" aria-label="Разделы настроек">
          <div v-for="group in TAB_GROUPS" :key="group.label" class="nav-group">
            <div class="nav-group-label">{{ group.label }}</div>
            <button
              v-for="item in group.items"
              :key="item.id"
              type="button"
              class="settings-nav-item"
              :data-settings-tab="item.id"
              :class="{ active: tab === item.id }"
              :aria-current="tab === item.id ? 'page' : undefined"
              @click="setTab(item.id)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path :d="item.icon" />
              </svg>
              <span>
                <strong>{{ item.label }}</strong>
                <small>{{ item.short }}</small>
              </span>
            </button>
          </div>
        </nav>
      </aside>

      <div class="settings-workspace" :class="{ wide: tab === 'providers' || tab === 'plugins' }">
        <header class="section-intro">
          <span class="section-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path :d="currentTab.icon" />
            </svg>
          </span>
          <div>
            <p class="eyebrow">{{ currentTab.group }}</p>
            <h2>{{ currentTab.label }}</h2>
            <p>{{ currentTab.description }}</p>
          </div>
        </header>

    <!-- Приложение: локальные настройки устройства, не уезжают на другие окна -->
    <section v-if="tab === 'app'">
      <div class="card">
        <div class="card-head">
          <div>
            <h3>Экран устройства</h3>
            <p class="muted small">Локальная настройка — не влияет на другие компьютеры и планшеты.</p>
          </div>
          <span class="scope-pill">Это устройство</span>
        </div>
        <div class="mode">
          <ToggleSwitch
            :model-value="pwa.wakeLockEnabled"
            :disabled="pwa.wakeLockBusy || (!pwa.wakeLockSupported && !pwa.wakeLockEnabled)"
            label="Не гасить экран"
            @update:model-value="pwa.setWakeLockEnabled"
          />
          <p class="muted small">
            Удерживает экран включённым на всех страницах кокпита. При сворачивании PWA
            блокировка снимается системой и автоматически возвращается после открытия.
          </p>
        </div>
        <p v-if="pwa.wakeLockActive" class="msg ok">Экран удерживается включённым.</p>
        <p v-else-if="pwa.wakeLockError" class="msg err">{{ pwa.wakeLockError }}</p>
        <p v-else-if="!pwa.wakeLockSupported" class="msg warn">
          {{ wakeLockNeedsHttps
            ? 'Функция доступна только при открытии кокпита через HTTPS.'
            : 'Этот браузер не поддерживает удержание экрана.' }}
        </p>
        <p v-else-if="pwa.wakeLockEnabled" class="muted small">
          Блокировка включится, когда приложение снова станет активным.
        </p>

        <div class="mode notification-mode">
          <div class="notification-line">
            <div>
              <b>Системные оповещения</b>
              <p class="muted small">
                Ответы агентов, вопросы и остановки конвейера, пока приложение запущено.
              </p>
            </div>
            <button
              :disabled="pwa.notificationBusy || !pwa.notificationSupported"
              @click="pwa.testNotification"
            >
              {{ pwa.notificationBusy
                ? 'Проверяю…'
                : (pwa.notificationPermission === 'granted' ? 'Проверить' : 'Включить и проверить') }}
            </button>
          </div>
          <p v-if="pwa.notificationPermission === 'granted'" class="msg ok">
            Оповещения разрешены на этом устройстве.
          </p>
          <p v-else-if="pwa.notificationError" class="msg err">{{ pwa.notificationError }}</p>
          <p v-else-if="!pwa.notificationSupported" class="msg warn">
            {{ notificationNeedsHttps
              ? 'Оповещения доступны только при открытии кокпита через HTTPS.'
              : 'Этот браузер не поддерживает системные оповещения.' }}
          </p>
          <p v-else class="muted small">
            Разрешение спрашивается только по этой кнопке — автоматический запрос PWA браузер блокирует.
          </p>
        </div>
      </div>
    </section>

    <!-- Речь: настройка общая для окон, возможности браузера — фактические для этого устройства -->
    <section v-else-if="tab === 'speech'" data-testid="speech-settings">
      <div v-if="speechLoading" class="card muted">Загрузка настроек речи…</div>
      <template v-else>
        <div class="card">
          <div class="card-head">
            <div>
              <h3>Движок диктовки</h3>
              <p class="muted small">Выбор хранится на сервере и действует во всех окнах Cockpit.</p>
            </div>
            <span class="scope-pill">Все устройства</span>
          </div>
          <div class="speech-choice-grid">
            <label class="speech-choice" :class="{ active: speech.engine === 'browser' }">
              <input v-model="speech.engine" type="radio" value="browser" />
              <span><b>Браузер</b><small>Текст приходит по мере распознавания, если браузер отдаёт промежуточные результаты.</small></span>
            </label>
            <label class="speech-choice" :class="{ active: speech.engine === 'whisper' }">
              <input v-model="speech.engine" type="radio" value="whisper" />
              <span><b>Whisper</b><small>Запись уходит только на сервер Cockpit и распознаётся локальной моделью.</small></span>
            </label>
          </div>

          <template v-if="speech.engine === 'browser'">
            <div class="speech-subhead">Обработка браузером</div>
            <div class="speech-choice-grid">
              <label class="speech-choice" :class="{ active: speech.browserProcessing === 'auto' }">
                <input v-model="speech.browserProcessing" type="radio" value="auto" />
                <span><b>На усмотрение браузера</b><small>Может выполняться на устройстве или удалённым сервисом браузера.</small></span>
              </label>
              <label class="speech-choice" :class="{ active: speech.browserProcessing === 'local' }">
                <input v-model="speech.browserProcessing" type="radio" value="local" />
                <span><b>Только на устройстве</b><small>Ставит <code>processLocally=true</code>; в облако молча не переключается.</small></span>
              </label>
            </div>
            <p v-if="speech.browserProcessing === 'auto'" class="msg warn" data-testid="speech-cloud-warning">
              До первой записи Cockpit отдельно попросит согласие: браузер может передать звук своему сервису.
              {{ speech.browserAutoConsent ? 'Согласие уже дано.' : 'Согласие ещё не дано.' }}
            </p>
            <p v-else-if="browserLocalBusy" class="muted small">Проверяю локальную модель этого браузера…</p>
          </template>
        </div>

        <div class="card" data-testid="speech-quality">
          <div class="card-head">
            <div>
              <h3>Качество Whisper</h3>
              <p class="muted small">Пресет задаёт модель и ширину поиска; ручные override имеют приоритет.</p>
            </div>
          </div>
          <div class="speech-quality-block">
            <b>Короткая диктовка</b>
            <div class="speech-quality-grid">
              <label v-for="preset in SPEECH_QUALITIES" :key="`dictation:${preset.id}`"
                     class="speech-quality" :class="{ active: speech.quality === preset.id }">
                <input v-model="speech.quality" type="radio" :value="preset.id" />
                <span><b>{{ preset.label }}</b><small>{{ preset.model }} · beam {{ preset.beam }}</small><small>{{ preset.hint }}</small></span>
              </label>
            </div>
            <p v-if="speech.model" class="msg info">Пресет {{ SPEECH_QUALITIES.find((item) => item.id === speech.quality)?.label }},
              но модель переопределена вручну: {{ speechModelLabel(speech.model) }}.</p>
          </div>
          <div class="speech-quality-block">
            <b>Разбор видео</b>
            <div class="speech-quality-grid">
              <label v-for="preset in SPEECH_QUALITIES" :key="`video:${preset.id}`"
                     class="speech-quality" :class="{ active: speech.videoQuality === preset.id }">
                <input v-model="speech.videoQuality" type="radio" :value="preset.id" />
                <span><b>{{ preset.label }}</b><small>{{ preset.model }}</small><small>{{ preset.hint }}</small></span>
              </label>
            </div>
            <p v-if="speech.videoModel" class="msg info">Модель видео переопределена: {{ speechModelLabel(speech.videoModel) }}.</p>
          </div>
          <button type="button" class="speech-advanced-toggle" data-testid="speech-advanced-toggle"
                  :aria-expanded="speechAdvanced" @click="speechAdvanced = !speechAdvanced">
            {{ speechAdvanced ? 'Скрыть продвинутые' : 'Показать продвинутые' }}
          </button>
          <div v-if="speechAdvanced" class="speech-advanced" data-testid="speech-advanced">
            <label>Модель диктовки
              <select class="speech-select" :value="speech.model || ''" @change="speech.model = $event.target.value || null">
                <option value="">Как в пресете ({{ speechModelLabel(QUALITY_MODELS[speech.quality]) }})</option>
                <option v-for="model in SPEECH_MODELS" :key="model.id" :value="model.id">{{ model.label }}</option>
              </select>
            </label>
            <label>Модель видео
              <select class="speech-select" :value="speech.videoModel || ''" @change="speech.videoModel = $event.target.value || null">
                <option value="">Как в пресете ({{ speechModelLabel(QUALITY_MODELS[speech.videoQuality]) }})</option>
                <option v-for="model in SPEECH_MODELS" :key="model.id" :value="model.id">{{ model.label }}</option>
              </select>
            </label>
            <label>Устройство для обоих сценариев
              <select v-model="speech.device" class="speech-select" data-testid="speech-device">
                <option value="auto">Авто — GPU с CPU-fallback</option>
                <option value="cpu">CPU</option>
                <option value="cuda" :disabled="!cudaReady">CUDA / NVIDIA GPU{{ cudaReady ? '' : ' — недоступно' }}</option>
              </select>
            </label>
            <label>Compute type
              <select class="speech-select" :value="speech.computeType || ''" @change="speech.computeType = $event.target.value || null">
                <option value="">По устройству (CPU int8 / CUDA float16)</option>
                <option value="int8">int8</option>
                <option value="int8_float16">int8_float16</option>
                <option value="float16">float16</option>
                <option value="float32">float32</option>
              </select>
            </label>
            <label>Beam size диктовки
              <input type="number" min="1" max="10" :value="speech.beamSize ?? ''" placeholder="Как в пресете"
                     @input="setNullableInteger('beamSize', $event.target.value, 1, 10)" />
            </label>
            <label>Пауза VAD, мс
              <input v-model.number="speech.vadSilenceMs" type="number" min="100" max="5000" step="100" />
            </label>
            <label class="speech-check">
              <input v-model="speech.conditionOnPreviousText" type="checkbox" />
              <span><b>Учитывать предыдущий текст</b><small>Помогает связности, но может повторять ошибку из прежнего фрагмента.</small></span>
            </label>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div>
              <h3>Язык и термины</h3>
              <p class="muted small">Один словарь используется Whisper и браузером, когда тот поддерживает contextual biasing.</p>
            </div>
          </div>
          <label class="speech-field">Язык
            <select v-model="speech.language" class="speech-select">
              <option value="auto">Как язык интерфейса / авто для Whisper</option>
              <option value="ru">Русский</option>
              <option value="en">English</option>
            </select>
          </label>
          <label class="speech-field">Термины проекта
            <textarea v-model="speech.dictionary" rows="6" maxlength="800"
                      placeholder="По одному термину или фразе на строку&#10;Fastify&#10;worktree&#10;Битрикс24"></textarea>
          </label>
          <div class="speech-field-actions">
            <button type="button" data-testid="speech-dictionary-template" @click="fillCockpitDictionary">Подставить термины кокпита</button>
            <span class="muted small">{{ [...speech.dictionary].length }} / 800 символов</span>
          </div>
          <p class="muted small">
            В браузере список применяется только при наличии <code>SpeechRecognitionPhrase</code>;
            неподдерживаемый словарь не ломает диктовку — запуск повторяется без него.
          </p>
          <p v-if="speechCapabilities.lastDictionaryMeasure" class="msg info">
            Последний замер словаря:
            {{ speechCapabilities.lastDictionaryMeasure.hotwordsTokens ?? speechCapabilities.lastDictionaryMeasure.tokens ?? 'токены не сообщены' }}
            <template v-if="speechCapabilities.lastDictionaryMeasure.hotwordsTruncated || speechCapabilities.lastDictionaryMeasure.truncated"> · обрезан моделью</template>
          </p>
        </div>

        <div class="card" data-testid="speech-models">
          <div class="card-head">
            <div>
              <h3>Локальные модели</h3>
              <p class="muted small">Первая диктовка ничего не скачивает: веса появляются только по явной кнопке.</p>
            </div>
          </div>
          <p v-if="!speechCapabilities.models.length" class="muted small">Сервер пока не сообщил каталог моделей.</p>
          <div v-else class="speech-model-list">
            <div v-for="model in speechCapabilities.models" :key="model.modelId" class="speech-model-row">
              <div class="speech-model-main">
                <b>{{ speechModelLabel(model.modelId) }}</b>
                <span class="muted small">{{ model.repo || model.modelId }}</span>
                <span class="speech-model-state" :class="model.cached ? 'ready' : 'missing'">
                  {{ model.cached ? `в кэше${formatModelSize(model.sizeMb) ? ` · ${formatModelSize(model.sizeMb)}` : ''}` : 'не скачана' }}
                </span>
              </div>
              <div class="speech-model-actions">
                <button type="button" :data-testid="`speech-download-${model.modelId}`"
                        :disabled="model.cached || speechJobActive(modelJob(model.modelId)) || speechStarting[`download:${model.modelId}`]"
                        @click="startSpeechJob('download', model.modelId)">
                  {{ model.cached ? 'Скачана' : 'Скачать' }}
                </button>
                <button v-if="!model.cached" type="button" :data-testid="`speech-copy-${model.modelId}`"
                        :disabled="speechJobActive(modelJob(model.modelId)) || speechStarting[`copy:${model.modelId}`]"
                        @click="startSpeechJob('copy', model.modelId)">Скопировать из общего кэша</button>
              </div>
              <div v-if="modelJob(model.modelId)" class="speech-job" :class="modelJob(model.modelId).status">
                <div>
                  <span>{{ modelJob(model.modelId).kind === 'copy' ? 'Копирование' : 'Скачивание' }}: {{ speechJobLabel(modelJob(model.modelId)) }}</span>
                  <button v-if="speechJobActive(modelJob(model.modelId))" type="button" class="speech-cancel"
                          :data-testid="`speech-cancel-${model.modelId}`" @click="cancelSpeechJob(modelJob(model.modelId))">Отменить</button>
                </div>
                <progress v-if="speechJobPercent(modelJob(model.modelId)) !== null" max="100" :value="speechJobPercent(modelJob(model.modelId))"></progress>
                <small v-if="modelJob(model.modelId).progress?.file" class="muted">{{ modelJob(model.modelId).progress.file }}</small>
                <p v-if="modelJob(model.modelId).error" class="msg err">{{ modelJob(model.modelId).error.message }}</p>
              </div>
            </div>
          </div>
        </div>

        <div class="card" data-testid="speech-environment">
          <div class="card-head">
            <div>
              <h3>Окружение и замер</h3>
              <p class="muted small">Проверка идёт в том же media-venv и HF-кэше, которые использует транскрипция.</p>
            </div>
            <button type="button" data-testid="speech-refresh" :disabled="speechRefreshing" @click="refreshSpeechCapabilities">
              {{ speechRefreshing ? 'Проверяю…' : 'Перепроверить' }}
            </button>
          </div>
          <div class="speech-env-grid">
            <div>
              <b>Whisper</b>
              <p :class="speechCapabilities.local.ready ? 'msg ok' : 'msg warn'">
                {{ speechCapabilities.local.ready ? 'Готов' : (speechCapabilities.local.reason || 'Не готов') }}
              </p>
              <ul v-if="speechCapabilities.local.checks.length" class="speech-checks">
                <li v-for="check in speechCapabilities.local.checks" :key="check.name || check.id" :class="check.ok ? 'ok' : 'err'">
                  {{ check.name || check.id }}<span v-if="!check.ok && check.fix" class="muted"> — {{ check.fix }}</span>
                </li>
              </ul>
            </div>
            <div>
              <b>CUDA</b>
              <p :class="cudaReady ? 'msg ok' : 'msg warn'">{{ cudaReason }}</p>
              <p v-if="!cudaReady" class="muted small">Доустановить воспроизводимым способом: <code data-testid="speech-cuda-command">deploy/install.sh --with-cuda</code>
              </p>
            </div>
          </div>
          <div class="speech-benchmark">
            <div>
              <b>Замер на эталонной записи</b>
              <p class="muted small">Модель {{ speechModelLabel(effectiveDictationModel) }} ·
                {{ speech.device === 'auto' ? `auto → ${benchmarkDevice}` : benchmarkDevice }} · {{ benchmarkComputeType }}.</p>
            </div>
            <button type="button" data-testid="speech-benchmark"
                    :disabled="speechJobActive(benchmarkJob()) || !benchmarkAvailable || (speech.device === 'cuda' && !cudaReady)"
                    @click="startBenchmark">Замерить</button>
          </div>
          <p v-if="!benchmarkAvailable" class="msg warn" data-testid="speech-benchmark-unavailable">
            {{ benchmarkReason }} Укажи эталонный WAV через <code>COCKPIT_SPEECH_BENCHMARK_AUDIO</code>.
          </p>
          <div v-if="benchmarkJob()" class="speech-job" :class="benchmarkJob().status">
            <div>
              <span>Замер: {{ speechJobLabel(benchmarkJob()) }}</span>
              <button v-if="speechJobActive(benchmarkJob())" type="button" class="speech-cancel" data-testid="speech-benchmark-cancel"
                      @click="cancelSpeechJob(benchmarkJob())">Отменить</button>
            </div>
            <progress v-if="speechJobPercent(benchmarkJob()) !== null" max="100" :value="speechJobPercent(benchmarkJob())"></progress>
            <p v-if="benchmarkJob().error" class="msg err">{{ benchmarkJob().error.message }}</p>
          </div>
          <p v-if="benchmarkResult" class="msg ok" data-testid="speech-benchmark-result">{{ benchmarkText(benchmarkResult) }}</p>
        </div>

        <div class="card">
          <div class="card-head">
            <div>
              <h3>Фактический путь</h3>
              <p class="muted small">Серверный выбор может быть недоступен в конкретном браузере.</p>
            </div>
            <span class="status-pill" :class="speechEffective.startsWith('Недоступно') ? 'danger' : 'ok'">
              <span class="dot"></span>{{ speechEffective.startsWith('Недоступно') ? 'Недоступно' : 'Готово' }}
            </span>
          </div>
          <p data-testid="speech-effective"><b>Выбрано:</b> {{ speech.engine === 'browser' ? 'браузер' : 'Whisper' }}</p>
          <p><b>На этом устройстве:</b> {{ speechEffective }}</p>
          <p v-if="speech.engine === 'browser' && browserSpeechReason" class="msg warn">{{ browserSpeechReason }}</p>
          <p v-if="!speech.local.ready && speech.local.reason" class="muted small">Whisper: {{ speech.local.reason }}</p>
          <p class="muted small">Диктовка: {{ speechModelLabel(effectiveDictationModel) }} · видео: {{ speechModelLabel(effectiveVideoModel) }}.</p>
          <div class="row">
            <button class="primary" type="button" :disabled="speechSaving" data-testid="speech-save" @click="saveSpeech">
              {{ speechSaving ? 'Сохраняю…' : 'Сохранить' }}
            </button>
          </div>
          <p v-if="speechMsg" class="msg" :class="speechMsg.type">{{ speechMsg.text }}</p>
        </div>
      </template>
    </section>

    <!-- Битрикс24 -->
    <section v-else-if="tab === 'b24'">
      <div class="card">
        <div class="card-head">
          <div>
            <h3>Подключение к порталу</h3>
            <p class="muted small">Учётные данные хранятся только на сервере и не попадают в git.</p>
          </div>
          <span class="status-pill" :class="configured ? 'ok' : 'neutral'">
            <span class="dot"></span>{{ configured ? 'Настроено' : 'Не настроено' }}
          </span>
        </div>
        <div class="form-grid">
          <label class="full">Портал<input v-model="form.baseUrl" placeholder="https://ваш-портал.bitrix24.ru" /></label>
          <label>Логин<input v-model="form.login" autocomplete="username" placeholder="user@example.com" /></label>
          <label>Пароль
            <input v-model="form.password" type="password" autocomplete="current-password"
                   :placeholder="configured ? '•••••• (задан, введите новый для замены)' : 'пароль портала'" />
          </label>
        </div>
        <div class="row">
          <button class="primary" :disabled="saving || !form.login || !form.password" @click="save">{{ saving ? 'Сохранение…' : 'Сохранить' }}</button>
          <button :disabled="testing || !configured" @click="testAuth">{{ testing ? 'Проверка…' : 'Проверить авторизацию' }}</button>
        </div>
        <p v-if="msg" class="msg" :class="msg.type">{{ msg.text }}</p>
      </div>
    </section>

    <!-- Исполнители: реестр LLM-агентов (/api/providers) -->
    <section v-else-if="tab === 'providers'">
      <!-- Плашка на исполнителя, плашки — горизонтальной линией: у каждого ИИ свои
           ручки, и мешать их в один список нельзя. -->
      <div v-if="!prov.loaded" class="card muted">Загрузка…</div>
      <div v-else class="pvcards">
        <div v-for="p in prov.providers" :key="p.id" class="card pvcard">
          <div class="pvhead">
            <span class="pvicon" :style="{ color: p.available ? p.color : 'var(--ink-mid)' }">
              <ProviderIcon :provider="p" :size="20" />
            </span>
            <div class="pvtitle">
              <div class="pvname">{{ p.name }}</div>
              <div class="pvsub muted">{{ p.vendor }} · {{ p.kind }}</div>
            </div>
            <span class="pvstate" :class="p.available ? 'ok' : 'err'">
              <span class="dot"></span>{{ p.available ? 'доступен' : 'недоступен' }}
            </span>
          </div>
          <div class="pvfacts">
            <div class="pvsub muted">{{ p.authLabel }}<template v-if="p.version"> · {{ p.version }}</template></div>
            <div v-if="p.chatEnabled === false" class="pvsub pvsoon">
              Установка доступна; подключение к чатам пока не включено.
            </div>
            <div v-if="p.models?.length" class="pvsub muted">
              моделей в каталоге: {{ p.models.length }}<template v-if="hiddenCount(p)"> (в выборе {{ p.models.length - hiddenCount(p) }} — остальные скрыты)</template><template v-if="p.models.some((m) => m.unknown)"> · есть неизвестные CLI (помечены «?»)</template>
            </div>
            <!-- Индикатор новой версии: кокпит только сообщает, обновление — по кнопке -->
            <div v-if="p.updateAvailable" class="pvupd">
              ● Доступно обновление: <b>{{ p.latest }}</b> — нажми «Обновить»
            </div>
            <div v-else-if="p.latest" class="pvsub muted">последняя версия ({{ p.latest }})</div>
          </div>
          <div v-if="!p.available && (p.setupCommand || p.install)" class="pvinstall">
            {{ p.installed ? 'Авторизация' : 'Установка' }}:
            <code class="click" title="Кликни — откроется терминал с введённой командой"
                  @click="installInTerminal(p)">{{ p.setupCommand || p.install }}</code>
          </div>
          <p v-if="updMsg[p.id]" class="msg" :class="updMsg[p.id].type">{{ updMsg[p.id].text }}</p>
          <!-- Свои настройки исполнителя. Список объявляет сам executor (поле settings),
               фронт про вендоров не знает и рисует по kind; выбор сохраняется в prefs. -->
          <div class="pvset">
            <div class="pvsetttl">Настройки исполнителя</div>
            <template v-if="p.settings?.length">
              <div v-for="s in p.settings" :key="s.id" class="pvsetrow">
                <div class="pvsetline">
                  <ToggleSwitch v-if="s.kind === 'toggle'" :model-value="!!s.value"
                                :disabled="s.disabled === true" :label="s.label"
                                @update:model-value="(v) => saveProviderSetting(p, s, v)" />
                  <!-- Ползунок (num_ctx у Ollama): потолок вычисляет исполнитель.
                       Без валидного max падаем обратно в числовой инпут ниже. -->
                  <template v-else-if="s.kind === 'range' && Number(s.max) > Number(s.min)">
                    <span class="pvsetlbl">{{ s.label }}</span>
                    <input type="range" class="pvsetrange" :min="s.min" :max="s.max" :step="s.step || 1"
                           :value="s.value" :disabled="s.disabled === true"
                           @change="(e) => saveProviderSetting(p, s, Number(e.target.value))" />
                    <span class="pvrangeval">{{ Number(s.value).toLocaleString('ru') }} / {{ Number(s.max).toLocaleString('ru') }}</span>
                  </template>
                  <template v-else-if="s.kind === 'text' || s.kind === 'number' || s.kind === 'range'">
                    <span class="pvsetlbl">{{ s.label }}</span>
                    <input class="pvsetinput" :type="s.kind === 'range' ? 'number' : s.kind"
                           :min="s.kind === 'text' ? undefined : (Number(s.min) || 512)"
                           :value="s.value" :disabled="s.disabled === true"
                           @keydown.enter.prevent="(e) => { commitProviderSetting(p, s, e); e.target.blur(); }"
                           @blur="(e) => commitProviderSetting(p, s, e)" />
                  </template>
                  <span v-else class="pvsetlbl">{{ s.label }}</span>
                  <span v-if="s.note" class="pvsoon">{{ s.note }}</span>
                </div>
                <div v-if="s.hint" class="muted small">{{ s.hint }}</div>
                <p v-if="setMsg[`${p.id}:${s.id}`]" class="msg err">{{ setMsg[`${p.id}:${s.id}`] }}</p>
              </div>
            </template>
            <p v-else class="muted small">Своих настроек у этого исполнителя пока нет.</p>
          </div>
          <!-- MCP-серверы: чем агент этого CLI дополнен сверх своих инструментов.
               Список и живость знает только сам CLI, поэтому блок грузится отдельным
               запросом (см. loadMcpFor) и есть лишь у тех, кто объявил mcpStatus. -->
          <div v-if="p.mcp && p.available" class="pvset">
            <div class="pvsetttl">
              MCP-серверы
              <button class="mcpbtn" :disabled="mcpOf(p)?.loading" @click="loadMcpFor(p, true)">
                {{ mcpOf(p)?.loading ? 'Проверка…' : 'Перепроверить' }}
              </button>
            </div>
            <p v-if="!mcpOf(p) || (mcpOf(p).loading && !mcpOf(p).servers)" class="muted small">
              Опрашиваем CLI — это несколько секунд…
            </p>
            <p v-else-if="mcpOf(p).state === 'error'" class="msg err">
              Не удалось опросить: {{ mcpOf(p).error }}
            </p>
            <template v-else>
              <div v-for="g in mcpGroups(p)" :key="g.id" class="mcpgrp">
                <div class="mcpgrpttl muted">{{ g.label }} ({{ g.servers.length }})</div>
                <div v-if="g.hint" class="mcpgrphint muted">{{ g.hint }}</div>
                <div v-for="s in g.servers" :key="s.name" class="mcprow">
                  <div class="mcpline">
                    <span class="mcpdot" :class="mcpState(s).cls"></span>
                    <span class="mcpname" :title="s.target || undefined">{{ s.name }}</span>
                    <span class="mcpst" :class="mcpState(s).cls">{{ mcpState(s).label }}</span>
                  </div>
                  <!-- Причина отказа — то единственное, по чему сервер чинят -->
                  <div v-if="s.state !== 'ok' && s.detail" class="mcpdetail muted">{{ s.detail }}</div>
                  <div v-if="s.state === 'needs-auth'" class="mcpdetail muted">
                    {{ s.scope === 'account'
                      ? 'Авторизуется в настройках коннекторов на claude.ai — из кокпита ход этого не умеет.'
                      : 'Нужен вход: `claude mcp login ' + s.name + '` в терминале.' }}
                  </div>
                </div>
              </div>
              <p v-if="!mcpGroups(p).length" class="muted small">Серверов не подключено.</p>
              <p v-if="mcpOf(p).checkedAt" class="muted small">
                проверено {{ new Date(mcpOf(p).checkedAt).toLocaleTimeString('ru') }}
              </p>
            </template>
          </div>
          <div class="pvfoot">
            <button v-if="p.installed && p.canUpdate" class="upd" :class="{ hot: p.updateAvailable }" :disabled="!!updating"
                    title="Обновить CLI исполнителя. После обновления каталог моделей перечитается."
                    @click="updateProvider(p)">
              {{ updating === p.id ? 'Обновление…' : 'Обновить' }}
            </button>
          </div>
        </div>
      </div>
      <!-- Общее для всех исполнителей — отдельной карточкой под плашками -->
      <div class="card narrow">
        <div class="prow first">
          <ToggleSwitch :model-value="prefs?.showAllModels === true" label="Показывать все модели: скрытые и старые версии"
                        @update:model-value="toggleShowAllModels" />
          <div class="muted small">
            По умолчанию в выборе — актуальные модели из каталогов установленных исполнителей.
            Скрытые, устаревающие и старые версии доступны по этому флажку; дублирующие алиасы
            схлопываются с канонической моделью.
          </div>
          <p v-if="modelsMsg" class="msg" :class="modelsMsg.type">{{ modelsMsg.text }}</p>
        </div>
        <div class="row">
          <button :disabled="refreshing" @click="refreshProv">{{ refreshing ? 'Проверка…' : 'Перепроверить' }}</button>
          <button :disabled="checking" title="Кокпит и сам проверяет раз в 6 часов; обновление никогда не запускается автоматически"
                  @click="checkUpdates">{{ checking ? 'Смотрю…' : 'Проверить обновления' }}</button>
        </div>
        <p class="muted small">
          Новые версии проверяются автоматически раз в 6 часов (индикатор — точка на иконке
          исполнителя в шапке). Обновление ставится только по кнопке.
        </p>
      </div>
      <div class="card narrow">
        <div>
          <b>Доверенные каталоги</b>
          <p class="muted small trusted-copy">
            Дополнительные деревья, которые Cockpit открывает новым ходам исполнителей,
            поддерживающих эту настройку. Текущий каталог проекта доступен и без этого
            списка; корень <code>/</code> добавить нельзя.
          </p>
          <p v-if="!prov.loaded" class="muted small" data-testid="trusted-directory-providers">
            Определяю исполнителей по реестру…
          </p>
          <p v-else-if="trustedDirectoryProviderNames" class="muted small" data-testid="trusted-directory-providers">
            <b>Настройку применяют:</b> {{ trustedDirectoryProviderNames }}.
          </p>
          <p v-else class="muted small" data-testid="trusted-directory-providers">
            Сейчас ни один чат-исполнитель не применяет эту настройку.
          </p>
        </div>
        <div v-if="trustedDirectories.length" class="trusted-list">
          <div v-for="(directory, index) in trustedDirectories" :key="directory" class="trusted-item">
            <code :title="directory">{{ directory }}</code>
            <button type="button" :disabled="trustedDirectoriesBusy" @click="removeTrustedDirectory(index)">
              Убрать
            </button>
          </div>
        </div>
        <p v-else class="muted small">Дополнительных каталогов пока нет.</p>
        <div class="trusted-add">
          <input v-model="trustedDirectoryInput"
                 :disabled="trustedDirectoriesBusy"
                 placeholder="/home/user/Workspace"
                 aria-label="Абсолютный путь к доверенному каталогу"
                 @keyup.enter="addTrustedDirectory" />
          <button type="button"
                  :disabled="trustedDirectoriesBusy || !trustedDirectoryInput.trim()"
                  @click="addTrustedDirectory">
            Добавить
          </button>
        </div>
        <div class="row">
          <button class="primary" type="button" :disabled="trustedDirectoriesBusy" @click="applyTrustedDirectories">
            {{ trustedDirectoriesBusy ? 'Сохраняю…' : 'Сохранить каталоги' }}
          </button>
        </div>
        <p class="muted small">
          Настройка действует внутри Cockpit и не переписывает глобальные конфиги CLI.
          Режим подтверждений выбранного исполнителя продолжает действовать отдельно.
        </p>
        <p v-if="trustedDirectoriesMsg" class="msg" :class="trustedDirectoriesMsg.type">
          {{ trustedDirectoriesMsg.text }}
        </p>
      </div>
    </section>

    <!-- Запуски: обязательные правила перед стартом триажа/конвейера -->
    <section v-else-if="tab === 'runs'">
      <div class="card">
        <div class="card-head">
          <div>
            <h3>Поведение запусков</h3>
            <p class="muted small">Действует перед триажем задачи и стартом конвейера фабрики.</p>
          </div>
        </div>
        <div v-if="!prefs" class="muted">Загрузка…</div>
        <template v-else>
          <ToggleSwitch :model-value="prefs.gitRefreshBeforeRun" label="Обновлять репозитории перед запуском"
                        @update:model-value="toggleGitRefresh" />
          <p class="muted small">
            Перед триажем и конвейером: <code>git fetch</code> всегда; <code>git pull --ff-only</code> —
            только если репозиторий стоит на чистом master (ветка задачи или незакоммиченные
            правки не трогаются, в результате запуска фиксируется причина пропуска).
          </p>
          <ToggleSwitch :model-value="prefs.autoRecoverPipelines" label="Продолжать незакрытые конвейеры после запуска Cockpit"
                        @update:model-value="toggleAutoRecover" />
          <p class="muted small">
            Кокпит возобновит только прогон с погибшим демоном. Ворота, остановка для
            человека, завершённая задача и повторяющийся сбой остаются заблокированными.
            После трёх аварийных перезапусков потребуется ручное решение.
          </p>
          <div class="compact-setting">
            <label>
              Сжимать контекст чата при
              <NumberField v-model="compactWindow" :min="0" :step="10000" placeholder="0 — не вмешиваться" />
              <span class="unit">токенах</span>
            </label>
            <button class="btn" @click="saveCompactWindow">Сохранить</button>
          </div>
          <p class="muted small">
            CLI умеет сжимать разговор сам, но включает это у самого потолка своего окна:
            на окне 1M — около 950 000 токенов. У Claude ход дорожает гораздо раньше —
            примерно с 250 000: кокпит поднимает процесс агента на каждое сообщение, и выше
            этой границы переписка перестаёт читаться из кэша и пишется в него заново по
            двойному тарифу. У других исполнителей граница стоимости учитывается, только
            если они её объявили. <b>0</b> — не вмешиваться. Claude получает порог через свою
            переменную окружения, Codex — через <code>model_auto_compact_token_limit</code>.
            Кольцо в чате считает до ближайшего события: этого порога (если он не нулевой),
            объявленной исполнителем границы стоимости (если она есть) или 80% окна модели.
            На 80% ближайшей границы кольцо желтеет, на самой границе — краснеет.
          </p>
          <div class="compact-setting">
            <label>
              Сжимать контекст этапа конвейера при
              <NumberField v-model="stageCompactWindow" :min="0" :step="10000" placeholder="0 — не вмешиваться" />
              <span class="unit">токенах</span>
            </label>
            <button class="btn" @click="saveStageCompactWindow">Сохранить</button>
          </div>
          <p class="muted small">
            То же самое, но для агентов на узлах схемы, и порог отдельный: в чате сжатие
            рвёт нить разговора с тобой, а на этапе просто ужимает рабочий контекст между
            вызовами инструментов. На длинном этапе весь хвост может пройти в дорогой зоне,
            где каждый вызов инструмента оплачивается как первый. <b>0</b> — не вмешиваться.
            Применится к новым заходам; уже идущий
            этап доработает как есть.
          </p>
          <div class="compact-setting">
            <label>
              Звать, если ход конвейера молчит дольше
              <NumberField v-model="silenceWindowMin" :min="0" :step="5" placeholder="0 — не звать" />
              <span class="unit">мин</span>
            </label>
            <button class="btn" @click="saveSilenceWindow">Сохранить</button>
          </div>
          <p class="muted small">
            Зависший вызов инструмента не выглядит аварией: демон жив, этап работает,
            а движок вмешается только когда сгорит весь лимит этапа — это часы.
            Порог должен пропускать долгую сборку и прогон тестов, но сработать раньше
            таймаута зависшего MCP. <b>0</b> — не звать.
            Кокпит только оповещает: остановить ход и решить, что с ним делать, — твоё.
          </p>
          <p v-if="prefsMsg" class="msg" :class="prefsMsg.type">{{ prefsMsg.text }}</p>
        </template>
      </div>
      <div class="card">
        <div>
          <b>Диагностическое логирование фабрики</b>
          <p class="muted small debug-copy">
            Помогает разбирать выбор модели, переключение ИИ и ошибки runner-а.
            Не меняет маршрут или результат этапа. Короткий обязательный audit остаётся
            даже в режиме «Выключено».
          </p>
        </div>
        <div v-if="!factoryDebug && !factoryDebugMsg" class="muted">Загрузка…</div>
        <div v-else class="debug-setting">
          <label>
            Уровень
            <select class="settings-select"
                    :value="factoryDebug?.effective || 'off'"
                    :disabled="factoryDebugBusy"
                    @change="saveFactoryDebug($event.target.value)">
              <option v-for="level in FACTORY_DEBUG_LEVELS"
                      :key="level.value"
                      :value="level.value">
                {{ level.label }}
              </option>
            </select>
          </label>
          <span v-if="factoryDebug" class="debug-effective">
            действует: <b>{{ factoryDebug.effective }}</b>
            <span class="muted"> · источник: {{ factoryDebug.source }}</span>
          </span>
        </div>
        <p class="muted small">
          Подробные журналы имеют ограничение размера и срок хранения; prompt, credentials
          и status/control tokens в них не записываются. Выключение не удаляет уже созданные логи.
        </p>
        <p v-if="factoryDebugMsg" class="msg" :class="factoryDebugMsg.type">
          {{ factoryDebugMsg.text }}
        </p>
      </div>
    </section>

    <!-- Плагины: отключаемые блоки кокпита. Системные — из коробки; пользовательские —
         папки plugins/<id>/ (plugin.json + server.js), подхватываются на старте сервера. -->
    <section v-else-if="tab === 'plugins'">
      <p class="section-note">
        Плагин — отключаемый раздел кокпита: пункт в сайдбаре (под разделителем), свои API и настройки.
        Свой плагин — папка <code>plugins/&lt;id&gt;/</code> с манифестом <code>plugin.json</code>
        (+ опционально <code>server.js</code>), появится здесь после рестарта сервера.
      </p>
      <div v-if="!pluginsStore.loaded" class="muted">Загрузка…</div>
      <div v-else class="plugcards">
        <div v-for="p in pluginsStore.list" :key="p.id" class="card plugcard">
          <div class="plughead">
            <div>
              <b>{{ p.name }}</b>
              <span class="plugver">v{{ p.version }}</span>
              <span class="plugtag" :class="{ user: !p.system }">{{ p.system ? 'системный' : 'пользовательский' }}</span>
            </div>
            <ToggleSwitch :model-value="p.enabled" label="" @update:model-value="(v) => pluginsStore.toggle(p.id, v)" />
          </div>
          <p class="muted small">{{ p.description }}</p>
          <p v-if="p.needsRestart" class="muted small">Серверная часть подключается на старте — вкл/выкл подействует после рестарта кокпита.</p>
          <div v-if="p.enabled && p.settings.length" class="plugset">
            <template v-for="s in p.settings" :key="s.key">
              <div class="plugrow" :class="{ wide: s.type === 'model' }">
                <label>{{ s.label }}</label>
                <select v-if="s.type === 'select'" v-model="p.values[s.key]" class="inp">
                  <option v-for="o in s.options" :key="o" :value="o">{{ o }}</option>
                </select>
                <!-- Модель берётся из общего реестра исполнителей — того же, что рисует
                     селект в чате. Значение хранится парой «исполнитель + модель»:
                     склеенной строкой её не разобрать, у локальных исполнителей id
                     модели сам бывает со слэшами и двоеточиями (`hf.co/user/repo:tag`). -->
                <select v-else-if="s.type === 'model'" class="inp"
                        :value="pluginModelValue(p, s.key)"
                        @change="setPluginModel(p, s.key, $event.target.value)">
                  <option value="">— не выбрана —</option>
                  <!-- Выбор мог пропасть из каталога (сменили CLI, демон молчит).
                       Молча показать «не выбрана» нельзя: в настройках он остался,
                       и сервер всё ещё ходит именно этой моделью. -->
                  <option v-if="pluginModelLost(p, s.key)" :value="pluginModelValue(p, s.key)">
                    {{ pluginModelLost(p, s.key) }} — нет в реестре
                  </option>
                  <optgroup v-for="g in modelGroups" :key="g.id"
                            :label="g.name + (g.available ? '' : ' — недоступен')">
                    <option v-for="m in g.models" :key="m.id" :value="`${g.id}:${m.id}`" :disabled="!g.available">
                      {{ m.name }}
                    </option>
                  </optgroup>
                </select>
                <input v-else-if="s.type === 'checkbox'" v-model="p.values[s.key]" type="checkbox" />
                <input v-else v-model="p.values[s.key]" class="inp" type="text" />
              </div>
              <p v-if="s.hint" class="muted small plughint">{{ s.hint }}</p>
            </template>
            <button class="btn" @click="savePlugin(p)">Сохранить</button>
            <span v-if="plugMsg === p.id" class="msg ok">Сохранено</span>
          </div>
        </div>
      </div>
    </section>

    <!-- Сервер: демон systemd, перезапуск для применения нового кода (плагины, правки сервера) -->
    <section v-else-if="tab === 'server'">
      <p class="section-note">
        Боевой режим — демон systemd: юнит ставится один раз командой <code>deploy/install.sh</code>,
        дальше сервер живёт сам (<code>Restart=always</code>, ждёт VPN, переживает перезагрузки).
        Локальный checkout и опубликованный релиз применяются разными явными действиями:
        ни одно из них не выполняет неявный <code>git pull</code> и не затирает WIP.
      </p>
      <div class="card cockpit-release-card">
        <div class="card-head">
          <div>
            <h3>Версия Cockpit</h3>
            <p class="muted small">Запущенный процесс, текущий checkout и стабильный канал релизов.</p>
          </div>
          <span v-if="cockpitStatus" class="status-pill"
                :class="cockpitJob?.status === 'failed' ? 'danger' : cockpitStatus.updateAvailable ? 'warn' : 'ok'">
            <span class="dot"></span>
            {{ cockpitJob?.status === 'failed' ? 'Ошибка применения' : cockpitStatus.updateAvailable ? 'Есть релиз' : 'Актуально' }}
          </span>
        </div>
        <div v-if="cockpitUpdate.loading && !cockpitStatus" class="muted">Читаю локальную версию…</div>
        <template v-else-if="cockpitStatus">
          <dl class="version-facts">
            <div>
              <dt>Запущено</dt>
              <dd><b>{{ cockpitStatus.running.version }}</b> · <code>{{ shortSha(cockpitStatus.running.sha) }}</code></dd>
            </div>
            <div>
              <dt>Checkout</dt>
              <dd>
                <b>{{ cockpitStatus.checkout.version }}</b> · <code>{{ shortSha(cockpitStatus.checkout.sha) }}</code>
                · {{ cockpitStatus.checkout.branch || 'detached HEAD' }}
                <span v-if="cockpitStatus.checkout.dirty" class="dirty-mark">dirty</span>
              </dd>
            </div>
            <div>
              <dt>Стабильный канал</dt>
              <dd v-if="cockpitStatus.latest">
                <b>{{ cockpitStatus.latest.tag }}</b> · <code>{{ shortSha(cockpitStatus.latest.sha) }}</code>
                <a v-if="cockpitStatus.latest.url" :href="cockpitStatus.latest.url" target="_blank" rel="noopener noreferrer">Что изменилось ↗</a>
              </dd>
              <dd v-else>релизы пока не найдены</dd>
            </div>
            <div>
              <dt>Последняя проверка</dt>
              <dd>{{ fmtChecked(cockpitStatus.checkedAt) }}</dd>
            </div>
            <div>
              <dt>Web-бандл</dt>
              <dd>
                {{ clientBuildVersion }} · <code>{{ shortSha(clientBuildSha) }}</code>
                <span v-if="clientBuildSha !== 'dev' && clientBuildSha !== cockpitStatus.running.sha" class="dirty-mark">
                  ожидает обновления PWA
                </span>
              </dd>
            </div>
          </dl>

          <p v-if="cockpitStatus.checkoutChanged" class="msg info">
            Checkout изменился после запуска сервера. Чтобы запущенный процесс и web-бандл
            соответствовали ему, примените локальные изменения.
          </p>
          <p v-if="cockpitStatus.checkError" class="msg warn">
            {{ cockpitStatus.checkError.message }} Последний успешный результат сохранён.
          </p>

          <div v-if="cockpitJob" class="update-job" :class="cockpitJob.status">
            <b>{{ UPDATE_STAGE_LABELS[cockpitJob.stage] || cockpitJob.stage }}</b>
            <span class="muted small">
              {{ cockpitJob.kind === 'update' ? `Релиз ${cockpitJob.targetTag}` : 'Локальный checkout' }}
              · {{ shortSha(cockpitJob.targetSha) }}
            </span>
            <p v-if="cockpitJob.error" class="msg err">{{ cockpitJob.error.message }}</p>
          </div>

          <div class="row update-actions">
            <button :disabled="cockpitUpdate.checking || cockpitUpdate.active" @click="cockpitUpdate.check">
              {{ cockpitUpdate.checking ? 'Проверяю…' : 'Проверить обновления' }}
            </button>
            <button :disabled="!cockpitStatus.canApplyCheckout || cockpitUpdate.actionBusy"
                    @click="startCockpitAction('apply')">
              Применить локальные изменения
            </button>
            <button v-if="cockpitStatus.latest" class="primary"
                    :disabled="!cockpitStatus.canInstallRelease || cockpitUpdate.actionBusy"
                    @click="startCockpitAction('update')">
              Обновить до {{ cockpitStatus.latest.tag }}
            </button>
          </div>

          <ul v-if="cockpitStatus.applyBlockReasons?.length" class="block-reasons">
            <li v-for="reason in cockpitStatus.applyBlockReasons" :key="`apply-${reason}`">
              Локальное применение: {{ blockReasonLabel(reason) }}
            </li>
          </ul>
          <ul v-if="cockpitStatus.installBlockReasons?.length" class="block-reasons">
            <li v-for="reason in cockpitStatus.installBlockReasons" :key="`install-${reason}`">
              Установка релиза: {{ blockReasonLabel(reason) }}
            </li>
          </ul>
          <p v-if="cockpitUpdate.error" class="msg err">{{ cockpitUpdate.error }}</p>
        </template>
        <p v-else class="msg err">Не удалось прочитать состояние версии Cockpit.</p>
      </div>
      <div class="card">
        <div class="card-head">
          <div>
            <h3>Процесс Cockpit</h3>
            <p class="muted small">Перезапуск применяет свежий серверный код и состав плагинов.</p>
          </div>
          <span v-if="srv" class="status-pill" :class="srv.systemd ? 'ok' : 'warn'">
            <span class="dot"></span>{{ srv.systemd ? 'Под управлением systemd' : 'Ручной запуск' }}
          </span>
        </div>
        <div v-if="!srv" class="muted">Загрузка…</div>
        <template v-else>
          <p class="srvline">
            Режим: <b>{{ srv.systemd ? 'демон systemd' : 'запущен вручную' }}</b>
            <span class="muted"> · PID {{ srv.pid }} · работает {{ fmtUptime(srv.uptimeSec) }}</span>
          </p>
          <p v-if="!srv.systemd" class="muted small">
            Ручной запуск — режим разработки. Чтобы демон поднимался сам, один раз выполни
            <code>deploy/install.sh</code>. Режимы не смешивать: ручной экземпляр держит порт,
            и юнит будет падать в цикле.
          </p>
          <div class="row">
            <button class="btn" :disabled="restarting || rebuilding" @click="restartServer">
              {{ restarting ? 'Перезапускаю… жду возвращения' : 'Перезапустить сервер' }}
            </button>
            <button class="btn" :disabled="rebuilding || restarting" @click="rebuildWeb">
              {{ rebuilding ? 'Собираю web-бандл…' : 'Пересобрать web-бандл' }}
            </button>
          </div>
          <p class="muted small">Пересборка трогает только web: npm install + vite build из рабочего дерева, включая незакоммиченные правки. Без смены checkout и перезапуска сервера.</p>
          <p v-if="srvMsg" class="msg" :class="srvMsg.type">{{ srvMsg.text }}</p>
        </template>
      </div>
    </section>

    <!-- Доступ: вход в сам кокпит (один пользователь) -->
    <section v-else-if="tab === 'access'">
      <!-- Предупреждение только когда оно по делу: на localhost соединение и так не выходит
           за пределы машины, а за шлюзом браузер идёт по https. -->
      <p v-if="!auth.secure && !auth.isLocal" class="msg err">
        Текущее соединение без HTTPS — пароль передаётся открытым текстом. В карточке
        «В домашней сети» включи локальный HTTPS.
      </p>

      <!-- Сводка строится по фактическим путям, а не по двум неравноценным prefs-флагам:
           LAN без локального TLS остаётся доступен по HTTP, а шлюз вообще живёт отдельно. -->
      <div v-if="!prefs" class="card"><span class="muted">Загрузка способов подключения…</span></div>
      <AccessOverview
        v-else
        :local-https-enabled="prefs.accessLocalHttps === true"
        :local-https-busy="accessBusy === 'accessLocalHttps'"
        :local-message="accessMsg"
        :tls="tls"
        :tls-state="tlsState"
        :tls-error="tlsLoadError"
        :gateway-setup="gwSaved"
        :gateway-job="gwJob"
        :gateway-public-domain="gwPublicDomain"
        :gateway-checks="gwChecks"
        :gateway-state="gatewaySetupState"
        :gateway-error="gatewayLoadError"
        :active-details="activeAccessDetails"
        @set-local-https="setLocalHttpsMode"
        @reload-tls="loadTls"
        @toggle-details="toggleAccessDetails"
      />

      <!-- Учётная запись остаётся доступной независимо от того, раскрыт ли длинный мастер шлюза. -->
      <section class="access-account" aria-labelledby="access-account-title">
        <h3 id="access-account-title" class="sechead">Защита входа</h3>
        <div class="card">
          <div class="card-head">
            <div>
              <h3>Учётная запись</h3>
              <p class="muted small">Один пользователь Cockpit и его активные сессии.</p>
            </div>
            <span class="scope-pill">Сервер</span>
          </div>
          <p class="muted small">
            Пароль хранится хешем на сервере (<code>.state</code>, не в git) и в браузер не
            попадает — клиент получает только сессионную cookie.
          </p>
          <div class="form-grid">
            <label class="full">Логин<input v-model="acc.login" autocomplete="username" placeholder="необязательно" /></label>
            <label class="full">Текущий пароль
              <input v-model="acc.currentPassword" type="password" autocomplete="current-password" />
            </label>
            <label>Новый пароль
              <input v-model="acc.password" type="password" autocomplete="new-password" placeholder="минимум 8 символов" />
            </label>
            <label>Новый пароль ещё раз
              <input v-model="acc.password2" type="password" autocomplete="new-password" />
            </label>
          </div>
          <p class="muted small">
            Смена пароля разлогинивает все устройства — украденная cookie перестаёт работать.
            Текущее устройство останется в системе.
          </p>
          <div class="row">
            <button class="primary" :disabled="accBusy || !acc.currentPassword || !acc.password" @click="saveAccount">
              {{ accBusy ? 'Сохранение…' : 'Сменить пароль' }}
            </button>
            <button @click="auth.doLogout()">Выйти</button>
            <button class="danger-ghost" @click="logoutAll">Выйти со всех устройств</button>
          </div>
          <p v-if="accMsg" class="msg" :class="accMsg.type">{{ accMsg.text }}</p>
        </div>
      </section>

      <!-- Локальный HTTPS: свой корень + сертификат на адрес мозга -->
      <template v-if="tls?.source !== 'env' && activeAccessDetails === 'local'">
      <section
        id="local-https-settings"
        class="access-detail-region"
        role="region"
        aria-labelledby="local-https-settings-title"
        tabindex="-1"
      >
      <div class="access-detail-head">
      <h3 id="local-https-settings-title" class="sechead">Локальный HTTPS</h3>
      <p class="muted">
        Дома PWA не ставится без HTTPS: <code>navigator.serviceWorker</code> существует только
        в защищённом контексте, а сертификат на домашний адрес публичный центр не выпишет.
        Кокпит выпускает свой: корень ставится на устройства один раз, дальше всё как в интернете.
        Порт <code>{{ tls?.httpPort || 8140 }}</code> остаётся как был — по нему кокпит ходит
        сам с собой (фабрика, <code>bin/b24</code>, терминал с мозга).
      </p>
      </div>

      <!-- Ошибку показываем прямо здесь: до перезапуска сервера этих эндпоинтов ещё нет,
           и «Загрузка…» навсегда выглядела бы как зависший запрос. -->
      <div v-if="!tls" class="card">
        <span v-if="!tlsMsg" class="muted">Загрузка…</span>
        <template v-else>
          <p class="msg err">{{ tlsMsg.text }}</p>
          <p class="muted small">
            Если сервер ещё не перезапускался после обновления — перезапусти его на вкладке
            «Сервер»: раздел появится вместе с новыми эндпоинтами.
          </p>
        </template>
      </div>
      <template v-else>
        <p v-if="!tls.openssl" class="msg err">
          На машине нет <code>openssl</code> — выпустить сертификат нечем.
          Поставь его (<code>sudo apt install openssl</code>) и обнови страницу.
        </p>

        <div class="card">
          <p class="tlsline">
            Состояние:
            <b v-if="tls.https.up && tls.needsRestart" class="warn">
              работает с прежней конфигурацией на порту {{ tls.https.port }}
            </b>
            <b v-else-if="tls.https.up" class="ok">работает на порту {{ tls.https.port }}</b>
            <b v-else-if="tls.enabled" class="warn">выпущен, но не поднят</b>
            <b v-else class="off">выключен</b>
            <span v-if="tls.source === 'env'" class="muted"> · сертификат задан переменными окружения</span>
          </p>
          <p v-if="tls.https.error" class="msg err">{{ tls.https.error }}</p>
          <p v-if="tls.needsRestart" class="msg warn">
            Изменения вступят в силу после перезапуска сервера — сертификат читается один раз
            при старте. Кнопка на вкладке «Сервер».
          </p>

          <p v-if="tls.leaf.exists" class="muted small">
            Выписан на {{ tls.leaf.addresses.join(', ') }} ·
            действует до {{ new Date(tls.leaf.notAfter).toLocaleDateString('ru-RU') }}
            ({{ tls.leaf.daysLeft }} дн.)
            <template v-if="tls.ca.exists">
              · корень до {{ new Date(tls.ca.notAfter).toLocaleDateString('ru-RU') }}
            </template>
          </p>
          <p v-if="tls.missingAddresses.length" class="msg warn small">
            Адрес машины изменился: {{ tls.missingAddresses.join(', ') }} нет в сертификате.
            Перевыпусти — устройства при этом трогать не нужно, корень остаётся прежним.
          </p>

          <div class="tlsaddrs">
            <span class="muted small">Адреса, по которым будешь открывать кокпит:</span>
            <label v-for="a in tls.addresses" :key="a.address" class="tlsaddr">
              <input
                type="checkbox"
                :checked="tlsPicked.includes(a.address)"
                @change="toggleTlsAddress(a.address, $event.target.checked)"
              />
              <code>{{ a.address }}</code><span class="muted small">{{ a.iface }}</span>
            </label>
            <p v-if="!tls.addresses.length" class="muted small">
              Сетевых адресов не видно — машина не в сети?
            </p>
          </div>

          <div class="row">
            <button class="primary" :disabled="tlsBusy || !tlsPicked.length || !tls.openssl" @click="generateTls">
              {{ tlsBusy ? 'Выпускаю…' : (tls.leaf.exists ? 'Перевыпустить сертификат' : 'Выпустить сертификат') }}
            </button>
            <button v-if="tls.enabled" class="danger-ghost" :disabled="tlsBusy" @click="dropTlsCertificate">Удалить сертификат</button>
          </div>
          <p v-if="tlsMsg" class="msg" :class="tlsMsg.type">{{ tlsMsg.text }}</p>
        </div>

        <!-- Установка корня. QR ведёт на HTTP-адрес намеренно: он работает и до перезапуска,
             и после (http отдаёт корень даже клиентам из сети). Веди он на https — файл
             пришлось бы качать через то самое предупреждение, которое он и убирает. -->
        <div v-if="tls.ca.exists && tlsAddress()" class="card">
          <p class="tlsline"><b>Поставить корень на устройство</b></p>
          <div class="tlsqr">
            <img :src="`/api/settings/tls/ca.svg?address=${tlsAddress()}`" alt="QR со ссылкой на корневой сертификат" width="180" height="180" />
            <ol class="tlssteps small">
              <li>Наведи камеру планшета — откроется скачивание <code>cockpit-ca.crt</code>.</li>
              <li>Android: «Настройки → Безопасность → Шифрование → Установить сертификат →
                Сертификат ЦС». iOS/iPadOS: профиль установится сам, потом
                «Настройки → Основные → Об устройстве → Доверие сертификатам» — включить тумблер.</li>
              <li>Открой <code>{{ tlsUrl() || `https://${tlsAddress()}:8143` }}</code> — замок без предупреждений,
                и «Установить приложение» появится в меню браузера.</li>
            </ol>
          </div>
          <p class="muted small">
            На самом мозге ставить ничего не нужно: <code>http://localhost:{{ tls.httpPort || 8140 }}</code>
            и так защищённый контекст.
            <a :href="'/api/settings/tls/ca.crt'" download>Скачать корень файлом</a> ·
            отпечаток <code class="fp">{{ (tls.ca.fingerprint || '').slice(0, 29) }}…</code>
          </p>
        </div>
      </template>
      </section>
      </template>

      <!-- Шлюз: установка формой. Руками это два идемпотентных скрипта плюс reconciliation
           двух точных DNS-имён, которых ни один скрипт сделать не может. -->
      <template v-if="activeAccessDetails === 'gateway'">
      <section
        id="gateway-settings"
        class="access-detail-region"
        role="region"
        aria-labelledby="gateway-settings-title"
        tabindex="-1"
      >
      <div class="access-detail-head">
      <h3 id="gateway-settings-title" class="sechead">Доступ снаружи (VPS-шлюз)</h3>
      <p class="muted">
        Кокпит виден по публичному домену, а домашний адрес наружу не выставлен: с мозга на VPS
        идут два исходящих SSH-туннеля (один — кокпит, второй — стенды, чтобы трафик стендов не
        придавливал SSE и терминал). Схема не зависит ни от CGNAT, ни от смены сети.
      </p>
      <p class="section-note">
        Эта панель только настраивает и проверяет шлюз. Если её скрыть, уже установленные
        туннели, публичный домен и внешний доступ продолжат работать.
      </p>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <h3>Что настраиваем</h3>
            <p class="muted small">Выделенный поддомен и временный VPS, через который кокпит виден снаружи.</p>
          </div>
          <span v-if="gwSaved" class="status-pill ok"><i class="dot"></i>{{ gwSaved.domain }}</span>
        </div>
        <div class="form-grid">
          <label>Выделенный поддомен шлюза
            <input v-model="gw.domain" placeholder="cockpit.example.com" :disabled="gwRunning" />
          </label>
          <label>Адрес VPS (IPv4)
            <input v-model="gw.gateway" placeholder="203.0.113.10" :disabled="gwRunning" />
          </label>
          <label>Пользователь SSH
            <input v-model="gw.sshUser" placeholder="root" :disabled="gwRunning" />
          </label>
          <label>Порт SSH
            <input v-model.number="gw.sshPort" type="number" min="1" max="65535" :disabled="gwRunning" />
          </label>
        </div>
        <p class="muted small">
          Стенды поедут на поддомены <code>p&lt;порт&gt;.{{ gw.domain || 'домен' }}</code>, поэтому
          Cockpit резервирует два точных имени: этот поддомен и <code>*</code>. При каждой
          установке они заново сверяются с адресом текущего VPS.
        </p>
      </div>

      <!-- Cloudflare опционален: у другого провайдера DNS записи заводятся руками, и шаг
           честно превращается в подсказку, а не в отказ установки. -->
      <div class="card">
        <div class="card-head">
          <div>
            <h3>DNS-записи</h3>
            <p class="muted small">Единственный шаг, который ни один скрипт не сделает сам.</p>
          </div>
        </div>
        <ToggleSwitch
          :model-value="gw.useCloudflare" :disabled="gwRunning"
          label="Домен на Cloudflare — синхронизировать записи автоматически"
          @update:model-value="gw.useCloudflare = $event"
        />
        <template v-if="gw.useCloudflare">
          <div class="form-grid">
            <label class="full">API-токен Cloudflare
              <input
                v-model="gw.cloudflareToken" type="password" autocomplete="off"
                placeholder="токен с Zone:Read и DNS:Edit" :disabled="gwRunning"
              />
            </label>
          </div>
          <p class="muted small">
            Логин и пароль аккаунта тут не годятся: API Cloudflare ими не управляется вовсе
            (а с двухфакторной — тем более). Нужен токен: кабинет → My&nbsp;Profile →
            API&nbsp;Tokens → Create&nbsp;Token → шаблон «Edit zone DNS». В Permissions должны
            получиться ровно две строки: <code>Zone → Zone → Read</code> и
            <code>Zone → DNS → Edit</code>. Во второй строке средняя колонка — именно
            <b>DNS</b>, не Zone: похожее разрешение <code>Zone → Zone → Edit</code> не даёт
            права менять DNS и закончится отказом. В Zone&nbsp;Resources выбери Include →
            Specific&nbsp;zone → родительскую зону (для <code>cockpit.example.com</code>
            обычно <code>example.com</code>). Токен уходит на сервер только для сверки и
            установки, нигде не сохраняется.
          </p>
          <p class="muted small">
            Облако у записей будет <b>серым</b> (proxied выключен). Оранжевое — это уже прокси
            Cloudflare, а с ним возвращаются 100 секунд на ответ (рвёт долгий ход агента),
            100&nbsp;МБ на тело (рубит загрузку видео) и чужая терминация TLS.
          </p>
          <p class="muted small">
            Перед подтверждением Cockpit прочитает текущие записи и покажет изменения. У двух
            управляемых имён останется ровно по одной A-записи на текущий VPS; старые A,
            AAAA и CNAME удалятся. TXT, MX, CAA и вся остальная зона не затрагиваются.
          </p>
        </template>
        <p v-else class="muted small">
          Записи заведёшь сам в панели своего провайдера — установка их дождётся и назовёт,
          что именно нужно создать.
        </p>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <h3>Доступ к VPS</h3>
            <p class="muted small">Пароль уйдёт один раз — положить туда наш ключ. Нигде не сохраняется.</p>
          </div>
        </div>
        <div class="row">
          <button :disabled="gwBusy || gwRunning || !gw.gateway.trim()" @click="gwProbeHost">
            Проверить сервер
          </button>
          <span v-if="gwBusy && !gwProbe" class="muted small">стучимся…</span>
        </div>
        <template v-if="gwProbe">
          <p class="tlsline">Отпечаток ключа: <code class="fp">{{ gwProbe.fingerprint }}</code>
            <span class="muted small"> ({{ gwProbe.fingerprintType }})</span></p>
          <label class="tlsaddr">
            <input v-model="gwHostOk" type="checkbox" :disabled="gwRunning" />
            <span>Тип и SHA256-отпечаток SSH-ключа совпали с данными хостера</span>
          </label>
          <p class="muted small">
            Это отпечаток ключа самого VPS (SSH host key), а не твоего ключа для входа.
            Ищи в панели хостера поле SSH host key/fingerprint. Если его там нет, открой
            встроенную веб-консоль/VNC хостера — не подключение по SSH — и выполни
            <code>for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done</code>.
            Найди строку того же типа и сравни всё значение <code>SHA256:…</code> посимвольно.
            При несовпадении не ставь галку: сначала проверь IP и не закончилась ли
            переустановка VPS. Без сверки пароль root может уйти чужому серверу посередине.
            Подтверждённый отпечаток запомнится, и при следующем изменении установка
            остановится сама.
          </p>
          <div v-if="gwNeedsPassword" class="form-grid">
            <label class="full">Пароль {{ gw.sshUser || 'root' }} на VPS
              <input
                v-model="gw.sshPassword" type="password" autocomplete="off"
                placeholder="пароль из письма хостера" :disabled="gwRunning"
              />
            </label>
          </div>
          <p v-else class="msg ok">Сервер уже пускает по нашему ключу — пароль не нужен.</p>
          <p v-if="gwNeedsPassword" class="muted small">
            Нужен ровно один раз: положить на сервер наш ключ туннеля. Дальше вход только по
            ключу, пароль никуда не сохраняется.
          </p>
        </template>
        <p v-else class="muted small">
          Сначала проверяем сервер — жив ли он и тот ли это сервер. Пароль спросим после.
        </p>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <h3>Мозг и сертификаты</h3>
            <p class="muted small">Всё необязательное: без этих полей установка тоже проходит.</p>
          </div>
        </div>
        <div class="form-grid">
          <label class="full">Пароль sudo на мозге (необязательно)
            <input
              v-model="gw.sudoPassword" type="password" autocomplete="off"
              placeholder="оставь пустым — дадим команду для терминала" :disabled="gwRunning"
            />
          </label>
          <label class="full">Почта для Let’s Encrypt (необязательно)
            <input v-model="gw.acmeEmail" placeholder="для писем об истечении сертификата" :disabled="gwRunning" />
          </label>
        </div>
        <ToggleSwitch
          :model-value="gw.acmeStaging" :disabled="gwRunning"
          label="Тестовые сертификаты Let’s Encrypt (для проверки схемы)"
          @update:model-value="gw.acmeStaging = $event"
        />
        <p class="muted small">
          У Let’s Encrypt пять неудач на имя в час. Тестовый режим выдаёт недоверенный
          сертификат (браузер ругнётся), зато лимит не тратит — включай, если гоняешь установку
          повторно.
        </p>
      </div>

      <div class="row">
        <button class="primary" :disabled="!gwCanStart" @click="gwStart">Установить</button>
        <button :disabled="gwBusy || gwRunning || (!gwSaved && !gw.domain.trim())" @click="gwVerify">
          Проверить связь
        </button>
      </div>
      <p v-if="gwMsg" class="msg" :class="gwMsg.type">{{ gwMsg.text }}</p>
      <p v-if="!gwCanStart && !gwRunning" class="muted small">
        Кнопка ждёт: домен, адрес VPS, сверенный отпечаток<span v-if="gw.useCloudflare">,
        токен Cloudflare</span><span v-if="gwNeedsPassword">, пароль VPS</span>.
      </p>
      <p v-if="gw.useCloudflare" class="muted small">
        Выключение или удаление VPS само по себе DNS не очищает: токен не хранится, поэтому
        Cockpit не может изменить Cloudflare после установки. Следующий запуск снова заменит
        старый адрес текущим; перед окончательным освобождением IP запись пока нужно удалить вручную.
      </p>

      <!-- Ход установки. Живёт на сервере и уезжает по SSE: начали с компьютера — видно
           и с планшета, F5 картину не теряет. -->
      <div v-if="gwJob" class="card">
        <div class="card-head">
          <div>
            <h3>Установка</h3>
            <p class="muted small">Восемь шагов; сорвавшийся называет причину и не идёт дальше.</p>
          </div>
          <span
            class="status-pill"
            :class="gwJobConfirmed ? 'ok' : (gwJob.state === 'failed' ? 'danger' : 'warn')"
          ><i class="dot"></i>{{ gwJob.state === 'done' ? (gwJobConfirmed ? 'готово и проверено' : 'шаги завершены')
            : (gwJob.state === 'failed' ? 'сорвалась' : 'идёт') }}</span>
        </div>
        <ul class="gwsteps small">
          <li v-for="s in gwJob.steps" :key="s.key">
            <b :class="{ ok: s.state === 'ok', warn: s.state === 'run', off: s.state === 'skip' }">
              {{ GW_MARK[s.state] || '·' }}
            </b>
            <span>{{ s.title }}<span v-if="s.detail" class="muted"> — {{ s.detail }}</span></span>
          </li>
        </ul>
        <p v-if="gwJob.error" class="msg err">{{ gwJob.error.message }}</p>
        <p v-if="gwJob.state === 'done'" class="msg" :class="gwJobConfirmed ? 'ok' : 'warn'">
          <template v-if="gwJobConfirmed">
            Автоматические шаги завершены, внешний адрес проверен:
            <code>https://{{ gwJob.domain }}</code>.
          </template>
          <template v-else>
            Автоматические шаги завершены, но это ещё не подтверждает внешний доступ.
            Выполни оставшиеся действия, перезапуск, если он указан, затем нажми «Проверить связь».
          </template>
        </p>
        <!-- Не «осталось сделать», а чего ждать: трогать VPN визард не просит и не будет. -->
        <p v-if="gwJob.state === 'done'" class="muted small">
          Туннель ходит через VPN — так задумано, менять в нём ничего не нужно. Отсюда две
          особенности: до планшета крюк через выходной узел VPN, а вместе с VPN туннель падает
          и поднимается. Юниты туннеля этого и ждут, поэтому «activating» при опущенном
          VPN — ожидание, а не поломка. Если VPN уже работает через не-TUN интерфейс,
          его имя задаётся как <code>COCKPIT_VPN_IFACE</code> в корневом <code>.env</code>.
        </p>
        <p v-if="gwJob.needsRestart" class="msg warn">
          Нужен перезапуск сервера: домен и режим за прокси читаются один раз при старте.
          Кнопка — во вкладке «Сервер». Из чата агенту перезапускать нельзя: он сам дочерний
          процесс этого сервера.
        </p>
        <details v-if="gwJob.log?.length" class="gwlog">
          <summary class="muted small">Журнал ({{ gwJob.log.length }})</summary>
          <pre>{{ gwJob.log.join('\n') }}</pre>
        </details>
      </div>

      <!-- Что установка сделать не может: чужая панель DNS, root на мозге. Правила для VPN
           здесь нет намеренно — туннель ходит через него, и настройки VPN мы не трогаем. -->
      <div v-if="gwJob?.manual?.length" class="card">
        <div class="card-head">
          <div>
            <h3>Осталось сделать руками</h3>
            <p class="muted small">Шаги, которые кокпит за человека делать не имеет права.</p>
          </div>
        </div>
        <div v-for="m in gwJob.manual" :key="m.key" class="gwman">
          <p class="tlsline"><b>{{ m.title }}</b></p>
          <p class="muted small">{{ m.text }}</p>
          <template v-if="m.command">
            <pre class="gwcmd">{{ m.command }}</pre>
            <div class="row">
              <button @click="gwManualToTerminal(m)">Открыть в терминале</button>
            </div>
          </template>
        </div>
      </div>

      <div v-if="gwChecks" class="card">
        <div class="card-head">
          <div>
            <h3>Проверка связи</h3>
            <p class="muted small">Живые запросы снаружи: туннели, кокпит и стенд под входом.</p>
          </div>
          <span class="status-pill" :class="gwChecks.ok ? 'ok' : 'warn'">
            <i class="dot"></i>{{ gwChecks.ok ? 'всё сходится' : 'есть замечания' }}
          </span>
        </div>
        <ul class="gwsteps small">
          <li v-for="c in gwChecks.checks" :key="c.key">
            <b :class="c.ok ? 'ok' : 'warn'">{{ c.ok ? '✓' : '✗' }}</b>
            <span>{{ c.title }}<span v-if="c.detail" class="muted"> — {{ c.detail }}</span></span>
          </li>
        </ul>
        <p v-if="gwSaved && !gwPublicDomain" class="muted small">
          Стенды проверятся после перезапуска сервера — до него домен в конфиг не попал.
        </p>
      </div>
      </section>
      </template>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings {
  width: min(100%, 1280px);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.settings-hero {
  position: relative;
  min-height: 150px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 28px;
  padding: 28px 30px;
  border: 1px solid var(--line);
  border-radius: 18px;
  background:
    radial-gradient(circle at 82% 20%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 28%),
    linear-gradient(135deg, color-mix(in srgb, var(--surface) 94%, var(--accent)) 0%, var(--surface) 72%);
  box-shadow: var(--shadow);
}
.settings-hero::after {
  content: '';
  position: absolute;
  inset: auto -70px -110px auto;
  width: 280px;
  height: 220px;
  border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent);
  border-radius: 50%;
}
.settings-hero > div:first-child { position: relative; z-index: 1; max-width: 680px; }
.settings-hero h2, .section-intro h2 { margin: 0; letter-spacing: -.025em; }
.settings-hero h2 { font-size: clamp(23px, 2vw, 30px); line-height: 1.2; }
.settings-hero p:last-child { max-width: 620px; margin: 10px 0 0; color: var(--ink-mid); }
.eyebrow {
  margin: 0 0 6px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 720;
  letter-spacing: .095em;
  line-height: 1.2;
  text-transform: uppercase;
}
.hero-mark {
  position: relative;
  z-index: 1;
  flex: none;
  display: grid;
  place-items: center;
  width: 72px;
  height: 72px;
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--line));
  border-radius: 22px;
  background: color-mix(in srgb, var(--accent) 10%, var(--ground));
  color: var(--accent);
  transform: rotate(3deg);
}
.hero-mark svg { width: 34px; height: 34px; }

.settings-layout {
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  align-items: start;
  gap: 28px;
}
.settings-nav-wrap { min-width: 0; }
.settings-nav {
  position: sticky;
  top: 0;
  display: grid;
  gap: 14px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface) 86%, transparent);
}
.nav-group { display: grid; gap: 3px; }
.nav-group-label {
  padding: 5px 10px 4px;
  color: var(--ink-mid);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.settings-nav-item {
  position: relative;
  width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--ink-mid);
  cursor: pointer;
  text-align: left;
  transition: border-color .15s, background .15s, color .15s;
}
.settings-nav-item::before {
  content: '';
  position: absolute;
  left: -11px;
  width: 3px;
  height: 22px;
  border-radius: 0 4px 4px 0;
  background: transparent;
}
.settings-nav-item:hover { border-color: var(--line); background: var(--surface-2); color: var(--ink); }
.settings-nav-item.active {
  border-color: color-mix(in srgb, var(--accent) 30%, var(--line));
  background: color-mix(in srgb, var(--accent) 11%, var(--surface-2));
  color: var(--ink);
}
.settings-nav-item.active::before { background: var(--accent); }
.settings-nav-item svg { flex: none; width: 20px; height: 20px; color: currentColor; }
.settings-nav-item.active svg { color: var(--accent); }
.settings-nav-item > span { min-width: 0; display: grid; gap: 1px; }
.settings-nav-item strong { overflow: hidden; font-size: 13.5px; font-weight: 630; text-overflow: ellipsis; }
.settings-nav-item small { overflow: hidden; color: var(--ink-mid); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }

.settings-workspace { min-width: 0; max-width: 860px; }
.settings-workspace.wide { max-width: none; }
.section-intro {
  min-height: 80px;
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 2px 0 20px;
  border-bottom: 1px solid var(--line);
}
.section-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--line));
  border-radius: 12px;
  background: color-mix(in srgb, var(--accent) 9%, var(--surface));
  color: var(--accent);
}
.section-icon svg { width: 21px; height: 21px; }
.section-intro h2 { font-size: 22px; line-height: 1.2; }
.section-intro p:last-child { max-width: 700px; margin: 5px 0 0; color: var(--ink-mid); font-size: 13.5px; }
section { display: flex; flex-direction: column; gap: 14px; padding-top: 18px; }
.section-note {
  max-width: 760px;
  margin: 0;
  padding: 11px 13px;
  border-left: 2px solid color-mix(in srgb, var(--accent) 58%, var(--line));
  border-radius: 0 9px 9px 0;
  background: color-mix(in srgb, var(--accent) 6%, transparent);
  color: var(--ink-mid);
  font-size: 12.5px;
}
.section-note code { background: var(--surface-2); border-radius: 4px; padding: 1px 5px; font-size: 12px; }

.muted code { background: var(--surface-2); border-radius: 4px; padding: 1px 5px; font-size: 12px; }
.card {
  min-width: 0;
  background: linear-gradient(180deg, color-mix(in srgb, var(--surface) 96%, #fff) 0%, var(--surface) 100%);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 13px;
  box-shadow: inset 0 1px 0 #ffffff08;
}
.card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.card-head h3 { margin: 0; font-size: 14px; font-weight: 660; letter-spacing: -.01em; }
.card-head p { margin: 4px 0 0; }
.scope-pill, .status-pill {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 25px;
  padding: 3px 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--ground);
  color: var(--ink-mid);
  font-size: 10.5px;
  white-space: nowrap;
}
.status-pill .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ink-mid); }
.status-pill.ok { border-color: color-mix(in srgb, var(--good) 34%, var(--line)); color: var(--good); }
.status-pill.ok .dot { background: var(--good); box-shadow: 0 0 6px color-mix(in srgb, var(--good) 55%, transparent); }
.status-pill.warn { border-color: color-mix(in srgb, var(--warn) 38%, var(--line)); color: var(--warn); }
.status-pill.warn .dot { background: var(--warn); }
.status-pill.danger { border-color: color-mix(in srgb, var(--bad) 38%, var(--line)); color: var(--bad); }
.status-pill.danger .dot { background: var(--bad); }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.form-grid .full { grid-column: 1 / -1; }
.speech-choice-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.speech-choice {
  display: flex; flex-direction: row; align-items: flex-start; gap: 10px; min-width: 0;
  padding: 12px; border: 1px solid var(--line); border-radius: 11px; background: var(--ground);
  cursor: pointer;
}
.speech-choice.active { border-color: color-mix(in srgb, var(--accent) 65%, var(--line));
  background: color-mix(in srgb, var(--accent) 8%, var(--ground)); }
.speech-choice input { flex: none; width: 16px; height: 16px; margin: 2px 0 0; padding: 0; accent-color: var(--accent); }
.speech-choice span { min-width: 0; display: grid; gap: 4px; color: var(--ink); }
.speech-choice small { color: var(--ink-mid); font-size: 12px; line-height: 1.45; }
.speech-choice code { font-size: 11px; }
.speech-subhead { margin-top: 3px; color: var(--ink-mid); font-size: 11px; font-weight: 700;
  letter-spacing: .06em; text-transform: uppercase; }
.speech-field { gap: 7px; }
.speech-field textarea, .speech-select {
  width: 100%; box-sizing: border-box; border: 1px solid var(--line); border-radius: 9px;
  background: var(--ground); color: var(--ink); padding: 10px 11px; font: inherit; font-size: 14px;
}
.speech-field textarea { resize: vertical; min-height: 116px; line-height: 1.45; }
.speech-field textarea:focus, .speech-select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.speech-select option { background: var(--surface); color: var(--ink); }
.speech-quality-block { display: grid; gap: 9px; }
.speech-quality-block + .speech-quality-block { padding-top: 13px; border-top: 1px solid var(--line); }
.speech-quality-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; }
.speech-quality { display: flex; flex-direction: row; align-items: flex-start; gap: 9px; min-width: 0;
  padding: 11px; border: 1px solid var(--line); border-radius: 10px; background: var(--ground); cursor: pointer; }
.speech-quality.active { border-color: color-mix(in srgb, var(--accent) 65%, var(--line));
  background: color-mix(in srgb, var(--accent) 8%, var(--ground)); }
.speech-quality input { flex: none; width: 15px; height: 15px; margin: 2px 0 0; padding: 0; accent-color: var(--accent); }
.speech-quality span { display: grid; gap: 3px; min-width: 0; color: var(--ink); }
.speech-quality small { color: var(--ink-mid); font-size: 11.5px; line-height: 1.4; }
.speech-advanced-toggle { justify-self: start; }
.speech-advanced { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 11px;
  padding-top: 13px; border-top: 1px dashed var(--line); }
.speech-check { grid-column: 1 / -1; display: flex; flex-direction: row; align-items: flex-start; gap: 9px;
  padding: 10px 11px; border: 1px solid var(--line); border-radius: 9px; background: var(--ground); }
.speech-check input { flex: none; width: 16px; height: 16px; padding: 0; margin-top: 2px; accent-color: var(--accent); }
.speech-check span { display: grid; gap: 3px; }
.speech-check small { color: var(--ink-mid); line-height: 1.4; }
.speech-field-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.speech-field-actions button { padding: 7px 10px; font-size: 12px; }
.speech-model-list { display: grid; gap: 9px; }
.speech-model-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 9px 12px;
  padding: 11px; border: 1px solid var(--line); border-radius: 10px; background: var(--ground); }
.speech-model-main { display: grid; gap: 2px; min-width: 0; }
.speech-model-main > .muted { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.speech-model-state { width: fit-content; margin-top: 3px; border-radius: 999px; padding: 2px 7px; font-size: 10.5px; }
.speech-model-state.ready { background: color-mix(in srgb, var(--good) 12%, transparent); color: var(--good); }
.speech-model-state.missing { background: var(--surface-2); color: var(--ink-mid); }
.speech-model-actions { display: flex; align-items: center; justify-content: flex-end; gap: 7px; flex-wrap: wrap; }
.speech-model-actions button { padding: 7px 10px; font-size: 12px; }
.speech-job { grid-column: 1 / -1; display: grid; gap: 5px; padding-top: 7px; border-top: 1px dashed var(--line);
  color: var(--ink-mid); font-size: 12px; }
.speech-job > div { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.speech-job progress { width: 100%; height: 7px; accent-color: var(--accent); }
.speech-job.done { color: var(--good); }
.speech-job.failed, .speech-job.interrupted { color: var(--bad); }
.speech-cancel { padding: 4px 8px; font-size: 11px; }
.speech-env-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.speech-env-grid > div { display: grid; align-content: start; gap: 6px; padding: 11px;
  border: 1px solid var(--line); border-radius: 10px; background: var(--ground); }
.speech-env-grid p { margin: 0; }
.speech-checks { display: grid; gap: 3px; margin: 2px 0 0; padding-left: 18px; font-size: 11.5px; }
.speech-checks .ok { color: var(--good); }
.speech-checks .err { color: var(--bad); }
.speech-benchmark { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding-top: 12px; border-top: 1px solid var(--line); }
.speech-benchmark p { margin: 3px 0 0; }
/* Карточки плагинов — горизонтальной линией, с переносом на узких экранах. */
.plugcards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); gap: 14px; align-items: start; }
.plugcard { gap: 8px; }
.plughead { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.plugver { color: var(--mut); font-size: 12px; margin-left: 8px; }
.plugtag { font-size: 11px; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; margin-left: 8px; color: var(--mut); }
.plugtag.user { border-color: color-mix(in srgb, var(--accent) 45%, transparent); color: var(--accent); }
.plugcard .small { flex: 1; }
.plugset { display: flex; flex-direction: column; gap: 8px; border-top: 1px dashed var(--line); padding-top: 10px; }
.plugrow { display: flex; align-items: center; gap: 10px; }
.plugrow label { min-width: 140px; color: var(--mut); font-size: 13px; }
.plugrow .inp { max-width: 220px; }
.plugrow input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--accent); }
/* Нормальный селект вместо нативного: свой фон, рамка и шеврон. */
.plugrow select.inp {
  appearance: none; -webkit-appearance: none;
  background: var(--bg) url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23888da8' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 10px center;
  border: 1px solid var(--line); border-radius: 8px; color: var(--ink);
  padding: 6px 28px 6px 10px; font: inherit; font-size: 13px; cursor: pointer;
}
.plugrow select.inp:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.plugrow select.inp:focus { outline: none; border-color: var(--accent); }
/* Раскрытый список рисует система, и фон от самого селекта он не наследует:
   без этого правила на тёмной теме он нечитаем (та же грабля, что в чате). */
.plugrow select.inp option, .plugrow select.inp optgroup { background: var(--surface); color: var(--ink); }
/* Выбор модели: подпись сверху, селект во всю карточку — названия моделей вместе
   с именем исполнителя в 220 px не помещаются. */
.plugrow.wide { flex-direction: column; align-items: stretch; gap: 5px; }
.plugrow.wide label, .plugrow.wide .inp { min-width: 0; max-width: none; }
.plughint { margin: -3px 0 2px; }
label { min-width: 0; display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--ink-mid); }
input { width: 100%; min-width: 0; padding: 10px 11px; border: 1px solid var(--line); border-radius: 9px; background: var(--ground); color: var(--ink); font-size: 14px; }
input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.debug-copy { margin: 5px 0 0; }
.trusted-copy { margin: 5px 0 0; }
.trusted-list { display: grid; gap: 7px; }
.trusted-item { display: flex; align-items: stretch; gap: 8px; min-width: 0; }
.trusted-item code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; background: var(--ground); border: 1px solid var(--line);
  border-radius: 7px; padding: 0 9px; height: 36px; box-sizing: border-box;
  display: flex; align-items: center; font-size: 12px; }
.trusted-item button { flex: none; height: 36px; box-sizing: border-box; padding: 0 10px; font-size: 12px; }
.trusted-add { display: flex; align-items: stretch; gap: 8px; }
.trusted-add input { flex: 1; min-width: 0; height: 38px; box-sizing: border-box; }
.trusted-add button { height: 38px; box-sizing: border-box; }
.debug-setting { display: flex; align-items: end; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.debug-setting label { min-width: 230px; }
/* Порог автокомпакта: подпись, поле и единица в одну строку — значение читается как
   фраза («сжимать при N токенах»), а не как безымянное число в форме. */
.compact-setting { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
.compact-setting label { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.compact-setting label :deep(.nf) { width: 130px; }
.compact-setting .unit { color: var(--ink-mid); }
.debug-effective { font-size: 12px; padding-bottom: 8px; color: var(--ink-mid); }
.settings-select {
  appearance: none; -webkit-appearance: none;
  background: var(--ground) url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23888da8' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 11px center;
  border: 1px solid var(--line); border-radius: 9px; color: var(--ink);
  padding: 9px 32px 9px 11px; font: inherit; font-size: 14px; cursor: pointer;
}
.settings-select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.settings-select:disabled { opacity: .55; cursor: default; }
/* Настройка показа моделей — отделена от списка исполнителей */
.prow { border-top: 1px solid var(--line); margin-top: 12px; padding-top: 12px; display: grid; gap: 6px; }
/* Первый блок своей карточки — отбивать сверху не от чего */
.prow.first { border-top: none; margin-top: 0; padding-top: 0; }
button { padding: 9px 14px; border-radius: 9px; border: 1px solid var(--line); background: var(--surface-2); color: var(--ink); font-size: 14px; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
button.primary { background: var(--accent); color: #07101d; border-color: var(--accent); font-weight: 650; }
button.danger-ghost { border-color: color-mix(in srgb, var(--bad) 42%, var(--line)); color: color-mix(in srgb, var(--bad) 82%, #fff); }
button.danger-ghost:hover:not(:disabled) { background: color-mix(in srgb, var(--bad) 10%, var(--surface-2)); border-color: var(--bad); }
.msg { font-size: 13px; margin: 0; white-space: pre-line; }
.small { font-size: 12px; line-height: 1.5; }
.msg.ok { color: var(--good); }
.msg.err { color: var(--bad); }

/* Плашка исполнителя: у каждого ИИ своя карточка, карточки — горизонтальным рядом */
/* Без align-items: start — плашки в ряду тянутся до общей высоты */
.pvcards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 350px), 1fr)); gap: 14px; }
.pvcard { gap: 10px; }
.pvhead { display: flex; align-items: center; gap: 10px; }
.pvtitle { flex: 1; min-width: 0; }
.pvfacts { display: grid; gap: 2px; }
.pvicon { flex: none; display: grid; place-items: center; width: 34px; height: 34px;
  border: 1px solid var(--line); border-radius: 9px; background: var(--ground); }
.pvname { font-size: 14px; font-weight: 600; }
.pvsub { font-size: 12.5px; }
/* Свои настройки исполнителя — отбиты от фактов о CLI, как у карточек плагинов */
.pvset { display: flex; flex-direction: column; gap: 8px; border-top: 1px dashed var(--line); padding-top: 10px; }
.pvsetttl { font-size: 12px; color: var(--ink-mid); text-transform: uppercase; letter-spacing: .04em; }
.pvsetrow { display: grid; gap: 3px; }
.pvsetline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pvsetinput { flex: 1; min-width: 140px; padding: 6px 9px; border: 1px solid var(--line);
  border-radius: 8px; background: var(--ground); color: var(--ink); font-size: 13px; }
.pvsetinput:focus { outline: none; border-color: var(--accent); }
.pvsetinput:disabled { opacity: .55; cursor: not-allowed; }
.pvsetrange { flex: 1; min-width: 140px; accent-color: var(--accent); }
.pvsetrange:disabled { opacity: .55; cursor: not-allowed; }
.pvrangeval { font-size: 12px; color: var(--mut, var(--ink-mid)); white-space: nowrap;
  font-variant-numeric: tabular-nums; }
.pvsetlbl { font-size: 13px; }
/* Ручка объявлена исполнителем, но ещё не подключена к ходу */
.pvsoon { font-size: 11px; border: 1px solid var(--line); border-radius: 999px;
  padding: 1px 8px; color: var(--mut, var(--ink-mid)); }
/* MCP-серверы исполнителя: заголовок с кнопкой проверки, затем секции по scope */
.pvsetttl { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.mcpbtn { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink);
  border-radius: 8px; padding: 3px 9px; font-size: 11px; cursor: pointer;
  text-transform: none; letter-spacing: 0; }
.mcpbtn:disabled { opacity: .55; cursor: default; }
.mcpgrp { display: grid; gap: 4px; }
.mcpgrpttl { font-size: 11.5px; }
.mcpgrphint { font-size: 11px; line-height: 1.4; opacity: .8; }
.mcprow { display: grid; gap: 2px; padding: 3px 0; }
.mcpline { display: flex; align-items: center; gap: 8px; }
.mcpdot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--ink-mid); }
.mcpdot.ok { background: var(--good); box-shadow: 0 0 6px color-mix(in srgb, var(--good) 60%, transparent); }
.mcpdot.err { background: var(--bad); }
.mcpdot.warn { background: var(--warn, #e0a33a); }
/* Аккаунтный коннектор: локальной проверки нет, поэтому и цвета тревоги нет */
.mcpdot.idle { background: var(--ink-mid); }
/* Имя может быть длинным (у коннекторов оно с префиксом) — режем его, а не колонку:
   без min-width: 0 флекс-элемент не сжимается ниже своего содержимого и распирает плашку */
.mcpname { flex: 1; min-width: 0; font-size: 13px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.mcpst { flex: none; font-size: 12px; }
.mcpst.ok { color: var(--good); }
.mcpst.err { color: var(--bad); }
.mcpst.warn { color: var(--warn, #e0a33a); }
.mcpst.idle { color: var(--ink-mid); }
.mcpdetail { font-size: 11.5px; line-height: 1.45; padding-left: 16px;
  overflow-wrap: anywhere; }
/* Кнопка футера прижата к низу плашки: при равной высоте ряда кнопки в одну линию */
.pvfoot { display: flex; justify-content: flex-end; margin-top: auto; }
.upd { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink); border-radius: 8px;
  padding: 5px 11px; font-size: 12px; cursor: pointer; }
.upd:hover:not(:disabled) { border-color: var(--line-2); }
.upd:disabled { opacity: .55; cursor: default; }
/* Есть новая версия — кнопка заметная, но ничего не делает сама */
.upd.hot { border-color: color-mix(in srgb, var(--warn, #e0a33a) 55%, var(--line));
  background: color-mix(in srgb, var(--warn, #e0a33a) 14%, transparent); color: var(--warn, #e0a33a); }
.pvupd { margin-top: 3px; font-size: 12.5px; color: var(--warn, #e0a33a); }
.pvupd b { font-weight: 600; }
.pvstate { flex: none; display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; }
.pvstate .dot { width: 8px; height: 8px; border-radius: 50%; }
.pvstate.ok { color: var(--good); }
.pvstate.ok .dot { background: var(--good); box-shadow: 0 0 6px color-mix(in srgb, var(--good) 60%, transparent); }
.pvstate.err { color: var(--bad); }
.pvstate.err .dot { background: var(--bad); }
/* Подсказка установки недоступного исполнителя */
.pvinstall { font-size: 12px; color: var(--ink-mid); margin-top: 4px; }
.pvinstall code.click { background: var(--ground); border: 1px solid var(--line); border-radius: 5px;
  padding: 2px 7px; font-size: 11.5px; cursor: pointer; user-select: all; }
.pvinstall code.click:hover { border-color: var(--line-2); color: var(--ink); }

/* Сервер: строка режима + кнопка перезапуска */
.srvline { margin: 0; font-size: 13.5px; }
.srvline b { font-weight: 640; }
.version-facts { display: grid; gap: 10px; margin: 0; }
.version-facts > div { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 12px; align-items: baseline; }
.version-facts dt { color: var(--ink-mid); font-size: 12px; }
.version-facts dd { margin: 0; min-width: 0; font-size: 13px; overflow-wrap: anywhere; }
.version-facts dd b { font-weight: 650; }
.version-facts dd code { background: var(--ground); border-radius: 5px; padding: 1px 5px; }
.version-facts dd a { margin-left: 8px; color: var(--accent); }
.dirty-mark { margin-left: 6px; color: var(--warn); font-size: 11px; }
.msg.info { color: var(--accent); }
.update-job { display: grid; gap: 4px; padding: 11px 12px; border: 1px solid var(--line); border-radius: 9px; background: var(--ground); }
.update-job.failed { border-color: color-mix(in srgb, var(--bad) 40%, var(--line)); }
.update-job.done { border-color: color-mix(in srgb, var(--good) 40%, var(--line)); }
.update-actions { align-items: center; }
.block-reasons { margin: 0; padding-left: 18px; display: grid; gap: 5px; color: var(--ink-mid); font-size: 12px; line-height: 1.45; }

/* Локальный HTTPS */
.sechead { margin: 12px 0 0; font-size: 14px; font-weight: 640; }
.access-account { display: grid; gap: 8px; }
.access-account > .sechead { margin: 0; }
.access-detail-region {
  display: grid;
  gap: 12px;
  scroll-margin-top: 18px;
}
.access-detail-region:focus { outline: none; }
.access-detail-region:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
  border-radius: 8px;
}
.access-detail-head { display: grid; gap: 8px; padding-top: 4px; }
.access-detail-head .sechead, .access-detail-head > p { margin: 0; }

/* Режим доступа: тумблер + пояснение под ним, выровненное по подписи тумблера. */
.mode { display: grid; gap: 2px; }
.mode > p { margin: 0 0 0 39px; }
.mode + .mode { border-top: 1px solid var(--line); padding-top: 12px; }
.notification-mode > p { margin-left: 0; }
.notification-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.notification-line > div { display: grid; gap: 2px; }
.notification-line p { margin: 0; }
.notification-line button { flex: none; }
.tlsline { margin: 0; font-size: 13.5px; }
.tlsline b { font-weight: 640; }
.tlsline b.ok { color: var(--good); }
.tlsline b.warn { color: var(--warn, #e0a33a); }
.tlsline b.off { color: var(--ink-mid); }
.msg.warn { color: var(--warn, #e0a33a); }
.tlsaddrs { display: grid; gap: 6px; }
.tlsaddr { flex-direction: row; align-items: center; gap: 8px; }
.tlsaddr input { flex: none; width: 15px; height: 15px; accent-color: var(--accent); padding: 0; }
.tlsaddr code { background: var(--ground); border: 1px solid var(--line); border-radius: 6px;
  padding: 2px 7px; font-size: 12.5px; }
.tlsqr { display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap; }
/* QR всегда на белом: тёмный фон карточки камера читает через раз */
.tlsqr img { flex: none; background: #fff; border-radius: 8px; padding: 6px; }
.tlssteps { flex: 1; min-width: 240px; margin: 0; padding-left: 18px; display: grid; gap: 6px;
  color: var(--ink-mid); }
.tlssteps code { background: var(--surface-2); border-radius: 4px; padding: 1px 5px; font-size: 12px; }
.fp { font-size: 11px; }

/* Шлюз наружу: ход установки, ручные шаги и журнал.
   Свой список, а не .tlssteps: там <ol> с номерами, а у шага уже есть своя метка
   состояния — номер рядом с «✓» читается как второй значок. */
.gwsteps { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; color: var(--ink-mid); }
.gwsteps li { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.gwsteps li > span { min-width: 0; overflow-wrap: anywhere; }
.gwsteps b { flex: none; width: 12px; text-align: center; font-weight: 700; color: var(--ink-mid); }
.gwsteps b.ok { color: var(--good); }
.gwsteps b.warn { color: var(--warn, #e0a33a); }
.gwsteps b.off { color: var(--ink-dim, var(--ink-mid)); }

.gwman { display: grid; gap: 6px; padding: 11px 12px; border: 1px solid var(--line);
  border-radius: 9px; background: var(--ground); }
.gwman + .gwman { margin-top: 8px; }
.gwman p { margin: 0; }
/* Команда показывается ЦЕЛИКОМ с переносом: по ней принимают решение, многоточие тут вредно.
   Без overflow-wrap длинный путь распирал бы всю колонку настроек (см. грабли про min-width). */
.gwcmd { margin: 0; padding: 9px 10px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--surface-2); font-size: 12px; line-height: 1.5;
  white-space: pre-wrap; overflow-wrap: anywhere; }
.gwlog summary { cursor: pointer; }
.gwlog pre { margin: 8px 0 0; max-height: 260px; overflow: auto; padding: 9px 10px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2);
  font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }

/* Планшет: вертикальная рейка превращается в липкую горизонтальную навигацию. */
@media (max-width: 1099px) {
  .settings { gap: 18px; }
  .settings-layout { display: block; }
  .settings-nav-wrap {
    position: sticky;
    top: -1px;
    z-index: 20;
    margin: 0 -1px;
    padding: 8px 1px;
    background: linear-gradient(var(--ground) 78%, transparent);
  }
  .settings-nav {
    position: static;
    display: flex;
    gap: 6px;
    overflow-x: auto;
    padding: 7px;
    scroll-snap-type: x proximity;
    scrollbar-width: none;
  }
  .settings-nav::-webkit-scrollbar { display: none; }
  .nav-group { display: contents; }
  .nav-group-label { display: none; }
  .settings-nav-item {
    flex: 0 0 auto;
    width: auto;
    min-width: 132px;
    padding: 9px 11px;
    scroll-snap-align: start;
  }
  .settings-nav-item::before { display: none; }
  .settings-workspace, .settings-workspace.wide { max-width: 920px; margin: 16px auto 0; }
}

/* Мобильный: одна колонка без горизонтального переполнения и с крупными действиями. */
@media (max-width: 639px) {
  .settings { gap: 12px; }
  .settings-hero { min-height: 0; padding: 19px; border-radius: 14px; }
  .settings-hero h2 { font-size: 21px; }
  .settings-hero p:last-child { display: none; }
  .hero-mark { width: 48px; height: 48px; border-radius: 14px; }
  .hero-mark svg { width: 24px; height: 24px; }
  .settings-nav-wrap { margin: 0 -16px; padding: 7px 16px; }
  .settings-nav { margin: 0 -7px; }
  .settings-nav-item { min-width: auto; padding: 9px 11px; }
  .settings-nav-item small { display: none; }
  .section-intro { min-height: 0; gap: 11px; padding: 4px 0 16px; }
  .section-icon { width: 38px; height: 38px; border-radius: 10px; }
  .section-intro h2 { font-size: 19px; }
  .section-intro p:last-child { font-size: 12.5px; }
  section { gap: 12px; padding-top: 14px; }
  .card { padding: 15px; border-radius: 12px; }
  .card-head { flex-wrap: wrap; gap: 10px; }
  .form-grid { grid-template-columns: minmax(0, 1fr); }
  .form-grid .full { grid-column: auto; }
  .speech-choice-grid { grid-template-columns: minmax(0, 1fr); }
  .speech-quality-grid, .speech-advanced, .speech-env-grid { grid-template-columns: minmax(0, 1fr); }
  .speech-model-row { grid-template-columns: minmax(0, 1fr); }
  .speech-model-actions { justify-content: flex-start; }
  .speech-benchmark { align-items: stretch; flex-direction: column; }
  .pvcards, .plugcards { grid-template-columns: minmax(0, 1fr); }
  .pvhead { align-items: flex-start; flex-wrap: wrap; }
  .pvstate { margin-left: 44px; }
  .plughead { align-items: flex-start; }
  .plugrow { align-items: stretch; flex-direction: column; gap: 5px; }
  .plugrow label, .plugrow .inp { min-width: 0; max-width: none; }
  .row { display: grid; grid-template-columns: minmax(0, 1fr); }
  .row > button { width: 100%; }
  .compact-setting { align-items: stretch; flex-direction: column; }
  .compact-setting label { align-items: stretch; flex-direction: column; }
  .compact-setting label :deep(.nf) { width: 100%; }
  .trusted-add { flex-direction: column; }
  .trusted-add button { width: 100%; }
  .debug-setting { align-items: stretch; flex-direction: column; }
  .debug-setting label { min-width: 0; }
  .mode > p { margin-left: 0; padding-left: 39px; }
  .notification-line { align-items: stretch; flex-direction: column; }
  .notification-line button { width: 100%; }
  .version-facts > div { grid-template-columns: minmax(0, 1fr); gap: 3px; }
  .tlsaddr { flex-wrap: wrap; }
  .tlsqr { display: grid; justify-items: center; }
  .tlsqr img { width: min(180px, 100%); height: auto; }
  .tlssteps { min-width: 0; width: 100%; }
  .fp { overflow-wrap: anywhere; }
}
</style>
