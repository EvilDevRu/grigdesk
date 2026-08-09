<script setup>
import { ref, computed, watch, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useRouter } from 'vue-router';
import { api } from '../shared/api-client.js';
import { confirmDialog } from '../shared/ui/confirm.js';
import { registerLayer } from '../shared/ui/layer-stack.js';
import HelpTip from '../shared/ui/HelpTip.vue';
import { useUiStore } from '../stores/ui.js';
import { useTasksStore } from '../stores/tasks.js';
import { useBoardStore } from '../stores/board.js';
import { useAnalysisStore } from '../stores/analysis.js';
import { useTaskFavoritesStore } from '../stores/task-favorites.js';
import { useTaskSeenStore } from '../stores/task-seen.js';
import { liveTimerSec, secToHMS } from '../shared/format.js';
import { mdToHtml } from '../shared/md.js';
import { providerLabel } from '../shared/runner-display.js';
import OpenDiffButton from './OpenDiffButton.vue';
import TaskFavoriteButton from './board/TaskFavoriteButton.vue';

const router = useRouter();

const ui = useUiStore();
const tasks = useTasksStore();
const board = useBoardStore();
const favorites = useTaskFavoritesStore();
const seen = useTaskSeenStore();
const { taskId } = storeToRefs(ui);

const detail = ref(null);
const loading = ref(false);
const busy = ref(null);   // какое действие выполняется
const err = ref(null);
const commentText = ref('');
const now = ref(Date.now());

let ticker = null;
let unregisterTaskLayer = null;

// Таймер задачи — из кеша доски (там timerRunning/elapsed/startedAt).
const boardTask = computed(() => {
  const d = board.data; if (!d || !taskId.value) return null;
  const id = Number(taskId.value);
  for (const list of [d.tasks, d.toReview, d.created, d.accomplice, d.auditor]) {
    const t = (list || []).find((x) => x.id === id);
    if (t) return t;
  }
  return null;
});
const running = computed(() => !!boardTask.value?.timerRunning);
const elapsed = computed(() => (boardTask.value ? liveTimerSec(boardTask.value, now.value) : null));

// B24 отдаёт описание с HTML/entities — чистим до читаемого текста.
function htmlToText(s) {
  return (s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\n{3,}/g, '\n\n').trim();
}
const cleanDesc = computed(() => htmlToText(detail.value?.description));

// Описание — текстом, но URL в нём должны жить: экранируем и оборачиваем ссылки.
function linkify(s) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return esc(s || '').replace(/(https?:\/\/[^\s&]+(?:&amp;[^\s&]+)*)/g,
    (u) => `<a href="${u.replace(/&amp;/g, '&')}" target="_blank" rel="noopener">${u}</a>`);
}
const descHtml = computed(() => linkify(cleanDesc.value));

// ── Обсуждение в Telegram: что стоит за ссылками t.me из описания ──
// Поле `telegram` приходит от GET /api/b24/task/:id (сервер уже применил
// allowlist и лимиты). Тело задачи оно не трогает — это отдельный блок.
// Текст цитат — из чужого чата, поэтому только интерполяция: никакого v-html,
// как у описания. Отказ показываем ровно так, как прислал сервер: у него нет
// ни цитат, ни имени чата, и придумывать их за него нельзя.
const tgLinks = computed(() => detail.value?.telegram?.links || []);

