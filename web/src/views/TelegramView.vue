<script setup>
// Native-раздел канала Telegram: подключение бота, услышанные чаты, служебная
// личка и allowlist «чат/тема → проект». Общая очередь и её activation живут
// отдельно на `/inbox`; Telegram не владеет её карточками, решениями и моделью.
//
// Бот не ведёт диалог и не задаёт уточняющих вопросов. Единственное исходящее
// сообщение — явно включённое у конкретного правила подтверждение уже созданной
// задачи с номером и ссылкой на Битрикс24.
//
// Почему нет кнопки «создать бота»: у Телеграма нет API создания ботов вовсе —
// бот заводится только личной перепиской человека с @BotFather. Кокпит берёт
// на себя всё, что после: проверяет токен через getMe, называет бота по имени
// и кладёт секрет в server/.state с правами 0600. Терминал для этого не нужен.
//
// Правила «чат или тема → проект» — не настройка удобства, а разрешение читать:
// без правила ссылку на чат не развернёт никто. Поэтому редактор ничего не
// придумывает за человека (пустой список значит «закрыто везде») и правит список
// целиком: сервер и проверяет его целиком, одним валидатором.
import { computed, onMounted, ref, watch } from 'vue';

import { api } from '../shared/api-client.js';
import { confirmDialog } from '../shared/ui/confirm.js';
import { usePluginsStore } from '../stores/plugins.js';

const plugins = usePluginsStore();
if (!plugins.loaded) plugins.load();
const pluginOff = computed(() => plugins.loaded && !plugins.enabled('telegram'));

const bot = ref(null);
const poll = ref(null);   // состояние опроса: подключённый бот и идущий опрос — разное
const providerConnection = ref('disconnected');
const providerReason = ref('');
const chats = ref([]);    // что бот уже слышал
const rules = ref([]);    // рабочая копия правил: правится на месте, уезжает целиком
const savedRules = ref('[]'); // слепок того, что лежит на сервере — по нему видно несохранённое
const projects = ref([]);
const loading = ref(true);
const token = ref('');
const busy = ref('');     // '' | 'connect' | 'recheck' | 'disconnect' | 'rules' | 'service'
const error = ref('');
const note = ref('');

const connected = computed(() => !!bot.value?.configured);
const providerWritable = computed(() => connected.value && providerConnection.value === 'connected');
const canConnect = computed(() => providerConnection.value !== 'degraded');
// null — старая запись без этого поля: выдумывать состояние приватности нельзя.
const privacyKnown = computed(() => typeof bot.value?.canReadAllGroupMessages === 'boolean');

// Двe меры времени, и путать их нельзя: своё состояние кокпит считает в
// миллисекундах, а даты сообщений приходят от Bot API в секундах и такими же
// лежат в архиве. Поэтому две функции с явными именами, а не одна «универсальная».
function fmtMs(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
}
function fmtSec(sec) { return fmtMs(Number(sec || 0) * 1000); }

function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  return b === 1 ? forms[0] : forms[2];
}

const CHAT_KIND = {
  private: 'личный чат', group: 'группа', supergroup: 'супергруппа', channel: 'канал',
};
const chatKind = (c) => [CHAT_KIND[c.type] || c.type || 'чат', c.isForum ? 'с темами' : '']
  .filter(Boolean).join(', ');

// Что написать про опрос. Отдельно от «бот подключён»: токен может быть цел, а
// апдейты забирать второй экземпляр — тогда сообщения не придут вообще, и это
// должно быть видно словами, а не отсутствием чатов в списке.
const pollState = computed(() => {
  if (connected.value && !providerWritable.value) {
    return {
      kind: 'warn',
      text: 'Provider сейчас не готов к записи. Архив и ранее принятые обращения доступны только для чтения.',
    };
  }
  const p = poll.value;
  if (!p) return null;
  if (p.lastError) return { kind: 'warn', text: p.lastError.message };
  if (!p.running) {
    return {
      kind: 'warn',
      text: 'Опрос не идёт: сервер поднялся раньше, чем появился токен. Нажми «Проверить» — '
        + 'или перезапусти сервер, тогда опрос заведётся сам.',
    };
  }
  const parts = ['✓ Бот слушает Телеграм.'];
  if (p.lastMessageAt) parts.push(`Последнее сообщение — ${fmtMs(p.lastMessageAt)}.`);
  else if (p.lastPollAt) parts.push(`Сообщений пока не было, последний ответ Телеграма — ${fmtMs(p.lastPollAt)}.`);
  return { kind: 'good', text: parts.join(' ') };
});

async function loadChats() {
  try {
    chats.value = (await api.get('/api/telegram/chats')).chats || [];
  } catch (e) {
    // Список чатов вторичен: из-за него не должно пропадать подключение бота.
    if (e.data?.error !== 'plugin_disabled') error.value = e.message;
  }
}

// --- служебный чат ---

// Куда бот пересылает сам себе сообщение, которого нет в архиве (копия удаляется
// сразу). Выбор закрыт с двух сторон, и обе — про утечку: произвольный номер тут
// значил бы «шли рабочую переписку, куда скажу», а групповой чат не годится даже
// свой — служебная копия видна всем участникам, и уведомление о ней успевает
// уйти до удаления. Поэтому в списке только личка, которую бот уже слышал.
const serviceOptions = computed(() => {
  const out = new Map();
  for (const c of chats.value) {
    if (c.type === 'private') out.set(String(c.id), c.title || `чат ${c.id}`);
  }
  // Назначенный чат остаётся в списке, даже если архив о нём молчит: иначе селект
  // показывал бы «не выбран» при работающей пересылке.
  const cur = bot.value?.serviceChatId;
  if (cur && !out.has(String(cur))) out.set(String(cur), bot.value.serviceChatTitle || `чат ${cur}`);
  return [...out].map(([value, label]) => ({ value, label }));
});

const serviceChoice = ref('');
const serviceSaved = computed(() => (bot.value?.serviceChatId ? String(bot.value.serviceChatId) : ''));
// Селект идёт за сервером: bot.value присваивается в пяти местах (загрузка,
// подключение, перепроверка, отключение, само сохранение), и ловить их поимённо
// — верный способ забыть одно.
watch(serviceSaved, (id) => { serviceChoice.value = id; }, { immediate: true });
const serviceDirty = computed(() => serviceChoice.value !== serviceSaved.value);

async function saveService() {
  if (busy.value || !providerWritable.value) return;
  busy.value = 'service';
  error.value = '';
  note.value = '';
  try {
    const res = await api.post('/api/telegram/service-chat', {
      botId: bot.value.botId,
      chatId: serviceChoice.value ? Number(serviceChoice.value) : null,
    });
    bot.value = res.bot;
    note.value = bot.value.serviceChatId
      ? `Служебный чат — ${bot.value.serviceChatTitle || bot.value.serviceChatId}.`
      : 'Служебный чат снят: пересылать сообщения бот больше не будет.';
  } catch (e) {
    error.value = e.message;
    // Отказ сервера не должен оставлять в селекте то, чего сервер не принял.
    serviceChoice.value = serviceSaved.value;
  } finally {
    busy.value = '';
  }
}

// --- правила «чат или тема → проект» ---

// Ростер портала для селекта ответственного. Пустой список — не беда: задача
// без ответственного уходит на владельца сессии, и это разумный дефолт.
const b24users = ref([]);
async function loadUsers() {
  try {
    b24users.value = (await api.get('/api/b24/users')).users || [];
  } catch {
    // Портал не настроен или не отвечает — правила от этого не ломаются.
  }
}

// Проекты портала для GROUP_ID задачи. В форме показываем имена, числовой id
// остаётся только значением option и уезжает в уже существующий контракт правила.
const b24groups = ref([]);
const b24GroupsFailed = ref(false);
async function loadGroups() {
  try {
    b24groups.value = (await api.get('/api/b24/groups')).groups || [];
    b24GroupsFailed.value = false;
  } catch {
    // Сохранённые правила всё равно остаются редактируемыми: ниже подмешиваем
    // неизвестный id отдельным option, а новый проект просто нельзя выбрать.
    b24GroupsFailed.value = true;
  }
}

