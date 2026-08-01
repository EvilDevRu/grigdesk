<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../../shared/api-client.js';
import { useChatStore, CONTEXT_WINDOW } from '../../stores/chat.js';
import { useTasksStore } from '../../stores/tasks.js';
import { useProvidersStore } from '../../stores/providers.js';
import EffortSlider from './EffortSlider.vue';
import StepList from './StepList.vue';
import ChatQuestion from './ChatQuestion.vue';
import ChatPermission from './ChatPermission.vue';
import HelpTip from '../../shared/ui/HelpTip.vue';
import { confirmDialog } from '../../shared/ui/confirm.js';
import { mdToHtml } from '../../shared/md.js';
import { documentRouteHref } from '../../features/documents/links.js';
import { lastModelRun, modelRunView } from '../../shared/chat-model-run.js';

// Одна сессия чата. Переиспользуется в плавающей панели и на странице «Агенты».
const props = defineProps({
  sid: { type: String, required: true },
  variant: { type: String, default: 'panel' }, // 'panel' | 'page'
});
// back — «назад к списку чатов»: кнопка живёт в шапке, но видна только на узком экране,
// где список и чат делят одну колонку (показом управляет CSS, не JS).
const emit = defineEmits(['back']);

const router = useRouter();
const chat = useChatStore();
const tasks = useTasksStore();

const sess = computed(() => chat.sessions.find((s) => s.id === props.sid) || null);

// ── Название чата (шапка на странице «Чаты» — в панели своё, вкладками, см. ChatTabs) ──
const editingTitle = ref(false);
const titleVal = ref('');
const titleEl = ref(null);
async function startTitleEdit() {
  titleVal.value = chat.tabLabel(sess.value);
  editingTitle.value = true;
  await nextTick();
  titleEl.value?.focus();
  titleEl.value?.select();
}
function commitTitle() {
  if (editingTitle.value) chat.setTitle(props.sid, titleVal.value.trim());
  editingTitle.value = false;
}

// ── Модели из реестра исполнителей (/api/providers): группы по ИИ, сила — сверху,
// у каждой модели свои уровни эффорта и своё окно контекста. Хардкода нет:
// новая модель/уровень появляется из реестра сама. ──
const prov = useProvidersStore();
prov.load();
// Модель чата: пустая = «по умолчанию»; сохранённый алиас (`opus`) резолвится в ту модель,
// на которую он указывает у текущего CLI. Решаем здесь, а не при создании чата: реестр
// к тому моменту может быть не загружен, да и бинарь потом обновится.
const current = computed(() => prov.modelOf(sess.value?.model));
const modelId = computed(() => current.value.id);
const currentModel = computed(() => current.value.model);
// Группы моделей для селекта (что именно видно — решает стор, правило одно на весь кокпит).
const provGroups = computed(() => prov.providers
  .map((p) => ({ ...p, models: prov.visibleModels(p, modelId.value) }))
  .filter((p) => p.models.length));
const FALLBACK_MODELS = ['opus', 'sonnet', 'haiku', 'fable']; // пока реестр не загрузился
const effortLevels = computed(() => currentModel.value?.efforts || []);
// Режимы прав исполнителя (список даёт его CLI). Пока чат не выбрал свой — показываем
// «вручную»: именно так работает чат по умолчанию (спрашивает разрешение на действия).
const modes = computed(() => prov.modesOf(sess.value?.model));
const currentMode = computed(() => {
  const want = sess.value?.mode;
  const list = modes.value;
  if (want && list.some((m) => m.id === want)) return want;
  return list.some((m) => m.id === 'manual') ? 'manual' : (list[0]?.id || '');
});
const modeHint = computed(() => modes.value.find((m) => m.id === currentMode.value)?.hint || 'Режим прав агента');
const ctxWindow = computed(() => currentModel.value?.context || CONTEXT_WINDOW);
// Модель выбрана, но установленный CLI про неё не знает (реестр помечает `unknown`):
// полный id он обычно всё равно принимает, а вот алиас/подпись могут врать — предупреждаем.
const modelUnknown = computed(() => !!currentModel.value?.unknown);
// Последний завершённый ход с моделью. Claude сообщает `actualModel` из потока,
// Codex JSONL пока его не отдаёт — у него честно показываем «запрошено», иначе
// поиск последнего непустого факта откатывался к старому Claude-ответу.
const lastRun = computed(() => lastModelRun(sess.value?.messages || []));
const lastRunView = computed(() => modelRunView(lastRun.value));
const lastRequestedName = computed(() => {
  const id = lastRun.value?.model;
  return id ? (prov.modelOf(id).model?.name || id) : '';
});
function onModelChange(e) {
  const oldProv = current.value.provider?.id;
  const newProv = prov.modelOf(e.target.value).provider?.id;
  chat.setModel(props.sid, e.target.value);
  // Сменили ИИ (claude ↔ gpt) — sessionId прежнего исполнителя несовместим,
  // резюмить им нельзя: сбрасываем контекст, история чата остаётся.
  if (oldProv && newProv && oldProv !== newProv && sess.value?.sessionId) {
    chat.resetContext(props.sid);
  }
  // У новой модели может не быть текущего уровня эффорта — снимаем явный выбор.
  // Выбирать другую ступень за пользователя нельзя.
  const lv = effortLevels.value;
  if (sess.value?.effort && lv.length && !lv.includes(sess.value.effort)) {
    chat.setEffort(props.sid, '');
  }
}

// Реестр загружается асинхронно и может обновиться уже после открытия чата.
// Когда он принёс достоверный список, старое неподдерживаемое значение не сохраняем.
watch(effortLevels, (levels) => {
  if (sess.value?.effort && levels.length && !levels.includes(sess.value.effort)) {
    chat.setEffort(props.sid, '');
  }
}, { immediate: true });

// ── Список задач для селекта (с ЗАГОЛОВКАМИ, не только номером) ──
let taskListPromise = null;
function fetchTaskList() {
  if (!taskListPromise) taskListPromise = api.get('/api/tasks').then((r) => r.tasks || []).catch(() => []);
  return taskListPromise;
}
const taskOpts = ref([]); // [{ task, route, title }]
onMounted(async () => {
  // При открытии — сразу в конец истории
  await nextTick();
  scrollDown();
  chat.loadConveyor();
  const list = await fetchTaskList();
  taskOpts.value = list.map((t) => ({ task: String(t.task), route: t.route, title: '' }));
  // Подтягиваем названия из B24 (для «#<TASK> · Название задачи…»).
  list.forEach((t) => tasks.load(t.task).then((d) => {
    const o = taskOpts.value.find((x) => x.task === String(t.task));
    if (o && d?.title) o.title = d.title;
  }).catch(() => {}));
});
function optLabel(o) { return `#${o.task} · ${o.title || o.route || 'задача'}`; }
const activeTaskLabel = computed(() => {
  const id = String(sess.value?.taskId || '');
  if (!id) return 'Без привязки к задаче';
  const option = taskOpts.value.find((o) => o.task === id);
  return option ? optLabel(option) : `#${id}`;
});
function onTaskChange(e) {
  const val = e.target.value;
  const o = taskOpts.value.find((x) => x.task === val);
  chat.setTask(props.sid, val || null, o ? (o.title || `#${o.task}`) : '');
}

