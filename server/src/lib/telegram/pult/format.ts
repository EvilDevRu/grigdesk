// Тексты карточек телеграм-пульта и кодек callback_data. Только чистые функции.
//
// Всё, что уезжает в Telegram, — plain text без parse_mode: в карточках недоверенное
// содержимое (названия задач B24, вопросы агента, команды инструментов), и разметка
// дала бы ему форматировать сообщение бота. Недоверенные куски схлопываются в одну
// строку, карточка собирает свои переносы сама.
//
// Шапка карточки (номер задачи, этап) не отбрасывается никогда: усечение съедает
// тело. Карточка без номера бесполезна — правило то же, что у ответа
// «задача создана» в inbox-channel.js.
//
// «Что делает агент» карточки НЕ вычисляют: правило одно на всех и живёт в
// shared/pipeline/agentActivity.ts — там же, откуда его берут плашка конвейера и
// чип навигации.
import { activityFromSilence, agentActivityLabel } from '../../../../../shared/pipeline/agentActivity.ts';
import type { AgentSilence } from '../../../../../shared/pipeline/agentActivity.ts';
import { contextFill } from '../../../../../shared/chat/chatContext.ts';

type Payload = Record<string, unknown>;

// Кнопка пульта: текст и её `callback_data` (≤ 64 байта по контракту Bot API).
interface PultButton {
  text: string;
  callback_data: string;
}

// Разобранное нажатие кнопки. Незнакомая или покорёженная строка сюда не
// доходит вовсе: разбор возвращает null, и человек видит «кнопка устарела».
export interface PultCallback {
  kind: string;
  taskId?: string;
  gateKey?: string;
  decision?: string;
  withComment?: boolean;
  pid?: string;
  index?: number;
  action?: string;
  step?: string;
  page?: number;
  nodePage?: number;
  turnId?: string;
}

// Прогон глазами пульта. Форма приходит из общей сводки конвейера; здесь описано
// только то, что карточка показывает человеку.
export interface PultTask extends Payload {
  task?: unknown;
  title?: unknown;
  result?: unknown;
  daemonAlive?: unknown;
  stall?: unknown;
  quiet?: { text?: unknown } | null;
  // Замер молчания приходит из сводки движка и разбирается общим правилом:
  // своей формы у него здесь нет, иначе она разошлась бы с плашкой конвейера.
  silence?: AgentSilence | null;
  graph?: {
    route?: unknown;
    progress?: unknown;
    statuses?: Record<string, unknown>;
    nodes?: Record<string, unknown[]>;
    pos?: unknown;
    timing?: unknown;
    stall?: unknown;
  } | null;
}

export const LIMITS = Object.freeze({
  title: 200, // заголовок/шапка
  card: 1000, // тело обычной карточки
  question: 1500, // вопрос агента: варианты читают целиком
  preview: 300, // превью команды в запросе разрешения
  planPage: 3200, // страница плана + наша шапка обязаны влезть в сообщение 4096
  callback: 64, // потолок Bot API на callback_data, байты
});

/** Потолок текста кнопки: длиннее Telegram показывает обрезком без многоточия. */
export const BUTTON_TEXT_LIMIT = 56;

export const STATUS_PAGE_SIZE = 5;
export const NODE_PAGE_SIZE = 12;
const PLAN_MAX_PAGES = 32;

export const PULT_REPLY_BUTTONS = Object.freeze({
  pipeline: '📋 Конвейер',
  agent: '💬 Агент',
  tasks: '📥 Задачи',
  more: '⚙️ Ещё',
});

/** Постоянная клавиатура лички владельца. Каждый вызов отдаёт свежий объект. */
export function pultReplyKeyboard() {
  return {
    keyboard: [
      [{ text: PULT_REPLY_BUTTONS.pipeline }, { text: PULT_REPLY_BUTTONS.agent }],
      [{ text: PULT_REPLY_BUTTONS.tasks }, { text: PULT_REPLY_BUTTONS.more }],
    ],
    is_persistent: true,
    resize_keyboard: true,
  };
}

export function pultReplyAction(text: unknown): string | null {
  return Object.entries(PULT_REPLY_BUTTONS).find(([, label]) => text === label)?.[0] || null;
}

export const homeCard = () => [
  'Пульт кокпита',
  '',
  '📋 Конвейер — что сейчас идёт и где требуется решение.',
  '💬 Агент — разговор с ассистентом и управление его памятью.',
  '📥 Задачи — просмотр и запуск задач пока недоступны.',
  '⚙️ Ещё — этот экран и служебные команды.',
].join('\n');

export const agentCard = () => [
  '💬 Ассистент',
  '',
  'Напиши сообщение или пришли голосовое — это обычный auto-ход в общем разговоре «Компаньон».',
  'Действия, требующие решения, ассистент спросит отдельной карточкой.',
].join('\n');

export const tasksCard = () => '📥 Просмотр и запуск задач пока недоступны. Открой задачи в кокпите.';