/** Положительное целое из поля ввода; пусто и мусор — «не задано». */
function toId(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// Проект могли архивировать или убрать из доступных уже после сохранения правила.
// Не подменяем такое значение на «без проекта» при следующей несвязанной правке.
const b24GroupOptions = computed(() => {
  const out = new Map();
  for (const group of b24groups.value) {
    const id = toId(group?.id);
    const name = String(group?.name || '').trim();
    if (id && name) out.set(id, { id, name, missing: false });
  }
  for (const rule of rules.value) {
    const id = toId(rule.b24?.groupId);
    if (id && !out.has(id)) {
      out.set(id, { id, name: `Проект #${id} (сохранён, но сейчас недоступен)`, missing: true });
    }
  }
  return [...out.values()];
});

// --- автомат «заводить задачи без меня» ---

// Те же дефолты, что у сервера (lib/telegram/rules-store.js). Копия здесь
// осознанная: форма обязана показать новое правило до того, как сервер его
// увидит, а тянуть ради трёх чисел общий модуль в браузер незачем.
const AUTO_TASK = { enabled: false, minConfidence: 0.7, maxPerDay: 10 };

/**
 * Число в границах; «не задано» — это дефолт, а НЕ ноль.
 *
 * Тот же довод, что на сервере: в полях ввода всё строки, стёртое поле приезжает
 * пустой строкой, а `Number('')` — ноль. Нулевой порог означал бы «заводи задачу
 * по любому разбору» — стирание поля не имеет права ослаблять автомат.
 */
function toNum(v, lo, hi, def) {
  if (v === null || v === undefined || String(v).trim() === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}

/** Половина автомата у правила. Читаем, не дописывая: правило могло приехать без неё. */
const autoOf = (r) => (r.autoTask && typeof r.autoTask === 'object' ? r.autoTask : AUTO_TASK);

function setAuto(r, key, value) {
  r.autoTask = { ...autoOf(r), [key]: value };
}

// Порог показываем процентами: «0.7» человек читает хуже, чем «70».
const pctOf = (r) => Math.round(toNum(autoOf(r).minConfidence, 0, 1, AUTO_TASK.minConfidence) * 100);

function setPct(r, value) {
  setAuto(r, 'minConfidence', Math.round(toNum(value, 0, 100, AUTO_TASK.minConfidence * 100)) / 100);
}

function setCap(r, value) {
  setAuto(r, 'maxPerDay', Math.round(toNum(value, 0, 100, AUTO_TASK.maxPerDay)));
}

/**
 * То, что уедет на сервер. Форма приводится здесь, а не в разметке: в полях
 * ввода всё строки, а правило хранит числа — иначе тема «42» приехала бы
 * строкой, а стёртое поле пустой строкой вместо «весь чат».
 */
function payload() {
  return rules.value.map((r) => {
    const thread = Number(r.threadId);
    const chatId = Number(r.chatId);
    const b24 = r.b24 || {};
    const priority = Number(b24.priority);
    return {
      ...r,
      project: String(r.project || '').trim(),
      chatId: r.chatId === null || r.chatId === '' || !Number.isSafeInteger(chatId) ? null : chatId,
      // Пустое поле имени — это «имя ещё не введено», а не имя из пустой строки.
      username: String(r.username ?? '').trim() || null,
      threadId: Number.isSafeInteger(thread) && thread > 0 ? thread : null,
      kind: r.kind === 'wish' ? 'wish' : 'bug',
      b24: {
        ...b24,
        responsibleId: toId(b24.responsibleId),
        groupId: toId(b24.groupId),
        priority: [0, 1, 2].includes(priority) ? priority : 1,
      },
      // Границы повторяют серверные, чтобы сохранение не возвращало другие числа
      // и «есть несохранённое» не загоралось сразу после успешного сохранения.
      autoTask: {
        ...autoOf(r),
        enabled: !!autoOf(r).enabled,
        minConfidence: toNum(autoOf(r).minConfidence, 0, 1, AUTO_TASK.minConfidence),
        maxPerDay: Math.round(toNum(autoOf(r).maxPerDay, 0, 100, AUTO_TASK.maxPerDay)),
      },
      notifyTaskCreated: r.notifyTaskCreated === true,
    };
  });
}

// «Есть несохранённое» считаем по тому, что уедет, а не по буквам в полях:
// стёртая и заново набранная тема — это не изменение.
const dirty = computed(() => JSON.stringify(payload()) !== savedRules.value);

// Чаты для выбора: услышанные плюс те, что уже привязаны правилом. Второе
// обязательно — бота могли убрать из чата, и без своей строки правило нельзя
// было бы ни увидеть, ни снять, хотя разрешение продолжает действовать.
const chatOptions = computed(() => {
  const out = new Map();
  for (const c of chats.value) out.set(c.id, c.title || `чат ${c.id}`);
  for (const r of rules.value) {
    if (r.chatId !== null && r.chatId !== undefined && !out.has(Number(r.chatId))) {
      out.set(Number(r.chatId), r.title || `чат ${r.chatId}`);
    }
  }
  return [...out].map(([id, label]) => ({ value: `id:${id}`, label }));
});

// HTTP Bot API не умеет перечислять форумные темы. Сервер собирает их из
// `message_thread_id` уже услышанных сообщений и отдаёт только для выбранного
// чата — так открытие страницы не сканирует архивы всех групп подряд.
const topicsByChat = ref({});
const topicLoading = ref({});
const topicErrors = ref({});

function ruleChatId(r) {
  const direct = Number(r.chatId);
  if (Number.isSafeInteger(direct) && direct !== 0) return direct;
  const username = String(r.username || '').replace(/^@/, '').toLowerCase();
  if (!username) return null;
  return chats.value.find((c) => String(c.username || '').toLowerCase() === username)?.id ?? null;
}

const topicKey = (chatId) => String(chatId);
const topicsOf = (r) => topicsByChat.value[topicKey(ruleChatId(r))] || [];
const topicsLoaded = (r) => Object.prototype.hasOwnProperty.call(
  topicsByChat.value, topicKey(ruleChatId(r)),
);
const topicsBusy = (r) => !!topicLoading.value[topicKey(ruleChatId(r))];
const topicsError = (r) => topicErrors.value[topicKey(ruleChatId(r))] || '';
const topicChoice = (r) => (toId(r.threadId) ? String(toId(r.threadId)) : '');
const topicKnown = (r) => topicsOf(r).some((t) => t.id === toId(r.threadId));
const topicLabel = (t) => {
  if (t.title) return `${t.title} · тема ${t.id}`;
  const count = Number(t.messages || 0);
  return `Тема ${t.id} · ${count} ${plural(count, ['сообщение', 'сообщения', 'сообщений'])}`;
};

/** Корень темы открывается как обычное сообщение с id, равным thread_id. */
function topicLink(r) {
  const threadId = toId(r.threadId);
  const chatId = ruleChatId(r);
  if (!threadId || chatId === null) return '';
  const chat = chats.value.find((c) => Number(c.id) === Number(chatId));
  const username = String(chat?.username || r.username || '').replace(/^@/, '').trim();
  if (/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(username)) {
    return `https://t.me/${username}/${threadId}`;
  }
  const id = String(chatId);
  return /^-100\d+$/.test(id) ? `https://t.me/c/${id.slice(4)}/${threadId}` : '';
}

async function loadTopics(chatId, { force = false } = {}) {
  const id = Number(chatId);
  if (!Number.isSafeInteger(id) || id === 0) return;
  const key = topicKey(id);
  if (topicLoading.value[key] || (!force && Object.prototype.hasOwnProperty.call(topicsByChat.value, key))) return;

  topicLoading.value[key] = true;
  topicErrors.value[key] = '';
  try {
    const res = await api.get(`/api/telegram/chats/${encodeURIComponent(id)}/topics`);
    topicsByChat.value[key] = Array.isArray(res?.topics) ? res.topics : [];
  } catch (e) {
    // Ручной ввод остаётся рабочим даже со старым сервером или временной ошибкой
    // архива; общей красной плашкой вторичный справочник страницу не перекрывает.
    topicErrors.value[key] = e.message || 'Не удалось загрузить темы.';
  } finally {
    topicLoading.value[key] = false;
  }
}

const loadTopicsForRule = (r, force = false) => loadTopics(ruleChatId(r), { force });

async function loadRuleTopics() {
  const ids = [...new Set(rules.value.map(ruleChatId).filter((id) => id !== null))];
  await Promise.all(ids.map((id) => loadTopics(id)));
}

function setThread(r, value) {
  r.threadId = value === '' ? null : toId(value);
}

// Проект из правила, которого нет в списке (переименовали, убрали профиль),
// показываем как есть: пустой селект означал бы «проект не выбран», и первое
// же сохранение увело бы правило не туда.
const projectOptions = computed(() => {
  const out = new Set(projects.value);
  for (const r of rules.value) if (r.project) out.add(r.project);
  return [...out];
});

const chatMode = (r) => {
  if (r.chatId !== null && r.chatId !== undefined && r.chatId !== '') return `id:${r.chatId}`;
  return r.username === null || r.username === undefined ? '' : 'name';
};

function setChat(r, value) {
  r.title = '';
  r.threadId = null;
  if (value === 'name') {
    // Публичный чат привязывается именем: в ссылке t.me/имя числового id нет вовсе.
    r.chatId = null;
    r.username = '';
    return;
  }
  r.username = null;
  r.chatId = value ? Number(value.slice(3)) : null;
  const known = chatOptions.value.find((o) => o.value === value);
  if (known) r.title = known.label;
  if (r.chatId !== null) loadTopics(r.chatId);
}

function addRule() {
  if (!providerWritable.value) return;
  rules.value.push({
    project: '', chatId: null, username: null, title: '', threadId: null,
    // Вид по умолчанию — баг: тема с жалобами и есть главный источник поводов,
    // «Идея» ставится осознанно. Приоритет 1 — средний, коды портала: 0/1/2.
    kind: 'bug',
    b24: { responsibleId: null, groupId: null, priority: 1 },
    // Ответы выключены: включение — осознанное решение для конкретного чата/темы.
    notifyTaskCreated: false,
    // Автомат выключен у нового правила: сначала посмотри, что вообще прилетает
    // в этот чат, и только потом отдавай его роботу.
    autoTask: { ...AUTO_TASK },
  });
}

async function loadRules() {
  try {
    const res = await api.get('/api/telegram/rules');
    rules.value = res.rules || [];
    projects.value = res.projects || [];
    savedRules.value = JSON.stringify(payload());
    await loadRuleTopics();
  } catch (e) {
    if (e.data?.error !== 'plugin_disabled') error.value = e.message;
  }
}

async function saveRules() {
  if (busy.value || !providerWritable.value) return;
  busy.value = 'rules';
  error.value = '';
  note.value = '';
  try {
    const res = await api.put('/api/telegram/rules', {
      botId: bot.value.botId,
      rules: payload(),
    });
    // Ответ сервера — уже нормализованные правила: берём их, а не свою копию,
    // иначе на экране осталась бы форма до проверки, а на диске другая.
    rules.value = res.rules || [];
    savedRules.value = JSON.stringify(payload());
    note.value = rules.value.length
      ? `Сохранено: ${rules.value.length} ${plural(rules.value.length, ['правило', 'правила', 'правил'])}.`
      : 'Правил не осталось — чаты снова закрыты.';
  } catch (e) {
    // Текст валидатора уже человеческий и с номером правила — показываем как есть.
    error.value = e.message;
  } finally {
    busy.value = '';
  }
}

async function load() {
  loading.value = true;
  try {
    const res = await api.get('/api/telegram/status');
    bot.value = res.bot;
    poll.value = res.poll;
    providerConnection.value = typeof res.connection === 'string'
      ? res.connection
      : (res.bot?.configured ? 'connected' : 'disconnected');
    providerReason.value = typeof res.reason === 'string' ? res.reason : '';
    error.value = '';
    if (bot.value?.configured) {
      await loadChats();
      await loadRules();
      await loadUsers();
      await loadGroups();
    }
  } catch (e) {
    // Выключенный плагин — не ошибка: заглушку покажет pluginOff.
    if (e.data?.error !== 'plugin_disabled') error.value = e.message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function connect() {
  if (!token.value.trim() || busy.value || !canConnect.value) return;
  busy.value = 'connect';
  error.value = '';
  note.value = '';
  try {
    const res = await api.post('/api/telegram/connect', { token: token.value.trim() });
    bot.value = res.bot;
    poll.value = res.poll;
    providerConnection.value = 'connected';
    providerReason.value = '';
    token.value = '';   // проверенный токен уже на сервере, в поле ему делать нечего
    note.value = `Бот @${bot.value.username} подключён.`;
    await loadChats();
    // И правила тоже: до подключения карточки «Разрешённые чаты» не было, значит
    // не было и списка проектов — без этого селект проекта пустой до F5.
    await Promise.all([loadRules(), loadUsers(), loadGroups()]);
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = '';
  }
}

async function recheck() {
  if (busy.value) return;
  busy.value = 'recheck';
  error.value = '';
  note.value = '';
  try {
    const res = await api.post('/api/telegram/recheck', {});
    bot.value = res.bot;
    poll.value = res.poll;
    providerConnection.value = 'connected';
    providerReason.value = '';
    note.value = bot.value.canReadAllGroupMessages
      ? 'Проверено: бот читает переписку в группах целиком.'
      : 'Проверено. Режим приватности всё ещё включён.';
    await loadChats();
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = '';
  }
}

async function disconnect() {
  const ok = await confirmDialog(
    `Отключить бота @${bot.value?.username || ''}? Токен будет стёрт, приём в Inbox остановится. `
      + 'Ранее принятые обращения останутся только для чтения; для возврата понадобится вставить токен и отдельно возобновить приём.',
    { danger: true, okText: 'Отключить' },
  );
  if (!ok || busy.value) return;
  busy.value = 'disconnect';
  error.value = '';
  note.value = '';
  try {
    const res = await api.post('/api/telegram/disconnect', {});
    bot.value = res.bot;
    poll.value = res.poll;
    providerConnection.value = 'disconnected';
    providerReason.value = '';
    chats.value = [];
    topicsByChat.value = {};
    topicLoading.value = {};
    topicErrors.value = {};
    note.value = 'Бот отключён, токен стёрт. Ранее принятые обращения остаются в общем Inbox только для чтения.';
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = '';
  }
}
</script>

<template>
  <div class="tg">
    <section v-if="pluginOff" class="card disabled-card">
      <div class="disabled-mark">TG</div>
      <div>
        <h2 class="ttl">Телеграм пока выключен</h2>
        <p class="muted lead">
          Включи плагин «Телеграм» в разделе «Настройки → Плагины»,
          затем вернись сюда — появится пошаговое подключение.
        </p>
      </div>
    </section>

    <template v-else>
      <header class="tg-hero">
        <div class="hero-copy">
          <div class="eyebrow">Канал Telegram</div>
          <h2 class="ttl">
            <template v-if="loading">Готовим рабочее пространство…</template>
            <template v-else-if="connected">Бот подключён и хранит сообщения в своём канале</template>
            <template v-else>Подключи бота — это займёт несколько минут</template>
          </h2>
          <p class="muted lead">
            Здесь управляются подключение, архив и allowlist Telegram. Очередь и отдельный
            переключатель приёма новых обращений находятся в общем разделе «Входящие».
            Бот читает только явно разрешённые ниже чаты и пишет туда лишь включённые
            подтверждения уже созданных задач.
          </p>
        </div>

        <div v-if="!loading && connected" class="hero-stats" aria-label="Сводка Телеграма">
          <a class="hero-stat" href="#/inbox">
            <strong>Inbox</strong>
            <span>приём и общая очередь</span>
          </a>
          <a class="hero-stat" href="#tg-chats">
            <strong>{{ chats.length }}</strong>
            <span>{{ plural(chats.length, ['чат пишет', 'чата пишут', 'чатов пишут']) }} боту</span>
          </a>
          <a class="hero-stat" href="#tg-rules">
            <strong>{{ rules.length }}</strong>
            <span>{{ plural(rules.length, ['правило', 'правила', 'правил']) }} доступа</span>
          </a>
        </div>

        <div v-else-if="!loading" class="setup-summary">
          <span class="setup-time">≈ 3 минуты</span>
          <span>Нужен только Телеграм и токен от @BotFather</span>
        </div>

        <div v-else class="hero-loading"><span class="spin"></span> Загружаю состояние бота</div>
      </header>

      <div v-if="error || note" class="feedback" role="status" aria-live="polite">
        <p v-if="error" class="err">{{ error }}</p>
        <p v-if="note" class="ok">{{ note }}</p>
      </div>

      <!-- Подключённый бот: native provider lifecycle и его account-scoped настройки. -->
      <template v-if="!loading && connected">
        <nav class="setup-path" aria-label="Настройка Телеграма">
          <a class="path-step done" href="#tg-bot">
            <span class="path-mark">1</span>
            <span class="path-copy">
              <b>Бот подключён</b>
              <small v-if="privacyKnown && bot.canReadAllGroupMessages">Группы доступны целиком</small>
              <small v-else>Проверь режим приватности</small>
            </span>
          </a>
          <a class="path-step" :class="{ done: chats.length }" href="#tg-chats">
            <span class="path-mark">2</span>
            <span class="path-copy">
              <b>Получи сообщение</b>
              <small>{{ chats.length ? 'Бот уже слышит чаты' : 'Добавь бота в рабочий чат' }}</small>
            </span>
          </a>
          <a class="path-step" :class="{ done: rules.length, attention: dirty }" href="#tg-rules">
            <span class="path-mark">3</span>
            <span class="path-copy">
              <b>Разреши чат</b>
              <small v-if="dirty">Есть несохранённые изменения</small>
              <small v-else>{{ rules.length ? 'Привязка к проекту настроена' : 'Выбери проект для чата' }}</small>
            </span>
          </a>
        </nav>

        <div class="tg-grid">
          <aside class="side-stack" aria-label="Состояние и вспомогательные настройки">
            <!-- Подключение и здоровье опроса — отдельные provider-состояния. -->
            <section id="tg-bot" class="card bot-card">
              <div class="head">
                <div class="bot-name">
                  <span class="status-dot" :class="pollState?.kind === 'good' ? 'on' : 'warn'"></span>
                  <div>
                    <div class="section-kicker">Подключённый бот</div>
                    <div class="name">@{{ bot.username }}</div>
                  </div>
                </div>
              </div>

              <div v-if="privacyKnown && bot.canReadAllGroupMessages" class="state good">
                ✓ Режим приватности выключен — в группах бот видит переписку целиком.
              </div>
              <div v-else-if="privacyKnown" class="state warn">
                <b>Бот пока не видит переписку в группах.</b>
                {{ bot.privacyHint }}
                Выключи режим у @BotFather и нажми «Проверить».
              </div>
              <div v-else class="state">
                Состояние режима приватности неизвестно — нажми «Проверить».
              </div>

              <div v-if="pollState" class="state" :class="pollState.kind">{{ pollState.text }}</div>
              <div v-if="providerReason" class="state warn">Причина provider: {{ providerReason }}</div>

              <p class="muted sub">
                Следующий шаг: добавь @{{ bot.username }} в рабочий чат обычным
                «Добавить участника» и отправь тестовое сообщение.
              </p>

              <div class="bot-actions">
                <button class="btn" :disabled="!!busy" @click="recheck">
                  {{ busy === 'recheck' ? 'Проверяю…' : 'Проверить' }}
                </button>
                <button class="btn danger disconnect" :disabled="!!busy" @click="disconnect">Отключить</button>
              </div>

              <details class="technical">
                <summary>Данные подключения</summary>
                <div class="muted sub technical-data">
                  id {{ bot.botId }} · токен {{ bot.tokenHint }}
                  <template v-if="bot.connectedAt"> · подключён {{ fmtMs(bot.connectedAt) }}</template>
                </div>
              </details>
            </section>

            <!-- Единственный источник имён для привязки «чат/тема → проект». -->
            <section id="tg-chats" class="card chats-card">
              <div class="head compact-head">
                <div>
                  <div class="section-kicker">Источник сообщений</div>
                  <div class="section-title">
                    <span class="h">Что слышит бот</span>
                    <span v-if="chats.length" class="count subtle">{{ chats.length }}</span>
                  </div>
                </div>
                <button class="btn compact" :disabled="loading" @click="loadChats">Обновить</button>
              </div>

              <div v-if="!chats.length" class="mini-empty">
                <b>Сообщений пока не было</b>
                <p class="muted sub">
                  Добавь бота в рабочий чат и напиши туда что-нибудь — чат появится здесь.
                </p>
              </div>
              <ul v-else class="chats">
                <li v-for="c in chats" :key="c.id" class="chat">
                  <div class="cname">{{ c.title || `чат ${c.id}` }}</div>
                  <div class="muted sub">
                    {{ chatKind(c) }} ·
                    {{ c.messages }} {{ plural(c.messages, ['сообщение', 'сообщения', 'сообщений']) }}
                  </div>
                  <div class="muted chat-meta">
                    id {{ c.id }}<template v-if="c.lastAt"> · последнее {{ fmtSec(c.lastAt) }}</template>
                  </div>
                </li>
              </ul>

              <p class="muted sub card-foot">
                Этот список только показывает, откуда уже пришли сообщения. Чтобы использовать
                их в задачах, настрой привязку «чат или тема → проект» ниже.
              </p>
            </section>

            <!-- Необязательный фолбэк для сообщений, которых ещё нет в архиве. -->
            <section class="card service-card">
              <div class="head compact-head">
                <div>
                  <div class="section-kicker">Для старых ссылок · необязательно</div>
                  <div class="h">Служебный чат</div>
                </div>
                <span class="optional-chip">Опционально</span>
              </div>

              <p class="muted sub">
                Выбери свою личку с ботом. Через неё кокпит сможет достать сообщение,
                которое было отправлено до подключения бота.
              </p>

              <fieldset class="native-editor" :disabled="!providerWritable || !!busy">
                <div class="service-control">
                  <select v-model="serviceChoice" class="sel">
                    <option value="">не выбран — пересылки не будет</option>
                    <option v-for="o in serviceOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                  </select>
                  <button v-if="serviceDirty" class="btn primary" @click="saveService">
                    {{ busy === 'service' ? 'Сохраняю…' : 'Сохранить' }}
                  </button>
                </div>
              </fieldset>

              <p v-if="!serviceOptions.length" class="muted sub">
                Выбирать пока не из чего: напиши боту в личку что угодно, и чат появится здесь.
              </p>
              <p v-else-if="!serviceSaved" class="muted sub">
                Пока чат не выбран, старые ссылки останутся неразвёрнутыми — новые сообщения
                продолжат работать как обычно.
              </p>

              <details class="explain compact-explain">
                <summary>Зачем нужна именно личка?</summary>
                <p class="muted sub">
                  Бот на секунду пересылает туда исходное сообщение и сразу удаляет копию.
                  Групповой чат не подходит: служебную копию успеют увидеть его участники.
                </p>
              </details>
            </section>
          </aside>

          <!-- Allowlist: широкая карточка и явная последовательность «откуда → куда → автомат». -->
          <section id="tg-rules" class="card rules-card">
            <div v-if="!providerWritable" class="state warn" data-state="provider-read-only">
              Provider не подключён для записи. Правила и архив показаны только для чтения;
              переподключение не возобновит приём Inbox автоматически.
            </div>
            <fieldset class="native-editor rules-editor" :disabled="!providerWritable || !!busy">
            <div class="head rules-head">
              <div>
                <div class="section-kicker">Доступ и маршрутизация</div>
                <div class="section-title">
                  <span class="h">Разрешённые чаты</span>
                  <span v-if="rules.length" class="count subtle">{{ rules.length }}</span>
                </div>
              </div>
              <button class="btn" :disabled="!!busy" @click="addRule">Добавить чат</button>
            </div>

            <div class="rules-callout">
              <span class="callout-mark">!</span>
              <div>
                <b>Бот слышит чат, но кокпит не использует его без правила.</b>
                <p class="muted sub">
                  Правило одновременно разрешает читать переписку и объясняет, в какой проект
                  создавать задачу. Всё, чего нет в списке, остаётся закрытым.
                </p>
              </div>
            </div>

            <div v-if="!rules.length" class="empty-rules">
              <div>
                <b>Ни один чат не разрешён</b>
                <p class="muted sub">
                  Добавь первое правило, выбери услышанный чат и проект кокпита.
                </p>
              </div>
              <button class="btn primary" :disabled="!!busy" @click="addRule">Добавить первое правило</button>
            </div>

            <ol v-else class="rules">
              <li v-for="(r, i) in rules" :key="i" class="rule">
                <div class="rule-head">
                  <div>
                    <span class="rule-number">Правило {{ i + 1 }}</span>
                    <b>{{ r.title || r.username || 'Новый чат' }}</b>
                  </div>
                  <button class="icon-btn danger x" title="Убрать правило" @click="rules.splice(i, 1)">×</button>
                </div>

                <div class="rule-builder">
                  <section class="rule-part">
                    <div class="part-head">
                      <span class="part-number">1</span>
                      <div>
                        <b>Откуда читать</b>
                        <small>Рабочий чат целиком или одна тема</small>
                      </div>
                    </div>

                    <div class="field-grid source-fields">
                      <label class="control full">
                        <span class="field-label">Чат</span>
                        <select class="sel chat-select" :value="chatMode(r)" @change="setChat(r, $event.target.value)">
                          <option value="">чат не выбран</option>
                          <option v-for="o in chatOptions" :key="o.value" :value="o.value">
                            {{ o.label }}
                          </option>
                          <option value="name">публичный чат по имени…</option>
                        </select>
                      </label>
                      <label v-if="chatMode(r) === 'name'" class="control">
                        <span class="field-label">Имя публичного чата</span>
                        <input
                          v-model="r.username"
                          class="inp thin"
                          spellcheck="false"
                          placeholder="имя_чата"
                        />
                      </label>
                      <div class="control topic-control">
                        <span class="field-label">Тема <em>необязательно</em></span>
                        <select
                          class="sel thin topic-select"
                          :disabled="!ruleChatId(r)"
                          :value="topicChoice(r)"
                          @focus="loadTopicsForRule(r, true)"
                          @change="setThread(r, $event.target.value)"
                        >
                          <option value="">Вся переписка — все темы</option>
                          <option v-for="topic in topicsOf(r)" :key="topic.id" :value="String(topic.id)">
                            {{ topicLabel(topic) }}
                          </option>
                          <option
                            v-if="topicChoice(r) && !topicKnown(r)"
                            :value="topicChoice(r)"
                          >
                            Тема {{ topicChoice(r) }} · сохранена вручную
                          </option>
                        </select>

                        <div class="topic-status muted">
                          <span v-if="!ruleChatId(r)">Сначала выбери услышанный чат.</span>
                          <span v-else-if="topicsBusy(r)"><span class="spin mini"></span> Загружаю темы…</span>
                          <span v-else-if="topicsError(r)">{{ topicsError(r) }}</span>
                          <span v-else-if="topicsOf(r).length">
                            Найдено: {{ topicsOf(r).length }}.
                            <template v-if="topicsOf(r).some((topic) => !topic.title)">
                              Названия появятся после нового сообщения в теме.
                            </template>
                            <template v-else>Список обновляется по сообщениям бота.</template>
                          </span>
                          <span v-else-if="topicsLoaded(r)">
                            Тем пока не слышно — отправь сообщение в нужную тему.
                          </span>
                          <button
                            v-if="ruleChatId(r)"
                            type="button"
                            class="link-btn"
                            :disabled="topicsBusy(r)"
                            @click="loadTopicsForRule(r, true)"
                          >
                            Обновить
                          </button>
                          <a
                            v-if="topicLink(r)"
                            :href="topicLink(r)"
                            target="_blank"
                            rel="noopener"
                          >
                            Открыть выбранную тему
                          </a>
                        </div>

                        <details class="manual-topic">
                          <summary>Темы нет в списке — ввести номер вручную</summary>
                          <label class="manual-topic-field">
                            <span class="field-label">Номер из ссылки на тему</span>
                            <input
                              v-model="r.threadId"
                              class="inp thin"
                              inputmode="numeric"
                              placeholder="тема: например 42"
                            />
                          </label>
                        </details>
                      </div>
                    </div>

                    <p class="muted sub part-hint">
                      Кокпит показывает темы, в которых бот уже видел сообщения.
                      «Вся переписка» разрешает весь чат; одна выбранная тема не открывает соседние.
                    </p>
                  </section>

                  <section class="rule-part">
                    <div class="part-head">
                      <span class="part-number">2</span>
                      <div>
                        <b>Куда создать задачу</b>
                        <small>Проект кокпита и параметры Битрикс24</small>
                      </div>
                    </div>

                    <div class="field-grid destination-fields">
                      <label class="control project-control">
                        <span class="field-label">Проект кокпита <em>обязательно</em></span>
                        <select v-model="r.project" class="sel project-select">
                          <option value="">проект кокпита не выбран</option>
                          <option v-for="p in projectOptions" :key="p" :value="p">{{ p }}</option>
                        </select>
                      </label>
                      <label class="control">
                        <span class="field-label">Тип</span>
                        <select v-model="r.kind" class="sel thin">
                          <option value="bug">Баг</option>
                          <option value="wish">Идея</option>
                        </select>
                      </label>
                      <label class="control">
                        <span class="field-label">Проект Битрикс24 <em>необязательно</em></span>
                        <select v-model="r.b24.groupId" class="sel thin b24-group-select">
                          <option :value="null">
                            {{ b24GroupsFailed ? 'без проекта — список сейчас недоступен' : 'без проекта Битрикс24' }}
                          </option>
                          <option v-for="group in b24GroupOptions" :key="group.id" :value="group.id">
                            {{ group.name }}
                          </option>
                        </select>
                      </label>
                      <label class="control responsible-control">
                        <span class="field-label">Ответственный</span>
                        <select v-model="r.b24.responsibleId" class="sel">
                          <option :value="null">ответственный — я</option>
                          <option v-for="u in b24users" :key="u.id" :value="u.id">{{ u.name }}</option>
                        </select>
                      </label>
                      <label class="control">
                        <span class="field-label">Приоритет</span>
                        <select v-model.number="r.b24.priority" class="sel thin">
                          <option :value="0">низкий</option>
                          <option :value="1">средний</option>
                          <option :value="2">высокий</option>
                        </select>
                      </label>
                    </div>

                    <p class="muted sub part-hint">
                      Проект кокпита определяет, к какому коду относится переписка. Проект
                      Битрикс24 выбирает раздел, в котором появится задача на портале.
                    </p>

                    <label class="task-reply-option">
                      <input v-model="r.notifyTaskCreated" type="checkbox" />
                      <span>
                        <b>Сообщать в Telegram о создании задачи</b>
                        <small>
                          После ручной или автоматической постановки бот ответит в этот
                          чат или тему номером задачи, её названием и ссылкой на Битрикс24.
                        </small>
                      </span>
                    </label>
                  </section>
                </div>

                <!-- Класс rrow и подпись lbl сохранены как явный контракт тестов формы. -->
                <div class="rrow auto-panel" :class="{ enabled: autoOf(r).enabled }">
                  <span class="lbl">автомат</span>
                  <div class="auto-copy">
                    <b>Автоматизация</b>
                    <span class="muted sub">Необязательно — сначала можно разбирать всё вручную</span>
                  </div>
                  <label class="chk">
                    <input
                      type="checkbox"
                      :checked="autoOf(r).enabled"
                      @change="setAuto(r, 'enabled', $event.target.checked)"
                    />
                    заводить задачи без меня
                  </label>
                  <template v-if="autoOf(r).enabled">
                    <label class="num">
                      уверенность от
                      <input class="inp num-f" :value="pctOf(r)" @change="setPct(r, $event.target.value)" />
                      %
                    </label>
                    <label class="num">
                      не больше
                      <input
                        class="inp num-f"
                        :value="autoOf(r).maxPerDay"
                        @change="setCap(r, $event.target.value)"
                      />
                      задач в сутки
                    </label>
                  </template>
                </div>
              </li>
            </ol>

            <details v-if="rules.length" class="explain rules-explain">
              <summary>Как безопасно включать автомат</summary>
              <p class="muted sub">
                Включай его только для чатов, где почти каждое сообщение — постановка.
                Кокпит передаст обращение общей модели из «Настройки → Плагины → Входящие».
                Если уверенности не хватит, задача не создастся: обращение останется в общей очереди.
                Суточный лимит защищает портал от случайного потока задач.
              </p>
            </details>

            <div v-if="dirty" class="savebar">
              <span>Изменения ещё не применены</span>
              <div class="row">
                <button class="btn primary" :disabled="!!busy" @click="saveRules">
                  {{ busy === 'rules' ? 'Сохраняю…' : 'Сохранить' }}
                </button>
                <button class="btn" :disabled="!!busy" @click="loadRules">Отменить</button>
              </div>
            </div>
            </fieldset>
          </section>
        </div>
      </template>

      <!-- Первое подключение: два шага стоят рядом и не требуют знания архитектуры. -->
      <template v-else-if="!loading">
        <div class="setup-grid">
          <section class="card setup-card">
            <div class="setup-card-head">
              <span class="setup-number">1</span>
              <div>
                <div class="section-kicker">В Телеграме</div>
                <div class="h">Создай отдельного бота</div>
              </div>
            </div>

            <ol class="steps">
              <li>
                <span class="step-mark">1</span>
                <span>Найди <b>@BotFather</b> с синей галочкой и отправь <code>/newbot</code>.</span>
              </li>
              <li>
                <span class="step-mark">2</span>
                <span>Задай видимое людям имя, например «Кокпит · входящие».</span>
              </li>
              <li>
                <span class="step-mark">3</span>
                <span>Задай имя пользователя латиницей с окончанием <code>bot</code>.</span>
              </li>
              <li>
                <span class="step-mark">4</span>
                <span>Скопируй присланный токен вида <code>8123456789:AA…</code>.</span>
              </li>
              <li>
                <span class="step-mark">5</span>
                <span>Отправь <code>/setprivacy</code>, выбери бота и нажми <b>Disable</b>,
                  чтобы он видел обычные сообщения в группах.</span>
              </li>
            </ol>

            <div class="info-note">
              Бота нельзя создать кнопкой на сайте: Телеграм разрешает делать это только
              в переписке с @BotFather. После выдачи токена всё остальное настроит кокпит.
            </div>
          </section>

          <section class="card setup-card token-card">
            <div class="setup-card-head">
              <span class="setup-number">2</span>
              <div>
                <div class="section-kicker">В кокпите</div>
                <div class="h">Вставь токен и подключи</div>
              </div>
            </div>

            <p class="muted">
              Кокпит сначала проверит токен у Телеграма. Если всё в порядке, покажет имя
              бота и начнёт слушать новые сообщения.
            </p>

            <div class="state" :class="providerConnection === 'degraded' ? 'warn' : ''"
                 data-state="provider-disconnected">
              Telegram не подключён: новые сообщения не принимаются. Ранее принятые обращения,
              если они есть, остаются в общем Inbox только для чтения.
              <template v-if="providerReason"> Причина: {{ providerReason }}.</template>
            </div>

            <label class="control token-control">
              <span class="field-label">Токен от @BotFather</span>
              <input
                v-model="token"
                class="inp"
                type="password"
                autocomplete="off"
                spellcheck="false"
                placeholder="8123456789:AA…"
                @keydown.enter="connect"
              />
            </label>
            <button class="btn primary connect-btn" :disabled="!canConnect || !token.trim() || !!busy" @click="connect">
              {{ busy === 'connect' ? 'Проверяю токен…' : 'Подключить' }}
            </button>

            <div class="security-note">
              <b>Токен останется на сервере.</b>
              <span>
                В браузер вернутся только последние четыре знака. Если токен утечёт,
                отзови его у @BotFather командой <code>/revoke</code>.
              </span>
            </div>

            <details class="technical">
              <summary>Где хранится токен</summary>
              <div class="muted sub technical-data">
                В account-aware credential store <code>server/.state/telegram-account-creds.json</code>,
                доступном только владельцу.
              </div>
            </details>
          </section>
        </div>

        <section class="after-connect">
          <div class="after-title">Что произойдёт после подключения</div>
          <div class="after-grid">
            <div class="after-step">
              <span>1</span>
              <div><b>Добавишь бота в чат</b><small>Как обычного участника группы</small></div>
            </div>
            <div class="after-step">
              <span>2</span>
              <div><b>Выберешь проект</b><small>Кокпит не откроет чат без разрешения</small></div>
            </div>
            <div class="after-step">
              <span>3</span>
              <div><b>Включишь приём в Inbox</b><small>Старая история не станет backlog</small></div>
            </div>
          </div>
        </section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.tg {
  --tg-soft: color-mix(in srgb, var(--accent) 9%, var(--surface));
  width: min(1480px, 100%); margin: 0 auto; padding-bottom: 36px;
  display: flex; flex-direction: column; gap: 16px;
}

/* Верх страницы сразу отвечает на два вопроса новичка: что здесь происходит и
   насколько всё уже настроено. Цифры справа — быстрые переходы к рабочим блокам. */
.tg-hero {
  position: relative; overflow: hidden; display: grid;
  grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 28px;
  min-height: 150px; padding: 24px 26px;
  border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--line)); border-radius: 16px;
  background:
    radial-gradient(circle at 92% 5%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 34%),
    linear-gradient(135deg, color-mix(in srgb, var(--surface) 93%, var(--accent)), var(--surface));
  box-shadow: var(--shadow);
}
.tg-hero::after {
  content: ''; position: absolute; width: 230px; height: 230px; right: -105px; bottom: -155px;
  border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent); border-radius: 50%;
  pointer-events: none;
}
.hero-copy { position: relative; z-index: 1; max-width: 760px; }
.eyebrow, .section-kicker {
  color: var(--accent); font-size: 10.5px; font-weight: 720; letter-spacing: .09em;
  line-height: 1.25; text-transform: uppercase;
}
.ttl { margin: 5px 0 8px; font-size: clamp(21px, 2vw, 28px); line-height: 1.2; letter-spacing: -.025em; }
.lead { max-width: 76ch; margin: 0; font-size: 13.5px; line-height: 1.6; }
.hero-stats { position: relative; z-index: 1; display: grid; grid-template-columns: repeat(3, minmax(104px, 1fr)); gap: 8px; }
.hero-stat {
  min-width: 112px; padding: 13px 14px; border: 1px solid var(--line); border-radius: 11px;
  background: color-mix(in srgb, var(--ground) 66%, transparent); transition: border-color .14s, transform .14s;
}
.hero-stat:hover { border-color: var(--accent); transform: translateY(-1px); }
.hero-stat strong { display: block; font-size: 24px; line-height: 1; font-variant-numeric: tabular-nums; }
.hero-stat span { display: block; margin-top: 7px; color: var(--ink-mid); font-size: 11.5px; line-height: 1.3; }
.setup-summary, .hero-loading {
  position: relative; z-index: 1; display: flex; flex-direction: column; gap: 5px;
  max-width: 260px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 11px;
  background: color-mix(in srgb, var(--ground) 58%, transparent); color: var(--ink-mid); font-size: 12.5px;
}
.setup-time { color: var(--good); font-size: 18px; font-weight: 680; }
.hero-loading { flex-direction: row; align-items: center; }

.feedback { padding: 11px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
.err { color: var(--bad); font-size: 13px; margin: 0; }
.ok { color: var(--good); font-size: 13px; margin: 0; }

/* Маршрут настройки — не вкладки: каждый пункт ведёт к своему блоку и показывает,
   какой обязательный шаг ещё не завершён. */
.setup-path {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px;
  padding: 1px; border: 1px solid var(--line); border-radius: 13px; background: var(--line); overflow: hidden;
}
.path-step {
  min-width: 0; min-height: 66px; display: flex; align-items: center; gap: 11px; padding: 11px 15px;
  background: var(--surface); transition: background .14s;
}
.path-step:hover { background: var(--surface-2); }
.path-mark {
  width: 28px; height: 28px; flex: none; display: grid; place-items: center;
  border: 1px solid var(--line-2); border-radius: 50%; color: var(--ink-mid); font-size: 12px; font-weight: 720;
}
.path-step.done .path-mark { border-color: color-mix(in srgb, var(--good) 60%, var(--line)); color: var(--good); }
.path-step.done .path-mark::after { content: '✓'; }
.path-step.done .path-mark { font-size: 0; }
.path-step.done .path-mark::after { font-size: 13px; }
.path-step.attention .path-mark { border-color: var(--warn); color: var(--warn); }
.path-copy { min-width: 0; display: flex; flex-direction: column; }
.path-copy b { font-size: 12.5px; }
.path-copy small { overflow: hidden; color: var(--ink-mid); font-size: 11.5px; text-overflow: ellipsis; white-space: nowrap; }

.tg-grid {
  display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(320px, .75fr);
  align-items: start; gap: 16px;
}
/* Native-карточки канала участвуют в общей сетке без лишней DOM-колонки. */
.side-stack { display: contents; }
.bot-card { grid-column: 1; grid-row: 1; }
.chats-card { grid-column: 2; grid-row: 1; }
.service-card { grid-column: 2; grid-row: 2; }
.rules-card { grid-column: 1; grid-row: 2; }
[id^='tg-'] { scroll-margin-top: 16px; }

.card {
  min-width: 0; padding: 18px; display: flex; flex-direction: column; gap: 13px;
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow);
}
.native-editor { min-width: 0; margin: 0; padding: 0; border: 0; }
.rules-editor { display: flex; flex-direction: column; gap: 13px; }
.h { font-size: 15px; font-weight: 680; letter-spacing: -.01em; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.compact-head { align-items: center; }
.section-title { display: flex; align-items: center; gap: 8px; margin-top: 3px; }
.name { font-size: 16px; font-weight: 680; }
.sub { font-size: 12.5px; margin: 0; line-height: 1.5; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.count {
  min-width: 22px; height: 22px; padding: 0 7px; display: inline-grid; place-items: center;
  border-radius: 999px; background: var(--accent); color: #fff; font-size: 11px; font-weight: 720;
  font-variant-numeric: tabular-nums;
}
.count.subtle { border: 1px solid var(--line); background: var(--surface-2); color: var(--ink-mid); }

.btn, .icon-btn {
  border: 1px solid var(--line); color: var(--ink); background: var(--surface-2); cursor: pointer;
  transition: border-color .13s, background .13s, color .13s, transform .13s;
}
.btn { min-height: 36px; padding: 8px 13px; border-radius: 9px; font-size: 13px; }
.btn.compact { min-height: 31px; padding: 5px 10px; font-size: 12px; }
.btn:hover:not(:disabled), .icon-btn:hover:not(:disabled) { border-color: var(--line-2); background: color-mix(in srgb, var(--surface-2) 86%, #fff); }
.btn.primary { border-color: var(--good); background: var(--good); color: #06210f; font-weight: 660; }
.btn.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--good) 88%, #fff); border-color: color-mix(in srgb, var(--good) 88%, #fff); }
.btn.danger, .icon-btn.danger { color: var(--bad); }
.btn:disabled, .icon-btn:disabled { opacity: .48; cursor: default; }
.btn:focus-visible, .icon-btn:focus-visible, summary:focus-visible,
.inp:focus-visible, .sel:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.icon-btn {
  width: 30px; height: 30px; flex: none; display: grid; place-items: center; padding: 0;
  border-radius: 8px; font-size: 18px; line-height: 1;
}

.inp, .sel {
  width: 100%; min-width: 0; border: 1px solid var(--line); border-radius: 8px;
  color: var(--ink); background: var(--ground); font-family: inherit; font-size: 13px;
}
.inp { padding: 9px 11px; }
.sel { padding: 8px 9px; }
.inp.thin, .sel.thin { min-width: 0; }
.inp:hover, .sel:hover { border-color: var(--line-2); }
.sel option { color: var(--ink); background: var(--surface); }
.field-label { color: var(--ink-mid); font-size: 11.5px; font-weight: 590; }
.field-label em { margin-left: 3px; color: var(--ink-mid); font-size: 10px; font-style: normal; font-weight: 440; }
.control { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.steps code, .sub code, .security-note code, .info-note code, .technical code {
  padding: 1px 5px; border-radius: 5px; background: var(--surface-2); font-family: var(--mono); font-size: 12px;
}

.state {
  padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--surface-2); color: var(--ink-mid); font-size: 12.5px; line-height: 1.5;
}
.state.good { border-color: color-mix(in srgb, var(--good) 28%, var(--line)); color: var(--good); background: color-mix(in srgb, var(--good) 7%, var(--surface-2)); }
.state.warn { border-color: color-mix(in srgb, var(--warn) 32%, var(--line)); color: var(--warn); background: color-mix(in srgb, var(--warn) 7%, var(--surface-2)); }
.state a { text-decoration: underline; text-underline-offset: 2px; }

.explain, .technical { border-top: 1px solid var(--line); padding-top: 10px; }
.explain summary, .technical summary {
  width: fit-content; color: var(--ink-mid); font-size: 12px; cursor: pointer; user-select: none;
}
.explain[open] summary, .technical[open] summary { color: var(--ink); }
.explain p { margin: 8px 0 0; }
.technical-data { margin-top: 8px; overflow-wrap: anywhere; }

/* --- Provider и native stores --- */
.bot-name { min-width: 0; display: flex; align-items: center; gap: 10px; }
.status-dot { width: 9px; height: 9px; flex: none; border-radius: 50%; background: var(--warn); box-shadow: 0 0 0 4px color-mix(in srgb, var(--warn) 10%, transparent); }
.status-dot.on { background: var(--good); box-shadow: 0 0 0 4px color-mix(in srgb, var(--good) 10%, transparent); }
.bot-actions { display: flex; gap: 8px; }
.bot-actions .btn:first-child { flex: 1; }
.bot-actions .disconnect { display: inline-flex; }
.chats { max-height: 310px; overflow: auto; list-style: none; margin: 0; padding: 0 3px 0 0; display: flex; flex-direction: column; gap: 7px; }
.chat { padding: 9px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); }
.cname { font-size: 13px; font-weight: 650; overflow-wrap: anywhere; }
.chat-meta { margin-top: 2px; font-size: 10.5px; overflow-wrap: anywhere; }
.card-foot { padding-top: 10px; border-top: 1px solid var(--line); }
.mini-empty { padding: 12px; border: 1px dashed var(--line-2); border-radius: 9px; background: color-mix(in srgb, var(--ground) 28%, transparent); }
.mini-empty b { font-size: 12.5px; }
.mini-empty p { margin-top: 3px; }
.optional-chip { padding: 3px 7px; border: 1px solid var(--line); border-radius: 999px; color: var(--ink-mid); font-size: 10.5px; }
.service-control { display: flex; align-items: stretch; gap: 8px; }
.service-control .sel { flex: 1; }
.compact-explain { padding-top: 8px; }

/* --- Правила --- */
.rules-head { align-items: center; }
.rules-callout {
  display: flex; align-items: flex-start; gap: 10px; padding: 11px 13px;
  border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--line)); border-radius: 9px; background: var(--tg-soft);
}
.callout-mark {
  width: 22px; height: 22px; flex: none; display: grid; place-items: center;
  border-radius: 50%; background: color-mix(in srgb, var(--accent) 16%, var(--surface-2)); color: var(--accent); font-weight: 760;
}
.rules-callout b { font-size: 12.5px; }
.rules-callout p { margin-top: 2px; }
.empty-rules {
  display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px;
  border: 1px dashed var(--line-2); border-radius: 10px; background: color-mix(in srgb, var(--ground) 28%, transparent);
}
.empty-rules p { margin-top: 3px; }
.rules { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; counter-reset: none; }
.rule { overflow: hidden; border: 1px solid var(--line); border-radius: 11px; background: color-mix(in srgb, var(--ground) 24%, var(--surface)); }
.rule-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 13px; border-bottom: 1px solid var(--line); background: var(--surface-2); }
.rule-head > div { min-width: 0; display: flex; align-items: baseline; gap: 9px; }
.rule-head b { overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.rule-number { flex: none; color: var(--ink-mid); font-size: 11px; }
.rule-builder { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.rule-part { min-width: 0; padding: 14px; }
.rule-part + .rule-part { border-left: 1px solid var(--line); }
.part-head { display: flex; align-items: center; gap: 9px; margin-bottom: 12px; }
.part-number {
  width: 24px; height: 24px; flex: none; display: grid; place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--line)); border-radius: 7px; color: var(--accent); font-size: 11px; font-weight: 720;
}
.part-head > div { display: flex; flex-direction: column; line-height: 1.3; }
.part-head b { font-size: 13px; }
.part-head small { color: var(--ink-mid); font-size: 10.5px; }
.field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.field-grid .full { grid-column: 1 / -1; }
.topic-control { grid-column: 1 / -1; }
.topic-status {
  min-height: 17px; display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  font-size: 10.5px; line-height: 1.4;
}
.topic-status .spin.mini { width: 11px; height: 11px; border-width: 1px; }
.link-btn {
  padding: 0; border: 0; color: var(--accent); background: none; font: inherit;
  text-decoration: underline; text-underline-offset: 2px; cursor: pointer;
}
.link-btn:disabled { opacity: .48; cursor: default; }
.manual-topic { margin-top: 2px; }
.manual-topic summary {
  width: fit-content; color: var(--ink-mid); font-size: 10.5px; cursor: pointer; user-select: none;
}
.manual-topic[open] summary { color: var(--ink); }
.manual-topic-field { display: flex; flex-direction: column; gap: 5px; margin-top: 8px; }
.part-hint { margin-top: 10px; }
.task-reply-option {
  display: flex; align-items: flex-start; gap: 8px; margin-top: 11px; padding: 10px 11px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); cursor: pointer;
}
.task-reply-option input {
  width: 15px; height: 15px; flex: none; margin-top: 2px; accent-color: var(--accent); cursor: pointer;
}
.task-reply-option span { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.task-reply-option b { font-size: 12px; }
.task-reply-option small { color: var(--ink-mid); font-size: 10.5px; line-height: 1.4; }
.rrow { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.auto-panel { padding: 12px 14px; border-top: 1px solid var(--line); background: var(--surface-2); }
.auto-panel.enabled { background: color-mix(in srgb, var(--accent) 7%, var(--surface-2)); }
.lbl { padding: 2px 7px; border: 1px solid var(--line); border-radius: 999px; color: var(--ink-mid); font-size: 9.5px; text-transform: uppercase; }
.auto-copy { min-width: 150px; display: flex; flex: 1; flex-direction: column; }
.auto-copy b { font-size: 12.5px; }
.chk, .num { display: flex; align-items: center; gap: 6px; color: var(--ink-mid); font-size: 12px; }
.chk { cursor: pointer; }
.chk input { width: 15px; height: 15px; accent-color: var(--accent); cursor: pointer; }
.num-f { width: 56px; min-width: 0; padding: 6px 7px; text-align: center; }
.rules-explain { margin-top: -2px; }
.savebar {
  position: sticky; bottom: -1px; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 14px;
  margin: 1px -6px -6px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--warn) 28%, var(--line));
  border-radius: 10px; background: color-mix(in srgb, var(--surface) 92%, var(--warn)); box-shadow: 0 -6px 22px #0005;
  color: var(--warn); font-size: 12px;
}