// ── Контекст (окно — у каждой модели своё, из реестра) ──
const ctxPct = computed(() => Math.min(100, Math.round(((sess.value?.contextTokens || 0) / ctxWindow.value) * 100)));
// ── Порог «дорогого» разговора ────────────────────────────────────────────────
// Цвет кольца НЕ по проценту окна и НЕ по вбитому числу: красное там, где кокпит и так
// сожмёт («Настройки → Запуски → Сжимать контекст чата»), но не позже потолка окна модели.
// Процент окна как единственный ориентир врёт тем сильнее, чем окно больше: на 1M
// «жёлтые» 60% — это 600k, а дорожает разговор уже с ~250k (кокпит поднимает процесс CLI
// на каждое сообщение, выше этого кэш промпта на новом ходу не совпадает, и вся переписка
// пишется в кэш заново по двойному тарифу вместо чтения по десятой доле).
// Абсолютное число без потолка врало бы в другую сторону: у модели с окном 200k порог
// 200k недостижим, кольцо осталось бы зелёным до самого конца разговора.
const CTX_CEIL_RATIO = 0.8;  // потолок: доля окна модели, дальше которой ждать нельзя
const CTX_WARN_RATIO = 0.8;  // жёлтое — на подходе к порогу
const ctxLimit = computed(() => {
  const ceil = Math.round(ctxWindow.value * CTX_CEIL_RATIO);
  const want = chat.compactWindow || 0; // 0 — автосжатие в настройках выключено
  return want > 0 ? Math.min(want, ceil) : ceil;
});
const ctxClass = computed(() => {
  const tokens = sess.value?.contextTokens || 0;
  if (tokens >= ctxLimit.value) return 'hi';
  if (tokens >= ctxLimit.value * CTX_WARN_RATIO) return 'mid';
  return '';
});
// Codex в exec --json не сообщает фактическую заполненность окна. Даже старые
// сохранённые GPT-чаты без флага показываем честно, узнавая executor по модели.
const ctxIsEstimate = computed(() => !!sess.value?.contextIsEstimate || current.value?.provider?.id === 'codex');
const ctxTitle = computed(() => {
  const s = sess.value;
  const tokens = (s?.contextTokens || 0).toLocaleString('ru');
  if (s?.compacting) return 'Сжимаю контекст…';
  if (!s?.sessionId) return s?.pendingSeed ? 'Контекст сжат — выжимка уедет со следующим сообщением' : 'Контекст: пусто';
  if (s?.compactedAt && !s.contextTokens) return 'Контекст сжат — размер покажется после следующего хода';
  const hint = 'клик — сжать (Alt+клик — сбросить память агента)';
  if (ctxIsEstimate.value) {
    return `Ввод последнего хода: ${tokens} токенов (≈${ctxPct.value}% окна) · Codex не отдаёт точную заполненность контекста · ${hint}`;
  }
  const warn = (s?.contextTokens || 0) >= ctxLimit.value * CTX_WARN_RATIO ? ' · разговор уже дорогой, пора сжать' : '';
  return `Контекст: ${tokens} токенов (${ctxPct.value}%)${warn} · ${hint}`;
});
// Кольцо-индикатор контекста (клик — сжатие, Alt+клик — сброс памяти).
const RING_C = 2 * Math.PI * 9;
// На время сжатия дуга — короткий бегунок: кольцо в этот момент вращается, а полное
// (или почти полное) кольцо при вращении выглядело бы неподвижным.
const SPIN_DASH = RING_C * 0.75;
const ringDash = computed(() => (sess.value?.compacting ? SPIN_DASH : RING_C * (1 - ctxPct.value / 100)));

/**
 * Клик по кольцу. Основное действие — СЖАТИЕ: агент пересказывает разговор сам и
 * продолжает с выжимки. Alt+клик оставлен под прежнее поведение кольца — полный сброс
 * памяти агента: путать эти два действия дорого (после сброса переписка на экране
 * остаётся, а агент не помнит ничего), поэтому у каждого свой вопрос и свой текст.
 */
async function onCtxClick(e) {
  const s = sess.value;
  if (!s?.sessionId || s.compacting || s.sending) return;
  if (e.altKey) {
    const ok = await confirmDialog(
      'Агент забудет весь разговор: следующее сообщение начнёт его с нуля. Переписка на экране останется, но вернуть агенту контекст будет уже нельзя.',
      { title: 'Сбросить память агента?', okText: 'Сбросить', danger: true },
    );
    if (ok) chat.resetContext(props.sid);
    return;
  }
  const tokens = (s.contextTokens || 0).toLocaleString('ru');
  const ok = await confirmDialog(
    `Сейчас в контексте ${tokens} токенов. Агент соберёт из разговора рабочую выжимку и продолжит с неё — что решили, чего касались, что осталось. Это полноценный ход: он займёт время и потратит токены один раз, зато каждый следующий ход станет дешевле.`,
    { title: 'Сжать контекст чата?', okText: 'Сжать' },
  );
  if (ok) chat.compact(props.sid);
}

// Идёт сжатие — управление чата заморожено: ход уже в полёте, менять ему модель, задачу
// или права поздно, а второй ход на ту же сессию её убьёт. Поле ввода, вложения и диктовка
// намеренно живые: следующее сообщение можно готовить, пока агент пересказывает разговор.
const frozen = computed(() => !!sess.value?.compacting);

// ── «Прочитано» ──
// Открытый на экране чат читается сам: компонент рисуется ровно тогда, когда на чат
// смотрят (панель открыта / раздел «Чаты»). Ответ, пришедший в свёрнутую вкладку ОС,
// остаётся непрочитанным до возврата — поэтому слушаем ещё и visibilitychange.
function markRead() { if (!document.hidden) chat.markRead(props.sid); }
watch(() => [props.sid, sess.value?.unread], markRead, { immediate: true });
document.addEventListener('visibilitychange', markRead);
onUnmounted(() => document.removeEventListener('visibilitychange', markRead));

// ── Ввод ──
const input = ref(sess.value?.draft || '');
const body = ref(null);
function scrollDown() { if (body.value) body.value.scrollTop = body.value.scrollHeight; }