function tokenCount(value: unknown): string {
  const n = Number(value);
  if (!(n > 0) || !Number.isFinite(n)) return '';
  if (n < 1_000) return String(Math.round(n));
  const compact = n >= 1_000_000 ? n / 1_000_000 : n / 1_000;
  const suffix = n >= 1_000_000 ? 'M' : 'k';
  return `${compact.toFixed(compact >= 100 ? 0 : 1).replace(/\.0$/u, '')}${suffix}`;
}

function fileWord(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'файлов';
  if (mod10 === 1) return 'файл';
  if (mod10 >= 2 && mod10 <= 4) return 'файла';
  return 'файлов';
}

/** Независимые части итога: неизвестные значения не превращаются в нули. */
export function turnSummary({ files, tokens, contextTokens, contextWindow, compactWindow = 0 }: {
  files?: unknown;
  tokens?: unknown;
  contextTokens?: unknown;
  contextWindow?: unknown;
  compactWindow?: unknown;
} = {}): string {
  const parts: string[] = [];
  const paths = Array.isArray(files) ? [...new Set(files.filter((value) => typeof value === 'string' && value))] : [];
  if (paths.length) parts.push(`${paths.length} ${fileWord(paths.length)}`);
  const formattedTokens = tokenCount(tokens);
  if (formattedTokens) parts.push(`${formattedTokens} ток.`);
  if (Number(contextTokens) > 0 && Number(contextWindow) > 0) {
    const fill = contextFill({
      tokens: Number(contextTokens),
      window: Number(contextWindow),
      compactWindow: Math.max(0, Number(compactWindow) || 0),
    });
    parts.push(`контекст ${fill.pct}%`);
  }
  return parts.length ? `— ${parts.join(' · ')}` : '';
}

/** Управляющие символы → пробел, пробелы схлопнуты: недоверенный кусок в одну строку. */
export function collapseLine(value: unknown): string {
  return String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Честное усечение по код-пойнтам: длинное заканчивается «…», короткое не трогается. */
export function clipText(value: unknown, limit: number): string {
  const text = String(value ?? '');
  const points = [...text];
  if (points.length <= limit) return text;
  return `${points.slice(0, Math.max(0, limit - 1)).join('').trimEnd()}…`;
}

/** Схлопнуть и уложить в лимит одним движением. */
const line = (value: unknown, limit: number) => clipText(collapseLine(value), limit);

/**
 * Шапка неприкосновенна, тело режется в остаток лимита карточки.
 * Если шапка сама длиннее лимита (не бывает при наших шаблонах), она усечётся честно.
 */
function withHeader(header: unknown, body: string, limit: number = LIMITS.card): string {
  const head = clipText(header, limit);
  if (!body) return head;
  const budget = limit - [...head].length - 1;
  if (budget <= 1) return head;
  return `${head}\n${clipText(body, budget)}`;
}

export function gateCard({ subject, reason }: { subject?: unknown; reason?: unknown }): string {
  return withHeader(`⏳ ${subject} ждёт тебя`, `Ворота: ${collapseLine(reason)}`);
}

/**
 * Кто спрашивает. Голое «чат» бесполезно: чатов у человека несколько, и вопрос вроде
 * «что именно выпиливаем?» без имени разговора неотвечаем — приходится открывать кокпит,
 * то есть ровно то, ради чего пульт и заведён. Название чата даёт `/api/chat/waiting`;
 * нет ни его, ни задачи — честно остаётся «чат».
 */
export function chatSubject(waiting: Payload | null | undefined): string {
  const title = line(waiting?.chatTitle, LIMITS.title);
  const task = waiting?.taskId == null ? '' : collapseLine(waiting.taskId);
  if (title && task) return `#${task} — ${title}`;
  const companion = waiting?.purpose === 'companion'
    || String(waiting?.logicalIdentity || '').startsWith('companion:');
  return title || (task ? `#${task}` : (companion ? 'Компаньон' : 'чат'));
}

/** Строка варианта: номер совпадает с номером кнопки, пояснение агента идёт следом. */
const OPTION_LIMIT = 160;
function optionLines(options: unknown): string[] {
  const list = Array.isArray(options) ? options.slice(0, 8) as Payload[] : [];
  return list.map((option, index) => {
    const label = line(option?.label || `вариант ${index + 1}`, BUTTON_TEXT_LIMIT);
    const about = line(option?.description, OPTION_LIMIT);
    return `${index + 1}) ${label}${about ? `\n   ${about}` : ''}`;
  });
}

/**
 * Карточка вопроса. `header` AskUserQuestion — короткий чип темы («Объём», «Подход»),
 * ради него он в контракте и есть; пояснения вариантов на кнопку не влезают (56 символов)
 * и живут в теле карточки под теми же номерами.
 */
export function questionCard({ subject, question, options = [], header = '', note = '' }: {
  subject?: unknown;
  question?: unknown;
  options?: unknown;
  header?: unknown;
  note?: unknown;
}): string {
  const topic = line(header, 60);
  const choices = optionLines(options);
  // Блоки собираются по одному и склеиваются пустой строкой: общий `filter(Boolean)`
  // по строкам выбросил бы сам разделитель, и варианты слипались бы с вопросом.
  const blocks = [
    [topic ? `Тема: ${topic}` : '', collapseLine(question)].filter(Boolean).join('\n'),
    choices.join('\n'),
    collapseLine(note),
  ].filter(Boolean);
  return withHeader(`❓ ${subject} — вопрос агента`, blocks.join('\n\n'), LIMITS.question);
}

export function permissionCard({ subject, tool, preview }: {
  subject?: unknown;
  tool?: unknown;
  preview?: unknown;
}): string {
  const body = [
    `${collapseLine(tool)}: ${line(preview, LIMITS.preview)}`,
    'Полный текст — в кокпите.',
  ].join('\n');
  return withHeader(`🔐 ${subject} — агент просит разрешение`, body);
}

/** Этап — часть шапки: `🛑 #4188 встал: <причина> (SANDBOX)`. Режется только причина. */
export function stallCard({ subject, stage, reason }: {
  subject?: unknown;
  stage?: unknown;
  reason?: unknown;
}): string {
  const prefix = `🛑 ${subject} встал: `;
  const suffix = stage ? ` (${collapseLine(stage)})` : '';
  const budget = LIMITS.card - [...prefix].length - [...suffix].length;
  return `${prefix}${line(reason, Math.max(1, budget))}${suffix}`;
}

export function silenceCard({ subject, text }: { subject?: unknown; text?: unknown }): string {
  return withHeader(`💤 ${subject}: ${collapseLine(text)}`, '');
}

// ------------------------------------------------------ состояние конвейера

const TASK_STATUS_ICON = Object.freeze({
  run: '🔵',
  wait: '⏳',
  premature: '⏳',
  stall: '🛑',
  fail: '✖',
  skipbad: '✖',
});

const NODE_STATUS_ICON = Object.freeze({
  done: '✓',
  skip: '↷',
  idle: '↷',
  run: '▸',
  wait: '⏳',
  premature: '⏳',
  stall: '🛑',
  fail: '✖',
  skipbad: '✖',
  pending: '○',
});

const NODE_STATUS_TEXT = Object.freeze({
  run: 'выполняется',
  wait: 'ждёт решения',
  premature: 'ждёт решения, хвост ещё работает',
  stall: 'встал',
  fail: 'оборвался',
  skipbad: 'пропущен с ошибкой',
  done: 'готово',
  skip: 'пропущен',
  idle: 'не требовался',
  pending: 'ещё не начат',
});

const finiteCount = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
};