/* --- Первое подключение --- */
.setup-grid { display: grid; grid-template-columns: minmax(0, 1.12fr) minmax(330px, .88fr); align-items: stretch; gap: 16px; }
.setup-card { padding: 21px; }
.setup-card-head { display: flex; align-items: center; gap: 11px; }
.setup-number {
  width: 34px; height: 34px; flex: none; display: grid; place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--line)); border-radius: 10px; color: var(--accent); font-size: 14px; font-weight: 760;
}
.steps { list-style: none; margin: 3px 0 0; padding: 0; display: flex; flex-direction: column; gap: 9px; font-size: 13px; }
.steps li { display: grid; grid-template-columns: 23px minmax(0, 1fr); align-items: start; gap: 9px; }
.step-mark {
  width: 21px; height: 21px; display: grid; place-items: center; margin-top: 1px;
  border-radius: 50%; background: var(--surface-2); color: var(--ink-mid); font-size: 10px; font-weight: 700;
}
.info-note, .security-note {
  padding: 11px 12px; border: 1px solid var(--line); border-radius: 9px;
  background: var(--surface-2); color: var(--ink-mid); font-size: 12px; line-height: 1.55;
}
.token-card { background: linear-gradient(145deg, color-mix(in srgb, var(--surface) 95%, var(--accent)), var(--surface)); }
.token-card > .muted { margin: 3px 0 6px; font-size: 13px; }
.token-control { margin-top: auto; }
.token-control .inp { padding: 11px 12px; font-family: var(--mono); }
.connect-btn { width: 100%; min-height: 42px; }
.security-note { display: flex; flex-direction: column; gap: 3px; }
.security-note b { color: var(--ink); }
.after-connect { padding: 2px 4px; }
.after-title { margin-bottom: 9px; color: var(--ink-mid); font-size: 11px; font-weight: 670; letter-spacing: .06em; text-transform: uppercase; }
.after-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.after-step { display: flex; align-items: center; gap: 10px; padding: 12px 13px; border: 1px solid var(--line); border-radius: 10px; background: color-mix(in srgb, var(--surface) 75%, transparent); }
.after-step > span { color: var(--accent); font-size: 11px; font-weight: 760; }
.after-step > div { min-width: 0; display: flex; flex-direction: column; }
.after-step b { font-size: 12px; }
.after-step small { color: var(--ink-mid); font-size: 10.5px; }