function tgTime(sec) {
  if (!sec) return '';
  return new Date(sec * 1000).toLocaleString('ru-RU',
    { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
// «ещё 1 сообщение / 3 сообщения / 5 сообщений» — общего хелпера склонения
// во фронте нет, а хвост без согласования читается как опечатка.
function tgPlural(n) {
  const teen = n % 100;
  if (teen >= 11 && teen <= 14) return 'сообщений';
  const one = n % 10;
  if (one === 1) return 'сообщение';
  if (one >= 2 && one <= 4) return 'сообщения';
  return 'сообщений';
}

async function loadDetail(force = false) {
  if (!taskId.value) return;
  loading.value = true; err.value = null;
  try { detail.value = await tasks.load(taskId.value, force); }
  catch (e) { err.value = e.message; }
  finally { loading.value = false; }
}

// ── Триаж: оценка сложности/рисков разведкой кода (без стенда) ──
const analysisStore = useAnalysisStore();
const triage = ref(null);        // ответ /api/analysis/:id
const showNote = ref(false);     // разведнота развёрнута
let triageTimer = null;
const triageState = computed(() => triage.value?.status?.state || null);
const triageBusy = computed(() => triageState.value === 'queued' || triageState.value === 'running');
const noteHtml = computed(() => (triage.value?.note ? mdToHtml(triage.value.note) : ''));

async function loadTriage() {
  if (!taskId.value) return;
  try { triage.value = await analysisStore.detail(taskId.value); } catch { /* блок триажа не ломает модалку */ }
  // Пока идёт — подтягиваем статус; закончилось — останавливаемся.
  if (triageBusy.value && !triageTimer) {
    triageTimer = setInterval(loadTriage, 6000);
  } else if (!triageBusy.value && triageTimer) {
    clearInterval(triageTimer); triageTimer = null;
  }
}
const analyzeNow = () => act('analyze', async () => {
  await analysisStore.analyze(taskId.value);
  await loadTriage();
});

// Ответ на вопросы триажа: уходит комментарием в B24 (агент читает комментарии
// вместе с тикетом) и сразу запускает переоценку — цикл уточнения в один клик.
// К уточнению можно приложить фото (скрин переписки/бага): файл сохраняется в
// chats/attachments, в комментарий вписывается абсолютный путь — агент переоценки
// открывает его Read'ом (папка выдана ему через --add-dir).
const clarifyText = ref('');
const clarifyAtts = ref([]);   // [{file,name,url,path}]
const clarifyUploading = ref(false);
async function onClarifyFiles(e) {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  await uploadClarifyFiles(files);
}
function dropClarifyAtt(file) { clarifyAtts.value = clarifyAtts.value.filter((a) => a.file !== file); }
// Скрин из буфера обмена (Ctrl+V прямо в поле) и перетаскивание файлов — как в чате.
async function uploadClarifyFiles(files) {
  if (!files.length) return;
  clarifyUploading.value = true;
  try {
    for (const f of files) {
      const fd = new FormData();
      fd.append('file', f, f.name || 'clipboard.png');
      clarifyAtts.value.push(await api.upload('/api/chat/upload', fd));
    }
  } catch (e2) { err.value = e2.message; }
  finally { clarifyUploading.value = false; }
}
function onClarifyPaste(e) {
  const files = [...(e.clipboardData?.items || [])]
    .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
    .map((i) => i.getAsFile()).filter(Boolean);
  if (files.length) { e.preventDefault(); uploadClarifyFiles(files); }
}
const clarifyDrag = ref(false);
function onClarifyDrop(e) {
  clarifyDrag.value = false;
  uploadClarifyFiles([...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/')));
}
// Сохраняются ЛОКАЛЬНО (t<id>.clarify.md), НЕ комментарием в B24: комментарии
// видит заказчик, а рабочие пояснения — внутренняя кухня. Их читают триаж и конвейер.
const clarifySaved = ref('');
async function loadClarifications() {
  try { clarifySaved.value = (await api.get(`/api/tasks/${taskId.value}/clarifications`)).text || ''; }
  catch { clarifySaved.value = ''; }
}
const sendClarify = () => act('clarify', async () => {
  const photos = clarifyAtts.value.map((a) => `[приложено фото: ${a.path}]`).join('\n');
  const r = await api.post(`/api/tasks/${taskId.value}/clarifications`, {
    text: `${clarifyText.value.trim()}${photos ? `\n${photos}` : ''}`,
  });
  clarifySaved.value = r.text || '';
  clarifyText.value = ''; clarifyAtts.value = [];
  await analysisStore.analyze(taskId.value);
  await loadTriage();
});

// ── Табы модалки: Триаж | Комментарии ──
const mtab = ref('triage');
const comments = ref(null);    // null = ещё не загружали
const comLoading = ref(false);
async function loadComments() {
  comLoading.value = true;
  try { comments.value = (await api.get(`/api/b24/task/${taskId.value}/comments`)).comments || []; }
  catch { comments.value = []; }
  finally { comLoading.value = false; }
}
watch(mtab, (t) => { if (t === 'comments' && comments.value === null) loadComments(); });

// Уже ли задача на конвейере (есть в состоянии фабрики) — для защиты от повторного запуска.
const conveyor = ref(null);
// Живой стенд задачи ({fePort, apiPort}) — чтобы снести его прямо отсюда.
const sandbox = ref(null);
async function loadConveyor() {
  conveyor.value = null; sandbox.value = null;
  if (!taskId.value) return;
  try {
    const { tasks: list } = await api.get('/api/tasks');
    conveyor.value = (list || []).find((t) => String(t.task) === String(taskId.value)) || null;
  } catch { /* нет данных фабрики — не блокируем */ }
  if (!conveyor.value) return;
  // Порты стенда лежат не в списке задач, а в графе — тянем только для задач конвейера.
  // Общий стенд и исторический реестр принадлежат не этой карточке: их lifecycle
  // интерфейс не трогает.
  try {
    const g = await api.get(`/api/tasks/${taskId.value}/graph`);
    if (g?.fePort && !g.readOnly && g.workspaceMode !== 'shared') {
      sandbox.value = { fePort: g.fePort, apiPort: g.apiPort || null };
    }
  } catch { /* графа нет — кнопку сноса просто не покажем */ }
}
function openConveyor() { ui.close(); router.push('/pipeline'); }

// Снести стенд, не уходя в конвейер: стенд убирают из карточки, и возвращаться
// на страницу конвейера ради одной кнопки незачем. Снос идёт до пары минут
// (docker + схемы БД) — кнопка на это время становится индикатором.
// После сноса перечитываем состояние: сервер уносит реестр задачи в архив, то есть
// задача уходит и с конвейера — иначе в карточке осталась бы кнопка «Уже на конвейере».
const sandboxBusy = ref(false);
const sandboxMsg = ref(null);
async function sandboxDown() {
  if (sandboxBusy.value) return;
  if (!(await confirmDialog(
    `Снести стенд задачи #${taskId.value}? Текущий прогон уйдёт в архив, после чего задачу можно будет отправить на конвейер заново. Ветка и незакоммиченные изменения сохранятся.`,
    { danger: true, okText: 'Снести' },
  ))) return;
  sandboxBusy.value = true; err.value = null; sandboxMsg.value = null;
  try {
    await api.post(`/api/tasks/${taskId.value}/sandbox/down`);
    await loadConveyor();
    sandboxMsg.value = 'Стенд снесён, прогон перенесён в архив';
  } catch (e) {
    err.value = e.status === 501
      ? 'Снос стенда не настроен: нет COCKPIT_SANDBOX_DOWN_CMD и down.sh у профиля.'
      : e.message;
  } finally { sandboxBusy.value = false; }
}

async function act(name, fn) {
  busy.value = name; err.value = null;
  try { await fn(); }
  catch (e) { err.value = e.message; }
  finally { busy.value = null; }
}
const toggleTimer = () => act('timer', () => tasks.timer(taskId.value, running.value ? 'pause' : 'start'));
const complete = async () => { if (await confirmDialog('Завершить задачу?', { okText: 'Завершить' })) act('complete', async () => { await tasks.complete(taskId.value); ui.close(); }); };
const launchMsg = ref(null);

// ── Запуск на конвейер ──
// Маршрут и критерии задаёт человек. Технические immutable-входы route engine форма
// тоже показывает явно: целевые ветки для ship и exact instrumentation scope для debug.
// Критерии пустыми допустимы: тогда их формулирует этап-переводчик. Выдумывать их за человека нельзя —
// отказ на приёмке откатывает маршрут на сборку со сбросом всего хвоста.
const launchForm = ref(null);   // форма открыта
const launchOpts = ref(null);   // ответ /launch-options
const launchOptionsBusy = ref(false);
const DIAGNOSIS_LABELS = {
  functional: 'поведение',
  performance: 'производительность',
  data: 'данные',
  integration: 'интеграция',
};
let launchOptionsRequest = 0;
function preferredLaunchRoute(opts) {
  const guess = triage.value?.analysis?.route_guess;
  return opts.routes?.includes(guess) ? guess : opts.defaultRoute;
}
function makeLaunchForm(opts, criteria = '') {
  const route = preferredLaunchRoute(opts);
  const needsInstrumentation = opts.routeOptions?.[route]?.instrumentationRequired;
  return {
    profile: opts.profile,
    route,
    criteria,
    instrumentationFiles: needsInstrumentation
      ? (opts.instrumentationSuggestions || []).slice(0, 1).join('\n')
      : '',
    diagnosisKind: opts.diagnosisSuggestion?.kind || 'functional',
    diagnosisSignal: opts.diagnosisSuggestion?.signal || '',
    // '' = исполнителя решает профиль; явный выбор уезжает в launch как runnerPrimary.
    // Форма пересоздаётся на каждый ответ launch-options, поэтому смена профиля
    // сама сбрасывает выбор — чужой набор исполнителей не наследуется.
    runner: '',
  };
}
async function openLaunch() {
  if (conveyor.value) { launchMsg.value = 'Уже на конвейере'; return; }
  if (launchOptionsBusy.value) return;
  err.value = null; launchMsg.value = null;
  const requestId = ++launchOptionsRequest;
  let opts = null;
  launchOptionsBusy.value = true;
  try { opts = await tasks.launchOptions(taskId.value); }
  catch (e) {
    if (requestId === launchOptionsRequest) err.value = `Не удалось узнать параметры запуска: ${e.message}`;
    return;
  } finally {
    if (requestId === launchOptionsRequest) launchOptionsBusy.value = false;
  }
  if (requestId !== launchOptionsRequest) return;
  launchOpts.value = opts;

  // Если каталог выбранного по умолчанию профиля недоступен, при нескольких профилях
  // оставляем форму открытой: человек может выбрать другой опубликованный каталог.
  const profiles = opts.profiles?.length ? opts.profiles : [opts.profile];
  if (opts.error && profiles.length === 1) {
    err.value = opts.message || 'маршрут сейчас нельзя запустить';
    return;
  }
  // Триаж уже прикинул маршрут — показываем это подсказкой рядом, но выбирает человек.
  launchForm.value = makeLaunchForm(opts);
  if (opts.error) err.value = opts.message || 'выбранный профиль сейчас нельзя запустить';
  return undefined;
}
async function changeLaunchProfile() {
  const profile = launchForm.value?.profile;
  if (!profile || launchOptionsBusy.value) return;
  const previousProfile = launchOpts.value?.profile;
  const requestId = ++launchOptionsRequest;
  const criteria = launchForm.value.criteria;
  launchOptionsBusy.value = true;
  err.value = null;
  try {
    const opts = await tasks.launchOptions(taskId.value, profile);
    if (requestId !== launchOptionsRequest || !launchForm.value) return;
    launchOpts.value = opts;
    launchForm.value = makeLaunchForm(opts, criteria);
    if (opts.error) err.value = opts.message || 'выбранный профиль сейчас нельзя запустить';
  } catch (e) {
    if (requestId === launchOptionsRequest) {
      if (launchForm.value && previousProfile) launchForm.value.profile = previousProfile;
      err.value = `Не удалось выбрать профиль: ${e.message}`;
    }
  } finally {
    if (requestId === launchOptionsRequest) launchOptionsBusy.value = false;
  }
}
const routeGuess = computed(() => {
  const guess = triage.value?.analysis?.route_guess;
  return guess && guess !== launchForm.value?.route && launchOpts.value?.routes?.includes(guess) ? guess : null;
});
const launchRouteOption = computed(() => (
  launchOpts.value?.routeOptions?.[launchForm.value?.route] || null
));
const launchNeedsDelivery = computed(() => launchRouteOption.value?.deliveryMode === 'publish');
const launchNeedsInstrumentation = computed(() => Boolean(
  launchRouteOption.value?.instrumentationRequired
));
const launchRouteIsSuggested = computed(() => (
  triage.value?.analysis?.route_guess === launchForm.value?.route
));
const launchDeliverySummary = computed(() => (launchOpts.value?.repositories || [])
  .map((repo) => `${repo.name}/${repo.targetBranch || '—'}`)
  .join(' · '));
const launchInstrumentationItems = computed(() => String(
  launchForm.value?.instrumentationFiles || '',
).split('\n').map((item) => item.trim()).filter(Boolean));
const launchInstrumentationSummary = computed(() => {
  const [first, ...rest] = launchInstrumentationItems.value;
  if (!first) return 'scope не определён';
  const short = first.split('/').pop();
  return rest.length ? `${short} + ещё ${rest.length}` : short;
});
const launchDiagnosisSummary = computed(() => (
  DIAGNOSIS_LABELS[launchForm.value?.diagnosisKind] || launchForm.value?.diagnosisKind || 'поведение'
));
const launchValidationError = computed(() => {
  if (loading.value || !detail.value) return 'Постановка задачи ещё загружается.';
  if (!launchForm.value?.route) return 'Выбери маршрут.';
  if (!launchRouteOption.value?.deliveryMode) return 'Каталог не отдал delivery contract маршрута.';
  if (launchOpts.value?.profileContractError) return launchOpts.value.profileContractError;
  if (launchNeedsDelivery.value) {
    if (!launchOpts.value?.repositories?.length) return 'Профиль не объявил репозитории для SHIP.';
    const missing = launchOpts.value.repositories
      .filter((repo) => !repo.targetBranch?.trim())
      .map((repo) => repo.name);
    if (missing.length) return `Профиль не настроил целевые ветки: ${missing.join(', ')}.`;
  }
  if (launchNeedsInstrumentation.value && !launchForm.value.instrumentationFiles.trim()) {
    return 'Маршрут требует хотя бы один файл инструментации.';
  }
  return null;
});
function changeLaunchRoute() {
  if (!launchForm.value || !launchNeedsInstrumentation.value
      || launchForm.value.instrumentationFiles.trim()) return;
  launchForm.value.instrumentationFiles = (launchOpts.value?.instrumentationSuggestions || [])
    .slice(0, 1).join('\n');
}
function doLaunch(payload) {
  return act('launch', async () => {
    const r = await tasks.launch(taskId.value, payload);
    launchForm.value = null;
    launchMsg.value = r.outcome === 'already_running' ? 'Уже идёт на конвейере'
      : r.outcome === 'launched' ? `Запущено (профиль ${r.profile}${r.route ? `, маршрут ${r.route}` : ''}${r.attempt ? `, попытка ${r.attempt.slice(0, 10)}…` : ''})`
      : r.note || 'Отправлено';
    await loadConveyor();
  });
}
const launchSelected = () => {
  if (launchValidationError.value) return;
  const instrumentationFiles = launchNeedsInstrumentation.value
    ? launchForm.value.instrumentationFiles.split('\n').map((s) => s.trim()).filter(Boolean)
    : [];
  return doLaunch({
    profile: launchForm.value.profile,
    route: launchForm.value.route,
    title: detail.value?.title || '',
    description: cleanDesc.value || '',
    // По строке на критерий: пустые строки отбрасывает сборка тикета.
    acceptanceCriteria: launchForm.value.criteria.split('\n').map((s) => s.trim()).filter(Boolean),
    instrumentationFiles,
    diagnosisKind: launchNeedsInstrumentation.value ? launchForm.value.diagnosisKind : '',
    diagnosisSignal: launchNeedsInstrumentation.value
      ? launchForm.value.diagnosisSignal.trim()
      : '',
    // Исполнитель — только при явном выборе: пустое значение значит «по профилю»,
    // и сервер не должен получать лишний ключ.
    ...(launchForm.value.runner ? { runnerPrimary: launchForm.value.runner } : {}),
  });
};
const sendComment = () => act('comment', async () => {
  await tasks.comment(taskId.value, commentText.value);
  commentText.value = '';
  loadComments();
});
const refresh = () => { loadDetail(true); board.load(true); };
const toggleFavorite = () => favorites.toggle(taskId.value);

// Открытие/закрытие модалки по taskId.
watch(taskId, (id) => {
  if (id) {
    detail.value = null; launchMsg.value = null; sandboxMsg.value = null;
    launchForm.value = null; launchOpts.value = null;
    launchOptionsRequest += 1; launchOptionsBusy.value = false;
    triage.value = null; showNote.value = false;
    mtab.value = 'triage'; comments.value = null; clarifyAtts.value = []; clarifySaved.value = '';
    loadClarifications();
    loadDetail();
    favorites.load(true);
    // Задачу открыли — она больше не новая. Отметка серверная, поэтому метка гаснет
    // и в других окнах; ошибка отметки на показ задачи не влияет.
    seen.markSeen([id]);
    loadConveyor();
    loadTriage();
    if (!ticker) ticker = setInterval(() => { now.value = Date.now(); }, 1000);
  } else {
    if (ticker) { clearInterval(ticker); ticker = null; }
    if (triageTimer) { clearInterval(triageTimer); triageTimer = null; }
  }
}, { immediate: true });
watch(() => ui.launchRequested, (requested) => {
  if (!requested || !taskId.value) return;
  ui.consumeTaskLaunch();
  openLaunch();
}, { flush: 'post', immediate: true });
onUnmounted(() => {
  if (ticker) clearInterval(ticker);
  if (triageTimer) clearInterval(triageTimer);
  unregisterTaskLayer?.();
});

watch(taskId, (id) => {
  unregisterTaskLayer?.();
  unregisterTaskLayer = id
    ? registerLayer('task-modal', { priority: 100, close: () => ui.close() })
    : null;
}, { immediate: true });
</script>

<template>
  <div v-if="taskId" class="overlay" @click.self="ui.close()">
    <div class="panel">
      <header class="mhead">
        <span class="mid mono">#{{ taskId }}</span>
        <h3 class="mtitle"><span v-if="loading && !detail" class="spin"></span> {{ detail?.title || (loading ? 'Загрузка…' : 'Задача') }}</h3>
        <TaskFavoriteButton :active="favorites.isFavorite(taskId)"
                            :pending="!favorites.loaded || favorites.loading || favorites.isPending(taskId)"
                            :task-title="detail?.title || boardTask?.title || `Задача #${taskId}`"
                            @toggle="toggleFavorite" />
        <button class="icon" title="Обновить" @click="refresh">⟳</button>
        <button class="icon" title="Закрыть" @click="ui.close()">✕</button>
      </header>

      <div class="mbody">
        <p v-if="err" class="err">{{ err }}</p>
        <p v-if="favorites.error" class="err">Избранное: {{ favorites.error }}</p>

        <div class="meta">
          <span v-if="detail?.status_label" class="tag">{{ detail.status_label }}</span>
          <span v-if="detail?.priority_label" class="tag">{{ detail.priority_label }}</span>
          <span v-if="boardTask?.group" class="tag">{{ boardTask.group }}</span>
          <span v-if="boardTask?.deadline" class="tag" :class="{ over: boardTask.overdue }">до {{ boardTask.deadline }}</span>
        </div>

        <p v-if="cleanDesc" class="desc" v-html="descHtml"></p>

        <!-- Обсуждение в Telegram: то, на что показывают ссылки в описании -->
        <section v-if="tgLinks.length" class="tg">
          <div class="tlbl">Обсуждение в Telegram</div>
          <div v-for="(l, i) in tgLinks" :key="i" class="tgitem">
            <!-- Нераскрытая ссылка обязана объяснить себя: молчание читается
                 как «в чате пусто», а причина — как «сюда нет доступа». -->
            <div v-if="!l.ok" class="tgfail">
              <span class="tgurl">{{ l.url }}</span>
              <span class="tgwhy">{{ l.message || 'ссылка не раскрыта' }}</span>
            </div>
            <template v-else>
              <div class="tghead">
                <span class="tgchat">{{ l.chat?.title || 'Чат' }}</span>
                <span v-if="l.chat?.username" class="tgat">@{{ l.chat.username }}</span>
                <span v-if="l.thread" class="tgthread">тема {{ l.thread }}</span>
                <a class="tgurl" :href="l.url" target="_blank" rel="noopener">открыть</a>
              </div>
              <div v-for="q in l.quotes" :key="q.messageId" class="tgq" :class="{ tgtarget: q.target }">
                <div class="tgmeta">
                  <span class="tgauthor">{{ q.author }}</span>
                  <span class="tgtime">{{ tgTime(q.at) }}</span>
                  <span v-if="q.target" class="tgpin">← ссылка</span>
                </div>
                <div class="tgtext">{{ q.text }}<template v-if="q.trimmed">…</template></div>
                <div v-if="q.media?.length" class="tgmedia">{{ q.media.join(', ') }}</div>
              </div>
              <div v-if="l.more" class="tgmore">ещё {{ l.more }} {{ tgPlural(l.more) }} в ветке</div>
            </template>
          </div>
        </section>

        <!-- Табы: Триаж | Комментарии -->
        <nav class="mtabs">
          <button class="mtab" :class="{ active: mtab === 'triage' }" @click="mtab = 'triage'">Триаж</button>
          <button class="mtab" :class="{ active: mtab === 'comments' }" @click="mtab = 'comments'">
            Комментарии<template v-if="comments?.length"> ({{ comments.length }})</template>
          </button>
        </nav>

        <!-- Триаж: оценка сложности/рисков без стенда -->
        <div v-show="mtab === 'triage'" class="triage">
          <div class="thead2">
            <span class="tlbl">Триаж</span>
            <template v-if="triage?.analysis">
              <!-- Пока идёт переоценка, старые чипсы притушены + явный индикатор: иначе
                   «нажал уточнить — и ничего не изменилось» (оценка-то на экране осталась). -->
              <span class="tchips" :class="{ dim: triageBusy }">
                <span class="tchip" :class="triage.analysis.complexity >= 4 ? 'warn' : triage.analysis.complexity === 3 ? 'acc' : ''">сложность {{ triage.analysis.complexity }}/5</span>
                <span class="tchip" :class="triage.analysis.risk >= 4 ? 'bad' : triage.analysis.risk === 3 ? 'warn' : ''">риск {{ triage.analysis.risk }}/5</span>
                <span class="tchip">дифф {{ triage.analysis.diff_size }}</span>
                <span class="tchip">{{ triage.analysis.route_guess }}</span>
                <span v-if="triage.analysis.confidence !== 'high'" class="tchip" :class="triage.analysis.confidence === 'low' ? 'warn' : ''">уверенность: {{ triage.analysis.confidence }}</span>
              </span>
              <span v-if="triageBusy" class="tmuted"><span class="spin"></span> {{ triageState === 'running' ? 'переоценка идёт…' : 'переоценка в очереди…' }}</span>
            </template>
            <span v-else-if="triageBusy" class="tmuted"><span class="spin"></span> {{ triageState === 'running' ? 'разведка идёт…' : 'в очереди…' }}</span>
            <span v-else-if="triageState === 'failed'" class="terr" :title="triage?.status?.error">триаж упал: {{ (triage?.status?.error || '').slice(0, 80) }}</span>
            <span v-else class="tmuted">задача не оценена</span>
            <button class="btn tbtn" :disabled="triageBusy || busy === 'analyze'" @click="analyzeNow">
              {{ triageBusy ? '…' : triage?.analysis ? '↻ Переоценить' : '🔍 Оценить' }}
            </button>
          </div>

          <template v-if="triage?.analysis">
            <p v-if="triage.analysis.summary" class="tsum">{{ triage.analysis.summary }}</p>
            <p v-if="triage.stale?.length" class="tstale">
              ⚠ Код под оценкой менялся: {{ triage.stale.slice(0, 5).join(', ') }}{{ triage.stale.length > 5 ? ` и ещё ${triage.stale.length - 5}` : '' }} — стоит переоценить.
            </p>
            <ul v-if="triage.analysis.risk_markers?.length" class="tlist">
              <li v-for="m in triage.analysis.risk_markers" :key="m">⚠ {{ m }}</li>
            </ul>
            <ul v-if="triage.analysis.questions?.length" class="tlist q">
              <li v-for="qq in triage.analysis.questions" :key="qq">? {{ qq }}</li>
            </ul>
            <div v-if="triage.analysis.questions?.length || triage.analysis.needs_clarification"
                 class="clarify" :class="{ drag: clarifyDrag }"
                 @dragover.prevent="clarifyDrag = true" @dragleave="clarifyDrag = false" @drop.prevent="onClarifyDrop">
              <div class="clarify-row">
                <textarea v-model="clarifyText" rows="2"
                          placeholder="Ответ на вопросы — сохранится локально для агентов, в B24 не уйдёт… (Ctrl+V — скрин, Ctrl+Enter — отправить)"
                          @paste="onClarifyPaste"
                          @keydown.ctrl.enter.prevent="sendClarify"></textarea>
                <HelpTip text="Фото для агента: скрин переписки или бага. Можно вставить из буфера (Ctrl+V) или перетащить сюда." align="right">
                  <label class="attachbtn">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                    </svg>
                    <input type="file" accept="image/*" multiple hidden @change="onClarifyFiles" />
                  </label>
                </HelpTip>
                <button class="btn tbtn" :disabled="busy === 'clarify' || triageBusy || clarifyUploading || (!clarifyText.trim() && !clarifyAtts.length)" @click="sendClarify">
                  {{ busy === 'clarify' ? '…' : '↻ Уточнить и переоценить' }}
                </button>
              </div>
              <div v-if="clarifyAtts.length || clarifyUploading" class="attrow">
                <span v-for="a in clarifyAtts" :key="a.file" class="attchip">
                  <img :src="a.url" :alt="a.name" />
                  <span class="attname">{{ a.name }}</span>
                  <button class="attx" title="Убрать" @click="dropClarifyAtt(a.file)">✕</button>
                </span>
                <span v-if="clarifyUploading" class="tmuted"><span class="spin"></span> загрузка…</span>
              </div>
            </div>
            <details v-if="clarifySaved" class="clhist">
              <summary>Внутренние уточнения (локально, для агентов — заказчик не видит)</summary>
              <div class="clhist-body">{{ clarifySaved }}</div>
            </details>
            <button v-if="triage.note" class="tnote-toggle" @click="showNote = !showNote">
              {{ showNote ? '▾ Свернуть разведноту' : '▸ Разведнота (карта кода для планировщика)' }}
            </button>
            <div v-if="showNote" class="tnote" v-html="noteHtml"></div>
            <p class="tmeta mono">
              {{ triage.analysis.generated_at ? new Date(triage.analysis.generated_at).toLocaleString('ru-RU') : '' }}
              <template v-if="triage.analysis.meta">· {{ triage.analysis.meta.model }} · {{ Math.round((triage.analysis.meta.duration_ms || 0) / 60000) }} мин<template v-if="triage.analysis.meta.cost_usd"> · ${{ triage.analysis.meta.cost_usd.toFixed(2) }}</template></template>
            </p>
          </template>
        </div>

        <!-- Комментарии задачи (таб): список из B24 + добавление -->
        <div v-show="mtab === 'comments'" class="comtab">
          <div v-if="comLoading && comments === null" class="tmuted"><span class="spin"></span> загрузка комментариев…</div>
          <div v-else-if="comments && !comments.length" class="tmuted">Комментариев нет.</div>
          <div v-else-if="comments" class="comlist">
            <div v-for="c in comments" :key="c.mid" class="com">
              <div class="comhead">
                <b>{{ c.author }}</b>
                <span class="comtime mono">{{ c.time }}</span>
              </div>
              <div class="comtext">{{ c.text }}</div>
              <div v-if="c.attachments?.length" class="comatts">
                <span v-for="a in c.attachments" :key="a.attachedId" class="comatt">📎 {{ a.name || `файл ${a.attachedId}` }}</span>
              </div>
            </div>
          </div>
          <div class="comment">
            <textarea v-model="commentText" rows="2" placeholder="Добавить комментарий…"></textarea>
            <button class="btn" :disabled="busy === 'comment' || !commentText.trim()" @click="sendComment">
              {{ busy === 'comment' ? 'Отправка…' : 'Отправить' }}
            </button>
          </div>
        </div>

        <!-- Управление -->
        <div class="controls">
          <div class="timer mono" :class="{ run: running }">
            <span class="tclock">{{ elapsed !== null ? secToHMS(elapsed) : '—' }}</span>
            <span class="tstate">{{ running ? 'идёт' : 'остановлен' }}</span>
          </div>
          <div class="cbtns">
            <button class="btn" :class="running ? 'warn' : 'primary'" :disabled="busy === 'timer'" @click="toggleTimer">
              {{ busy === 'timer' ? '…' : running ? '⏸ Остановить учёт' : '▶ Начать учёт' }}
            </button>
            <button class="btn good" :disabled="busy === 'complete'" @click="complete">
              {{ busy === 'complete' ? '…' : '✓ Завершить' }}
            </button>
            <!-- Уже на конвейере — вместо запуска показываем переход, повторный старт заблокирован.
                 Затык виден прямо на кнопке: карточку задачи открывают чаще, чем конвейер, а
                 «Уже на конвейере» одинаково выглядело и у идущей задачи, и у вставшей, поэтому
                 ожидание человека оставалось незаметным. -->
            <button v-if="conveyor" class="btn onconv" :class="{ stalled: conveyor.stall }" @click="openConveyor"
                    :title="conveyor.stall
                      ? `${conveyor.stall.title} — ${conveyor.stall.hint}`
                      : `Задача уже на конвейере (${conveyor.route || 'маршрут'}) — открыть`">
              {{ conveyor.stall ? (conveyor.stall.kind === 'crashed' ? '✖ Конвейер оборвался' : '🛑 Конвейер встал')
                 : conveyor.daemonAlive ? '🏭 Идёт на конвейере' : '🏭 Уже на конвейере' }} →
            </button>
            <button v-else class="btn launch" :disabled="busy === 'launch' || launchOptionsBusy || !!launchForm" @click="openLaunch" title="Запустить фабрику по задаче">
              {{ busy === 'launch' || launchOptionsBusy ? '…' : '🏭 На конвейер' }}
            </button>
            <!-- Стенд задачи сносится прямо отсюда: карточку открывают, чтобы закрыть
                 задачу, и ради одной кнопки идти в конвейер незачем. -->
            <button v-if="sandbox" class="btn sbdown" :class="{ busy: sandboxBusy }" :disabled="sandboxBusy"
                    :title="`Снести песочницу задачи (фронт :${sandbox.fePort}${sandbox.apiPort ? `, API :${sandbox.apiPort}` : ''})`"
                    @click="sandboxDown">
              <span v-if="sandboxBusy"><span class="sbspin"></span> сношу стенд…</span>
              <span v-else>⏏ Снести стенд</span>
            </button>
            <OpenDiffButton :task-id="taskId" />
          </div>
          <!-- Обычный запуск показывает только человеческое решение. Immutable-техника
               видна кратко и раскрывается отдельно для редкой ручной корректировки. -->
          <div v-if="launchForm" class="lform">
            <div v-if="launchOpts.profiles?.length > 1" class="lrow">
              <label class="llbl" for="launch-profile">Профиль</label>
              <select id="launch-profile" v-model="launchForm.profile" class="lsel"
                      :disabled="launchOptionsBusy || busy === 'launch'" @change="changeLaunchProfile">
                <option v-for="p in launchOpts.profiles" :key="p" :value="p">{{ p }}</option>
              </select>
              <span v-if="launchOptionsBusy" class="lhint"><span class="spin"></span> читаю каталог…</span>
            </div>
            <div class="lrow">
              <label class="llbl" for="launch-route">Маршрут</label>
              <select id="launch-route" v-model="launchForm.route" class="lsel"
                      @change="changeLaunchRoute">
                <option v-for="r in launchOpts.routes" :key="r" :value="r">{{ r }}</option>
              </select>
              <span v-if="launchRouteIsSuggested" class="lhint good">рекомендован триажем</span>
              <span v-else-if="routeGuess" class="lhint">триаж предлагает: {{ routeGuess }}</span>
            </div>
            <div v-if="launchOpts.runners?.length" class="lrow">
              <label class="llbl" for="launch-runner">Исполнитель</label>
              <select id="launch-runner" v-model="launchForm.runner" class="lsel"
                      :disabled="launchOptionsBusy || busy === 'launch'">
                <option value="">Из профиля<template v-if="launchOpts.defaultRunner"> ({{ providerLabel(launchOpts.defaultRunner) }})</template></option>
                <option v-for="r in launchOpts.runners" :key="r" :value="r">{{ providerLabel(r) }}</option>
              </select>
            </div>

            <div class="lsummary" aria-label="Параметры запуска">
              <div class="lsummary-row">
                <span>Профиль</span>
                <b class="mono">{{ launchForm.profile }}</b>
              </div>
              <div v-if="launchNeedsDelivery" class="lsummary-row">
                <span>SHIP</span>
                <b class="mono">{{ launchDeliverySummary }}</b>
              </div>
              <div v-if="launchNeedsInstrumentation" class="lsummary-row">
                <span>Диагностика</span>
                <b>{{ launchDiagnosisSummary }} · {{ launchInstrumentationSummary }}</b>
              </div>
              <p v-if="launchNeedsDelivery" class="lshipwarn">
                После финальных одобренных ворот маршрут сделает commit, push и PR.
              </p>
            </div>

            <label class="llbl">Критерии приёмки <span class="lopt">— необязательно</span></label>
            <textarea v-model="launchForm.criteria" rows="2"
                      placeholder="Например: экспорт не падает на выборке 10 000 строк&#10;в отчёте появилась колонка «Менеджер»"></textarea>
            <p class="lnote">
              Если оставить пустым, критерии сформулирует этап-переводчик по постановке.
            </p>

            <details v-if="launchNeedsDelivery || launchNeedsInstrumentation" class="ladvanced">
              <summary>Дополнительные параметры</summary>
              <div class="ladvanced-body">
                <template v-if="launchNeedsDelivery">
                  <label class="llbl">Целевые ветки из конфигурации профиля</label>
                  <div v-for="repo in launchOpts.repositories" :key="repo.name" class="lrepo">
                    <span class="mono">{{ repo.name }}</span>
                    <code class="mono">{{ repo.targetBranch }}</code>
                  </div>
                </template>
                <template v-if="launchNeedsInstrumentation">
                  <label class="llbl" for="launch-instrumentation">
                    Точный scope <span class="lopt">— по одному repo:relative/path на строку</span>
                  </label>
                  <textarea id="launch-instrumentation" v-model="launchForm.instrumentationFiles" rows="3"
                            spellcheck="false" class="mono"
                            placeholder="backend:app/Path/To/File.php"></textarea>
                  <div class="lrow">
                    <label class="llbl" for="launch-diagnosis-kind">Тип диагноза</label>
                    <select id="launch-diagnosis-kind" v-model="launchForm.diagnosisKind" class="lsel">
                      <option value="functional">functional</option>
                      <option value="performance">performance</option>
                      <option value="data">data</option>
                      <option value="integration">integration</option>
                    </select>
                  </div>
                  <label class="llbl" for="launch-diagnosis-signal">Наблюдаемый сигнал</label>
                  <input id="launch-diagnosis-signal" v-model="launchForm.diagnosisSignal"
                         class="linp" maxlength="200" autocomplete="off"
                         placeholder="Коротко: что именно воспроизводится" />
                  <p class="lnote">
                    Scope закрепляется на всю попытку; временные probes разрешены только в этих файлах.
                  </p>
                </template>
              </div>
            </details>
            <p v-if="launchValidationError" class="lerror">{{ launchValidationError }}</p>
            <div class="lbtns">
              <button class="btn" @click="launchForm = null">Отмена</button>
              <button class="btn primary"
                      :disabled="busy === 'launch' || launchOptionsBusy || !!launchOpts.error || !!launchValidationError"
                      @click="launchSelected">
                {{ busy === 'launch' ? 'Запускаю…' : '🏭 Запустить' }}
              </button>
            </div>
          </div>
          <div v-if="conveyor?.stall" class="convstall">
            <b>{{ conveyor.stall.title }}</b>
            <span>{{ conveyor.stall.hint }}</span>
          </div>
          <span v-if="launchMsg" class="lmsg">{{ launchMsg }}</span>
          <span v-if="sandboxMsg" class="lmsg">{{ sandboxMsg }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; background: #04060acc; backdrop-filter: blur(4px); display: flex; align-items: flex-start;
  justify-content: center; padding: 48px 16px; z-index: 100; overflow-y: auto; }
.panel { background: var(--surface); border: 1px solid var(--line-2); border-radius: 16px;
  width: 100%; max-width: 860px; box-shadow: 0 20px 60px #000b; overflow: hidden; }
.mhead { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.mid { color: var(--ink-mid); font-size: 13px; flex: none; }
.mtitle { flex: 1; margin: 0; font-size: 16px; font-weight: 640; min-width: 0; }
.icon { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid);
  width: 30px; height: 30px; border-radius: 8px; cursor: pointer; flex: none; }
.icon:hover { color: var(--ink); }
.mbody { padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.err { color: var(--bad); margin: 0; font-size: 13px; }
.meta { display: flex; flex-wrap: wrap; gap: 6px; }
.tag { font-size: 12px; color: var(--ink-mid); background: var(--surface-2); border: 1px solid var(--line);
  border-radius: 999px; padding: 2px 10px; }
.tag.over { color: var(--bad); }
.desc { margin: 0; font-size: 14px; color: var(--ink); white-space: pre-wrap; line-height: 1.55;
  max-height: 300px; overflow-y: auto; }
.desc :deep(a) { color: var(--accent); text-decoration: none; word-break: break-all; }
.desc :deep(a:hover) { text-decoration: underline; }

/* Обсуждение в Telegram. min-width: 0 обязателен: блок стоит во флекс-колонке,
   а без него флекс-элемент не сжимается ниже своего содержимого — одна длинная
   ссылка из чужого чата раздвинула бы модалку (та же грабля, что была в чате).
   Ветка скроллится внутри себя: переписка не должна вытеснять описание. */
.tg { min-width: 0; max-height: 320px; overflow-y: auto;
  background: var(--ground); border: 1px solid var(--line); border-radius: 12px;
  padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }
.tgitem { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.tgfail { display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
.tgfail .tgurl { color: var(--ink-mid); overflow-wrap: anywhere; }
.tgwhy { color: var(--warn); }
.tghead { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; font-size: 12px; min-width: 0; }
.tgchat { color: var(--ink); font-weight: 600; overflow-wrap: anywhere; }
.tgat, .tgthread { color: var(--ink-mid); }
.tghead .tgurl { color: var(--accent); text-decoration: none; margin-left: auto; }
.tghead .tgurl:hover { text-decoration: underline; }
.tgq { border-left: 2px solid var(--line); padding: 0 0 0 8px; display: flex;
  flex-direction: column; gap: 2px; min-width: 0; }
.tgq.tgtarget { border-left-color: var(--accent); }
.tgmeta { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap;
  font-size: 11px; color: var(--ink-mid); }
.tgauthor { color: var(--ink); }
.tgpin { color: var(--accent); }
.tgtext { font-size: 13px; color: var(--ink); white-space: pre-wrap;
  overflow-wrap: anywhere; line-height: 1.5; }
.tgmedia { font-size: 11px; color: var(--ink-mid); overflow-wrap: anywhere; }
.tgmore { font-size: 11px; color: var(--ink-mid); }

.triage { background: var(--ground); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px;
  display: flex; flex-direction: column; gap: 8px; }
.thead2 { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tlbl { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-mid); margin-right: 4px; }
.tchips { display: contents; }
.tchips.dim { display: inline-flex; gap: 6px; flex-wrap: wrap; opacity: .45; }
.tchip { font-size: 12px; font-family: var(--mono, monospace); color: var(--ink-mid);
  border: 1px solid var(--line); border-radius: 999px; padding: 2px 9px; }
.tchip.acc { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.tchip.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
.tchip.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, transparent); }
.tmuted { color: var(--ink-mid); font-size: 13px; display: inline-flex; align-items: center; gap: 6px; }
.terr { color: var(--bad); font-size: 12px; }
.tbtn { margin-left: auto; height: 32px; padding: 0 12px; font-size: 12px; }
.tsum { margin: 0; font-size: 13px; color: var(--ink); line-height: 1.5; }
.tstale { margin: 0; font-size: 12px; color: var(--warn); }
.tlist { margin: 0; padding: 0 0 0 4px; list-style: none; font-size: 12px; color: var(--ink-mid); display: flex; flex-direction: column; gap: 3px; }
.tlist.q li { color: var(--warn); }
.clarify { display: flex; flex-direction: column; gap: 8px; border-radius: 10px; }
.clarify.drag { outline: 2px dashed var(--accent); outline-offset: 3px; }
.clarify-row { display: flex; gap: 8px; align-items: flex-end; }
/* В ряду уточнения кнопка стоит вплотную к скрепке (auto-margin — только в шапке триажа),
   все контролы одной высоты. */
.clarify-row .tbtn { margin-left: 0; height: 36px; }
.clarify-row textarea { min-height: 58px; }
.clhist { border: 1px dashed var(--line); border-radius: 9px; padding: 7px 11px; }
.clhist summary { cursor: pointer; font-size: 12.5px; color: var(--ink-mid); user-select: none; }
.clhist-body { margin-top: 6px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere;
  max-height: 220px; overflow-y: auto; }
.attachbtn { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); cursor: pointer;
  color: var(--ink-mid); }
.attachbtn svg { width: 17px; height: 17px; }
.attachbtn:hover { border-color: var(--accent); color: var(--accent); }
.attrow { display: flex; gap: 8px; flex-wrap: wrap; width: 100%; }
.attchip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line);
  border-radius: 8px; padding: 3px 8px 3px 3px; background: var(--surface-2); font-size: 12px; }
.attchip img { width: 26px; height: 26px; object-fit: cover; border-radius: 5px; }
.attname { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-mid); }
.attx { background: none; border: none; color: var(--ink-mid); cursor: pointer; padding: 0 2px; }
.attx:hover { color: var(--bad); }
/* ── Табы модалки ── */
.mtabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); }
.mtab { background: none; border: none; border-bottom: 2px solid transparent; margin-bottom: -1px;
  color: var(--ink-mid); font-size: 13px; padding: 7px 12px; cursor: pointer; }
.mtab:hover { color: var(--ink); }
.mtab.active { color: var(--ink); border-bottom-color: var(--accent); font-weight: 600; }
/* ── Таб комментариев ── */
.comtab { display: flex; flex-direction: column; gap: 12px; }
.comlist { display: flex; flex-direction: column; gap: 10px; max-height: 340px; overflow-y: auto; }
.com { background: var(--ground); border: 1px solid var(--line); border-radius: 10px; padding: 9px 12px; }
.comhead { display: flex; gap: 10px; align-items: baseline; font-size: 13px; }
.comtime { color: var(--ink-mid); font-size: 11.5px; }
.comtext { margin-top: 4px; font-size: 13.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.comatts { margin-top: 6px; display: flex; gap: 8px; flex-wrap: wrap; }
.comatt { font-size: 12px; color: var(--ink-mid); border: 1px dashed var(--line); border-radius: 7px; padding: 2px 8px; }
.clarify textarea { flex: 1; resize: vertical; padding: 8px 10px; border: 1px solid var(--line);
  border-radius: 9px; background: var(--surface-2); color: var(--ink); font-family: inherit; font-size: 13px; }
.clarify textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.tnote-toggle { background: none; border: none; color: var(--accent); font-size: 12px; cursor: pointer; text-align: left; padding: 0; }
.tnote { font-size: 13px; color: var(--ink); line-height: 1.55; max-height: 360px; overflow-y: auto;
  border-top: 1px solid var(--line); padding-top: 8px; }
.tnote :deep(h3), .tnote :deep(h4), .tnote :deep(h5), .tnote :deep(h6) { margin: 10px 0 4px; font-size: 13px; color: var(--ink); }
.tnote :deep(p) { margin: 4px 0; }
.tnote :deep(ul) { margin: 4px 0; padding-left: 18px; }
.tnote :deep(code) { font-family: var(--mono, monospace); font-size: 12px; background: var(--surface-2);
  border-radius: 4px; padding: 1px 4px; }
.tnote :deep(pre) { background: var(--surface-2); border-radius: 8px; padding: 8px 10px; overflow-x: auto; }
.tmeta { margin: 0; font-size: 11px; color: var(--ink-mid); }
.controls { display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  padding: 14px 16px; background: var(--ground); border: 1px solid var(--line); border-radius: 12px; }
.timer { display: flex; flex-direction: column; margin-right: auto; }
.tclock { font-size: 19px; font-weight: 650; }
.timer.run .tclock { color: var(--good); }
.tstate { font-size: 11px; color: var(--ink-mid); }
.cbtns { display: flex; align-items: stretch; gap: 8px; flex-wrap: wrap; }
.btn { height: 40px; padding: 0 15px; border-radius: 9px; border: 1px solid var(--line); background: var(--surface-2);
  color: var(--ink); font-size: 13px; font-weight: 500; line-height: 1; cursor: pointer; white-space: nowrap;
  display: inline-flex; align-items: center; justify-content: center; }
.btn:disabled { opacity: .5; cursor: default; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.good { background: var(--good); border-color: var(--good); color: #06210f; }
.btn.warn { background: var(--warn); border-color: var(--warn); color: #241802; }
.btn.onconv { background: color-mix(in srgb, var(--accent) 16%, transparent);
  border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); color: var(--accent); }
.btn.onconv:hover { background: color-mix(in srgb, var(--accent) 24%, transparent); }
.btn.onconv.stalled { background: color-mix(in srgb, var(--bad) 16%, transparent);
  border-color: color-mix(in srgb, var(--bad) 50%, var(--line)); color: var(--bad); }
.btn.onconv.stalled:hover { background: color-mix(in srgb, var(--bad) 26%, transparent); }
.convstall { display: flex; flex-direction: column; gap: 2px; width: 100%; margin-top: 6px;
  padding: 7px 10px; border-radius: 8px; color: var(--bad);
  background: color-mix(in srgb, var(--bad) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--bad) 30%, transparent); font-size: 12px; }
.convstall span { color: var(--ink-mid); }
/* Снос стенда — действие необратимое: обычная кнопка, краснеет под курсором (как на конвейере). */
.btn.sbdown { color: var(--ink-mid); }
.btn.sbdown:hover:not(:disabled) { color: var(--bad); border-color: var(--bad); }
.btn.sbdown.busy { color: var(--bad); border-color: var(--bad); opacity: .85; }
.sbspin { display: inline-block; width: 10px; height: 10px; border: 2px solid var(--bad);
  border-top-color: transparent; border-radius: 50%; vertical-align: -1px; margin-right: 6px;
  animation: sbspin .8s linear infinite; }
@keyframes sbspin { to { transform: rotate(360deg); } }
.lmsg { font-size: 12px; color: var(--good); flex-basis: 100%; }
/* Форма запуска: решение человека сверху, технический immutable-контракт — свёрнут. */
.lform { flex-basis: 100%; display: flex; flex-direction: column; gap: 7px; margin-top: 8px;
  padding: 11px 12px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--line); }
.lrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.llbl { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-mid); }
.lopt { text-transform: none; letter-spacing: 0; }
.lsel { height: 32px; padding: 0 8px; border-radius: 8px; border: 1px solid var(--line);
  background: var(--ground); color: var(--ink); font-size: 13px; }
.lrepo { display: grid; grid-template-columns: minmax(90px, auto) 1fr; align-items: center; gap: 10px; }
.lrepo code { color: var(--ink); overflow-wrap: anywhere; }
.linp { min-width: 0; height: 32px; padding: 0 9px; border-radius: 8px; border: 1px solid var(--line);
  background: var(--ground); color: var(--ink); font-family: inherit; font-size: 13px; }
.linp:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.lhint { font-size: 12px; color: var(--ink-mid); }
.lhint.good { color: var(--good); }
.lsummary { display: grid; gap: 5px; padding: 8px 10px; border: 1px solid var(--line);
  border-radius: 9px; background: var(--ground); }
.lsummary-row { display: grid; grid-template-columns: minmax(90px, auto) 1fr; gap: 10px;
  align-items: baseline; font-size: 12.5px; }
.lsummary-row > span { color: var(--ink-mid); }
.lsummary-row > b { min-width: 0; overflow-wrap: anywhere; font-weight: 550; }
.lshipwarn { margin: 2px 0 0; padding-top: 6px; border-top: 1px solid var(--line);
  color: var(--warn); font-size: 11.5px; line-height: 1.4; }
.lform textarea { resize: vertical; padding: 8px 10px; border: 1px solid var(--line); border-radius: 9px;
  background: var(--ground); color: var(--ink); font-family: inherit; font-size: 13px; }
.lform textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.lnote { margin: 0; font-size: 11.5px; color: var(--ink-mid); line-height: 1.45; }
.ladvanced { margin-top: 2px; border: 1px dashed var(--line); border-radius: 9px; padding: 7px 10px; }
.ladvanced summary { color: var(--ink-mid); font-size: 12px; cursor: pointer; user-select: none; }
.ladvanced[open] summary { margin-bottom: 9px; }
.ladvanced-body { display: flex; flex-direction: column; gap: 7px; }
.lerror { margin: 0; color: var(--bad); font-size: 12px; }
.lbtns { display: flex; gap: 8px; justify-content: flex-end; }
.comment { display: flex; gap: 8px; align-items: flex-end; }
.comment textarea { flex: 1; resize: vertical; padding: 9px 11px; border: 1px solid var(--line);
  border-radius: 9px; background: var(--ground); color: var(--ink); font-family: inherit; font-size: 14px; }
.comment textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
</style>