export function taskProgress(task: PultTask | null | undefined) {
  const progress = (task?.graph?.progress || {}) as Payload;
  const done = finiteCount(progress.done);
  const total = finiteCount(progress.total);
  // Floor не показывает ложные 100% у ещё не завершённого длинного маршрута.
  const percent = total > 0 ? Math.max(0, Math.min(100, Math.floor((done / total) * 100))) : null;
  return { done, total, percent, current: typeof progress.current === 'string' ? progress.current : null };
}

function taskCurrent(task: PultTask | null | undefined) {
  const graph = task?.graph;
  const progress = taskProgress(task);
  const nodeId = progress.current;
  const status = nodeId ? (graph?.statuses?.[nodeId] || 'pending') : null;
  const label = nodeId ? collapseLine(graph?.nodes?.[nodeId]?.[1] || nodeId) : '';
  return { ...progress, nodeId, status, label };
}

export function taskStatusIcon(task: PultTask | null | undefined): string {
  const current = taskCurrent(task);
  const icons = TASK_STATUS_ICON as Record<string, string>;

  if (task?.stall || task?.graph?.stall) return '🛑';
  if (task?.quiet) return '💤';
  const statusKey = String(current.status || '');

  if (statusKey && icons[statusKey]) return String(icons[statusKey]);
  if (task?.daemonAlive) return '🔵';
  if (current.total > 0 && current.done >= current.total) return '✅';
  return '○';
}

function taskHeading(task: PultTask | null | undefined): string {
  const id = collapseLine(task?.task);
  const title = line(task?.title, LIMITS.title);
  return `${taskStatusIcon(task)} #${id}${title ? ` — ${title}` : ''}`;
}

function currentLine(task: PultTask | null | undefined): string {
  if (!task?.graph) return 'Сейчас: граф недоступен';
  const current = taskCurrent(task);
  if (!current.nodeId) {
    return current.total > 0 && current.done >= current.total
      ? 'Сейчас: готово'
      : 'Сейчас: активный узел не определён';
  }
  const state = (NODE_STATUS_TEXT as Record<string, string>)[String(current.status)]
    || collapseLine(current.status);
  return `Сейчас: ${current.label || current.nodeId}${state ? ` · ${state}` : ''}`;
}

function progressLine(task: PultTask | null | undefined): string {
  const { done, total, percent } = taskProgress(task);
  return total > 0
    ? `Прогресс маршрута: ${done}/${total} · ${percent}%`
    : 'Прогресс маршрута: нет данных';
}