.disabled-card { min-height: 150px; flex-direction: row; align-items: center; gap: 16px; }
.disabled-mark {
  width: 48px; height: 48px; flex: none; display: grid; place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line)); border-radius: 14px;
  background: var(--tg-soft); color: var(--accent); font-weight: 760;
}
.disabled-card .ttl { margin-top: 0; }

/* Средние экраны: native-карточки становятся одной колонкой. */
@media (max-width: 1100px) {
  .tg-hero { grid-template-columns: minmax(0, 1fr); gap: 17px; }
  .hero-stats { width: 100%; }
  .hero-stat { min-width: 0; }
  .setup-summary { max-width: none; flex-direction: row; align-items: baseline; }
  .setup-grid { grid-template-columns: minmax(0, 1fr) minmax(310px, .82fr); }
}

@media (max-width: 860px) {
  .tg-grid { grid-template-columns: minmax(0, 1fr); }
  .side-stack, .rules-card { grid-column: 1; grid-row: auto; }
  .side-stack { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; }
  .bot-card { grid-column: 1 / -1; grid-row: auto; }
  .chats-card, .service-card { grid-column: auto; grid-row: auto; }
  .setup-grid { grid-template-columns: minmax(0, 1fr); }
  .rule-builder { grid-template-columns: minmax(0, 1fr); }
  .rule-part + .rule-part { border-left: 0; border-top: 1px solid var(--line); }
}

