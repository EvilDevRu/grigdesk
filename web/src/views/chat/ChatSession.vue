<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../../shared/api-client.js';
import { createSpeechStream } from '../../shared/speech-stream.js';
import { useChatStore, CONTEXT_WINDOW } from '../../stores/chat.js';
import { useTasksStore } from '../../stores/tasks.js';
import { useUiStore } from '../../stores/ui.js';
import { useProvidersStore } from '../../stores/providers.js';
import EffortSlider from './EffortSlider.vue';
import StepList from './StepList.vue';
import ChatQuestion from './ChatQuestion.vue';
import ChatPermission from './ChatPermission.vue';
import HelpTip from '../../shared/ui/HelpTip.vue';
import { confirmDialog } from '../../shared/ui/confirm.js';
import { mdToHtml } from '../../shared/md.js';
import { documentLinkFromClick, documentRouteHref } from '../../features/documents/links.js';
import { useDocumentPreviewStore } from '../../stores/document-preview.js';
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
const ui = useUiStore();
const documentPreview = useDocumentPreviewStore();

function onMarkdownClick(event) {
  if (!isPlainClick(event)) return;
  const image = event.target?.closest?.('img');
  if (image) {
    event.preventDefault();
    documentPreview.showImage({
      src: image.currentSrc || image.getAttribute('src'),
      name: image.getAttribute('alt') || image.getAttribute('title') || 'Изображение',
      mime: '',
    });
    return;
  }
  const href = documentLinkFromClick(event);
  if (!href) return;
  event.preventDefault();
  documentPreview.show(href);
}

function isPlainClick(event) {
  return event?.button === 0
    && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function onAttachmentClick(event, attachment) {
  if (!isImg(attachment) || !isPlainClick(event)) return;
  event.preventDefault();
  documentPreview.showImage({
    src: api.url(attachment.url),
    name: attachment.name,
    mime: attachment.mime,
  });
}

// Архивный разговор открывается для чтения прямо из архива. Отправка сообщения
// сама перенесёт тот же объект в активные (stores/chat.js), отдельной копии нет.
const sess = computed(() => chat.sessions.find((s) => s.id === props.sid)
  || (chat.archived || []).find((s) => s.id === props.sid)
  || null);

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
const current = computed(() => prov.modelOf(sess.value?.modelRef || sess.value?.model));
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
const modes = computed(() => prov.modesOf(sess.value?.modelRef || sess.value?.model));
const currentMode = computed(() => {
  const want = sess.value?.mode;
  const list = modes.value;
  if (want && list.some((m) => m.id === want)) return want;
  return list.some((m) => m.id === 'manual') ? 'manual' : (list[0]?.id || '');
});
const modeHint = computed(() => modes.value.find((m) => m.id === currentMode.value)?.hint || 'Режим прав агента');
// Codex сообщает эффективное окно только в token_count конкретной сессии (например,
// catalog 272k × 95% = 258.4k). Оно точнее каталожного fallback и потому приоритетно.
const ctxWindow = computed(() => sess.value?.contextWindow || currentModel.value?.context || CONTEXT_WINDOW);
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
async function onModelChange(e) {
  // Reset Kimi асинхронный и на время запроса перерисовывает select со старой моделью.
  // Поэтому выбранный id надо снять с DOM до await, иначе после подтверждения здесь
  // снова окажется K3 и визуально успешный reset отменит саму смену модели.
  const select = e.target;
  const nextModelId = select.value;
  const oldProv = current.value.provider?.id;
  const newProv = prov.modelOf(nextModelId).provider?.id;
  // Сменили ИИ (claude ↔ gpt) — sessionId прежнего исполнителя несовместим,
  // резюмить им нельзя: сбрасываем контекст, история чата остаётся.
  // У старого фронта Kimi reset был только локальным: в истории id уже мог быть null,
  // а server-owned binding — всё ещё жив. Поэтому для Kimi сбрасываем sidecar даже без
  // видимого sessionId; revision позволяет стору отличить сохранённый чат от нового.
  if (oldProv && newProv && oldProv !== newProv && (sess.value?.sessionId || oldProv === 'kimi')) {
    // Для Kimi reset меняет server-owned binding. Модель переключаем только после
    // подтверждения, иначе при сетевой ошибке старую сессию было бы уже не сбросить.
    if (!await chat.resetContext(props.sid)) {
      select.value = modelId.value;
      return;
    }
  }
  chat.setModel(props.sid, nextModelId);
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
// Пока ход идёт, кольцо показывает ЖИВОЙ размер (`liveContext` — вход каждого обращения
// к модели, его сообщает claude), а не цифру с прошлого хода. Разница не косметическая:
// автокомпакт CLI срабатывает на границе хода, и без живого замера кольцо весь ход горело
// бы красным по уже сжатому контексту.
const ctxTokens = computed(() => (sess.value?.sending && sess.value?.liveContext) || sess.value?.contextTokens || 0);
// ── Ближайший практический порог контекста ────────────────────────────────────
// Цвет кольца НЕ по одному проценту окна и НЕ по одному вбитому числу: красное у
// ближайшего события — настроенного сжатия, объявленной исполнителем границы цены или
// безопасного потолка окна. Только первый порог реально запускает сжатие; остальные
// предупреждают. Граница цены — свойство транспорта/кэша provider-а, а не универсальное
// правило для всех моделей.
// Абсолютное число без потолка врало бы в другую сторону: у модели с окном 200k порог
// 200k недостижим, кольцо осталось бы зелёным до самого конца разговора.
const CTX_CEIL_RATIO = 0.8;  // потолок: доля окна модели, дальше которой ждать нельзя
const CTX_WARN_RATIO = 0.8;  // жёлтое — на подходе к порогу
const providerCostCliff = computed(() => {
  const value = current.value?.provider?.contextCostCliff;
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.round(value)) : null;
});
const ctxLimit = computed(() => {
  const ceil = Math.round(ctxWindow.value * CTX_CEIL_RATIO);
  const want = chat.compactWindow || 0; // 0 — автосжатие в настройках выключено
  // Побеждает ближайшее событие: сжатие кокпита, подорожание хода или потолок окна.
  // Отсутствующее `contextCostCliff` означает, что у provider-а такой оси вовсе нет.
  return Math.min(want > 0 ? want : Infinity, providerCostCliff.value || Infinity, ceil);
});
// Заполненность — доля ТОГО ЖЕ порога, по которому кольцо красится. Раньше цвет считался
// от порога, а дуга и подсказка — от окна модели, и на 1M это расходилось втрое: 168k
// давали жёлтый цвет (84% порога) при дуге, залитой на 17%. Человек читает форму, а не
// оттенок, поэтому почти пустое кольцо перевешивало предупреждение — «места ещё дофига»,
// пока CLI уже сжимал контекст по кругу.
const ctxPct = computed(() => Math.min(100, Math.round((ctxTokens.value / Math.max(1, ctxLimit.value)) * 100)));
const CODEX_CONTEXT_METRIC = 'active-input-v1';
const ctxUnavailable = computed(() => current.value?.provider?.id === 'codex'
  && !!sess.value?.sessionId
  && sess.value?.contextMetric !== CODEX_CONTEXT_METRIC);
const ctxClass = computed(() => {
  if (ctxUnavailable.value) return '';
  const tokens = ctxTokens.value;
  if (tokens >= ctxLimit.value) return 'hi';
  if (tokens >= ctxLimit.value * CTX_WARN_RATIO) return 'mid';
  return '';
});
const ctxIsEstimate = computed(() => !!sess.value?.contextIsEstimate);
const ctxWindowUnverified = computed(() => (
  !sess.value?.contextWindow && !!currentModel.value?.contextUnverified
));
const fmtTokens = (value) => Math.max(0, Number(value) || 0).toLocaleString('ru');
const fmtSessionTokens = (value) => {
  const tokens = Math.max(0, Number(value) || 0);
  if (tokens < 1_000_000) return fmtTokens(tokens);
  return `${(tokens / 1_000_000).toLocaleString('ru', { maximumFractionDigits: 1 })} млн`;
};
const spentHint = computed(() => {
  const total = sess.value?.totalInputTokens || 0;
  if (!total) return '';
  const cached = sess.value?.cachedInputTokens || 0;
  return ` · за сессию обработано ${fmtTokens(total)} входных токенов${cached ? `, из них ${fmtTokens(cached)} из кэша` : ''}`;
});
const ctxAtWarning = computed(() => ctxTokens.value >= ctxLimit.value * CTX_WARN_RATIO);
const ctxLimitReached = computed(() => ctxTokens.value >= ctxLimit.value);
const ctxCostCliffReached = computed(() => providerCostCliff.value !== null
  && ctxTokens.value >= providerCostCliff.value);
const ctxLimitWhat = computed(() => (
  chat.compactWindow > 0 && ctxLimit.value === chat.compactWindow ? 'до сжатия'
    : providerCostCliff.value !== null && ctxLimit.value === providerCostCliff.value ? 'до подорожания хода'
      : 'до потолка окна'
));
const ctxLimitShort = computed(() => (
  chat.compactWindow > 0 && ctxLimit.value === chat.compactWindow ? 'автосжатие'
    : providerCostCliff.value !== null && ctxLimit.value === providerCostCliff.value ? 'цена хода'
      : '80% окна'
));

// Визуальная подсказка не собирается из одной длинной строки: у штатного HelpTip есть
// форматированный слот, поэтому числа, предупреждение и действия остаются отдельными
// смысловыми блоками. `ctxTitle` ниже — только компактная доступная подпись кнопки.
const ctxTooltip = computed(() => {
  const s = sess.value;
  const modelWindow = `${fmtTokens(ctxWindow.value)}${ctxWindowUnverified.value ? ' · неточно' : ''}`;
  const rows = [{ label: 'Окно', value: modelWindow, unverified: ctxWindowUnverified.value }];
  const total = s?.totalInputTokens || 0;
  const cached = s?.cachedInputTokens || 0;
  const addSessionRows = () => {
    if (total) rows.push({ label: 'За сессию', value: fmtSessionTokens(total) });
    if (cached) rows.push({ label: 'Из кэша', value: fmtSessionTokens(cached) });
  };

  if (s?.compacting) {
    return {
      title: 'Контекст', percent: '', tone: 'active', status: 'Сжимаю контекст…',
      detail: 'Агент готовит рабочую выжимку разговора.', rows: [], actions: false,
    };
  }
  if (!s?.sessionId) {
    return {
      title: 'Контекст', percent: '', tone: '',
      status: s?.pendingSeed ? 'Контекст сжат' : 'Контекст пуст',
      detail: s?.pendingSeed
        ? 'Выжимка уедет агенту со следующим сообщением.'
        : 'Размер появится после первого хода.',
      rows, actions: false,
    };
  }
  if (s?.compactedAt && !ctxTokens.value) {
    addSessionRows();
    return {
      title: 'Контекст', percent: '', tone: '', status: 'Контекст сжат',
      detail: 'Новый размер появится после следующего хода.', rows, actions: true,
    };
  }
  if (ctxUnavailable.value) {
    addSessionRows();
    return {
      title: 'Контекст', percent: '', tone: '', status: 'Точная заполненность пока недоступна',
      detail: 'Codex сообщит её после следующего завершённого хода.', rows, actions: true,
    };
  }

  rows.unshift(
    {
      label: 'Сейчас',
      value: `${ctxIsEstimate.value ? '≈ ' : ''}${fmtTokens(ctxTokens.value)}${s?.sending && s?.liveContext ? ' · этот ход' : ''}`,
    },
    { label: 'Порог', value: `${fmtTokens(ctxLimit.value)} · ${ctxLimitShort.value}` },
  );
  addSessionRows();
  return {
    title: 'Контекст',
    percent: `${ctxPct.value}%`,
    tone: ctxCostCliffReached.value || ctxLimitReached.value ? 'bad' : (ctxAtWarning.value ? 'warn' : ''),
    status: ctxCostCliffReached.value
      ? 'Ход уже подорожал — пора сжать'
      : ctxLimitReached.value
        ? 'Порог достигнут — пора сжать'
        : (ctxAtWarning.value ? 'Порог близко — пора сжать' : ''),
    detail: '',
    rows,
    actions: true,
  };
});
const ctxTitle = computed(() => {
  const s = sess.value;
  const tokens = fmtTokens(ctxTokens.value);
  if (s?.compacting) return 'Сжимаю контекст…';
  if (!s?.sessionId) {
    const empty = s?.pendingSeed
      ? 'Контекст сжат — выжимка уедет со следующим сообщением'
      : 'Контекст: пусто';
    return ctxWindowUnverified.value
      ? `${empty} · окно модели ${fmtTokens(ctxWindow.value)} (не подтверждено)`
      : empty;
  }
  if (s?.compactedAt && !ctxTokens.value) return 'Контекст сжат — размер покажется после следующего хода';
  const hint = 'клик — сжать (Alt+клик — сбросить память агента)';
  if (ctxUnavailable.value) return `Точная заполненность Codex появится после следующего завершённого хода${spentHint.value} · ${hint}`;
  const warn = ctxCostCliffReached.value
    ? ' · ход уже подорожал — пора сжать'
    : ctxLimitReached.value
      ? ' · порог достигнут — пора сжать'
      : (ctxAtWarning.value ? ' · порог близко — пора сжать' : '');
  const estimate = ctxIsEstimate.value ? 'примерно ' : '';
  // Пока ход идёт, цифра замерена ЭТИМ ходом — про это стоит сказать прямо: иначе
  // упавший на глазах контекст (автокомпакт CLI) выглядит сбоем кольца.
  const live = s?.sending && s?.liveContext ? ' (замер этого хода)' : '';
  // Считаем от того же порога, что рисует дугу. Окно модели остаётся в подсказке
  // справочно: на 1M оно вводило в заблуждение как основная шкала — «из 1 000 000»
  // читается как огромный запас там, где до сжатия остались проценты.
  const limit = fmtTokens(ctxLimit.value);
  // Подпись называет ТО событие, которое случится первым, иначе цифра порога
  // необъяснима: «до потолка окна 250 000» при окне в миллион читается как ошибка.
  // «Не подтверждено» — разбор таблицы моделей в бинаре CLI сломался (обновился CLI,
  // сменился формат), и окно ниже это заглушка, а не факт. Молчать нельзя: именно по
  // этой цифре человек решает, пора ли сжимать. Замер самой сессии (Codex сообщает своё
  // окно) сильнее каталога, и к нему оговорка не относится.
  const window = ` · окно модели ${fmtTokens(ctxWindow.value)}${ctxWindowUnverified.value ? ' (не подтверждено)' : ''}`;
  return `Контекст: ${estimate}${tokens} из ${limit} ${ctxLimitWhat.value} (${ctxPct.value}%)${live}${warn}${window}${spentHint.value} · ${hint}`;
});
// Кольцо-индикатор контекста (клик — сжатие, Alt+клик — сброс памяти).
const RING_C = 2 * Math.PI * 9;
// На время сжатия дуга — короткий бегунок: кольцо в этот момент вращается, а полное
// (или почти полное) кольцо при вращении выглядело бы неподвижным.
const SPIN_DASH = RING_C * 0.75;
const ringDash = computed(() => (sess.value?.compacting ? SPIN_DASH : RING_C * (1 - ctxPct.value / 100)));
// Нативный disabled выкидывает кнопку из Tab-порядка вместе с её подсказкой. Кольцо
// остаётся фокусируемым и честно объявляет недоступность через aria-disabled; обработчик
// ниже всё равно не запускает действие, пока нет сессии или идёт ход/сжатие.
const ctxRingDisabled = computed(() => !sess.value?.sessionId
  || !!sess.value?.compacting || !!sess.value?.sending);

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
    if (ok) await chat.resetContext(props.sid);
    return;
  }
  const contextNow = ctxUnavailable.value
    ? 'Точный размер текущего контекста пока недоступен.'
    : `Сейчас в контексте ${fmtTokens(ctxTokens.value)} токенов.`;
  const ok = await confirmDialog(
    `${contextNow} Агент соберёт из разговора рабочую выжимку и продолжит с неё — что решили, чего касались, что осталось. Это полноценный ход: он займёт время и потратит токены один раз, зато каждый следующий ход станет дешевле.`,
    { title: 'Сжать контекст чата?', okText: 'Сжать' },
  );
  if (ok) chat.compact(props.sid);
}