/**
 * Чем занят агент прямо сейчас: «пишет» против «нет событий 28 мин (playwright)».
 * Это главный ответ на вопрос «висит или работает», ради которого с телефона и
 * открывают кокпит. Формулировку даёт общий agentActivityLabel, здесь только шапка.
 */
export function activityLine(task: PultTask | null | undefined): string {
  const activity = activityFromSilence(task?.silence);
  if (!activity) return '';
  return `Агент: ${agentActivityLabel(activity)}`;
}

/** Длительность словами: «3 ч 40 мин», «12 мин», «45 с». */
export function formatDuration(sec: unknown): string {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  if (total < 60) return `${total} с`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} мин`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} ч ${rest} мин` : `${Math.floor(minutes / 60)} ч`;
}

/**
 * Время работы прогона. `approximate` не прячем: цифра собрана из артефактов
 * запусков, и выдавать её за точную нельзя (см. factory-graph.md).
 */
function timingLine(task: PultTask | null | undefined): string {
  const timing = task?.graph?.timing as Payload | undefined;
  const sec = Number(timing?.workSec);

  if (!Number.isFinite(sec) || sec <= 0) return '';

  return `Работа: ${timing?.approximate ? '≈' : ''}${formatDuration(sec)}`;
}

/**
 * Терминальный RESULT trusted-журнала попытки словами. Иконка отделена от текста:
 * доехавший маршрут и закрытая попытка — разные события, и путать их нельзя.
 */
const RUN_RESULT = Object.freeze({
  completed: { icon: '✅', text: 'маршрут завершён' },
  abandoned: { icon: '⏹', text: 'попытка закрыта' },
  recovered: { icon: '♻', text: 'попытка восстановлена в новую' },
  'human-rewind': { icon: '↩', text: 'возврат человеком' },
  'loop-continue': { icon: '🔁', text: 'цикл продолжен после поднятого потолка кругов' },
});

export function runResult(value: unknown): { icon: string; text: string } | null {
  const key = String(value ?? '').trim();

  if (!key) return null;

  return (RUN_RESULT as Record<string, { icon: string; text: string }>)[key]
    || { icon: '•', text: collapseLine(key) };
}

function taskCountLabel(value: unknown): string {
  const n = finiteCount(value);
  const mod100 = n % 100;
  const mod10 = n % 10;
  const word = mod100 >= 11 && mod100 <= 14
    ? 'задач'
    : mod10 === 1 ? 'задача' : mod10 >= 2 && mod10 <= 4 ? 'задачи' : 'задач';
  return `${n} ${word}`;
}

/** Полная карточка одной задачи: те же поля, что в шапке веб-конвейера. */
export function taskStatusCard(task: PultTask | null | undefined): string {
  const graph = task?.graph;
  const lines = [
    taskHeading(task),
    graph?.route ? `Маршрут: ${line(graph.route, 100)}` : '',
    currentLine(task),
    progressLine(task),
    activityLine(task),
    timingLine(task),
  ];
  const stall = (task?.stall || graph?.stall) as Payload | undefined;

  if (stall?.title) lines.push(`Причина: ${line(stall.title, 400)}`);
  if (task?.quiet?.text) lines.push(`Молчание: ${line(task.quiet.text, 400)}`);
  return clipText(lines.filter(Boolean).join('\n'), 4_000);
}

/**
 * Живая карточка прогона: то же тело, что у `/status <id>`, но сообщение не
 * пересылается заново, а редактируется на месте. Приписка про самообновление
 * нужна, чтобы человек не жал «Обновить» ради уже приехавшей цифры.
 */
export function liveCard(task: PultTask | null | undefined): string {
  const result = runResult(task?.result);
  if (result) return finishedCard(task);
  return `${taskStatusCard(task)}\n\nКарточка обновляется сама.`;
}

/** Итог прогона: отдельное сообщение `done:` после терминального RESULT. */
export function finishedCard(task: PultTask | null | undefined): string {
  const result = runResult(task?.result) || { icon: '•', text: 'прогон закрыт' };
  const id = collapseLine(task?.task);
  const title = line(task?.title, LIMITS.title);
  const { done, total, percent } = taskProgress(task);
  const lines = [
    `${result.icon} #${id}${title ? ` — ${title}` : ''}: ${result.text}`,
    task?.graph?.route ? `Маршрут: ${line(task.graph.route, 100)}` : '',
    total > 0 ? `Прошло узлов: ${done}/${total} · ${percent}%` : '',
    timingLine(task),
  ];
  return clipText(lines.filter(Boolean).join('\n'), 4_000);
}

/**
 * «Значимый» отпечаток задачи: смена узла, статуса, прогресса или исхода правит
 * карточку немедленно, а тикающие минуты молчания — только по остыванию таймера.
 * Иначе каждое `state-change` идущего прогона било бы в Telegram правкой.
 */
export function liveSignature(task: PultTask | null | undefined): string {
  const current = taskCurrent(task);
  return [
    current.nodeId || '', current.status || '', current.done, current.total,
    String(task?.result || ''), task?.stall ? '1' : '0', task?.quiet ? '1' : '0',
    task?.daemonAlive ? '1' : '0',
  ].join('|');
}