@media (max-width: 640px) {
  .tg { gap: 12px; padding-bottom: 20px; }
  .tg-hero { min-height: 0; padding: 18px; border-radius: 13px; }
  .ttl { font-size: 21px; }
  .hero-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .hero-stat { padding: 10px; }
  .hero-stat strong { font-size: 19px; }
  .hero-stat span { font-size: 9.5px; }
  .setup-summary { flex-direction: column; }
  .setup-path { grid-template-columns: minmax(0, 1fr); }
  .path-step { min-height: 58px; }
  .side-stack { grid-template-columns: minmax(0, 1fr); }
  .bot-card { grid-column: 1; }
  .card { padding: 14px; }
  .head { flex-wrap: wrap; }
  .bot-card .head { flex-wrap: nowrap; }
  .field-grid { grid-template-columns: minmax(0, 1fr); }
  .field-grid .full { grid-column: 1; }
  .auto-panel { align-items: flex-start; }
  .auto-copy { flex-basis: calc(100% - 70px); }
  .chk { flex-basis: 100%; }
  .service-control { flex-direction: column; }
  .savebar { position: static; align-items: flex-start; flex-direction: column; }
  .savebar .row, .savebar .btn { width: 100%; }
  .empty-rules { align-items: stretch; flex-direction: column; }
  .after-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