// Сжатие или server-owned reset замораживают управление: менять модель/задачу/права
// посреди перехода нельзя. Поле ввода, вложения и диктовка остаются живыми; сама кнопка
// отправки ждёт завершения перехода.
const frozen = computed(() => !!sess.value?.compacting || !!sess.value?.sessionResetting);
const frozenHint = computed(() => (sess.value?.sessionResetting
  ? 'Сбрасывается память агента — отправка будет доступна после подтверждения сервера'
  : 'Идёт сжатие контекста — отправка будет доступна сразу после него'));

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
  if (speechBusy.value || drainingRecognition) return;
  const t = input.value.trim();
  const atts = pending.value.slice();
  if ((!t && !atts.length) || !sess.value || frozen.value) return;
  // Точное имя пункта выполняем через его dispatch. `/`-команды провайдера идут
  // служебным ходом, `$skill` — обычным prompt; run:'none' остаётся обычным сообщением.
  // Сверка регистронезависимая — как в меню: имя навыка приходит от исполнителя.
  const exact = allCommands.value.find((c) => c.cmd.toLowerCase() === t.toLowerCase() && c.run !== 'none');
  if (exact) { runCommand(exact); return; }
  input.value = '';
  atBottom.value = true; // своё сообщение всегда показываем — как в мессенджерах
  // Черновик отправленного сообщения гасим сразу: дебаунс успел бы записать его
  // уже после отправки, и в списке чат остался бы «с черновиком».
  clearTimeout(draftTimer);
  chat.setDraft(props.sid, '');
  pending.value = [];
  const accepted = await chat.send(props.sid, t, atts);
  if (accepted === false) {
    input.value = t;
    pending.value = atts;
    chat.setDraft(props.sid, t);
  }
}
function onKey(e) {
  // Открыто меню команд — стрелки/Enter/Tab/Esc управляют им.
  // Навигация по выбираемым пунктам (cmdNav): заголовки и run:'none' пропускаются.
  const m = cmdNav.value;
  if (cmdMatches.value.length) {
    if (e.key === 'ArrowDown' && m.length) { e.preventDefault(); cmdIndex.value = (cmdIndex.value + 1) % m.length; return; }
    if (e.key === 'ArrowUp' && m.length) { e.preventDefault(); cmdIndex.value = (cmdIndex.value - 1 + m.length) % m.length; return; }
    if ((e.key === 'Enter' || e.key === 'Tab') && m.length) { e.preventDefault(); runCommand(m[Math.min(cmdIndex.value, m.length - 1)]); return; }
    if (e.key === 'Escape') { input.value = ''; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); submit(); }
}