/** Компактная страница всех прогонов; подробности открываются кнопкой задачи. */
export function statusListCard({
  tasks = [],
  totalTasks = tasks.length,
  page = 0,
  totalPages = 1,
  chatWaiting = 0,
}: {
  tasks?: PultTask[];
  totalTasks?: number;
  page?: number;
  totalPages?: number;
  chatWaiting?: number;
} = {}): string {
  const lines = [`Конвейер · ${totalTasks ? taskCountLabel(totalTasks) : 'задач нет'} · ${page + 1}/${totalPages}`];
  for (const task of tasks) {
    const current = taskCurrent(task);
    const progress = current.total > 0 ? `${current.done}/${current.total} · ${current.percent}%` : 'нет прогресса';
    const where = current.label || (task?.graph ? 'активный узел не определён' : 'граф недоступен');
    lines.push('', taskHeading(task), `${progress} · ${where}`);
  }
  if (chatWaiting > 0) lines.push('', `💬 В чатах ждут ответа: ${chatWaiting}`);
  return clipText(lines.join('\n'), 4_000);
}

function nodePosition(value: unknown): [number, number] {
  if (Array.isArray(value)) return [Number(value[0]) || 0, Number(value[1]) || 0];

  return [Number(value) || 0, 0];
}

/** Страница узлов в порядке схемы (слева направо, затем сверху вниз). */
export function taskNodesPage(task: PultTask | null | undefined, requestedPage: unknown = 0) {
  const graph = task?.graph;
  if (!graph) {
    return {
      text: `🗺 #${collapseLine(task?.task)}: граф недоступен`,
      page: 0,
      totalPages: 1,
    };
  }
  const positions = (graph.pos || {}) as Payload;
  const ids = Object.keys(positions).sort((a, b) => {
    const [ax, ay] = nodePosition(positions[a]);
    const [bx, by] = nodePosition(positions[b]);
    return ax - bx || ay - by || a.localeCompare(b);
  });
  const totalPages = Math.max(1, Math.ceil(ids.length / NODE_PAGE_SIZE));
  const page = Math.max(0, Math.min(totalPages - 1, finiteCount(requestedPage)));
  const pageIds = ids.slice(page * NODE_PAGE_SIZE, (page + 1) * NODE_PAGE_SIZE);
  const heading = `🗺 Узлы #${collapseLine(task?.task)}${task?.title ? ` — ${line(task.title, LIMITS.title)}` : ''} · ${page + 1}/${totalPages}`;
  const rows = pageIds.map((id) => {
    const status = String(graph.statuses?.[id] || 'pending');
    const icon = (NODE_STATUS_ICON as Record<string, string>)[status] || '○';
    const label = line(graph.nodes?.[id]?.[1] || id, 180);
    return `${icon} ${label}`;
  });
  return { text: [heading, ...rows].join('\n'), page, totalPages };
}

/** Совместимый короткий вход для мест, которым нужен только текст первой страницы. */
export const taskNodesCard = (task: PultTask | null | undefined) => taskNodesPage(task, 0).text;

function cleanPlan(value: unknown): string {
  return String(value ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === '\n' || char === '\t' ? char : ' '))
    .replace(/\n{4,}/gu, '\n\n\n')
    .trim();
}

/** План отдаётся plain text страницами; произвольных файлов эта ручка не открывает. */
export function planPages(value: unknown): string[] {
  const text = cleanPlan(value);

  if (!text) return [];

  const points = [...text];
  const pages: string[] = [];
  let offset = 0;
  while (offset < points.length && pages.length < PLAN_MAX_PAGES) {
    let end = Math.min(points.length, offset + LIMITS.planPage);
    if (end < points.length) {
      const candidate = points.slice(offset, end).join('');
      const newline = candidate.lastIndexOf('\n');
      if (newline >= Math.floor(LIMITS.planPage * 0.6)) {
        end = offset + [...candidate.slice(0, newline)].length;
      }
    }
    pages.push(points.slice(offset, end).join('').trim());
    offset = end;
    while (points[offset] === '\n') offset += 1;
  }
  if (offset < points.length && pages.length) {
    const notice = '… План длиннее лимита Telegram-пульта; полностью он доступен в кокпите.';
    const bodyLimit = LIMITS.planPage - [...notice].length - 2;
    pages[pages.length - 1] = `${clipText(pages[pages.length - 1], bodyLimit)}\n\n${notice}`;
  }
  return pages;
}

export function planPageCard({ taskId, pages, page = 0 }: {
  taskId?: unknown;
  pages?: unknown;
  page?: unknown;
}) {
  const safePages = Array.isArray(pages) && pages.length ? pages : ['План ещё не создан.'];
  const index = Math.max(0, Math.min(safePages.length - 1, finiteCount(page)));
  return {
    text: `📄 План #${collapseLine(taskId)} · ${index + 1}/${safePages.length}\n\n${safePages[index]}`,
    page: index,
    totalPages: safePages.length,
  };
}