// ── Автопрокрутка ──
// Едем вниз на всё новое (сообщения, шаги ленты, «думает…»), но ТОЛЬКО если пользователь
// и так внизу: отлистал историю вверх — не дёргаем, иначе читать невозможно.
const NEAR_BOTTOM_PX = 120;
const atBottom = ref(true);
function onBodyScroll() {
  const el = body.value;
  if (!el) return;
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
}
async function autoScroll() {
  if (!atBottom.value) return;
  await nextTick();
  scrollDown();
}
watch(() => [
  sess.value?.messages?.length,
  sess.value?.steps?.length,
  sess.value?.sending,
  chat.permFor(props.sid)?.pid,
  chat.questionFor(props.sid)?.pid,
], autoScroll);
// Переключение на другой чат: подставляем его черновик и — в конец истории.
watch(() => props.sid, async () => {
  input.value = sess.value?.draft || '';
  atBottom.value = true; // новый чат открываем в конце истории
  await nextTick();
  scrollDown();
});
// Набранный, но не отправленный текст живёт в чате (и на сервере): переключение чатов,
// перезагрузка страницы и второе окно его не теряют. Пишем с задержкой — не на каждую букву.
let draftTimer = null;
watch(input, (v) => {
  clearTimeout(draftTimer);
  const sid = props.sid;
  draftTimer = setTimeout(() => chat.setDraft(sid, v), 400);
});
// Уход со страницы/закрытие вкладки — дописываем черновик немедленно, дебаунс не успел бы.
function flushDraft() { clearTimeout(draftTimer); chat.setDraft(props.sid, input.value); }
window.addEventListener('beforeunload', flushDraft);
onUnmounted(() => { flushDraft(); window.removeEventListener('beforeunload', flushDraft); });
async function submit() {
  const t = input.value.trim();
  const atts = pending.value.slice();
  if ((!t && !atts.length) || !sess.value || frozen.value) return;
  // Точное имя команды — выполняем её, а не шлём агенту.
  if (COMMANDS.some((c) => c.cmd === t)) { runCommand(t); return; }
  input.value = '';
  atBottom.value = true; // своё сообщение всегда показываем — как в мессенджерах
  // Черновик отправленного сообщения гасим сразу: дебаунс успел бы записать его
  // уже после отправки, и в списке чат остался бы «с черновиком».
  clearTimeout(draftTimer);
  chat.setDraft(props.sid, '');
  pending.value = [];
  await chat.send(props.sid, t, atts);
}
function onKey(e) {
  // Открыто меню команд — стрелки/Enter/Tab/Esc управляют им.
  const m = cmdMatches.value;
  if (m.length) {
    if (e.key === 'ArrowDown') { e.preventDefault(); cmdIndex.value = (cmdIndex.value + 1) % m.length; return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); cmdIndex.value = (cmdIndex.value - 1 + m.length) % m.length; return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); runCommand(m[Math.min(cmdIndex.value, m.length - 1)].cmd); return; }
    if (e.key === 'Escape') { input.value = ''; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); submit(); }
}

// ── Слэш-команды: ввод «/» открывает меню со списком и описаниями (как в Claude Code) ──
const COMMANDS = [
  { cmd: '/compact', desc: 'Сжать контекст: агент пересказывает разговор и продолжает с выжимки' },
  { cmd: '/clear', desc: 'Очистить историю и сбросить контекст агента' },
  { cmd: '/reset', desc: 'Сбросить только контекст (история остаётся)' },
  { cmd: '/new', desc: 'Открыть новый чат' },
];
const cmdIndex = ref(0);
const cmdMatches = computed(() => {
  const t = input.value.trimStart().toLowerCase();
  if (!t.startsWith('/') || /[\s\n]/.test(t)) return [];
  return COMMANDS.filter((c) => c.cmd.startsWith(t));
});
watch(cmdMatches, (m) => { if (cmdIndex.value >= m.length) cmdIndex.value = 0; });
function runCommand(cmd) {
  input.value = '';
  cmdIndex.value = 0;
  if (cmd === '/compact') {
    // Тот же путь, что у кольца: подтверждение обязательно — сжатие тратит ход агента.
    onCtxClick({ altKey: false });
  } else if (cmd === '/clear') {
    pending.value = [];
    chat.clearChat(props.sid);
    // Историю только что вычистили — плашка о сбросе осталась бы единственной записью.
    chat.resetContext(props.sid, { note: false });
  } else if (cmd === '/reset') {
    chat.resetContext(props.sid);
  } else if (cmd === '/new') {
    chat.newSession();
  }
}

// ── Вложения (фото): кнопка 📎 + вставка из буфера. Файл сразу уходит на сервер
// (chats/attachments/), к сообщению прикладывается ссылка — агент читает через Read. ──
const pending = ref([]); // [{ file, name, url, mime }]
const fileInput = ref(null);
const attachBusy = ref(false);
async function addFiles(files) {
  for (const f of files) {
    if (!f) continue;
    attachBusy.value = true;
    try {
      const fd = new FormData();
      fd.append('file', f, f.name || 'image.png');
      pending.value.push(await api.upload('/api/chat/upload', fd));
    } catch (e) {
      inputErr.value = `Загрузка: ${e.message}`;
    } finally { attachBusy.value = false; }
  }
}
function onPick(e) { addFiles([...e.target.files]); e.target.value = ''; }
function onPaste(e) {
  const imgs = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/'));
  if (!imgs.length) return;
  e.preventDefault();
  addFiles(imgs.map((i) => i.getAsFile()).filter(Boolean));
}
function removePending(i) { pending.value.splice(i, 1); }
function isImg(a) { return (a.mime || '').startsWith('image/'); }

// Drag&drop файлов на весь чат: счётчик enter/leave (leave стреляет на каждом
// дочернем элементе), оверлей-подсказка поверх.
const dragDepth = ref(0);
const dragOver = computed(() => dragDepth.value > 0);
function onDragEnter(e) { if (e.dataTransfer?.types?.includes('Files')) dragDepth.value++; }
function onDragLeave() { if (dragDepth.value > 0) dragDepth.value--; }
function onDrop(e) {
  dragDepth.value = 0;
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) addFiles(files);
}

// ── Диктовка с микрофона: MediaRecorder → /api/chat/transcribe (whisper) → текст в поле ──
const recording = ref(false);
const transcribing = ref(false);
const inputErr = ref('');
let recorder = null;
async function toggleMic() {
  inputErr.value = '';
  if (recording.value) { recorder?.stop(); return; }
  // getUserMedia доступен только в secure context (https/localhost).
  if (!navigator.mediaDevices?.getUserMedia) {
    inputErr.value = 'Микрофон требует https или localhost — открой кокпит по защищённому адресу';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = window.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      recording.value = false;
      transcribing.value = true;
      try {
        const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
        const fd = new FormData();
        fd.append('file', blob, 'dictation.webm');
        const r = await api.upload('/api/chat/transcribe', fd);
        if (r.text) input.value = (input.value ? input.value.trimEnd() + ' ' : '') + r.text;
        else inputErr.value = 'Речь не распознана — попробуй ещё раз';
      } catch (e) {
        inputErr.value = `Распознавание: ${e.message}`;
      } finally { transcribing.value = false; }
    };
    recorder = mr;
    mr.start();
    recording.value = true;
  } catch (e) {
    inputErr.value = `Микрофон: ${e.message}`;
  }
}
// Ctrl+D — старт/стоп записи (по физической клавише, работает в любой раскладке).
function onGlobalKey(e) {
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyD' && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    toggleMic();
  }
}
onMounted(() => window.addEventListener('keydown', onGlobalKey));
onUnmounted(() => window.removeEventListener('keydown', onGlobalKey));

// ── Копирование сообщения (иконка при наведении) ──
const copiedIdx = ref(-1);
async function copyMsg(m, i) {
  const text = m.text || '';
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // http://<ip> — clipboard API нет, фоллбэк через скрытую textarea
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    copiedIdx.value = i;
    setTimeout(() => { if (copiedIdx.value === i) copiedIdx.value = -1; }, 1500);
  } catch { /* не скопировалось — молча */ }
}

// ── Спросы агента: разрешение на действие и вопрос (AskUserQuestion). Все висящие
// запросы лежат в сторе (приходят по SSE, после F5 — из /api/chat/waiting);
// берём адресованные этому чату. Висят, пока не ответишь: агент их ждёт. ──
const perm = computed(() => chat.permFor(props.sid));
const question = computed(() => chat.questionFor(props.sid));