// ── Команды и навыки: «/» открывает CLI-команды, «$» — skills Codex ──
// Две секции: клиентские команды кокпита и команды CLI выбранной модели (провайдерский
// список приезжает в /api/providers, контракт — server/src/lib/executors/index.js).
const COMMANDS = [
  { cmd: '/compact', desc: 'Сжать контекст: агент пересказывает разговор и продолжает с выжимки', source: 'cockpit', run: 'local' },
  { cmd: '/clear', desc: 'Очистить историю и сбросить контекст агента', source: 'cockpit', run: 'local' },
  { cmd: '/reset', desc: 'Сбросить только контекст (история остаётся)', source: 'cockpit', run: 'local' },
  { cmd: '/new', desc: 'Открыть новый чат', source: 'cockpit', run: 'local' },
];
// Команды исполнителя текущей модели. Резолвер тот же, что у селекта модели: для
// legacy-чатов без modelRef провайдер достаётся из сохранённого id модели.
const providerInfo = computed(() => current.value.provider || null);
const providerCommands = computed(() => {
  const p = providerInfo.value;
  return (Array.isArray(p?.commands) ? p.commands : [])
    .map((c) => ({ ...c, source: p.id }));
});
// Объединённый список: команда кокпита глушит провайдерскую с тем же именем
// (/compact уже есть у кокпита — дубль не показываем, поведение не меняется).
const allCommands = computed(() => {
  const merged = [...COMMANDS];
  for (const c of providerCommands.value) {
    if (!merged.some((x) => x.cmd === c.cmd)) merged.push(c);
  }
  return merged;
});
const cmdIndex = ref(0);
const cmdMatches = computed(() => {
  const t = input.value.trimStart().toLowerCase();
  if (!/^[/$]/.test(t) || /[\s\n]/.test(t)) return [];
  // Имя навыка приходит от Codex и заглавные в нём законны (`$Review-Agent`),
  // поэтому сверяем в нижнем регистре: иначе такой пункт нельзя было бы найти.
  return allCommands.value.filter((c) => c.cmd.toLowerCase().startsWith(t));
});
// Навигация идёт только по выбираемым пунктам: заголовки секций и пункты run:'none'
// (команда живёт в TUI исполнителя) пропускаются стрелками и не выбираются Enter/кликом.
const cmdNav = computed(() => cmdMatches.value.filter((c) => c.run !== 'none'));
// Плоский список для рендера: заголовки секций + пункты с их индексом навигации.
const cmdMenu = computed(() => {
  const items = [];
  let nav = 0;
  const push = (c) => items.push({ ...c, key: `${c.source}:${c.cmd}`, nav: c.run === 'none' ? -1 : nav++ });
  const cockpit = cmdMatches.value.filter((c) => c.source === 'cockpit');
  const own = cmdMatches.value.filter((c) => c.source !== 'cockpit');
  if (cockpit.length) items.push({ header: 'Cockpit', key: 'h:cockpit' });
  cockpit.forEach(push);
  if (own.length) items.push({ header: providerInfo.value?.name || 'Исполнитель', color: providerInfo.value?.color || '', key: 'h:provider' });
  own.forEach(push);
  return items;
});
watch(cmdNav, (m) => { if (cmdIndex.value >= m.length) cmdIndex.value = 0; });
// Меню ограничено по высоте и скроллится — при навигации стрелками подгоняем
// выбранный пункт в видимую область.
const cmdMenuEl = ref(null);
watch(cmdIndex, async () => {
  await nextTick();
  cmdMenuEl.value?.querySelector('.cmd.on')?.scrollIntoView({ block: 'nearest' });
});
async function runCommand(command) {
  if (speechBusy.value || drainingRecognition) return;
  const c = typeof command === 'string'
    ? allCommands.value.find((x) => x.cmd === command)
    : command;
  if (!c || c.run === 'none') return;
  if (c.source !== 'cockpit') {
    // Провайдерская команда/навык. Гард тот же, что у submit():
    // пока чат заморожен (сжатие/reset), ничего не выполняем и ввод не трогаем.
    if (!sess.value || frozen.value) return;
    // Команда с обязательным аргументом не отправляется: подставляем в композер.
    if (c.args) {
      input.value = `${c.cmd} `;
      cmdIndex.value = 0;
      return;
    }
    // `$skill` — обычный model prompt: Codex сам раскрывает явное упоминание в
    // содержимое SKILL.md. `slashCommand` нужен только локальным `/`-командам CLI.
    // Вложения тоже уезжают только с навыком: у служебного хода их не бывает,
    // а «переделай вот эту картинку» — обычный сценарий $-навыка.
    const skill = c.cmd.startsWith('$');
    const atts = skill ? pending.value.slice() : [];
    input.value = '';
    cmdIndex.value = 0;
    clearTimeout(draftTimer);
    chat.setDraft(props.sid, '');
    if (skill) pending.value = [];
    const accepted = skill
      ? await chat.send(props.sid, c.cmd, atts)
      : await chat.send(props.sid, c.cmd, [], { slashCommand: c.cmd });
    // Как в submit(): отклонённая отправка не теряет ни набранное, ни вложения.
    if (accepted === false) {
      input.value = c.cmd;
      if (skill) pending.value = atts;
      chat.setDraft(props.sid, c.cmd);
    }
    return;
  }
  input.value = '';
  cmdIndex.value = 0;
  if (c.cmd === '/compact') {
    // Тот же путь, что у кольца: подтверждение обязательно — сжатие тратит ход агента.
    onCtxClick({ altKey: false });
  } else if (c.cmd === '/clear') {
    pending.value = [];
    chat.clearChat(props.sid);
    // Историю только что вычистили — плашка о сбросе осталась бы единственной записью.
    chat.resetContext(props.sid, { note: false });
  } else if (c.cmd === '/reset') {
    chat.resetContext(props.sid);
  } else if (c.cmd === '/new') {
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

// ── Диктовка: browser SpeechRecognition или локальный Whisper ──
// Browser API сам управляет микрофоном. Whisper параллельно держит полный WebM
// для безопасного batch fallback и отправляет PCM в live-сессию. Обоими путями
// управляет одна generation-FSM: поздние события прежнего запуска не трогают ввод.
const recording = ref(false);
const transcribing = ref(false);
const preparingSpeech = ref(false);
const drainingSpeech = ref(false);
const interimSpeech = ref('');
const consentPending = ref(false);
const browserInstallPending = ref(false);
const browserInstalling = ref(false);
const speechNotice = ref('');
const inputErr = ref('');
const speechBusy = computed(() => recording.value || preparingSpeech.value
  || transcribing.value || drainingSpeech.value || consentPending.value
  || browserInstallPending.value || browserInstalling.value);

let speechGeneration = 0;
let desiredSpeech = false;
let activeRecognition = null;
let drainingRecognition = null;
let browserDrainTimer = null;
let browserRecognitionCtor = null;
let browserRestartTimer = null;
let browserRetries = { network: 0, noSpeech: 0 };
let phrasesDisabled = false;
let pendingBrowserInstall = null;
let localCapture = null;
let localTranscription = null;
let transcriptionAbort = null;
let speechDestroyed = false;
let speechSnapshotEpoch = 0;
const BROWSER_DRAIN_TIMEOUT_MS = 1800;
const LOCAL_STREAM_LAG_NOTICE_MS = 4000;
const LOCAL_RECORDER_STOP_TIMEOUT_MS = 2000;

function speechPrefs() {
  return chat.speech && typeof chat.speech === 'object'
    ? chat.speech
    : {
      engine: 'browser', browserProcessing: 'auto', browserAutoConsent: false,
      language: 'auto', dictionary: '', local: { ready: false, reason: '' }, revision: '',
    };
}

function browserSpeechCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function browserLanguage(language = speechPrefs().language) {
  if (language === 'ru') return 'ru-RU';
  if (language === 'en') return 'en-US';
  const uiLanguage = document.documentElement.lang || navigator.language || 'ru-RU';
  if (/^en(?:-|$)/i.test(uiLanguage)) return 'en-US';
  if (/^ru(?:-|$)/i.test(uiLanguage)) return 'ru-RU';
  return uiLanguage;
}

function dictionaryPhrases() {
  return String(speechPrefs().dictionary || '')
    .split(/\r?\n/)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 128)
    .map((term) => term.slice(0, 100));
}

function appendDictationText(text) {
  const piece = String(text || '').trim();
  if (!piece) return;
  const before = input.value;
  input.value = before ? `${before}${/\s$/.test(before) ? '' : ' '}${piece}` : piece;
}

function applySpeechResponse(response) {
  const raw = response?.speech || response?.settings || response;
  if (!raw || typeof raw !== 'object') return speechPrefs();
  const snapshot = (response?.settings || response?.speech)
    ? {
      ...raw,
      revision: raw.revision ?? response.revision,
      local: raw.local || response.capabilities?.local,
    }
    : raw;
  if (typeof chat.setSpeechSnapshot === 'function') {
    chat.setSpeechSnapshot((response?.settings || response?.speech)
      ? { settings: snapshot, revision: snapshot.revision, capabilities: response.capabilities }
      : snapshot);
  }
  else chat.speech = {
    ...speechPrefs(), ...snapshot,
    local: { ...(speechPrefs().local || {}), ...(snapshot.local || {}) },
  };
  return speechPrefs();
}

function previewSpeechResponse(response) {
  const raw = response?.speech || response?.settings || response;
  if (!raw || typeof raw !== 'object') return null;
  return { ...raw, revision: raw.revision ?? response?.revision };
}

function captureSpeechRequestContext() {
  const prefs = speechPrefs();
  return {
    epoch: speechSnapshotEpoch,
    sid: props.sid,
    revision: prefs.revision || '',
    engine: prefs.engine,
    browserProcessing: prefs.browserProcessing,
    browserAutoConsent: prefs.browserAutoConsent === true,
  };
}

function speechRequestContextMatchesCurrent(context) {
  const current = speechPrefs();
  return props.sid === context.sid
    && speechSnapshotEpoch === context.epoch
    && (current.revision || '') === context.revision
    && current.engine === context.engine
    && current.browserProcessing === context.browserProcessing
    && (current.browserAutoConsent === true) === context.browserAutoConsent;
}

function speechResponseMatchesCurrent(response) {
  const snapshot = previewSpeechResponse(response);
  if (!snapshot || typeof snapshot.revision !== 'string' || !snapshot.revision) return false;
  const current = speechPrefs();
  if (current.revision !== snapshot.revision) return false;
  if (snapshot.engine && current.engine !== snapshot.engine) return false;
  if (snapshot.browserProcessing && current.browserProcessing !== snapshot.browserProcessing) return false;
  if (typeof snapshot.browserAutoConsent === 'boolean'
    && current.browserAutoConsent !== snapshot.browserAutoConsent) return false;
  return true;
}

function speechResponseDisposition(context, response) {
  if (speechRequestContextMatchesCurrent(context)) return 'apply';
  // SSE собственного POST может доехать раньше HTTP response. Это не stale:
  // snapshot уже применён, если совпадают opaque revision и режим исполнения.
  if (speechResponseMatchesCurrent(response)) return 'current';
  return 'stale';
}

function rejectStaleSpeechRequest() {
  preparingSpeech.value = false;
  inputErr.value = 'Настройки речи изменились в другом окне — запусти диктовку ещё раз';
}

// Нужен sync epoch: HTTP promise может разрешиться в том же microtask, раньше
// обычного component watcher. Сравнение opaque revision не пытается упорядочить её.
watch(() => [
  speechPrefs().revision,
  speechPrefs().engine,
  speechPrefs().browserProcessing,
  speechPrefs().browserAutoConsent,
], () => {
  speechSnapshotEpoch++;
}, { flush: 'sync' });

function clearBrowserRestart() {
  if (browserRestartTimer) clearTimeout(browserRestartTimer);
  browserRestartTimer = null;
}

function stopTracks(stream) {
  for (const track of stream?.getTracks?.() || []) {
    try { track.stop(); } catch { /* дорожка уже закрыта */ }
  }
}

function releaseRecognition(recognition, method = 'abort') {
  if (!recognition) return;
  recognition.onstart = null;
  recognition.onresult = null;
  recognition.onerror = null;
  recognition.onend = null;
  try { recognition[method]?.(); } catch { /* API уже в idle */ }
  if (drainingRecognition === recognition) {
    drainingRecognition = null;
    drainingSpeech.value = false;
    if (browserDrainTimer) clearTimeout(browserDrainTimer);
    browserDrainTimer = null;
  }
  if (activeRecognition === recognition) activeRecognition = null;
}

function beginBrowserDrain(recognition, generation) {
  if (browserDrainTimer) clearTimeout(browserDrainTimer);
  drainingRecognition = recognition;
  drainingSpeech.value = true;
  browserDrainTimer = setTimeout(() => {
    browserDrainTimer = null;
    if (generation !== speechGeneration || drainingRecognition !== recognition) return;
    releaseRecognition(recognition, 'abort');
    interimSpeech.value = '';
  }, BROWSER_DRAIN_TIMEOUT_MS);
}

function finishBrowserDrain(recognition) {
  if (drainingRecognition !== recognition) return;
  drainingRecognition = null;
  drainingSpeech.value = false;
  if (browserDrainTimer) clearTimeout(browserDrainTimer);
  browserDrainTimer = null;
}

function finishLocalCapture(state) {
  if (!state || state.released) return;
  state.released = true;
  stopTracks(state.stream);
  if (localCapture === state) localCapture = null;
}

function localStreamSessionId(generation) {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid || `dictation-${Date.now()}-${generation}`;
}

function markLocalStreamFailure(state, error) {
  if (!state || state.liveError || state.cancelled) return;
  state.liveError = error instanceof Error ? error : new Error(String(error || 'live stream failed'));
  if (state.generation !== speechGeneration || speechDestroyed) return;
  interimSpeech.value = '';
  // При отсутствии AudioWorklet/WS серверный worker ещё не запускался — обычный
  // warmup безопасен. После разрыва уже начатой live-сессии идём в one-shot:
  // второй model process не должен пересечься с её bounded cleanup.
  if (state.livePreflightUnsupported) startLocalWarmup(state);
  speechNotice.value = 'Live-предпросмотр недоступен — итог распознаю после остановки.';
}

function onLocalStreamEvent(state, event) {
  if (!state || state.cancelled || speechDestroyed || state.generation !== speechGeneration) return;
  if (event?.type === 'ready') {
    state.liveReady = true;
    return;
  }
  if (event?.type !== 'partial' && event?.type !== 'final' && event?.type !== 'done') return;
  if (event.type === 'partial' && state.stopRequested) return;
  if (typeof event.text === 'string') state.liveFinalText = event.text;
  // После Stop provisional-хвост больше не показываем, но final/done сохраняем:
  // они завершат то же generation и ровно один раз попадут в textarea ниже.
  if (event.type === 'partial') {
    interimSpeech.value = event.text.trim();
    const lagMs = Number(event.lagMs);
    if (Number.isFinite(lagMs) && lagMs >= LOCAL_STREAM_LAG_NOTICE_MS) {
      speechNotice.value = `Распознавание отстаёт примерно на ${Math.ceil(lagMs / 1000)} с.`;
    } else if (speechNotice.value.startsWith('Распознавание отстаёт')) {
      speechNotice.value = '';
    }
  }
}

function startLocalStream(state) {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (typeof window.WebSocket !== 'function'
    || typeof AudioContext !== 'function'
    || typeof window.AudioWorkletNode !== 'function') {
    state.livePreflightUnsupported = true;
    const error = new Error('Браузер не поддерживает live AudioWorklet/WebSocket');
    error.code = 'speech_stream_unsupported';
    markLocalStreamFailure(state, error);
    state.livePromise = Promise.resolve(null);
    return;
  }
  const controller = new AbortController();
  state.liveSessionId = localStreamSessionId(state.generation);
  state.liveAbort = controller;
  state.livePromise = createSpeechStream({
    mediaStream: state.stream,
    sessionId: state.liveSessionId,
    revision: speechPrefs().revision,
    // Исполняемые options берутся только из server-owned snapshot по revision.
    signal: controller.signal,
    onEvent: (event) => onLocalStreamEvent(state, event),
    onError: (error) => markLocalStreamFailure(state, error),
  }).then((stream) => {
    state.liveController = stream;
    if (state.cancelled || speechDestroyed || state.generation !== speechGeneration) {
      void stream.cancel().catch(() => {});
      return null;
    }
    return stream;
  }).catch((error) => {
    markLocalStreamFailure(state, error);
    return null;
  });
}

function cancelLocalStream(state) {
  if (!state || state.cancelled) return;
  state.cancelled = true;
  try { state.liveAbort?.abort(); } catch { /* AbortController уже закрыт */ }
  try { Promise.resolve(state.liveController?.cancel?.()).catch(() => {}); }
  catch { /* WebSocket/AudioContext уже закрыты */ }
}

function stopLocalStream(state) {
  if (!state || state.liveStopPromise || state.cancelled) return state?.liveStopPromise;
  // Граница live должна совпадать с кликом Stop, а не с более поздним onstop
  // MediaRecorder. Для cold start та же promise-chain остановит stream сразу после ready.
  state.liveStopPromise = (async () => {
    const stream = state.liveController || await state.livePromise;
    if (!stream || state.cancelled || state.liveError) return null;
    return stream.stop();
  })();
  // onstop/watchdog присоединит авторитетный await позже; до этого rejection хранится.
  state.liveStopPromise.catch(() => {});
  return state.liveStopPromise;
}

function cancelLocalWarmup(state) {
  if (!state) return;
  state.warmupCancelled = true;
  if (state.warmupTimer) clearTimeout(state.warmupTimer);
  state.warmupTimer = null;
  if (state.resolveWarmup) {
    const resolve = state.resolveWarmup;
    state.resolveWarmup = null;
    resolve(null);
  }
  const warmupId = state.warmupId;
  if (!warmupId || state.warmupDeleteSent) return;
  state.warmupDeleteSent = true;
  // Warmup — оптимизация: его DELETE не должен мешать мгновенной отмене UI.
  api.del?.(`/api/chat/transcribe/warmup/${encodeURIComponent(warmupId)}`).catch(() => {});
}

function startLocalWarmup(state) {
  if (!state || state.warmupStarted || state.warmupCancelled) return state?.warmupPromise;
  state.warmupStarted = true;
  state.warmupPromise = new Promise((resolve) => {
    state.resolveWarmup = resolve;
    state.warmupTimer = setTimeout(() => {
      // Warmup — только ускорение. Не держим готовый blob из-за медленного
      // prewarm-запроса; поздний id освободим DELETE-ом.
      state.warmupTimer = null;
      state.warmupCancelled = true;
      state.resolveWarmup = null;
      resolve(null);
    }, 1500);
  });
  Promise.resolve()
    .then(() => api.post('/api/chat/transcribe/warmup', {}))
    .then((result) => {
      const warmupId = typeof result?.warmupId === 'string' ? result.warmupId : '';
      state.warmupId = warmupId;
      if (state.warmupCancelled) {
        cancelLocalWarmup(state);
        return;
      }
      if (state.warmupTimer) clearTimeout(state.warmupTimer);
      state.warmupTimer = null;
      const resolve = state.resolveWarmup;
      state.resolveWarmup = null;
      resolve?.(warmupId || null);
    })
    // Старый сервер или сбой warmup не отменяет one-shot транскрипцию.
    .catch(() => {
      if (state.warmupTimer) clearTimeout(state.warmupTimer);
      state.warmupTimer = null;
      const resolve = state.resolveWarmup;
      state.resolveWarmup = null;
      resolve?.(null);
    });
  return state.warmupPromise;
}

async function transcribeLocal(state) {
  if (!state.commit || speechDestroyed || state.completionGeneration !== speechGeneration) return;
  const generation = state.completionGeneration;
  const controller = new AbortController();
  transcriptionAbort?.abort();
  transcriptionAbort = controller;
  localTranscription = state;
  transcribing.value = true;
  try {
    const warmupId = await state.warmupPromise;
    if (speechDestroyed || controller.signal.aborted || generation !== speechGeneration) return;
    const blob = new Blob(state.chunks, { type: state.recorder.mimeType || 'audio/webm' });
    const fd = new FormData();
    fd.append('file', blob, 'dictation.webm');
    // Unknown/expired/used id сервер трактует как one-shot fallback; клиент
    // не пытается угадать живость id и не ломает обычный upload.
    if (warmupId) fd.append('warmupId', warmupId);
    // Сервер по этому id завершает именно прежний live worker до one-shot:
    // WebSocket close и multipart могут прийти в разных event-loop тиках.
    if (state.liveSessionId) fd.append('streamSessionId', state.liveSessionId);
    const result = await api.upload('/api/chat/transcribe', fd, { signal: controller.signal });
    if (speechDestroyed || controller.signal.aborted || generation !== speechGeneration) return;
    if (result?.text) {
      appendDictationText(result.text);
      speechNotice.value = '';
    }
    else inputErr.value = 'Речь не распознана — попробуй ещё раз';
  } catch (error) {
    if (!controller.signal.aborted && generation === speechGeneration && !speechDestroyed) {
      inputErr.value = `Распознавание: ${error.message}`;
    }
  } finally {
    if (transcriptionAbort === controller) {
      transcriptionAbort = null;
      transcribing.value = false;
    }
    if (localTranscription === state) localTranscription = null;
  }
}

async function finishLocalTranscription(state) {
  const generation = state.completionGeneration;
  localTranscription = state;
  try {
    const stream = await state.livePromise;
    if (state.cancelled || speechDestroyed || generation !== speechGeneration) return;
    if (stream && !state.liveError) {
      try {
        const done = await (state.liveStopPromise || stream.stop());
        if (state.cancelled || speechDestroyed || generation !== speechGeneration) return;
        const text = typeof done?.text === 'string' ? done.text.trim() : state.liveFinalText.trim();
        interimSpeech.value = '';
        speechNotice.value = '';
        if (text) {
          appendDictationText(text);
          return;
        }
        // Очень ранний Stop может застать AudioWorklet ещё до capture-ready. Полный
        // MediaRecorder WebM при этом уже есть, поэтому пустой live-final — повод
        // перепроверить запись batch-путём, а не молча потерять сказанное.
        speechNotice.value = 'Live-результат пуст — перепроверяю полную запись.';
      } catch (error) {
        markLocalStreamFailure(state, error);
      }
    }
    if (state.cancelled || speechDestroyed || generation !== speechGeneration) return;
    interimSpeech.value = '';
    // MediaRecorder писал с самого начала и не зависит от live-канала.
    // Поэтому любой его terminal failure безопасно заканчивается одним batch upload.
    await transcribeLocal(state);
  } finally {
    if (localTranscription === state) localTranscription = null;
    if (generation === speechGeneration) drainingSpeech.value = false;
  }
}

function localRecorderStopped(state) {
  if (!state || state.stopped) return;
  state.stopped = true;
  if (state.recorderStopTimer) clearTimeout(state.recorderStopTimer);
  state.recorderStopTimer = null;
  finishLocalCapture(state);
  recording.value = false;
  if (state.commit) {
    drainingSpeech.value = true;
    void finishLocalTranscription(state);
  } else if (state.completionGeneration === speechGeneration) {
    drainingSpeech.value = false;
  }
}

async function startWhisper(generation, fallbackReason = '') {
  if (generation !== speechGeneration || !desiredSpeech || speechDestroyed) return;
  const local = speechPrefs().local || {};
  if (!local.ready) {
    desiredSpeech = false;
    preparingSpeech.value = false;
    recording.value = false;
    const why = local.reason ? ` ${local.reason}` : '';
    inputErr.value = `${fallbackReason ? `${fallbackReason} ` : ''}Локальный Whisper недоступен.${why}`.trim();
    return;
  }
  if (window.isSecureContext === false || !navigator.mediaDevices?.getUserMedia) {
    desiredSpeech = false;
    preparingSpeech.value = false;
    inputErr.value = 'Микрофон требует https или localhost — открой кокпит по защищённому адресу';
    return;
  }
  const Recorder = window.MediaRecorder;
  if (!Recorder) {
    desiredSpeech = false;
    preparingSpeech.value = false;
    inputErr.value = 'MediaRecorder не поддерживается этим браузером';
    return;
  }
  preparingSpeech.value = true;
  let stream = null;
  let captureState = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (generation !== speechGeneration || !desiredSpeech || speechDestroyed) {
      stopTracks(stream);
      return;
    }
    const mime = typeof Recorder.isTypeSupported === 'function' && Recorder.isTypeSupported('audio/webm')
      ? 'audio/webm' : '';
    const recorder = new Recorder(stream, mime ? { mimeType: mime } : undefined);
    const state = {
      recorder, stream, chunks: [], generation, completionGeneration: generation,
      commit: false, stopped: false, released: false, warmupId: '', warmupPromise: Promise.resolve(null),
      warmupStarted: false, warmupCancelled: false, warmupDeleteSent: false,
      warmupTimer: null, resolveWarmup: null,
      liveAbort: null, livePromise: Promise.resolve(null), liveController: null,
      liveSessionId: '', liveStopPromise: null,
      liveError: null, liveReady: false, liveFinalText: '', stopRequested: false, cancelled: false,
      livePreflightUnsupported: false,
      recorderStopTimer: null,
    };
    captureState = state;
    localCapture = state;
    recorder.ondataavailable = (event) => { if (event.data?.size) state.chunks.push(event.data); };
    recorder.onstop = () => localRecorderStopped(state);
    recorder.onerror = (event) => {
      state.commit = false;
      desiredSpeech = false;
      cancelLocalStream(state);
      cancelLocalWarmup(state);
      if (generation === speechGeneration) {
        speechGeneration++;
        inputErr.value = `Микрофон: ${event.error?.message || 'ошибка записи'}`;
      }
      localRecorderStopped(state);
    };
    recorder.start();
    startLocalStream(state);
    preparingSpeech.value = false;
    recording.value = true;
    if (fallbackReason) speechNotice.value = `${fallbackReason} Использую локальный Whisper.`;
  } catch (error) {
    if (captureState) finishLocalCapture(captureState);
    else stopTracks(stream);
    if (generation !== speechGeneration || speechDestroyed) return;
    desiredSpeech = false;
    preparingSpeech.value = false;
    recording.value = false;
    inputErr.value = `Микрофон: ${error.message}`;
  }
}