// -------------------------------------------------------------- callback_data
//
// ≤ 64 байт по контракту Bot API, поэтому без JSON: короткий префикс формы и
// короткие идентификаторы. Всё длинное (hash маршрута, chatKey) живёт в снимке
// карточки на сервере, кнопка несёт только индекс — см. план, §5.3.

/** Собрать callback_data; переполнение — ошибка, обрезанный callback нажал бы не то. */
export function encodeCb(...parts: unknown[]): string {
  const data = parts.join(':');
  if (Buffer.byteLength(data, 'utf8') > LIMITS.callback) {
    throw new Error(`callback_data длиннее 64 байт: ${data.slice(0, 80)}`);
  }
  return data;
}

export const cbData = Object.freeze({
  gateApprove: (task: unknown, key: unknown) => encodeCb('g', task, key, 'a'),
  gateReject: (task: unknown, key: unknown) => encodeCb('g', task, key, 'r'),
  gateRejectPlain: (task: unknown, key: unknown) => encodeCb('g', task, key, 'rn'),
  question: (pid: unknown, index: unknown) => encodeCb('q', pid, index),
  questionText: (pid: unknown) => encodeCb('q', pid, 'txt'),
  permissionAllow: (pid: unknown) => encodeCb('p', pid, 'a'),
  permissionDeny: (pid: unknown) => encodeCb('p', pid, 'd'),
  permissionDenyComment: (pid: unknown) => encodeCb('p', pid, 'c'),
  resume: (task: unknown) => encodeCb('r', task),
  resumeYes: (task: unknown) => encodeCb('r', task, 'y'),
  sandboxRetry: (task: unknown) => encodeCb('sb', task),
  sandboxRetryYes: (task: unknown) => encodeCb('sb', task, 'y'),
  statusList: (page: unknown = 0) => encodeCb('sl', page),
  statusTask: (task: unknown, page: unknown = 0) => encodeCb('sd', task, page),
  statusNodes: (task: unknown, page: unknown = 0, nodePage: unknown = 0) => (
    encodeCb('sn', task, page, nodePage)
  ),
  // Узлы открываются на экране навигации — отдельной записи в state, а не на живой
  // карточке: она принадлежит вотчеру, экран — навигации человека.
  statusNodesNew: (task: unknown) => encodeCb('sm', task),
  planOpen: (task: unknown) => encodeCb('po', task),
  planPage: (task: unknown, page: unknown) => encodeCb('pp', task, page),
  agentCompact: () => 'ac:c',
  agentReset: () => 'ac:r',
  turnStop: (turnId: unknown) => encodeCb('ts', turnId),
  home: () => 'nh',
  screenClose: () => 'sc',
  dismiss: () => 'x',
});

// ------------------------------------------------------------------ клавиатуры
//
// Общие для вотчера (свежая карточка) и действий (пересборка после правки текста:
// editMessageText без reply_markup СНИМАЕТ кнопки — Bot API так устроен).

export const gateKeyboard = (taskId: unknown, gateKey: unknown) => [
  ...(gateKey === 'GATE_PLAN' ? [[
    { text: '📄 Посмотреть план', callback_data: cbData.planOpen(taskId) },
  ]] : []),
  [
    { text: '✓ Принять', callback_data: cbData.gateApprove(taskId, gateKey) },
    { text: '✗ Отклонить', callback_data: cbData.gateReject(taskId, gateKey) },
  ],
];

/** Второй шаг отклонения: реплай уже ждём, кнопками остаются оба быстрых выхода. */
export const gateRejectKeyboard = (taskId: unknown, gateKey: unknown) => [
  ...(gateKey === 'GATE_PLAN' ? [[
    { text: '📄 Посмотреть план', callback_data: cbData.planOpen(taskId) },
  ]] : []),
  [{ text: '✗ Отклонить без пояснения', callback_data: cbData.gateRejectPlain(taskId, gateKey) }],
  [{ text: '✓ Всё-таки принять', callback_data: cbData.gateApprove(taskId, gateKey) }],
];

/** Ряд закрытия экрана навигации: удаляет само сообщение-экран. */
export const screenCloseRow = () => [{ text: '✕ Закрыть', callback_data: cbData.screenClose() }];
export const homeRow = () => [{ text: '‹ Домой', callback_data: cbData.home() }];

/** Подсказка /help живёт на том же экране навигации и закрывается одной кнопкой. */
export const helpKeyboard = () => [screenCloseRow()];

export const homeKeyboard = () => [screenCloseRow()];

export const agentKeyboard = () => [
  [{ text: '🗜 Сжать', callback_data: cbData.agentCompact() }],
  [{ text: '🧹 Сбросить память', callback_data: cbData.agentReset() }],
  [{ text: '‹ Домой', callback_data: cbData.home() }],
];

export const tasksKeyboard = () => [[{ text: '‹ Домой', callback_data: cbData.home() }]];

export const stopKeyboard = (turnId: unknown) => [[{
  text: '⏹ Стоп',
  callback_data: cbData.turnStop(turnId),
}]];