// ── Действие «На конвейер» с защитой ──
const onConveyor = computed(() => chat.isOnConveyor(sess.value?.taskId));
const launchMsg = ref(null);
async function toConveyor() {
  const s = sess.value; if (!s?.taskId) return;
  if (onConveyor.value) { router.push('/pipeline'); chat.close(); return; }
  launchMsg.value = 'запуск…';
  try {
    const r = await tasks.launch(s.taskId, s.messages.map((m) => m.text).join('\n').slice(-3000));
    launchMsg.value = r.outcome === 'already_running' ? 'уже идёт' : r.outcome === 'launched' ? `запущено (${r.profile})` : (r.note || 'отправлено');
    chat.loadConveyor();
  } catch (e) { launchMsg.value = `ошибка: ${e.message}`; }
}
</script>

<template>
  <div v-if="sess" class="cs" :class="[variant, { frozen }]"
       @dragenter.prevent="onDragEnter" @dragover.prevent @dragleave="onDragLeave" @drop.prevent="onDrop">
    <!-- Оверлей при перетаскивании файла -->
    <div v-if="dragOver" class="drop-overlay">
      <div class="drop-box">📎 Отпусти, чтобы приложить</div>
    </div>
    <!-- Шапка в два ряда: сверху название и задача, снизу — настройки хода.
         Высота фиксирована токеном --chat-head-h: линия под шапкой чата идёт по той же
         горизонтали, что и линия под шапкой списка чатов слева. -->
    <div class="cs-top">
      <div class="hrow">
        <!-- Назад к списку — только когда список и чат делят одну колонку (мобила) -->
        <button v-if="variant === 'page'" class="back" title="К списку чатов" aria-label="К списку чатов"
                @click="emit('back')">←</button>
        <!-- Название чата — только на странице «Чаты»: в плавающей панели его уже показывают вкладки -->
        <div v-if="variant === 'page'" class="ttl">
          <input v-if="editingTitle" ref="titleEl" v-model="titleVal" class="ctitle-edit"
                 @keydown.enter="commitTitle" @keydown.esc="editingTitle = false" @blur="commitTitle" />
          <template v-else>
            <span class="ctitle" :title="chat.tabLabel(sess)" @dblclick="startTitleEdit">
              {{ chat.tabLabel(sess) }}
            </span>
            <!-- Карандаш, а не только двойной клик: переименование иначе не найти -->
            <button class="tedit" title="Переименовать чат" aria-label="Переименовать чат"
                    @click="startTitleEdit">✎</button>
          </template>
        </div>
        <HelpTip class="task-tip" :text="activeTaskLabel" align="left" fixed :trigger-focusable="false">
          <span class="sel task">
            <span class="lbl">задача</span>
            <select :value="sess.taskId || ''" :disabled="frozen" @change="onTaskChange">
              <option value="">без задачи</option>
              <option v-for="o in taskOpts" :key="o.task" :value="o.task">{{ optLabel(o) }}</option>
            </select>
          </span>
        </HelpTip>
      </div>
      <div class="col bar">
        <!-- Последний завершённый запуск. «Факт» пишем только когда модель назвал сам CLI;
             иначе показываем запрошенный id и не откатываемся к старому ходу другого ИИ. -->
        <div v-if="lastRunView.model || modelUnknown" class="factbar">
          <template v-if="lastRun">
            <span class="fb" :class="{ warn: lastRunView.mismatch }">
              последний ход · {{ lastRunView.source }}: <b>{{ lastRunView.model }}</b>
              <template v-if="lastRun.effort"> · усилие {{ lastRun.effort }}</template>
            </span>
            <span v-if="lastRunView.mismatch" class="fb warn">— запрошено «{{ lastRequestedName }}»</span>
          </template>
          <span v-if="modelUnknown" class="fb warn"
                title="установленный CLI не знает эту модель — обнови его в настройках">
            установленный CLI не знает эту модель — обнови его в настройках
          </span>
        </div>
        <div class="spacer"></div>
        <div class="sel model">
          <span class="lbl">модель</span>
          <select :value="modelId" :disabled="frozen"
                  :title="currentModel ? `${currentModel.name} · контекст ${(currentModel.context / 1000).toFixed(0)}k` : 'Модель'"
                  @change="onModelChange">
            <template v-if="provGroups.length">
              <optgroup v-for="p in provGroups" :key="p.id" :label="p.name + (p.available ? '' : ' — недоступен')">
                <!-- «?» — модели нет в каталоге установленного CLI (он про неё не знает) -->
                <option v-for="m in p.models" :key="m.id" :value="m.id" :disabled="!p.available"
                        :title="`${m.id} · контекст ${(m.context / 1000).toFixed(0)}k` + (m.unknown ? ' · нет в каталоге установленного CLI' : '')">
                  {{ m.name }}{{ m.unknown ? ' ?' : '' }}
                </option>
              </optgroup>
            </template>
            <template v-else>
              <option v-for="m in FALLBACK_MODELS" :key="m" :value="m">{{ m }}</option>
            </template>
          </select>
        </div>
        <!-- Режим прав: как агент поступает с действиями (спрашивать / сам / только план) -->
        <div v-if="modes.length" class="sel mode">
          <span class="lbl">режим</span>
          <select :value="currentMode" :disabled="frozen" :title="modeHint" @change="chat.setMode(sid, $event.target.value)">
            <option v-for="m in modes" :key="m.id" :value="m.id" :title="m.hint">{{ m.label }}</option>
          </select>
        </div>
        <EffortSlider v-if="effortLevels.length" :model-value="sess.effort" :levels="effortLevels"
                      @update:model-value="chat.setEffort(sid, $event)" />
        <!-- Контекст: кольцо показывает точное значение либо явно помеченную оценку Codex.
             Клик — сжатие контекста (с подтверждением), Alt+клик — сброс памяти агента. -->
        <button class="ctx-ring" :class="[ctxClass, { estimate: ctxIsEstimate, compacting: sess.compacting }]"
                :disabled="!sess.sessionId || sess.compacting || sess.sending"
                :title="ctxTitle" :aria-label="ctxTitle"
                @click="onCtxClick">
          <svg viewBox="0 0 24 24">
            <circle class="rbg" cx="12" cy="12" r="9" fill="none" stroke-width="3" />
            <circle class="rfg" cx="12" cy="12" r="9" fill="none" stroke-width="3" stroke-linecap="round"
                    :stroke-dasharray="RING_C" :stroke-dashoffset="ringDash" transform="rotate(-90 12 12)" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Плашки «переписка не сохраняется» здесь НЕТ намеренно: saveError — состояние
         общее (сервер не принимает запись вообще), а рисовалась бы она внутри открытого
         чата и висела бы в каждом, куда ни зайди. Об этой беде сообщает разовое
         оповещение из стора (_saveFailed), а сама переписка держится снимком в браузере. -->

    <!-- Сообщения: ты — справа, агент — слева, ошибка — компактная плашка -->
    <div ref="body" class="cs-body" @scroll.passive="onBodyScroll">
      <div class="col flow">
        <div v-if="!sess.messages?.length" class="empty">
          <div class="e-title">{{ sess.taskId ? chat.tabLabel(sess) : 'Спроси агента' }}</div>
          <p class="e-sub muted">
            {{ sess.taskId ? 'Агент видит код задачи (worktree).' : 'Свободный вопрос без привязки к задаче.' }}<br>
            Модель и усилие — сверху. Enter — отправить, Shift+Enter — перенос. «/» — команды.
          </p>
        </div>
        <div v-for="(m, i) in sess.messages || []" :key="i" class="msg" :class="m.role">
          <div v-if="m.attachments?.length" class="m-atts">
            <a v-for="a in m.attachments" :key="a.file" :href="api.url(a.url)" target="_blank" rel="noopener">
              <img v-if="isImg(a)" :src="api.url(a.url)" :alt="a.name" :title="a.name" />
              <span v-else class="m-file">📄 {{ a.name }}</span>
            </a>
          </div>
          <!-- Подпись агента: ответ визуально отличим от системных плашек и твоих пузырей -->
          <div v-if="m.role === 'assistant'" class="ahead">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true">
              <path d="M12 2.5v6.2 M12 15.3v6.2 M2.5 12h6.2 M15.3 12h6.2 M5.3 5.3l4.4 4.4 M14.3 14.3l4.4 4.4 M18.7 5.3l-4.4 4.4 M9.7 14.3l-4.4 4.4" />
            </svg>
            <span>Агент</span>
            <span v-if="m.actualModel || m.model" class="amodel">
              {{ m.actualModel || m.model }}<template v-if="!m.actualModel"> · запрошено</template><template v-if="m.effort"> · {{ m.effort }}</template>
            </span>
          </div>
          <!-- Сообщение принято, но агент ещё занят предыдущим: ходы идут по очереди,
               а не наперегонки (два CLI на одну сессию убивают друг друга). -->
          <div v-if="m.queued" class="m-queued">⏳ ждёт очереди — уйдёт, когда агент закончит текущий ход</div>
          <!-- Ход агента: чем он занимался до ответа (свёрнуто, как в VS Code) -->
          <StepList v-if="m.role === 'assistant' && m.steps?.length" :steps="m.steps" />
          <div v-if="m.text" class="mrow">
            <!-- Ответ агента — безопасный GFM; raw HTML экранируется в md.js -->
            <div v-if="m.role === 'assistant'" class="text md"
                 v-html="mdToHtml(m.text, { resolveHref: documentRouteHref })"></div>
            <div v-else class="text">{{ m.text }}</div>
            <button class="copy" :class="{ done: copiedIdx === i }"
                    :title="copiedIdx === i ? 'Скопировано' : 'Копировать сообщение'" @click="copyMsg(m, i)">
              <svg v-if="copiedIdx === i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
          </div>
        </div>
        <div v-if="sess.sending" class="msg assistant">
          <!-- Живая лента текущего хода: инструменты и размышления по мере поступления -->
          <StepList v-if="sess.steps?.length" :steps="sess.steps" live />
          <div class="text muted">
            <span class="spin"></span> думает…<template v-if="sess.progressTokens"> · {{ sess.progressTokens.toLocaleString('ru') }} ток.</template>
          </div>
        </div>
        <!-- Связь этого окна с сервером оборвалась посреди хода. Сам ход при этом идёт:
             он живёт в процессе сервера, а не во вкладке, и ответ вернётся через
             chats/pending. Плашка ЛОКАЛЬНАЯ (поле offline в историю не едет) — порвалось
             у этого окна, другим устройствам показывать нечего. -->
        <div v-if="sess.offline" class="msg offline">
          <div class="text">📡 Связь с сервером прервалась — ход продолжается, ответ появится, когда связь вернётся.</div>
        </div>
      </div>
    </div>

    <!-- Действие на конвейер (только для задачи) -->
    <div v-if="sess.taskId && sess.messages?.length" class="cs-act">
      <div class="col act-row">
        <button class="act" :class="{ onconv: onConveyor }" :disabled="frozen" @click="toConveyor">
          🏭 {{ onConveyor ? 'Уже на конвейере →' : 'На конвейер' }}
        </button>
        <span v-if="launchMsg" class="lm muted">{{ launchMsg }}</span>
      </div>
    </div>

    <!-- Диалог: агент задал вопрос и ждёт ответа (не разрешение — выбор по существу) -->
    <ChatQuestion v-if="question" :req="question"
                  @answer="chat.answerQuestion(question.pid, $event)" @skip="chat.answerQuestion(question.pid, [])" />

    <!-- Всплывашка разрешения: агент хочет выполнить действие -->
    <ChatPermission v-if="perm" :req="perm" @answer="(allow, remember) => chat.answerPerm(perm.pid, allow, remember)" />

    <!-- Ввод: единый композер, кнопки внутри (📎 фото, 🎤 диктовка) -->
    <div class="cs-input">
      <div class="col">
        <!-- Чипы ещё не отправленных вложений -->
        <div v-if="pending.length || attachBusy" class="pend">
          <div v-for="(a, i) in pending" :key="a.file" class="chip">
            <img v-if="isImg(a)" :src="api.url(a.url)" alt="" />
            <span class="nm">{{ a.name }}</span>
            <button class="x" title="Убрать" @click="removePending(i)">×</button>
          </div>
          <span v-if="attachBusy" class="muted"><span class="spin"></span></span>
        </div>
        <!-- Меню слэш-команд над композером -->
        <div v-if="cmdMatches.length" class="cmd-menu">
          <button v-for="(c, i) in cmdMatches" :key="c.cmd" class="cmd" :class="{ on: i === cmdIndex }"
                  @mouseenter="cmdIndex = i" @click="runCommand(c.cmd)">
            <span class="c-cmd">{{ c.cmd }}</span>
            <span class="c-desc">{{ c.desc }}</span>
          </button>
        </div>
        <div class="composer">
          <button class="tool" title="Приложить файл (или перетащи/вставь из буфера)" @click="fileInput.click()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <input ref="fileInput" type="file" multiple hidden @change="onPick" />
          <textarea v-model="input" rows="2"
                    :placeholder="recording ? 'Говори… (клик по микрофону — стоп)' : 'Сообщение агенту…'"
                    @keydown="onKey" @paste="onPaste"></textarea>
          <HelpTip align="right" :text="recording ? 'Остановить запись · Ctrl+D' : transcribing ? 'Расшифровываю запись…' : 'Надиктовать голосом · Ctrl+D'">
          <button class="tool mic" :class="{ rec: recording, wait: transcribing }" :disabled="transcribing"
                  @click="toggleMic">
            <!-- Расшифровка: крутящийся спиннер -->
            <svg v-if="transcribing" class="spin-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
              <path d="M21 12a9 9 0 1 1-6.2-8.56" />
            </svg>
            <!-- Запись: квадрат-стоп -->
            <svg v-else-if="recording" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
            </svg>
            <!-- Покой: микрофон -->
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" x2="12" y1="19" y2="22" />
            </svg>
          </button>
          </HelpTip>
          <!-- Пока агент работает, рядом появляется «стоп». Отправку при этом НЕ прячем:
               следующее сообщение можно готовить и слать сразу — сервер поставит его
               в очередь и пустит следом (раньше оно молча пропадало). -->
          <button v-if="sess.sending || sess.compacting" class="send stop" :disabled="sess.stopping"
                  :title="sess.stopping ? 'Останавливаю…'
                    : sess.compacting ? 'Прервать сжатие контекста' : 'Остановить агента'" @click="chat.stop(sid)">
            <span class="sq"></span>
          </button>
          <button class="send" :disabled="frozen || (!input.trim() && !pending.length)"
                  :title="frozen ? 'Идёт сжатие контекста — отправка будет доступна сразу после него'
                    : sess.sending ? 'Отправить следом — уйдёт, когда агент закончит текущий ход (Enter)' : 'Отправить (Enter)'"
                  @click="submit">↑</button>
        </div>
        <div v-if="inputErr" class="in-err">{{ inputErr }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* min-width: 0 обязателен: без него флекс-элемент не сжимается ниже min-content своего
   содержимого — одна длинная команда в ленте или во всплывашке раздувала всю колонку
   чата, и кнопки «Разрешить/Отклонить» уезжали за правый край экрана. */
.cs { display: flex; flex-direction: column; min-height: 0; min-width: 0; height: 100%; }

.col { width: 100%; min-width: 0; }

.cs-top { display: flex; flex-direction: column; gap: 4px; padding: 8px 22px; border-bottom: 1px solid var(--line); }
/* На странице высота шапки — общий с левым списком токен, иначе две разделительные линии
   расходятся. min-height, а не height: редкое предупреждение о модели важнее ровной линии —
   пусть шапка подрастёт, чем текст обрежется. */
.page .cs-top { min-height: var(--chat-head-h); justify-content: center; }
/* Ряд настроек на странице НЕ переносится: перенос — это плюс 30px к шапке и разъехавшиеся
   линии. Вместо переноса ряд ужимается (см. shrink у .factbar), а на узком экране страница
   и так уходит в одну колонку, где шапке разрешено расти. */
.page .bar { flex-wrap: nowrap; }
.hrow { display: flex; align-items: center; gap: 8px; min-width: 0; }
/* Назад к списку: на широком экране список виден всегда, кнопка нужна только на мобиле */
.back { display: none; flex: none; width: 30px; height: 30px; margin-left: -6px; border: none; border-radius: 8px;
  background: none; color: var(--ink-mid); font-size: 17px; line-height: 1; cursor: pointer; place-items: center; }
.back:hover { background: var(--surface-2); color: var(--ink); }
/* Название чата — как заголовок карточки, рядом карандаш переименования */
.ttl { display: flex; align-items: center; gap: 3px; flex: 1 1 auto; min-width: 0; }
.ctitle { font-size: 15px; font-weight: 600; cursor: default; line-height: 1.3;
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Карандаш приглушён, пока не наводишь на шапку: он нужен редко, но должен быть виден
   всегда — двойным кликом по названию переименование никто не находит. */
.tedit { flex: none; width: 24px; height: 24px; border: none; border-radius: 6px; background: none;
  color: var(--ink-mid); font-size: 12px; cursor: pointer; display: grid; place-items: center;
  opacity: .5; transition: opacity .12s, color .12s, background .12s; }
.hrow:hover .tedit { opacity: 1; }
.tedit:hover { background: var(--surface-2); color: var(--ink); opacity: 1; }
.tedit:focus-visible { opacity: 1; outline: 1px solid var(--accent); }
.ctitle-edit { width: 100%; max-width: 420px; height: 26px; background: var(--ground); border: 1px solid var(--line-2);
  border-radius: 7px; color: var(--ink); font-size: 14px; font-weight: 600; padding: 0 8px; outline: none; font-family: inherit; }
.bar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.spacer { flex: 1; }
.sel { position: relative; }
/* На странице задача делит верхний ряд с названием чата: ей — правая половина, но
   ужимается она первой (название важнее). Полное название задачи доступно по ховеру
   в общем HelpTip — внешний overflow страницы его не обрежет. */
.task-tip { flex: 0 1 420px; max-width: 520px; min-width: 150px; }
.task-tip :deep(.ht-tr) { width: 100%; min-width: 0; cursor: default; }
.task-tip :deep(.ht-tip) { max-width: min(520px, calc(100vw - 16px)); }
.sel.task { width: 100%; min-width: 0; }
/* Селект модели сжимаемый: в узкой плавающей панели ряд «модель + эффорт + кольцо»
   должен оставаться одним рядом, а не разъезжаться на три */
.sel.model { flex: 0 1 140px; min-width: 84px; }
/* Плавающая панель: контролы всегда в два ряда. Распорку убираем — при переносе
   она вставала В НАЧАЛО второго ряда и сдвигала селект модели вправо (кривой отступ);
   вместо неё ряд заполняет растянутый селект модели. */
.panel .spacer { display: none; }
.panel .task-tip { flex: 1 1 100%; max-width: none; min-width: 0; }
/* basis 0 (не auto!): естественная ширина селекта — по самой длинной опции,
   с ней эффорт и кольцо выдавливаются на третий ряд */
.panel .sel.model { flex: 1 1 0; min-width: 84px; }
/* В узкой панели факт-строке места в ряду нет — уводим её своим рядом под контролы */
.panel .factbar { order: 9; flex: 1 1 100%; }
/* Панель — строка состояния, а не форма: у контролов нет своих коробок, только
   подпись-метка, значение и шеврон. Разделители — тонкие вертикальные линии. */
.sel { position: relative; display: flex; align-items: center; gap: 7px; padding: 0 2px; }
.sel .lbl { flex: none; font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-mid); opacity: .75; }
.sel::after { content: ''; position: absolute; right: 2px; top: 50%; width: 6px; height: 6px; pointer-events: none;
  border-right: 1.5px solid var(--ink-mid); border-bottom: 1.5px solid var(--ink-mid); transform: translateY(-70%) rotate(45deg); }
.sel select { width: 100%; height: 28px; -webkit-appearance: none; appearance: none; background: none; border: none;
  border-bottom: 1px solid transparent; color: var(--ink); padding: 0 16px 0 0; font-size: 12.5px; font-family: inherit;
  cursor: pointer; text-overflow: ellipsis; }
.sel select:hover { border-bottom-color: var(--line-2); }
/* Заморозка на время сжатия (см. frozen): селекты и кнопки выключены атрибутом, слайдеру
   усилия своего disabled не заводили — гасим его вместе с рядом действий. Композер не
   трогаем: печатать во время сжатия можно, нельзя только отправить. */
.sel select:disabled { opacity: .5; cursor: default; }
.cs.frozen .bar :deep(.eff), .cs.frozen .cs-act { opacity: .5; pointer-events: none; }
.sel select:focus { outline: none; border-bottom-color: var(--accent); }
/* Раскрытый список системный — ему нужен непрозрачный фон, иначе на тёмной теме нечитаемо */
.sel select option, .sel select optgroup { background: var(--surface); color: var(--ink); }
.sel + .sel, .bar > .sel + :deep(.eff), .bar :deep(.eff) + .ctx-ring {
  border-left: 1px solid var(--line); padding-left: 12px; margin-left: 4px; }

/* Кольцо контекста — маленькое, кликабельное (сброс) */
.ctx-ring { width: 30px; height: 30px; flex: none; padding: 0; border: none; border-radius: 8px;
  background: none; cursor: pointer; display: grid; place-items: center; }
.ctx-ring svg { width: 22px; height: 22px; }
.ctx-ring .rbg { stroke: var(--surface-2); }
.ctx-ring .rfg { stroke: var(--good); transition: stroke-dashoffset .3s; }
.ctx-ring.mid .rfg { stroke: var(--warn); }
.ctx-ring.hi .rfg { stroke: var(--bad); }
/* У Codex это не порог заполненности, а только вход последнего хода — не тревожим красным. */
.ctx-ring.estimate .rfg { stroke: var(--accent); opacity: .8; }
/* Сжатие идёт: у него нет ленты шагов, поэтому единственный признак работы — само
   кольцо. Крутим его как спиннер (дуга на это время короткая — см. SPIN_DASH), иначе
   нажатие выглядело бы как «кнопка ничего не сделала». */
.ctx-ring.compacting { opacity: 1 !important; }
.ctx-ring.compacting .rfg { stroke: var(--accent); }
.ctx-ring.compacting svg { animation: ctx-spin .8s linear infinite; }
@keyframes ctx-spin { to { transform: rotate(1turn); } }
.ctx-ring:not(:disabled):hover { background: var(--surface-2); }
.ctx-ring:disabled { cursor: default; opacity: .7; }

/* Воздух сверху/снизу — margin'ом самого скролл-контейнера (не паддингом:
   нижний паддинг при прокрутке до конца ненадёжен). Правый паддинг меньше
   на ширину скроллбара (11px, styles.css) — края совпадают с композером. */
.cs-body { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 0 11px 0 22px; margin: 26px 0; }
/* min-height 100% — пустое состояние центрируется */
.flow { display: flex; flex-direction: column; gap: 14px; min-height: 100%; }

/* Пустое состояние — по центру, а не подсказка в углу */
.empty { margin: auto; text-align: center; padding: 24px; }
.e-title { font-size: 17px; font-weight: 600; }
.e-sub { font-size: 13px; line-height: 1.6; margin-top: 8px; }

.msg { display: flex; flex-direction: column; gap: 4px; }
/* Текст + иконка копирования рядом (в потоке, не поверх текста). У пользовательских
   сообщений порядок обратный — иконка слева от пузыря. */
.mrow { display: flex; align-items: flex-end; gap: 6px; min-width: 0; }
.msg.user .mrow { flex-direction: row-reverse; }
/* Копировать — просто иконка-призрак, появляется при наведении на сообщение */
.copy { flex: none; background: none; border: none; padding: 2px; margin-bottom: 3px;
  color: var(--ink-mid); cursor: pointer; opacity: 0; transition: opacity .15s, color .15s;
  display: grid; place-items: center; }
.copy svg { width: 14px; height: 14px; }
.msg:hover .copy { opacity: 1; }
.copy:hover { color: var(--ink); }
.copy.done { opacity: 1; color: var(--good); }
.msg .text { font-size: 13.5px; white-space: pre-wrap; line-height: 1.55; overflow-wrap: anywhere; min-width: 0; }
.page .msg .text { font-size: 14.5px; }
/* Ты — справа, пузырь с акцентом; роль ясна по стороне, лейблы не нужны */
.msg.user { align-self: flex-end; align-items: flex-end; max-width: min(78%, 720px); }
.msg.user .text { background: color-mix(in srgb, var(--accent) 18%, transparent); padding: 9px 13px; border-radius: 14px 14px 4px 14px; }
/* Агент — слева, с подписью и акцентной полоской, текст маркдауном */
.msg.assistant { align-self: stretch; border-left: 2px solid color-mix(in srgb, #d97757 45%, transparent); padding-left: 13px; }
.ahead { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600;
  letter-spacing: .04em; text-transform: uppercase; color: var(--ink-mid); }
.ahead svg { width: 12px; height: 12px; color: #d97757; }
/* Модель хода: факт из потока CLI либо честно помеченный запрос */
.amodel { font-weight: 400; text-transform: none; letter-spacing: 0; opacity: .75;
  font-family: var(--mono, monospace); font-size: 10.5px; }

/* Строка последнего хода — слева в ряду настроек (она и селект модели про одно и то же),
   поэтому ужимается многоточием: своим рядом она раздувала шапку и рвала выравнивание.
   shrink 100 — при нехватке места ряд отбирает ширину у неё, а не у селектов: подпись
   информационная, а контролами пользуются. */
.factbar { display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden;
  flex: 0 100 auto; font-size: 11px; color: var(--ink-mid); }
.fb { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fb b { font-weight: 600; font-family: var(--mono, monospace); color: var(--ink); }
.fb.warn { color: var(--warn, #e0a33a); }
.fb.warn b { color: var(--warn, #e0a33a); }
/* Маркдаун ответа */
.text.md :deep(p) { margin: 0 0 8px; }
.text.md :deep(p:last-child) { margin-bottom: 0; }
.text.md :deep(h1), .text.md :deep(h2), .text.md :deep(h3),
.text.md :deep(h4), .text.md :deep(h5), .text.md :deep(h6) {
  margin: 14px 0 6px; font-size: 14px; line-height: 1.35; }
.text.md :deep(ul), .text.md :deep(ol) { margin: 4px 0 8px; padding-left: 20px; }
.text.md :deep(li) { margin: 2px 0; }
.text.md :deep(a) { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.text.md :deep(a:hover) { color: color-mix(in srgb, var(--accent) 75%, white); }
.text.md :deep(blockquote) { margin: 6px 0 8px; padding: 2px 0 2px 10px;
  border-left: 2px solid var(--line); color: var(--ink-mid); }
.text.md :deep(code) { background: var(--surface-2); border-radius: 4px; padding: 1px 5px; font-size: 12px; }
.text.md :deep(pre) { background: var(--ground); border: 1px solid var(--line); border-radius: 8px;
  padding: 10px 12px; overflow-x: auto; margin: 6px 0 8px; }
.text.md :deep(pre code) { background: none; padding: 0; }
.text.md :deep(table) { display: block; max-width: 100%; overflow-x: auto;
  border-collapse: collapse; margin: 6px 0 8px; }
.text.md :deep(th), .text.md :deep(td) { border: 1px solid var(--line); padding: 5px 8px; text-align: left; }
.text.md :deep(th) { background: var(--surface-2); }
.text.md :deep(hr) { border: 0; border-top: 1px solid var(--line); margin: 10px 0; }
.text.md :deep(img) { display: block; max-width: min(100%, 760px); height: auto; border-radius: 8px; margin: 6px 0 8px; }
/* md-текст не pre-wrap (маркдаун сам управляет блоками) */
.msg.assistant .text.md { white-space: normal; }
/* Ошибка — компактная плашка по содержимому, а не баннер во всю ширину */
/* Обрыв связи — предупреждение, а не провал: цвет «внимание», не «ошибка». */
.msg.offline { align-self: flex-start; max-width: 80%; }
.msg.offline .text { background: color-mix(in srgb, var(--warn) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); color: var(--muted); }
.msg.error { align-self: flex-start; max-width: 80%; }
.msg.error .text { background: color-mix(in srgb, var(--bad) 12%, transparent); border: 1px solid color-mix(in srgb, var(--bad) 30%, transparent);
  color: var(--bad); padding: 8px 12px; border-radius: 10px; font-size: 12.5px; }
.msg.error .text::before { content: '⚠ '; }

/* Служебная плашка самого кокпита (сжали контекст, сбросили память агента) — это не
   реплика: её не говорил ни агент, ни человек. Поэтому по центру, без пузыря и подписи. */
.msg.note { align-self: center; max-width: 90%; }
.msg.note .text { font-size: 12.5px; color: var(--ink-mid); background: var(--surface-2);
  border: 1px solid var(--line); border-radius: 10px; padding: 6px 12px; text-align: center; }

/* Запись истории не проходит — предупреждение поперёк всей ширины, над лентой:
   это не ошибка одного сообщения, а риск потерять весь разговор. */
.cs-act { padding: 8px 22px; border-top: 1px solid var(--line); }
.act-row { display: flex; align-items: center; gap: 10px; }
.act { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink); border-radius: 8px; padding: 6px 11px; font-size: 12.5px; cursor: pointer; }
.act.onconv { background: color-mix(in srgb, var(--accent) 16%, transparent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); color: var(--accent); }
.lm { font-size: 12px; }

/* Вложения в сообщениях: превью-картинки, клик — оригинал */
.m-queued { font-size: 12px; color: var(--ink-mid); margin-bottom: 4px; }
.msg.user .m-queued { text-align: right; }
.m-atts { display: flex; gap: 8px; flex-wrap: wrap; }
.msg.user .m-atts { justify-content: flex-end; }
.m-atts img { max-width: 220px; max-height: 160px; border-radius: 10px; border: 1px solid var(--line); display: block; }
.m-file { font-size: 12.5px; color: var(--ink-mid); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; display: inline-block; }
.m-atts a { text-decoration: none; }

.cs-input { padding: 12px 22px 16px; border-top: 1px solid var(--line); }
/* Чипы вложений до отправки */
.pend { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
.chip { display: flex; align-items: center; gap: 6px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; padding: 4px 6px; }
.chip img { width: 30px; height: 30px; object-fit: cover; border-radius: 5px; }
.chip .nm { font-size: 11.5px; color: var(--ink-mid); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip .x { background: none; border: none; color: var(--ink-mid); cursor: pointer; font-size: 14px; padding: 0 2px; }
.chip .x:hover { color: var(--bad); }
/* Кнопки-инструменты композера (скрепка / микрофон) */
.tool { flex: none; width: 36px; height: 36px; background: transparent; border: none; border-radius: 10px; cursor: pointer;
  color: var(--ink-mid); display: grid; place-items: center; }
.tool svg { width: 18px; height: 18px; }
.tool:hover { background: var(--surface-2); color: var(--ink); }
.tool.mic.rec { color: var(--bad); background: color-mix(in srgb, var(--bad) 16%, transparent); animation: mic-pulse 1.2s ease-in-out infinite; }
.tool.mic.wait { cursor: default; color: var(--accent); opacity: 1; }
@keyframes mic-pulse { 50% { background: color-mix(in srgb, var(--bad) 38%, transparent); } }
.spin-ico { animation: ico-rotate .9s linear infinite; }
@keyframes ico-rotate { to { transform: rotate(360deg); } }
.in-err { margin-top: 6px; font-size: 12px; color: var(--bad); }

/* Меню слэш-команд: якорится над композером */
.cs-input .col { position: relative; }
.cmd-menu { position: absolute; bottom: calc(100% + 8px); left: 0; right: 0; z-index: 6;
  background: var(--surface); border: 1px solid var(--line-2); border-radius: 12px; overflow: hidden;
  box-shadow: 0 10px 30px rgba(0, 0, 0, .45); }
.cmd { display: flex; align-items: baseline; gap: 12px; width: 100%; padding: 9px 14px; background: transparent;
  border: none; cursor: pointer; text-align: left; }
.cmd + .cmd { border-top: 1px solid var(--line); }
.cmd.on { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.c-cmd { font-family: var(--mono, monospace); font-size: 13px; color: var(--accent); flex: none; }
.c-desc { font-size: 12.5px; color: var(--ink-mid); }

/* Оверлей drag&drop поверх всего чата */
.cs { position: relative; }
.drop-overlay { position: absolute; inset: 0; z-index: 5; background: color-mix(in srgb, var(--ground) 65%, transparent);
  display: grid; place-items: center; pointer-events: none; }
.drop-box { border: 2px dashed var(--accent); border-radius: 14px; padding: 18px 28px; font-size: 14px;
  color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }

.composer { display: flex; gap: 6px; align-items: flex-end; background: var(--ground); border: 1px solid var(--line); border-radius: 12px; padding: 8px; }
.composer:focus-within { border-color: var(--line-2); }
.cs-input textarea { flex: 1; resize: none; background: transparent; border: none; outline: none; color: var(--ink);
  padding: 6px 0; font-family: inherit; font-size: 14px; line-height: 1.45; }
.page .cs-input textarea { min-height: 48px; }
.send { flex: none; width: 36px; height: 36px; background: var(--accent); color: #fff; border: none; border-radius: 10px;
  font-size: 16px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.send:disabled { opacity: .5; cursor: default; }
/* Пока агент работает — та же кнопка становится «стоп» (квадрат), как в плеере */
.send.stop { background: var(--bad); }
.send.stop .sq { width: 11px; height: 11px; border-radius: 2px; background: #fff; display: block; }

/* ── Планшет (до 1099): ряд настроек без подписей-меток ─────────────────────────
   Рядом со списком чату остаётся ~400px, и в такую ширину ряд влезает только так.
   Значение каждого контрола говорит само за себя (модель, режим, уровень), а полное
   название есть в подсказке по ховеру. Поля страницы тоже ужимаем. */
@media (max-width: 1099px) {
  .page .cs-top { padding: 8px 14px; }
  .page .cs-body { padding: 0 11px 0 14px; }
  .page .cs-act, .page .cs-input { padding-left: 14px; padding-right: 14px; }
  .page .task-tip { flex: 0 1 300px; }
  .page .sel.model .lbl, .page .sel.mode .lbl, .page .bar :deep(.eff .cap) { display: none; }
  .page .sel.model { flex: 0 1 118px; }
}

/* ── Планшет-портрет и телефон: список и чат делят одну колонку ──────────────────
   Порог 900, а не 760: в 400px, что остаётся чату рядом со списком, ряд настроек уже
   не помещается, а резать контролы хуже, чем показывать по одной колонке (так же
   ведут себя почтовики и мессенджеры на планшете в портрете). Строение шапки то же —
   ширины теперь хватает: колонка одна. */
@media (max-width: 899px) {
  .page .back { display: grid; }
  .page .task-tip { flex: 0 1 380px; }
}

/* ── Телефон: шапке разрешено расти ──────────────────────────────────────────────
   Выравнивать тут нечего (шапка на экране одна), а ряд контролов в 340px не влезает:
   название с задачей и настройки расходятся по своим рядам, поля — к минимуму. */
@media (max-width: 759px) {
  .page .cs-top { min-height: 0; justify-content: flex-start; padding: 8px 10px; }
  /* Переносится только задача: «назад» и название остаются одной строкой — иначе
     кнопка занимает целый ряд в одиночку и шапка съедает пятую часть экрана. */
  .page .hrow { flex-wrap: wrap; }
  .page .task-tip { flex: 1 1 100%; max-width: none; min-width: 0; }
  .page .bar { flex-wrap: wrap; }
  /* Факт-строка своим рядом — в одном ряду с контролами от неё осталось бы три буквы */
  .page .factbar { order: 9; flex: 1 1 100%; }
  .page .spacer { display: none; }
  .page .sel.model { flex: 1 1 0; }
  .page .sel.task .lbl { display: none; }
  .page :deep(.eff .track) { width: 62px; }
  .page .cs-body { padding: 0 6px 0 12px; margin: 16px 0; }
  .page .cs-act, .page .cs-input { padding-left: 12px; padding-right: 12px; }
  .page .cs-input { padding-bottom: 12px; }
  /* Иначе длинный текст режется в узкий столбик */
  .page .msg.user { max-width: 92%; }
  .page .msg .text { font-size: 14px; }
  .page .m-atts img { max-width: 62vw; }
}
</style>