function browserOptions() {
  return { langs: [browserLanguage()], processLocally: true };
}

function browserErrorText(error) {
  const texts = {
    'not-allowed': 'Нет доступа к микрофону.',
    'audio-capture': 'Браузер не нашёл доступный микрофон.',
    'language-not-supported': 'Браузер не поддерживает выбранный язык.',
    'service-not-allowed': 'Сервис распознавания браузера недоступен.',
    network: 'Браузерное распознавание не доступно из-за сети.',
  };
  return texts[error] || `Браузерное распознавание завершилось с ошибкой: ${error}.`;
}

function fallbackToWhisper(generation, reason) {
  if (generation !== speechGeneration || !desiredSpeech || speechDestroyed) return;
  clearBrowserRestart();
  if (activeRecognition) releaseRecognition(activeRecognition);
  recording.value = false;
  interimSpeech.value = '';
  startWhisper(generation, reason);
}

function scheduleBrowserRestart(generation, delay) {
  if (generation !== speechGeneration || !desiredSpeech || speechDestroyed) return;
  clearBrowserRestart();
  preparingSpeech.value = true;
  browserRestartTimer = setTimeout(() => {
    browserRestartTimer = null;
    if (generation !== speechGeneration || !desiredSpeech || speechDestroyed) return;
    startBrowserRecognitionGuarded(browserRecognitionCtor, generation);
  }, delay);
}