export function statusListKeyboard(tasks: unknown, page: number, totalPages: number) {
  const rows = (Array.isArray(tasks) ? tasks as PultTask[] : []).map((task) => ([{
    text: `${taskStatusIcon(task)} #${collapseLine(task?.task)} · подробнее`,
    callback_data: cbData.statusTask(task?.task, page),
  }]));
  if (totalPages > 1) {
    const nav: PultButton[] = [];

    if (page > 0) nav.push({ text: '←', callback_data: cbData.statusList(page - 1) });
    nav.push({ text: `${page + 1}/${totalPages}`, callback_data: cbData.statusList(page) });
    if (page + 1 < totalPages) nav.push({ text: '→', callback_data: cbData.statusList(page + 1) });
    rows.push(nav);
  }
  rows.push([{ text: '↻ Обновить', callback_data: cbData.statusList(page) }]);
  rows.push(homeRow());
  rows.push(screenCloseRow());
  return rows;
}

/**
 * Кнопки живой карточки. Всё, что открывается отсюда, уходит на экран навигации —
 * отдельную запись в state: сама живая карточка принадлежит вотчеру, и он держит
 * её актуальной сам.
 */
export const liveKeyboard = (taskId: unknown) => [[
  { text: '🗺 Все узлы', callback_data: cbData.statusNodesNew(taskId) },
  { text: '📄 План', callback_data: cbData.planOpen(taskId) },
]];

export const taskStatusKeyboard = (taskId: unknown, page: unknown = 0) => [
  [
    { text: '🗺 Все узлы', callback_data: cbData.statusNodes(taskId, page) },
    { text: '📄 План', callback_data: cbData.planOpen(taskId) },
  ],
  [
    { text: '← К списку', callback_data: cbData.statusList(page) },
    { text: '↻ Обновить', callback_data: cbData.statusTask(taskId, page) },
  ],
  homeRow(),
  screenCloseRow(),
];

export function taskNodesKeyboard(
  taskId: unknown,
  page: number = 0,
  nodePage: number = 0,
  totalPages: number = 1,
) {
  const rows: PultButton[][] = [];

  if (totalPages > 1) {
    const nav: PultButton[] = [];
    if (nodePage > 0) nav.push({ text: '←', callback_data: cbData.statusNodes(taskId, page, nodePage - 1) });
    nav.push({ text: `${nodePage + 1}/${totalPages}`, callback_data: cbData.statusNodes(taskId, page, nodePage) });
    if (nodePage + 1 < totalPages) nav.push({
      text: '→', callback_data: cbData.statusNodes(taskId, page, nodePage + 1),
    });
    rows.push(nav);
  }
  rows.push([
    { text: '← К задаче', callback_data: cbData.statusTask(taskId, page) },
    { text: '📄 План', callback_data: cbData.planOpen(taskId) },
  ]);
  rows.push(homeRow());
  rows.push(screenCloseRow());
  return rows;
}

export function planPageKeyboard(taskId: unknown, page: number, totalPages: number) {
  const rows: PultButton[][] = [];

  if (totalPages > 1) {
    const nav: PultButton[] = [];
    if (page > 0) nav.push({ text: '←', callback_data: cbData.planPage(taskId, page - 1) });
    nav.push({ text: `${page + 1}/${totalPages}`, callback_data: cbData.planPage(taskId, page) });
    if (page + 1 < totalPages) nav.push({ text: '→', callback_data: cbData.planPage(taskId, page + 1) });
    rows.push(nav);
  }
  rows.push([{ text: '← К задаче', callback_data: cbData.statusTask(taskId, 0) }]);
  rows.push(homeRow());
  rows.push(screenCloseRow());
  return rows;
}

export const questionKeyboard = (pid: unknown, options: Payload[]) => [
  ...options.slice(0, 8).map((option, index) => ([{
    // Номер тот же, что у пояснения в теле карточки: кнопка коротка, объяснение длинно.
    text: clipText(`${index + 1}) ${collapseLine(option?.label || 'вариант')}`, BUTTON_TEXT_LIMIT),
    callback_data: cbData.question(pid, index),
  }])),
  [{ text: '✍ Свой ответ', callback_data: cbData.questionText(pid) }],
];

export const permissionKeyboard = (pid: unknown) => [
  [
    { text: '✓ Разрешить', callback_data: cbData.permissionAllow(pid) },
    { text: '✗ Отклонить', callback_data: cbData.permissionDeny(pid) },
  ],
  [{ text: '✗ Отклонить с пояснением', callback_data: cbData.permissionDenyComment(pid) }],
];

/** Кнопки восстановления (фаза 3): у SANDBOX свой путь — снос остатков + resume. */
export const stallKeyboard = (taskId: unknown, stage: unknown) => (stage === 'SANDBOX'
  ? [[{ text: '♻ Снести остатки и продолжить', callback_data: cbData.sandboxRetry(taskId) }]]
  : [[{ text: '▶ Продолжить прогон', callback_data: cbData.resume(taskId) }]]);