function handleBrowserError(recognition, generation, error) {
  if (generation !== speechGeneration || recognition !== activeRecognition || speechDestroyed) return;
  releaseRecognition(recognition);
  recording.value = false;
  interimSpeech.value = '';

  if (error === 'phrases-not-supported' && !phrasesDisabled) {
    phrasesDisabled = true;
    speechNotice.value = 'Этот браузер не применил словарь — продолжаю без подсказок.';
    scheduleBrowserRestart(generation, 0);
    return;
  }
  if (error === 'network') {
    browserRetries.network++;
    if (browserRetries.network <= 2) {
      scheduleBrowserRestart(generation, browserRetries.network * 300);
      return;
    }
    fallbackToWhisper(generation, browserErrorText(error));
    return;
  }
  if (error === 'no-speech') {
    browserRetries.noSpeech++;
    if (browserRetries.noSpeech <= 2) {
      speechNotice.value = 'Речь не услышана, пробую ещё раз…';
      scheduleBrowserRestart(generation, browserRetries.noSpeech * 250);
      return;
    }
    desiredSpeech = false;
    preparingSpeech.value = false;
    inputErr.value = 'Речь не услышана — попробуй ещё раз';
    return;
  }
  if (error === 'service-not-allowed' || error === 'language-not-supported') {
    fallbackToWhisper(generation, browserErrorText(error));
    return;
  }

  desiredSpeech = false;
  preparingSpeech.value = false;
  if (error !== 'aborted') inputErr.value = browserErrorText(error);
}

function startBrowserRecognition(Ctor, generation) {
  if (!Ctor || generation !== speechGeneration || !desiredSpeech || speechDestroyed) return;
  let recognition;
  try {
    recognition = new Ctor();
    recognition.lang = browserLanguage();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    if (speechPrefs().browserProcessing === 'local') recognition.processLocally = true;

    const terms = dictionaryPhrases();
    if (terms.length && !phrasesDisabled) {
      const Phrase = window.SpeechRecognitionPhrase;
      if ('phrases' in recognition && typeof Phrase === 'function') {
        try {
          recognition.phrases = terms.map((term) => new Phrase(term, 5));
        } catch {
          phrasesDisabled = true;
          speechNotice.value = 'Этот браузер не применил словарь; диктовка продолжается без него.';
        }
      } else {
        phrasesDisabled = true;
        speechNotice.value = 'Словарь не поддерживается этим браузером; диктовка продолжается без него.';
      }
    }
  } catch (error) {
    desiredSpeech = false;
    preparingSpeech.value = false;
    inputErr.value = `Не удалось подготовить диктовку: ${error.message}`;
    return;
  }

  const finalResults = new Set();
  activeRecognition = recognition;
  recognition.onstart = () => {
    if (generation !== speechGeneration || recognition !== activeRecognition || !desiredSpeech) return;
    preparingSpeech.value = false;
    recording.value = true;
  };
  recognition.onresult = (event) => {
    const draining = recognition === drainingRecognition;
    if (generation !== speechGeneration || recognition !== activeRecognition || (!desiredSpeech && !draining)) return;
    let interim = '';
    const start = Number.isInteger(event.resultIndex) ? event.resultIndex : 0;
    for (let index = start; index < (event.results?.length || 0); index++) {
      const result = event.results[index];
      const transcript = result?.[0]?.transcript || result?.item?.(0)?.transcript || '';
      if (result?.isFinal) {
        if (!finalResults.has(index)) {
          finalResults.add(index);
          appendDictationText(transcript);
        }
      } else if (!draining) {
        interim += `${interim ? ' ' : ''}${transcript.trim()}`;
      }
    }
    interimSpeech.value = draining ? '' : interim;
  };
  recognition.onerror = (event) => handleBrowserError(recognition, generation, event.error || 'unknown');
  recognition.onend = () => {
    if (generation !== speechGeneration || recognition !== activeRecognition || speechDestroyed) return;
    activeRecognition = null;
    finishBrowserDrain(recognition);
    recording.value = false;
    preparingSpeech.value = false;
    interimSpeech.value = '';
    // Обычный onend не даёт права бесконечно захватывать микрофон.
    desiredSpeech = false;
  };
  try {
    recognition.start();
    // Safari и некоторые test doubles не шлют onstart, но успешный
    // синхронный start уже означает, что кнопка должна стать «Стоп».
    preparingSpeech.value = false;
    recording.value = true;
  } catch (error) {
    releaseRecognition(recognition);
    desiredSpeech = false;
    preparingSpeech.value = false;
    recording.value = false;
    inputErr.value = error?.name === 'InvalidStateError'
      ? 'Диктовка уже запущена в этом браузере'
      : `Не удалось запустить диктовку: ${error.message}`;
  }
}

function failClosedBrowserAutoStart(generation, message) {
  if (generation !== speechGeneration || speechDestroyed) return;
  desiredSpeech = false;
  preparingSpeech.value = false;
  recording.value = false;
  browserInstalling.value = false;
  speechGeneration++;
  inputErr.value = message;
}

async function validateBrowserAutoStart(generation) {
  if (generation !== speechGeneration || !desiredSpeech || speechDestroyed) return false;
  const requestContext = captureSpeechRequestContext();
  if (requestContext.engine !== 'browser' || requestContext.browserProcessing !== 'auto'
    || !requestContext.browserAutoConsent || !requestContext.revision) {
    failClosedBrowserAutoStart(generation, 'Сервер не подтвердил актуальное согласие для браузерной диктовки');
    return false;
  }
  try {
    const response = await api.post('/api/settings/speech/browser-consent', {
      confirm: true,
      revision: requestContext.revision,
    });
    if (generation !== speechGeneration || !desiredSpeech || speechDestroyed) return false;
    const disposition = speechResponseDisposition(requestContext, response);
    const candidate = previewSpeechResponse(response);
    if (disposition === 'stale' || candidate?.engine !== 'browser'
      || candidate.browserProcessing !== 'auto' || candidate.browserAutoConsent !== true) {
      failClosedBrowserAutoStart(
        generation,
        'Настройки речи изменились в другом окне — браузерная диктовка не запущена',
      );
      return false;
    }
    if (disposition === 'apply') applySpeechResponse(response);
    await nextTick();
    if (generation !== speechGeneration || !desiredSpeech || speechDestroyed) return false;
    const current = speechPrefs();
    if (current.engine !== 'browser' || current.browserProcessing !== 'auto'
      || current.browserAutoConsent !== true || !speechResponseMatchesCurrent(response)) {
      failClosedBrowserAutoStart(
        generation,
        'Настройки речи изменились в другом окне — браузерная диктовка не запущена',
      );
      return false;
    }
    return true;
  } catch (error) {
    if (generation !== speechGeneration || !desiredSpeech || speechDestroyed) return false;
    failClosedBrowserAutoStart(
      generation,
      error?.status === 409
        ? 'Настройки речи изменились в другом окне — браузерная диктовка не запущена'
        : 'Не удалось проверить согласие на обработку речи — браузерная диктовка не запущена',
    );
    return false;
  }
}

async function startBrowserRecognitionGuarded(Ctor, generation, validatedRevision = '') {
  if (!Ctor || generation !== speechGeneration || !desiredSpeech || speechDestroyed) return;
  const prefs = speechPrefs();
  if (prefs.engine !== 'browser') return;
  if (prefs.browserProcessing === 'auto') {
    const alreadyValidated = !!validatedRevision
      && prefs.revision === validatedRevision
      && prefs.browserAutoConsent === true;
    if (!alreadyValidated && !await validateBrowserAutoStart(generation)) return;
    if (generation !== speechGeneration || !desiredSpeech || speechDestroyed) return;
    const current = speechPrefs();
    if (current.engine !== 'browser' || current.browserProcessing !== 'auto'
      || current.browserAutoConsent !== true) {
      failClosedBrowserAutoStart(
        generation,
        'Настройки речи изменились в другом окне — браузерная диктовка не запущена',
      );
      return;
    }
  } else if (prefs.browserProcessing !== 'local') {
    return;
  }
  startBrowserRecognition(Ctor, generation);
}

async function startBrowser(generation, validatedRevision = '') {
  if (generation !== speechGeneration || !desiredSpeech || speechDestroyed) return;
  if (window.isSecureContext === false) {
    fallbackToWhisper(generation, 'Браузерная диктовка требует HTTPS.');
    return;
  }
  const Ctor = browserSpeechCtor();
  if (!Ctor) {
    fallbackToWhisper(generation, 'Браузерная диктовка на этом устройстве недоступна.');
    return;
  }
  if (speechPrefs().browserProcessing === 'auto' && !speechPrefs().browserAutoConsent) {
    desiredSpeech = false;
    preparingSpeech.value = false;
    speechGeneration++;
    consentPending.value = true;
    return;
  }

  browserRecognitionCtor = Ctor;
  if (speechPrefs().browserProcessing === 'local') {
    const supportsLocal = 'processLocally' in (Ctor.prototype || {}) && typeof Ctor.available === 'function';
    if (!supportsLocal) {
      fallbackToWhisper(generation, 'Этот браузер не умеет распознавать речь на устройстве.');
      return;
    }
    preparingSpeech.value = true;
    try {
      const availability = await Ctor.available(browserOptions());
      if (generation !== speechGeneration || !desiredSpeech || speechDestroyed) return;
      if (availability === 'downloadable') {
        if (typeof Ctor.install !== 'function') {
          fallbackToWhisper(generation, 'Браузер не умеет устанавливать локальную языковую модель.');
          return;
        }
        desiredSpeech = false;
        preparingSpeech.value = false;
        speechGeneration++;
        pendingBrowserInstall = {
          Ctor,
          context: captureSpeechRequestContext(),
          options: browserOptions(),
        };
        browserInstallPending.value = true;
        return;
      }
      if (availability !== 'available' && availability !== true) {
        fallbackToWhisper(generation, availability === 'downloading'
          ? 'Браузер ещё скачивает языковую модель.'
          : 'Локальная языковая модель браузера недоступна.');
        return;
      }
    } catch {
      if (generation === speechGeneration) {
        fallbackToWhisper(generation, 'Не удалось проверить локальную модель браузера.');
      }
      return;
    }
  }
  startBrowserRecognitionGuarded(Ctor, generation, validatedRevision);
}

function beginSpeech({ browserAutoValidationRevision = '' } = {}) {
  // Новый запуск окончательно закрывает короткое окно, в котором предыдущий
  // штатный Stop ещё мог прислать свой последний final result.
  if (activeRecognition) releaseRecognition(activeRecognition);
  consentPending.value = false;
  browserInstallPending.value = false;
  pendingBrowserInstall = null;
  inputErr.value = '';
  speechNotice.value = '';
  interimSpeech.value = '';
  browserRetries = { network: 0, noSpeech: 0 };
  phrasesDisabled = false;
  const generation = ++speechGeneration;
  desiredSpeech = true;
  preparingSpeech.value = true;
  if (speechPrefs().engine === 'browser') startBrowser(generation, browserAutoValidationRevision);
  else startWhisper(generation);
}

async function confirmBrowserConsent() {
  if (!consentPending.value) return;
  consentPending.value = false;
  inputErr.value = '';
  preparingSpeech.value = true;
  const requestGeneration = ++speechGeneration;
  const requestContext = captureSpeechRequestContext();
  try {
    const response = await api.post('/api/settings/speech/browser-consent', {
      confirm: true,
      revision: requestContext.revision,
    });
    if (requestGeneration !== speechGeneration || speechDestroyed) return;
    const disposition = speechResponseDisposition(requestContext, response);
    if (disposition === 'stale') { rejectStaleSpeechRequest(); return; }
    const candidate = previewSpeechResponse(response);
    if (candidate?.engine !== 'browser' || candidate.browserProcessing !== 'auto'
      || candidate.browserAutoConsent !== true) {
      throw new Error('сервер не подтвердил согласие');
    }
    preparingSpeech.value = false;
    const snapshot = disposition === 'current' ? speechPrefs() : applySpeechResponse(response);
    await nextTick();
    if (snapshot.engine !== 'browser' || snapshot.browserProcessing !== 'auto' || snapshot.browserAutoConsent !== true) {
      throw new Error('сервер не подтвердил согласие');
    }
    if (requestGeneration !== speechGeneration || speechDestroyed) return;
    if (!speechResponseMatchesCurrent(response)) { rejectStaleSpeechRequest(); return; }
    beginSpeech({ browserAutoValidationRevision: snapshot.revision });
  } catch (error) {
    if (requestGeneration !== speechGeneration || speechDestroyed) return;
    preparingSpeech.value = false;
    // Stale-окно не допускаем к микрофону: сначала восстанавливаем snapshot.
    if (error.status === 409) {
      const recoveryContext = captureSpeechRequestContext();
      try {
        const latest = await api.get('/api/settings/speech');
        if (requestGeneration !== speechGeneration || speechDestroyed) return;
        const disposition = speechResponseDisposition(recoveryContext, latest);
        if (disposition === 'apply') applySpeechResponse(latest);
      } catch { /* ниже будет fail-closed */ }
      consentPending.value = speechPrefs().engine === 'browser'
        && speechPrefs().browserProcessing === 'auto' && !speechPrefs().browserAutoConsent;
      inputErr.value = 'Настройки речи изменились в другом окне — проверь выбор ещё раз';
    } else {
      inputErr.value = `Не удалось сохранить согласие: ${error.message}`;
    }
  }
}

async function useWhisperFromPrompt() {
  consentPending.value = false;
  browserInstallPending.value = false;
  pendingBrowserInstall = null;
  inputErr.value = '';
  preparingSpeech.value = true;
  const requestGeneration = ++speechGeneration;
  const requestContext = captureSpeechRequestContext();
  try {
    const response = await api.post('/api/settings/speech', { engine: 'whisper' });
    if (requestGeneration !== speechGeneration || speechDestroyed) return;
    const disposition = speechResponseDisposition(requestContext, response);
    if (disposition === 'stale') { rejectStaleSpeechRequest(); return; }
    const candidate = previewSpeechResponse(response);
    if (candidate?.engine !== 'whisper') throw new Error('движок не изменился');
    // Изменение engine должно пройти через общий watcher, пока микрофон ещё
    // не стартовал; иначе собственный server snapshot отменит только что
    // запущенный Whisper как будто это правка из другого окна.
    preparingSpeech.value = false;
    const snapshot = disposition === 'current' ? speechPrefs() : applySpeechResponse(response);
    await nextTick();
    if (requestGeneration !== speechGeneration || speechDestroyed) return;
    if (snapshot.engine !== 'whisper') throw new Error('движок не изменился');
    if (!speechResponseMatchesCurrent(response)) { rejectStaleSpeechRequest(); return; }
    beginSpeech();
  } catch (error) {
    if (requestGeneration !== speechGeneration || speechDestroyed) return;
    preparingSpeech.value = false;
    inputErr.value = `Не удалось выбрать Whisper: ${error.message}`;
  }
}

async function installBrowserLanguage() {
  const pendingInstall = pendingBrowserInstall;
  if (!browserInstallPending.value || !pendingInstall?.Ctor || !pendingInstall.context) return;
  browserInstallPending.value = false;
  if (!speechRequestContextMatchesCurrent(pendingInstall.context)
    || pendingInstall.context.engine !== 'browser'
    || pendingInstall.context.browserProcessing !== 'local') {
    pendingBrowserInstall = null;
    inputErr.value = 'Настройки речи изменились — локальная модель не будет установлена';
    return;
  }
  browserInstalling.value = true;
  preparingSpeech.value = true;
  inputErr.value = '';
  const generation = ++speechGeneration;
  desiredSpeech = true;
  try {
    const installed = await pendingInstall.Ctor.install(pendingInstall.options);
    if (generation !== speechGeneration || !desiredSpeech || speechDestroyed) return;
    if (!speechRequestContextMatchesCurrent(pendingInstall.context)
      || speechPrefs().engine !== 'browser'
      || speechPrefs().browserProcessing !== 'local'
      || (speechPrefs().browserAutoConsent === true) !== pendingInstall.context.browserAutoConsent) {
      failClosedBrowserAutoStart(
        generation,
        'Настройки речи изменились — установленная модель не будет запускать старый режим',
      );
      return;
    }
    if (installed !== true) {
      fallbackToWhisper(generation, 'Браузер не смог установить языковую модель.');
      return;
    }
    browserRecognitionCtor = pendingInstall.Ctor;
    startBrowserRecognitionGuarded(pendingInstall.Ctor, generation);
  } catch (error) {
    if (generation === speechGeneration) fallbackToWhisper(generation, `Не удалось установить языковую модель: ${error.message}.`);
  } finally {
    if (generation === speechGeneration) {
      browserInstalling.value = false;
      if (!recording.value && !desiredSpeech) preparingSpeech.value = false;
    }
    if (pendingBrowserInstall === pendingInstall) pendingBrowserInstall = null;
  }
}

function stopSpeech({ cancel = false } = {}) {
  const wasActive = desiredSpeech || recording.value || preparingSpeech.value || transcribing.value
    || consentPending.value || browserInstallPending.value || browserInstalling.value
    || drainingSpeech.value || activeRecognition || localCapture || localTranscription;
  const finishBrowserNormally = !cancel && !!activeRecognition;
  const finishLocalNormally = !cancel && !!localCapture;
  desiredSpeech = false;
  // Оба движка отдают final после Stop. Штатный drain сохраняет generation;
  // Esc/unmount/settings change инвалидируют запуск немедленно.
  const completionGeneration = finishBrowserNormally || finishLocalNormally
    ? speechGeneration : ++speechGeneration;
  clearBrowserRestart();
  consentPending.value = false;
  browserInstallPending.value = false;
  browserInstalling.value = false;
  pendingBrowserInstall = null;
  interimSpeech.value = '';
  preparingSpeech.value = false;
  recording.value = false;

  // Обрываем только upload, который уже шёл до этого stop. Важно сделать
  // это до recorder.stop(): onstop синхронно стартует новый штатный upload.
  if (transcriptionAbort) {
    if (cancel) {
      cancelLocalStream(localTranscription);
      cancelLocalWarmup(localTranscription);
    }
    transcriptionAbort.abort();
    transcriptionAbort = null;
    transcribing.value = false;
  }
  if (cancel && localTranscription) {
    localTranscription.commit = false;
    cancelLocalStream(localTranscription);
    cancelLocalWarmup(localTranscription);
  }
  if (activeRecognition) {
    const recognition = activeRecognition;
    if (cancel) {
      releaseRecognition(recognition, 'abort');
    } else {
      beginBrowserDrain(recognition, completionGeneration);
      try { recognition.stop?.(); } catch { releaseRecognition(recognition); }
    }
  }
  if (localCapture) {
    const state = localCapture;
    state.commit = !cancel;
    state.stopRequested = true;
    if (cancel) {
      cancelLocalStream(state);
      cancelLocalWarmup(state);
    } else {
      drainingSpeech.value = true;
      stopLocalStream(state);
    }
    state.completionGeneration = completionGeneration;
    try {
      if (state.recorder.state && state.recorder.state !== 'inactive') {
        if (!cancel) {
          // requestData повышает шанс сохранить WebM даже у браузера/полифила,
          // который зависнет и не пришлёт штатный onstop.
          try { state.recorder.requestData?.(); } catch { /* stop всё равно обязателен */ }
          state.recorderStopTimer = setTimeout(() => {
            state.recorderStopTimer = null;
            localRecorderStopped(state);
          }, LOCAL_RECORDER_STOP_TIMEOUT_MS);
        }
        state.recorder.stop();
      } else localRecorderStopped(state);
    } catch {
      state.commit = false;
      cancelLocalStream(state);
      cancelLocalWarmup(state);
      localRecorderStopped(state);
    }
    // Esc/unmount обязаны освободить hardware даже у неполного
    // MediaRecorder-полифила, который не присылает onstop.
    if (cancel) finishLocalCapture(state);
  }
  // У штатного Stop drain сохраняет generation и снимается в finally. Esc,
  // смена настроек и unmount generation инвалидируют, поэтому снимаем UI-lock
  // здесь явно: поздний finally старой сессии уже не имеет права менять новый UI.
  if (cancel) drainingSpeech.value = false;
  if (cancel && wasActive) speechNotice.value = 'Диктовка отменена.';
}

function toggleMic() {
  inputErr.value = '';
  if (drainingSpeech.value || drainingRecognition) return;
  if (recording.value || preparingSpeech.value || desiredSpeech) {
    stopSpeech();
    return;
  }
  if (transcribing.value) return;
  if (consentPending.value || browserInstallPending.value) {
    stopSpeech({ cancel: true });
    return;
  }
  const prefs = speechPrefs();
  if (prefs.engine === 'browser' && prefs.browserProcessing === 'auto' && !prefs.browserAutoConsent) {
    consentPending.value = true;
    speechNotice.value = '';
    return;
  }
  beginSpeech();
}