/** Подтверждение вторым тапом: [Да] [Отмена]. */
export const confirmKeyboard = (yesData: string) => [[
  { text: 'Да', callback_data: yesData },
  { text: 'Отмена', callback_data: cbData.dismiss() },
]];

const TASK_RE = /^\d{1,19}$/u;
const INDEX_RE = /^\d{1,4}$/u;
const PID_RE = /^[A-Za-z0-9-]{1,40}$/u;
const GATE_RE = /^[A-Z][A-Z0-9_]{0,48}$/u;
const TURN_RE = /^[A-Za-z0-9_-]{1,32}$/u;

const index = (value: unknown) => Number(value);
const step = (value: unknown) => (value === undefined ? 'ask' : value === 'y' ? 'yes' : 'no');

/**
 * Разбор callback_data в типизированное действие. Незнакомая, чужая или
 * покорёженная строка — null: нажатие ответится «кнопка устарела», а не упадёт.
 */
export function parseCallback(data: unknown): PultCallback | null {
  if (typeof data !== 'string' || !data || Buffer.byteLength(data, 'utf8') > LIMITS.callback) {
    return null;
  }

  const parts = data.split(':');
  const [kind] = parts;

  if (kind === 'x') return parts.length === 1 ? { kind: 'dismiss' } : null;

  if (kind === 'sc') return parts.length === 1 ? { kind: 'screen-close' } : null;

  if (kind === 'nh') return parts.length === 1 ? { kind: 'nav-home' } : null;

  if (kind === 'ac' && parts.length === 2) {
    if (parts[1] === 'c') return { kind: 'agent-compact' };
    if (parts[1] === 'r') return { kind: 'agent-reset' };
    return null;
  }

  if (kind === 'ts' && parts.length === 2 && TURN_RE.test(String(parts[1]))) {
    return { kind: 'turn-stop', turnId: String(parts[1]) };
  }

  if (kind === 'g' && parts.length === 4) {
    const [, taskId = '', gateKey = '', decision] = parts;

    if (!TASK_RE.test(taskId) || !GATE_RE.test(gateKey)) return null;
    if (decision === 'a') return { kind: 'gate', taskId, gateKey, decision: 'approve', withComment: false };
    if (decision === 'r') return { kind: 'gate', taskId, gateKey, decision: 'reject', withComment: true };
    if (decision === 'rn') return { kind: 'gate', taskId, gateKey, decision: 'reject', withComment: false };
    return null;
  }

  if (kind === 'q' && parts.length === 3) {
    const [, pid = '', option = ''] = parts;

    if (!PID_RE.test(pid)) return null;
    if (option === 'txt') return { kind: 'question-free', pid };
    if (INDEX_RE.test(option)) return { kind: 'question', pid, index: index(option) };
    return null;
  }

  if (kind === 'p' && parts.length === 3) {
    const [, pid = '', action] = parts;

    if (!PID_RE.test(pid)) return null;
    if (action === 'a') return { kind: 'permission', pid, action: 'allow' };
    if (action === 'd') return { kind: 'permission', pid, action: 'deny' };
    if (action === 'c') return { kind: 'permission', pid, action: 'deny-comment' };
    return null;
  }

  if ((kind === 'r' || kind === 'sb') && (parts.length === 2 || parts.length === 3)) {
    const [, taskId = '', tail] = parts;

    if (!TASK_RE.test(taskId)) return null;
    if (tail !== undefined && tail !== 'y' && tail !== 'n') return null;
    return { kind: kind === 'r' ? 'resume' : 'sandbox-retry', taskId, step: step(tail) };
  }

  if (kind === 'sl' && parts.length === 2 && INDEX_RE.test(String(parts[1]))) {
    return { kind: 'status-list', page: index(parts[1]) };
  }

  if (kind === 'sd' && parts.length === 3) {
    const [, taskId = '', page = ''] = parts;

    if (!TASK_RE.test(taskId) || !INDEX_RE.test(page)) return null;
    return { kind: 'status-task', taskId, page: index(page) };
  }

  // Трёхчастную форму понимаем ради уже отправленных кнопок до пагинации узлов.
  if (kind === 'sn' && (parts.length === 3 || parts.length === 4)) {
    const [, taskId = '', page = '', nodePage = '0'] = parts;

    if (!TASK_RE.test(taskId) || !INDEX_RE.test(page) || !INDEX_RE.test(nodePage)) return null;
    return { kind: 'status-nodes', taskId, page: index(page), nodePage: index(nodePage) };
  }

  if (kind === 'sm' && parts.length === 2 && TASK_RE.test(String(parts[1]))) {
    return { kind: 'status-nodes-new', taskId: String(parts[1]) };
  }

  if (kind === 'po' && parts.length === 2 && TASK_RE.test(String(parts[1]))) {
    return { kind: 'plan-open', taskId: String(parts[1]) };
  }

  if (kind === 'pp' && parts.length === 3) {
    const [, taskId = '', page = ''] = parts;

    if (!TASK_RE.test(taskId) || !INDEX_RE.test(page)) return null;
    return { kind: 'plan-page', taskId, page: index(page) };
  }

  return null;
}