// Ctrl+D — старт/стоп, Esc — отмена без отправки MediaRecorder-блоба.
function onGlobalKey(e) {
  if (e.key === 'Escape' && (recording.value || preparingSpeech.value || transcribing.value
    || consentPending.value || browserInstallPending.value || browserInstalling.value
    || drainingSpeech.value || desiredSpeech || activeRecognition)) {
    e.preventDefault();
    stopSpeech({ cancel: true });
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyD' && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    toggleMic();
  }
}

watch(() => [
  speechPrefs().revision,
  speechPrefs().engine,
  speechPrefs().browserProcessing,
  speechPrefs().browserAutoConsent,
  speechPrefs().language,
  speechPrefs().dictionary,
  speechPrefs().quality,
  speechPrefs().model,
  speechPrefs().device,
  speechPrefs().computeType,
  speechPrefs().beamSize,
  speechPrefs().vadSilenceMs,
  speechPrefs().conditionOnPreviousText,
],
  (next, previous) => {
    if (previous && next.some((value, index) => value !== previous[index])
      && (desiredSpeech || recording.value || activeRecognition || localCapture || transcribing.value
        || drainingSpeech.value || localTranscription
        || consentPending.value || browserInstallPending.value || browserInstalling.value)) {
      stopSpeech({ cancel: true });
      speechNotice.value = 'Диктовка остановлена: настройки речи изменились.';
    }
  }, { flush: 'sync' });
watch(() => props.sid, () => {
  if (desiredSpeech || recording.value || preparingSpeech.value || transcribing.value
    || drainingSpeech.value || activeRecognition || localCapture || localTranscription || consentPending.value
    || browserInstallPending.value || browserInstalling.value) stopSpeech({ cancel: true });
}, { flush: 'sync' });
onMounted(() => window.addEventListener('keydown', onGlobalKey));
onUnmounted(() => {
  speechDestroyed = true;
  stopSpeech({ cancel: true });
  window.removeEventListener('keydown', onGlobalKey);
});

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

// Как в мессенджере: в пузыре показываем только компактные часы и минуты, а полную
// локальную дату оставляем в подсказке и семантическом <time>. Старым сообщениям без
// sentAt время не придумываем — updatedAt относится ко всему чату, а не к запросу.
const messageTimeFormatter = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const messageDateTimeFormatter = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'medium', timeStyle: 'short',
});
function validMessageTime(value) {
  const time = Number(value);
  return Number.isSafeInteger(time) && time > 0 ? time : 0;
}
function messageTime(value) {
  const time = validMessageTime(value);
  return time ? messageTimeFormatter.format(new Date(time)) : '';
}
function messageTimeTitle(value) {
  const time = validMessageTime(value);
  return time ? `Отправлено ${messageDateTimeFormatter.format(new Date(time))}` : '';
}
function messageTimeIso(value) {
  const time = validMessageTime(value);
  return time ? new Date(time).toISOString() : '';
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
  ui.openTaskLaunch(s.taskId);
  launchMsg.value = 'выбери маршрут и проверь параметры запуска в карточке задачи';
}

// Debug открывается отдельным разговором, но остаётся в worktree этой же задачи.
// Здесь только готовим черновик: ни отправки агенту, ни запуска конвейера по клику нет.
const DEBUG_HINT = 'Откроется отдельный Debug-чат в той же песочнице задачи. Новый конвейер не создаётся, черновик останется неотправленным.';
const debugOpening = ref(false);
const debugMsg = ref('');
const debugTaskTitle = computed(() => {
  const task = String(sess.value?.taskId || '');
  return taskOpts.value.find((o) => o.task === task)?.title || sess.value?.title || '';
});
function recentDebugContext(messages = []) {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim())
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'Пользователь' : 'Агент'}: ${String(m.text).trim()}`)
    .join('\n\n')
    .slice(-3000);
}
async function openDebug() {
  const s = sess.value;
  if (!s?.taskId || s.purpose === 'debug' || debugOpening.value) return;
  debugOpening.value = true;
  debugMsg.value = '';
  try {
    await chat.openDebugFor({
      taskId: s.taskId,
      taskTitle: debugTaskTitle.value,
      sourceChatId: s.id,
      context: recentDebugContext(s.messages),
    });
    await router.push('/chats');
  } catch (e) {
    debugMsg.value = `ошибка: ${e.message}`;
  } finally {
    debugOpening.value = false;
  }
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
        <HelpTip class="task-tip" :text="activeTaskLabel" align="left" :trigger-focusable="false"
                 :tip-style="{ maxWidth: 'min(520px, calc(100vw - 16px))' }">
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
                  :title="currentModel ? `${currentModel.name} · контекст ${(currentModel.context / 1000).toFixed(0)}k` + (currentModel.contextUnverified ? ' · окно не подтверждено' : '') : 'Модель'"
                  @change="onModelChange">
            <template v-if="provGroups.length">
              <optgroup v-for="p in provGroups" :key="p.id" :label="p.name + (p.available ? '' : ' — недоступен')">
                <!-- «?» — модели нет в каталоге установленного CLI (он про неё не знает) -->
                <option v-for="m in p.models" :key="m.id" :value="m.id" :disabled="!p.available"
                        :title="`${m.id} · контекст ${(m.context / 1000).toFixed(0)}k` + (m.contextUnverified ? ' · окно не подтверждено' : '') + (m.unknown ? ' · нет в каталоге установленного CLI' : '')">
                  {{ m.name }}{{ m.contextUnverified ? ' · окно не подтверждено' : '' }}{{ m.unknown ? ' ?' : '' }}
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
        <!-- Контекст: точная активная заполненность; при недоступной метрике дуга пустая.
             Клик — сжатие контекста (с подтверждением), Alt+клик — сброс памяти агента.
             Подсказка штатная, а не browser title: так она не обрезается и вмещает
             раздельные числа, состояние и действия. -->
        <HelpTip class="ctx-tip" align="right" :trigger-focusable="false"
                 :tip-style="{ maxWidth: 'min(300px, calc(100vw - 16px))' }">
          <button class="ctx-ring" :class="[ctxClass, { estimate: ctxIsEstimate, compacting: sess.compacting }]"
                  :aria-disabled="ctxRingDisabled ? 'true' : undefined"
                  :aria-label="ctxTitle"
                  @click="onCtxClick">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle class="rbg" cx="12" cy="12" r="9" fill="none" stroke-width="3" />
              <circle class="rfg" cx="12" cy="12" r="9" fill="none" stroke-width="3" stroke-linecap="round"
                      :stroke-dasharray="RING_C" :stroke-dashoffset="ringDash" transform="rotate(-90 12 12)" />
            </svg>
          </button>
          <template #tip>
            <span class="ctx-pop" data-testid="context-tooltip">
              <span class="ctx-pop-head">
                <span><b>{{ ctxTooltip.title }}</b><span class="ctx-pop-unit"> · токены</span></span>
                <span v-if="ctxTooltip.percent" class="ctx-pop-pct" :class="ctxTooltip.tone">
                  {{ ctxTooltip.percent }}
                </span>
              </span>
              <span v-if="ctxTooltip.status" class="ctx-pop-status" :class="ctxTooltip.tone">
                {{ ctxTooltip.status }}
              </span>
              <span v-if="ctxTooltip.detail" class="ctx-pop-detail">{{ ctxTooltip.detail }}</span>
              <span v-if="ctxTooltip.rows.length" class="ctx-pop-rows">
                <span v-for="row in ctxTooltip.rows" :key="row.label"
                      class="ctx-pop-row" :class="{ unverified: row.unverified }">
                  <span class="ctx-pop-label">{{ row.label }}</span>
                  <span class="ctx-pop-value">{{ row.value }}</span>
                </span>
              </span>
              <span v-if="ctxTooltip.actions" class="ctx-pop-actions">
                <span class="ctx-pop-action"><b>Клик</b><span>сжать</span></span>
                <span class="ctx-pop-action"><b>Alt + клик</b><span>сбросить</span></span>
              </span>
            </span>
          </template>
        </HelpTip>
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
            Модель и усилие — сверху. Enter — отправить, Shift+Enter — перенос.
            «/» — команды, «$» — навыки Codex.
          </p>
        </div>
        <div v-for="(m, i) in sess.messages || []" :key="i" class="msg" :class="m.role">
          <div v-if="m.attachments?.length" class="m-atts">
            <a v-for="a in m.attachments" :key="a.file" :href="api.url(a.url)" target="_blank" rel="noopener"
               @click="onAttachmentClick($event, a)">
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
          <div v-if="m.text || (m.role === 'user' && validMessageTime(m.sentAt))" class="mrow">
            <!-- Ответ агента — безопасный GFM; raw HTML экранируется в md.js -->
            <div v-if="m.role === 'assistant'" class="text md"
                 v-html="mdToHtml(m.text, { resolveHref: documentRouteHref })"
                 @click="onMarkdownClick"></div>
            <div v-else class="text"><span v-if="m.text" class="m-copy">{{ m.text }}</span><time
              v-if="m.role === 'user' && validMessageTime(m.sentAt)" class="m-time"
              :datetime="messageTimeIso(m.sentAt)" :title="messageTimeTitle(m.sentAt)"
              :aria-label="messageTimeTitle(m.sentAt)">{{ messageTime(m.sentAt) }}</time></div>
            <button v-if="m.text" class="copy" :class="{ done: copiedIdx === i }"
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

    <!-- Действия задачи: конвейер или отдельный Debug-чат в той же песочнице. -->
    <div v-if="sess.taskId && (sess.messages?.length || sess.purpose !== 'debug')" class="cs-act">
      <div class="col act-row">
        <button v-if="sess.messages?.length" class="act" :class="{ onconv: onConveyor }" :disabled="frozen" @click="toConveyor">
          🏭 {{ onConveyor ? 'Уже на конвейере →' : 'На конвейер' }}
        </button>
        <HelpTip v-if="sess.purpose !== 'debug'" class="debug-tip" :text="DEBUG_HINT"
                 align="left" :trigger-focusable="false">
          <button class="act debug-act" :disabled="frozen || debugOpening" @click="openDebug">
            🐞 {{ debugOpening ? 'Открываю…' : 'Исправлять' }}
          </button>
        </HelpTip>
        <span v-if="launchMsg" class="lm muted">{{ launchMsg }}</span>
        <span v-if="debugMsg" class="lm muted">{{ debugMsg }}</span>
      </div>
    </div>

    <!-- Диалог: агент задал вопрос и ждёт ответа (не разрешение — выбор по существу) -->
    <ChatQuestion v-if="question" :req="question"
                  @answer="chat.answerQuestion(question.pid, $event)" @skip="chat.answerQuestion(question.pid, [])" />

    <!-- Всплывашка разрешения: агент хочет выполнить действие -->
    <ChatPermission v-if="perm" :req="perm"
                    @answer="(allow, remember, comment, choice) => chat.answerPerm(perm.pid, allow, remember, comment, choice)" />

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
        <!-- Меню команд/навыков над композером: секция кокпита + секция исполнителя модели -->
        <div v-if="cmdMenu.length" ref="cmdMenuEl" class="cmd-menu">
          <template v-for="item in cmdMenu" :key="item.key">
            <div v-if="item.header" class="cmd-head">
              <span v-if="item.color" class="dot" :style="{ background: item.color }"></span>{{ item.header }}
            </div>
            <button v-else class="cmd" :class="{ on: item.nav >= 0 && item.nav === cmdIndex, off: item.run === 'none' }"
                    :disabled="item.run === 'none'"
                    @mouseenter="item.nav >= 0 && (cmdIndex = item.nav)" @click="runCommand(item)">
              <span class="c-cmd">{{ item.cmd }}</span>
              <span class="c-desc">{{ item.desc }}</span>
              <span v-if="item.hint" class="c-hint">{{ item.hint }}</span>
            </button>
          </template>
        </div>
        <div v-if="consentPending" class="speech-prompt" data-testid="speech-consent">
          <div>
            <b>Перед первой диктовкой</b>
            <p>Браузер может обработать звук на этом устройстве или передать своему сервису.
              До подтверждения микрофон не включается.</p>
          </div>
          <div class="speech-actions">
            <button type="button" class="speech-primary" data-testid="speech-consent-browser" @click="confirmBrowserConsent">Продолжить в браузере</button>
            <button type="button" data-testid="speech-consent-whisper" @click="useWhisperFromPrompt">Использовать Whisper</button>
            <button type="button" @click="stopSpeech({ cancel: true })">Отмена</button>
          </div>
        </div>
        <div v-else-if="browserInstallPending" class="speech-prompt" data-testid="speech-browser-install">
          <div>
            <b>Нужна локальная языковая модель</b>
            <p>Браузер может скачать её и после этого распознавать речь только на этом устройстве.</p>
          </div>
          <div class="speech-actions">
            <button type="button" class="speech-primary" data-testid="speech-install-browser" @click="installBrowserLanguage">Скачать и продолжить</button>
            <button type="button" data-testid="speech-install-whisper" @click="useWhisperFromPrompt">Использовать Whisper</button>
            <button type="button" @click="stopSpeech({ cancel: true })">Отмена</button>
          </div>
        </div>
        <div v-if="interimSpeech" class="speech-interim" data-testid="speech-interim">Слышу: {{ interimSpeech }}</div>
        <div class="composer">
          <button class="tool" title="Приложить файл (или перетащи/вставь из буфера)" @click="fileInput.click()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <input ref="fileInput" type="file" multiple hidden @change="onPick" />
          <textarea v-model="input" rows="2"
                    :placeholder="recording ? 'Говори… (клик по микрофону — стоп, Esc — отмена)' : drainingSpeech ? 'Завершаю распознавание…' : speechBusy ? 'Подготавливаю диктовку…' : 'Сообщение агенту…'"
                    @keydown="onKey" @paste="onPaste"></textarea>
          <HelpTip align="right" :text="recording ? 'Остановить · Ctrl+D; отменить · Esc' : drainingSpeech ? 'Завершаю распознавание… Esc — отмена' : transcribing ? 'Расшифровываю запись…' : preparingSpeech || browserInstalling ? 'Подготавливаю… Esc — отмена' : 'Надиктовать голосом · Ctrl+D'">
          <button class="tool mic" :class="{ rec: recording, wait: transcribing || preparingSpeech || browserInstalling || drainingSpeech }" :disabled="transcribing || drainingSpeech"
                  :aria-label="recording ? 'Остановить диктовку' : 'Начать диктовку'" :aria-pressed="recording"
                  @click="toggleMic">
            <!-- Расшифровка: крутящийся спиннер -->
            <svg v-if="transcribing || preparingSpeech || browserInstalling || drainingSpeech" class="spin-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
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
          <button class="send" :disabled="frozen || speechBusy || (!input.trim() && !pending.length)"
                  :title="speechBusy ? 'Сначала заверши диктовку'
                    : frozen ? frozenHint
                    : sess.sending ? 'Отправить следом — уйдёт, когда агент закончит текущий ход (Enter)' : 'Отправить (Enter)'"
                  @click="submit">↑</button>
        </div>
        <div v-if="speechNotice" class="speech-note" data-testid="speech-notice">{{ speechNotice }}</div>
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
.sel + .sel, .bar > .sel + :deep(.eff), .bar :deep(.eff) + .ctx-tip {
  border-left: 1px solid var(--line); padding-left: 12px; margin-left: 4px; }

/* Кольцо контекста — маленькое, кликабельное (сжатие; Alt — сброс) */
.ctx-tip { flex: none; align-items: center; }
.ctx-tip :deep(.ht-tr) { align-items: center; }
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
.ctx-ring:not([aria-disabled="true"]):hover { background: var(--surface-2); }
.ctx-ring[aria-disabled="true"] { cursor: default; opacity: .7; }

/* Форматированная подсказка кольца. Содержимое слота телепортируется HelpTip-ом в body,
   но сохраняет scope этого компонента, поэтому локальные стили работают и не текут. */
.ctx-pop { display: flex; flex-direction: column; gap: 7px; width: 260px; max-width: 100%; text-align: left; }
.ctx-pop-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
.ctx-pop-unit { color: var(--ink-mid); font-weight: 400; }
.ctx-pop-pct { color: var(--good); font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }
.ctx-pop-pct.warn { color: var(--warn); }
.ctx-pop-pct.bad { color: var(--bad); }
.ctx-pop-status { display: block; font-weight: 600; }
.ctx-pop-status.warn { color: var(--warn); }
.ctx-pop-status.bad { color: var(--bad); }
.ctx-pop-status.active { color: var(--accent); }
.ctx-pop-detail { display: block; color: var(--ink-mid); }
.ctx-pop-rows { display: flex; flex-direction: column; gap: 4px; padding-top: 7px; border-top: 1px solid var(--line); }
.ctx-pop-row { display: grid; grid-template-columns: minmax(76px, auto) minmax(0, 1fr); gap: 14px; align-items: baseline; }
.ctx-pop-label { color: var(--ink-mid); }
.ctx-pop-value { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ctx-pop-row.unverified .ctx-pop-value { color: var(--warn); }
.ctx-pop-actions { display: flex; flex-direction: column; gap: 3px; padding-top: 7px; border-top: 1px solid var(--line); color: var(--ink-mid); }
.ctx-pop-action { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 8px; }
.ctx-pop-action b { color: var(--ink); font-weight: 600; }

/* Воздух сверху/снизу — margin'ом самого скролл-контейнера (не паддингом:
   нижний паддинг при прокрутке до конца ненадёжен). Правый паддинг меньше
   на ширину скроллбара (11px, styles.css) — края совпадают с композером.
   scrollbar-gutter: stable — место под скролл зарезервировано всегда, сообщения
   не «скачут» по горизонтали, когда полоса появляется/исчезает. */
.cs-body { flex: 1; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; padding: 0 11px 0 22px; margin: 26px 0; }
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
.msg.user .text { display: flow-root; background: color-mix(in srgb, var(--accent) 18%, transparent);
  padding: 9px 13px; border-radius: 14px 14px 4px 14px; }
/* Время запроса — внутри нижнего правого угла пузыря, как в Telegram: часы и минуты
   не спорят с текстом, полная дата доступна по наведению. */
.m-time { float: right; margin: .72em 0 0 9px; color: color-mix(in srgb, var(--ink-mid) 82%, transparent);
  font-size: 10px; font-weight: 400; line-height: 1; white-space: nowrap; user-select: none; }
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
.text.md :deep(img) { display: block; max-width: min(100%, 760px); height: auto; border-radius: 8px; margin: 6px 0 8px;
  cursor: zoom-in; }
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

/* Вложения в сообщениях: картинка открывается в общем viewer-е, файл — как оригинал. */
.m-queued { font-size: 12px; color: var(--ink-mid); margin-bottom: 4px; }
.msg.user .m-queued { text-align: right; }
.m-atts { display: flex; gap: 8px; flex-wrap: wrap; }
.msg.user .m-atts { justify-content: flex-end; }
.m-atts img { max-width: 220px; max-height: 160px; border-radius: 10px; border: 1px solid var(--line); display: block;
  cursor: zoom-in; }
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
.tool.mic { position: relative; isolation: isolate; overflow: visible; }
.tool.mic > svg { position: relative; z-index: 1; }
.tool.mic.rec { color: var(--bad); background: color-mix(in srgb, var(--bad) 16%, transparent); }
.tool.mic.rec::before { content: ''; position: absolute; inset: 3px; z-index: -1; border-radius: 9px;
  pointer-events: none; background: color-mix(in srgb, var(--bad) 48%, transparent);
  animation: mic-pulse 1.35s ease-out infinite; }
.tool.mic.wait { cursor: default; color: var(--accent); opacity: 1; }
@keyframes mic-pulse {
  0% { opacity: .72; transform: scale(.88); }
  75%, 100% { opacity: 0; transform: scale(1.62); }
}
.spin-ico { animation: ico-rotate .9s linear infinite; }
@keyframes ico-rotate { to { transform: rotate(360deg); } }
.in-err { margin-top: 6px; font-size: 12px; color: var(--bad); }
.speech-interim, .speech-note { font-size: 12px; color: var(--ink-mid); }
.speech-interim { margin-bottom: 6px; font-style: italic; }
.speech-note { margin-top: 6px; }
@media (prefers-reduced-motion: reduce) {
  .tool.mic.rec::before { animation: none; opacity: .35; transform: scale(1.18); }
}
.speech-prompt { display: grid; gap: 9px; margin-bottom: 8px; padding: 11px 12px; border: 1px solid var(--line-2);
  border-radius: 11px; background: color-mix(in srgb, var(--accent) 8%, var(--surface)); font-size: 13px; }
.speech-prompt p { margin: 3px 0 0; color: var(--ink-mid); line-height: 1.4; }
.speech-actions { display: flex; flex-wrap: wrap; gap: 7px; }
.speech-actions button { border: 1px solid var(--line-2); border-radius: 8px; padding: 6px 10px;
  background: var(--surface); color: var(--ink); cursor: pointer; font: inherit; }
.speech-actions button:hover { border-color: var(--accent); }
.speech-actions .speech-primary { border-color: transparent; background: var(--accent); color: white; }

/* Меню команд и навыков: якорится над композером */
.cs-input .col { position: relative; }
.cmd-menu { position: absolute; bottom: calc(100% + 8px); left: 0; right: 0; z-index: 6;
  background: var(--surface); border: 1px solid var(--line-2); border-radius: 12px; overflow: hidden;
  max-height: min(440px, 55vh); overflow-y: auto;
  box-shadow: 0 10px 30px rgba(0, 0, 0, .45); }
.cmd { display: flex; align-items: baseline; gap: 12px; width: 100%; padding: 9px 14px; background: transparent;
  border: none; cursor: pointer; text-align: left; }
.cmd + .cmd { border-top: 1px solid var(--line); }
.cmd.on { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.cmd.off { cursor: default; opacity: .55; }
.cmd.off .c-cmd { color: var(--ink-mid); }
.cmd-head { display: flex; align-items: center; gap: 7px; padding: 7px 14px 4px; font-size: 11px;
  text-transform: uppercase; letter-spacing: .06em; color: var(--ink-mid); border-top: 1px solid var(--line); }
.cmd-head:first-child { border-top: none; }
.cmd-head .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.c-cmd { font-family: var(--mono, monospace); font-size: 13px; color: var(--accent); flex: none; }
.c-desc { font-size: 12.5px; color: var(--ink-mid); }
.c-hint { margin-left: auto; font-size: 11px; color: var(--ink-mid); flex: none; }

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
