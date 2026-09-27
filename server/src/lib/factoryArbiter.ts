// Арбитр типизированной остановки конвейера.
//
// Движок останавливает маршрут fail-closed, когда автоматический возврат перестал давать
// прогресс: набор замечаний повторился, разошёлся осцилляцией или расширился новыми id.
// Остановка правильная — но зовёт она человека, а человек в этот момент делает работу
// курьера. Замер по журналам всех попыток: 28 типизированных остановок, медиана ожидания
// 15 минут, сумма 59.7 часа, максимум 13.9 часа простоя стенда и слота; пять ночных
// стоянок дают 53 часа из этих 60.
//
// Разобранный живой случай показал и вторую цену. Проверяющий вынес блокирующим вопрос,
// который ему не дали проверить правами; человек ответил на него за три минуты, опираясь
// на комментарий в коде, — и ошибся в посылке, потому что смотреть в репозиторий было
// некогда. Решение, записанное в журнал как обдуманное человеком, оказалось хуже того,
// что мог получить агент с доступом к тому же коду.
//
// Поэтому арбитр — не «ещё одна модель в цепочке», а замена ИМЕННО курьерской части: он
// собирает ровно то, что человек собирает руками (оба вердикта дуги, артефакты узлов,
// рабочее дерево), и предъявляет решение карточкой. Границы описаны у каждой проверки
// ниже; главная в том, что границу самой задачи арбитр менять не вправе.
//
// ЧТО АРБИТР МОЖЕТ, названо по замеру, а не по замыслу. Он идёт в режиме `plan`, и этот
// режим (проверено живым `claude -p`: агент отвечает «режим планирования не разрешает
// выполнение команд») даёт чтение, поиск и обход файлов, но НЕ запуск команд. Для
// разобранного случая этого хватает: вопрос «есть ли между модулями общий импорт»
// решается поиском по коду, и именно поиском он и был решён — в отличие от человека,
// который ответил по комментарию рядом. Но опыт запуском арбитру недоступен, и обещать
// его нельзя. Чтобы дать — нужен канал прав в контракте `executor.run` (сейчас туда
// уезжает только `fastMode`); это отдельная работа, а не забытая строка.
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ModelRegistry } from './chat/modelRef.ts';
import type { ExecutorRunInput, ExecutorRunResult } from './executors/index.ts';

// Кто принял решение — уезжает в `factory goto --actor`. Движок пишет это поле в событие
// журнала, и машинное решение перестаёт быть неотличимым от человеческого.
export const ARBITER_ACTOR = 'cockpit-arbiter';

// Потолок на попытку. Возврат арбитра начинает новую серию дуги (как и человеческий),
// то есть обнуляет замкнутый набор замечаний — без своего потолка арбитр мог бы съесть
// весь общий бюджет возвратов попытки, и человек увидел бы уже исчерпанную задачу.
export const ARBITER_MAX_PER_ATTEMPT = 2;

// Остановки, которые арбитр вправе разбирать.
//
// `no-progress` — топтание на дуге возвратов: два узла спорят, и спор проверяется по коду.
//
// `human` добавлен 28.08.2026 и НЕ безусловно. Такую остановку объявляет сам маршрут по
// классу владельца провала, который назвал агент, и классы эти разные: `environment` —
// упал стенд, `build` — не собралось, `human` — агент отдал развилку. Первые два ожиданием
// и чтением кода не лечатся, поэтому разбирается только третий (`ARBITRABLE_HUMAN_OWNERS`).
//
// Почему вообще разбирается: замер по опубликованным каталогам — 2785 переходов ведут
// в `human` против 184 в `done`, то есть это САМАЯ частая объявленная остановка. И часть
// её случаев — не вопрос к человеку по существу, а вопрос, который узел не смог проверить
// сам: `state-only` политика не дала ему запустить проверку, и он честно вынес её
// человеку (разобранный случай — в `docs/cockpit/gotchas.md`). У арбитра доступ к коду
// есть, поэтому такой вопрос закрывается чтением, а не будильником в чужой голове.
//
// `rewind-limit` — то же топтание, что `no-progress`, только счётчик кончился у движка
// (схема просила ещё один автоматический возврат, а этот переход уже дважды не помог), а
// не у набора замечаний. Разбирается тем же чтением кода; замер: 4 остановки, 8.7 часа
// простоя, медиана ожидания 20 минут.
const ARBITRABLE_STOPS = new Set<string | null | undefined>(['no-progress', 'human', 'rewind-limit']);

// Классы владельца, при которых остановку `human` есть смысл разбирать.
//
// `human` — агент отдал развилку. `plan` — принятый план не выдержал проверки (замер
// 8507: «опция убирает rAF-очередь, но perf-контракт не выполняет»); ответ на такое —
// новая гипотеза, а она собирается из отчёта узла и кода, то есть чтением.
//
// Пустой класс (`null`) узел не назвал вовсе — 9 остановок и 5 часов простоя, в том
// числе на `ship`, `skeptic` и `review`. Отказывать по формальному признаку «класс не
// назван» здесь дороже, чем попробовать: содержимое вердикта у арбитра перед глазами, и
// если разбирать нечего, он скажет это сам.
//
// НЕ входят `environment`, `build` и `tests`: упавший стенд и несобравшаяся сборка
// чтением кода не лечатся, а запускать команды арбитр пока не умеет — он ходит в режиме
// `plan`. До появления канала прав такие остановки чинит пересборка стенда и человек.
// `null` в наборе не опечатка: класс не назван — остановка всё равно разбирается,
// решение «есть ли что разбирать» принимает сам арбитр, видя вердикт целиком.
const ARBITRABLE_HUMAN_OWNERS = new Set<string | null | undefined>(['human', 'plan', null]);

const EVENT_RE = /^event\.(\d{20})\.[0-9a-f]{64}\.json$/;
const CARD_FIELDS = ['what', 'why', 'proof', 'risk'];
const FIELD_LIMIT = 1200;
const INSTRUCTION_LIMIT = 8000;

// Находка вердикта в том виде, в каком её записал агент: текст недоверенный.
export interface LedgerFinding {
  id?: string;
  severity?: string;
  anchor?: string;
  summary?: string;
}

// Один круг спора: чей заход, кому адресовано и что найдено.
export interface ArbiterRound {
  node: string | null;
  owner: string | null;
  findings: LedgerFinding[];
  reviewed: string[];
}

// Событие журнала попытки в том объёме, который читает арбитр.
interface LedgerEvent {
  kind?: string;
  actor?: string;
  node?: string;
  reason?: string;
  action?: { stop?: string; rewind?: string };
  verdict?: { owner?: string; findings?: unknown; reviewed?: unknown };
  loop?: unknown;
}

// Журнал попытки прочитан: дуга возвратов, её вердикты и потраченные арбитражи.
export interface ArbitrationContext {
  ok: true;
  stop: string | null;
  node: string | null;
  target: string | null;
  reason: string | null;
  series: ArbiterRound[];
  arbitrations: number;
  // Попытка режима «цикл»: этапы ведёт ведущая модель, второй управляющий поверх неё
  // запрещён. Признак берётся из журнала (снимки и события цикла).
  loop: boolean;
}

// Журнал попытки не прочитан — разбирать нечего.
export interface ArbitrationFailure {
  ok: false;
  error: string;
}

export type ArbitrationRead = ArbitrationContext | ArbitrationFailure;

// Ответ гейта: берётся ли арбитр и, если нет, что сказать человеку.
export interface ArbitrationGateResult {
  ok: boolean;
  error?: string;
  message?: string;
}

// Курсор задачи в том минимуме, который решает допуск арбитра.
export interface ArbitrationCursor {
  state?: string;
  stop?: string | null;
}

/**
 * Чтение журнала попытки под конкретную дугу.
 *
 * Возвращает вердикты серии автоматических возвратов и число уже потраченных арбитражей.
 * Серия считается ровно так же, как её считает движок: решение человека (или прошлый
 * арбитраж) начинает новую. Иначе арбитр разбирал бы вердикты, уже отменённые решением.
 */
export async function readArbitrationContext({ controlDir, task, attempt }: {
  controlDir: string;
  task: string | number;
  attempt: string;
}): Promise<ArbitrationRead> {
  const dir = path.join(
    controlDir, 'protocol-v2', 'tasks', `t${task}`, 'attempts', attempt, 'stage-results',
  );
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { ok: false, error: 'ledger_unreadable' };
  }
  const events = names
    .map((name) => ({ match: EVENT_RE.exec(name), name }))
    .filter((entry): entry is { match: RegExpExecArray; name: string } => Boolean(entry.match))
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
    .map((entry) => entry.name);

  let arbitrations = 0;
  let loop = false;
  let series: ArbiterRound[] = [];
  let stop: string | null = null;
  let node: string | null = null;
  let target: string | null = null;
  let reason: string | null = null;

  for (const name of events) {
    let event: LedgerEvent;
    try {
      event = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
    } catch {
      return { ok: false, error: 'ledger_unreadable' };
    }
    if (event.loop || event.kind === 'loop-ceiling' || event.kind === 'loop-continue') {
      loop = true;
    }
    if (event.kind === 'human-rewind') {
      if (event.actor === ARBITER_ACTOR) arbitrations += 1;
      series = [];
      stop = null;
      continue;
    }
    if (event.kind === 'no-progress' || event.kind === 'rewind-limit') {
      stop = event.kind;
      node = event.node || null;
      target = event.action?.rewind || null;
      reason = event.reason || null;
      // Вердикт, НА КОТОРОМ маршрут встал, — самый важный для разбора: именно его
      // замечания остались открытыми. Событие остановки несёт его так же, как обычный
      // коммит, и без этой ветки арбитр разбирал бы спор без последней реплики.
      if (event.verdict) {
        series.push({
          node: event.node ?? null,
          owner: event.verdict.owner ?? null,
          findings: Array.isArray(event.verdict.findings) ? event.verdict.findings : [],
          reviewed: Array.isArray(event.verdict.reviewed) ? event.verdict.reviewed : [],
        });
      }
      continue;
    }
    if (event.kind === 'commit') {
      // Остановку, объявленную САМИМ маршрутом (`on`/`onFailure` узла), движок пишет
      // обычным коммитом с `action.stop` — в отличие от своих `no-progress`/`rewind-limit`,
      // у которых отдельный `kind`. Пока эта ветка только обнуляла `stop`, арбитр не видел
      // ни узла такой остановки, ни его вердикта, хотя оба лежали в том же событии.
      const declared = typeof event.action?.stop === 'string' ? event.action.stop : null;
      stop = declared;
      if (declared) {
        node = event.node || null;
        // Точки возврата маршрут здесь не предлагает, и придумывать её арбитру нельзя:
        // узел не проиграл спор соседу, а сам позвал человека. Переигрывать надо его же —
        // с тем фактом, которого ему не хватило. Права прыгать через узлы арбитр не получает.
        target = event.node || null;
        reason = event.reason || null;
      }
      if (event.verdict && (event.action?.rewind || declared)) {
        series.push({
          node: event.node ?? null,
          owner: event.verdict.owner ?? null,
          findings: Array.isArray(event.verdict.findings) ? event.verdict.findings : [],
          reviewed: Array.isArray(event.verdict.reviewed) ? event.verdict.reviewed : [],
        });
      }
    }
  }

  return {
    ok: true, stop, node, target, reason, series, arbitrations, loop,
  };
}

/**
 * Берётся ли арбитр за такую остановку.
 *
 * Правило одно на всех: гейт самого арбитра, кнопка в карточке задачи и автоматический
 * вотчер. Вторая копия разошлась бы с первой, и человек получал бы кнопку, за которой
 * стоит отказ, — ровно та беда, из-за которой `waitingReason` живёт единственной функцией.
 */
export function stopIsArbitrable(
  stop: string | null | undefined,
  owner: string | null | undefined,
): boolean {
  if (!ARBITRABLE_STOPS.has(stop)) return false;
  if (stop === 'human') return ARBITRABLE_HUMAN_OWNERS.has(owner);
  return true;
}

/**
 * Тот же признак для карточки задачи и вотчера — по вердикту узла остановки целиком.
 *
 * Остановка `human` без вердикта — не «класс не назван», а исчерпанный бюджет повторов:
 * ни один заход результата не зафиксировал, и разбирать нечего. Гейт выше ответил бы на
 * неё `arc_unknown` (в журнале нет дуги с вердиктами), а кнопка, за которой стоит отказ,
 * хуже отсутствующей (t7989: «отдать арбитру» рядом с «раннер не получил результат»).
 */
export function stallIsArbitrable(
  stop: string | null | undefined,
  verdict: { owner: string | null } | null | undefined,
  { loop = false }: { loop?: boolean } = {},
): boolean {
  // Режим «цикл»: этапы ведёт ведущая модель, её остановку решает человек. Арбитр
  // стал бы вторым управляющим циклом поверх ведущего — ни кнопки, ни вотчера.
  if (loop) return false;
  if (stop === 'human' && !verdict) return false;
  return stopIsArbitrable(stop, verdict?.owner || null);
}

/** Разбирает ли арбитр эту остановку. Ответ словами: он уезжает человеку. */
export function arbitrationGate(
  context: ArbitrationRead | null | undefined,
  cursor: ArbitrationCursor | null | undefined,
  { loop = false }: { loop?: boolean } = {},
): ArbitrationGateResult {
  if (!context?.ok) {
    return { ok: false, error: 'ledger_unreadable', message: 'журнал попытки не прочитан' };
  }
  if (loop || context.loop) {
    return {
      ok: false,
      error: 'not_arbitrable',
      message: 'цикл ведёт этапы сам: его остановку решает человек, арбитр не вмешивается',
    };
  }
  if (cursor?.state !== 'stopped' || !ARBITRABLE_STOPS.has(cursor?.stop)) {
    return {
      ok: false,
      error: 'not_arbitrable',
      message: 'арбитр разбирает только остановку по отсутствию прогресса и вызов человека узлом',
    };
  }
  // Класс владельца объявил сам агент, и он решает, есть ли что разбирать: спор о коде
  // проверяется чтением, а упавший стенд — нет.
  if (cursor.stop === 'human') {
    const owner = context.series[context.series.length - 1]?.owner || null;
    if (!stopIsArbitrable(cursor.stop, owner)) {
      return {
        ok: false,
        error: 'not_arbitrable',
        message: owner
          ? `узел отдал остановку по классу «${owner}» — это отказ среды или сборки, чтением кода он не снимается`
          : 'узел не назвал класс провала — разбирать нечего',
      };
    }
  }
  if (!context.node || !context.target || !context.series.length) {
    return {
      ok: false,
      error: 'arc_unknown',
      message: 'в журнале попытки не нашлась дуга возвратов, на которой встал маршрут',
    };
  }
  if (context.arbitrations >= ARBITER_MAX_PER_ATTEMPT) {
    return {
      ok: false,
      error: 'arbiter_budget_spent',
      message: `арбитр уже разбирал эту попытку ${context.arbitrations} раза — дальше решает человек`,
    };
  }
  return { ok: true };
}

function findingLine(finding: LedgerFinding): string {
  const severity = finding.severity === 'deferred' ? 'отложенное' : 'блокирующее';
  const anchor = finding.anchor ? ` · якорь ${finding.anchor}` : '';
  return `  - [${finding.id}] (${severity}${anchor}) ${finding.summary}`;
}

/**
 * Промпт арбитра.
 *
 * Артефакты НЕ вклеиваются: у арбитра есть инструменты и доверенные каталоги, поэтому он
 * читает их сам и ровно столько, сколько нужно. Вклеивание упёрлось бы в потолок промпта
 * ровно там, где решение зависит от подробностей.
 */
export function buildArbiterPrompt({
  task, node, target, reason, series, stateDir, stop = 'no-progress', budgetMin = 20,
}: {
  task: string | number;
  node: string | null;
  target: string | null;
  reason: string | null;
  series: ArbiterRound[];
  stateDir: string;
  stop?: string | null;
  budgetMin?: number;
}): string {
  const rounds = series.map((entry, index) => {
    const lines = entry.findings.map(findingLine).join('\n');
    const reviewed = entry.reviewed.length
      ? `  просмотрено: ${entry.reviewed.join(', ')}`
      : '  охват прохода не объявлен';
    return `Круг ${index + 1} (узел ${entry.node}, адресовано ${entry.owner}):\n${lines}\n${reviewed}`;
  }).join('\n\n');

  // Вводная у двух остановок разная по существу, а не по форме. В `no-progress` спорят
  // ДВА узла, и арбитр решает, чья правда; в `human` узел никому не проиграл — он сам
  // позвал человека, и вопрос ровно один: действительно ли это выбор человека, или узлу
  // просто не дали проверить факт, который читается по коду.
  const preamble = stop === 'human'
    ? `Что произошло: узел «${node}» закрыл заход и САМ вернул решение человеку — так
объявлено в маршруте для класса провала, который назвал сам агент. Маршрут стоит; узел
переигран не будет, пока решение не принято. Причина, названная движком:

${reason || '(движок причину не назвал)'}

Что узел вынес человеку:

${rounds}

ВАЖНО: узел уже пытался разобраться и не смог. Одна из частых причин — политика узла
(state-only) не дала ему ЗАПУСТИТЬ проверку, и он честно вынес человеку вопрос, который
читается по коду за минуту. Сначала проверь именно это.`
    : `Что произошло: узел «${node}» несколько раз подряд возвращал работу узлу «${target}», и
движок счёл, что возвраты перестали давать прогресс. Причина остановки дословно:

${reason || '(движок причину не назвал)'}

Вердикты дуги по кругам:

${rounds}`;

  return `Ты арбитр конвейера задачи ${task}. Маршрут ОСТАНОВЛЕН и ждёт решения.

${preamble}

Артефакты узлов лежат в ${stateDir} — файлы вида t${task}.<узел>.md. Рабочее дерево задачи
открыто тебе на чтение.

Твои возможности: читать файлы, искать по коду, обходить дерево И ЗАПУСКАТЬ КОМАНДЫ
ЧТЕНИЯ — git log, git show, grep, запуск проверяющих скриптов. Нативные правки файлов и
запись перенаправлением в файл тебе закрыты режимом.

Но рабочее дерево задачи менять НЕЛЬЗЯ ВООБЩЕ: оно принадлежит остановленной попытке, и
всё, что в нём окажется, уедет в её коммит как работа узла. Команду, которая пишет в
дерево, не запускай, даже если технически можешь.

У тебя ${budgetMin} минут. Это не совет: по их истечении ход обрывается и разбор пропадает
целиком — потраченное время не превращается ни во что. Поэтому читай ровно то, что решает
спорное утверждение, и начинай формулировать заранее. Если к середине бюджета ответа нет,
верни verdict = "human" с тем, что успел выяснить: половина разбора человеку полезна,
оборванный ход — нет.

ТВОЯ ЗАДАЧА — не чинить работу, а СНЯТЬ ТУПИК. Спорное утверждение проверь ПО КОДУ, а не
рассуждением о нём. Именно этого не хватило: проверяющий узел вынес блокирующим вопрос,
который ему не дали проверить правами, а человек потом ответил на него по комментарию в
коде — и ошибся, хотя поиск по тому же каталогу давал ответ за десять секунд.

Реши одно из трёх:

1. Тупик снимается инженерным решением — какой вариант верен, что считать доказанным,
   какое из замечаний не подтверждается фактами. Тогда напиши указание узлу «${target}»${
  stop === 'human' ? ' (это тот же узел: он переиграет заход, получив недостающий факт)' : ''
}.
2. Решение меняет ГРАНИЦУ ЗАДАЧИ, но у развилки есть ОЧЕВИДНО МИНИМАЛЬНЫЙ вариант —
   тот, что не расширяет объём работы, не снимает ни одной проверки и не добавляет в
   продукт нового элемента. Тогда выбери его сам: verdict = "resolve", scope_change =
   true, и в card.what скажи ЧЕЛОВЕЧЕСКИМИ словами, что именно ты решил за человека.
   Конвейер поедет дальше, а человек проверит это решение на ближайших воротах — он и
   так принимает там план и результат. Примеры минимального: не добавлять новый элемент
   интерфейса, которого в продукте нет; ограничиться уже существующей областью; оставить
   поведение как есть, если требование не сформулировано однозначно.

3. Решение меняет границу задачи, и минимального варианта НЕТ — надо снять критерий
   приёмки, отказаться от проверки, выбрать между несравнимыми ценностями или расширить
   объём. Тогда verdict = "human" и назови, что именно ему решать. Это дорого: конвейер
   встанет до человека, поэтому выбирай этот исход только когда любой твой выбор
   пришлось бы переделывать.

Ответь ОДНИМ блоком JSON и ничем больше:

\`\`\`json
{
  "verdict": "resolve",
  "scope_change": false,
  "card": {
    "what": "что решил — одной фразой, без путей и хешей",
    "why": "почему — обычными словами",
    "proof": "что запускал или читал и что из этого вышло",
    "risk": "как человек увидит, что решение неверное"
  },
  "instruction": "что делать узлу ${target}: подробно, здесь пути и имена уместны"
}
\`\`\`

При verdict = "human" поля card заполняются так же (что выяснил, почему это выбор
человека, чем проверял, чем грозит ошибка), а instruction оставь пустой строкой.`;
}

function cleanField(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// Разобранное решение арбитра: карточка человеку и указание узлу.
export interface ArbiterDecision {
  ok: true;
  verdict: 'human' | 'resolve' | 'deferred';
  card: Record<string, string>;
  instruction: string;
  scopeChange: boolean;
}

// Решения нет: ответ модели не разобран или неполон.
export interface ArbiterDecisionFailure {
  ok: false;
  error: string;
  message: string;
}

export type ArbiterDecisionResult = ArbiterDecision | ArbiterDecisionFailure;

/**
 * Разбор ответа арбитра.
 *
 * Строгий: пустая карточка, отсутствующий вердикт или пропавшее указание означают, что
 * решения нет. Молча превратить такой ответ в возврат нельзя — узел получил бы пустое
 * задание, а журнал утверждал бы, что решение принято и обосновано.
 */
export function parseArbiterDecision(text: unknown): ArbiterDecisionResult {
  const source = String(text || '');
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? source.slice(source.indexOf('{'));
  let parsed: {
    card?: Record<string, unknown>;
    verdict?: unknown;
    instruction?: unknown;
    scope_change?: unknown;
  };
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, error: 'bad_model_reply', message: 'арбитр ответил не разбираемым JSON' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'bad_model_reply', message: 'арбитр ответил не объектом' };
  }

  const card: Record<string, string> = {};
  for (const field of CARD_FIELDS) {
    card[field] = cleanField(parsed.card?.[field], FIELD_LIMIT);
    if (!card[field]) {
      return {
        ok: false,
        error: 'bad_model_reply',
        message: `в карточке решения пусто поле «${field}»`,
      };
    }
  }

  // Явный отказ арбитра: минимального варианта нет, любой выбор пришлось бы переделывать.
  // Только этот исход останавливает конвейер — и решает так сам арбитр, видевший контекст.
  if (parsed.verdict === 'human') {
    return {
      ok: true,
      verdict: 'human',
      card,
      instruction: '',
      scopeChange: parsed.scope_change === true,
    };
  }
  if (parsed.verdict !== 'resolve') {
    return { ok: false, error: 'bad_model_reply', message: 'вердикт арбитра не назван' };
  }
  const instruction = cleanField(parsed.instruction, INSTRUCTION_LIMIT);
  if (!instruction) {
    return {
      ok: false,
      error: 'bad_model_reply',
      message: 'решение без указания узлу: доставлять нечего',
    };
  }

  // Решение, задевающее границу задачи, но с названным минимальным вариантом. Раньше
  // `scope_change: true` останавливал конвейер наравне с отказом — то есть у арбитра было
  // право только сказать «решай сам», и человека будили посреди работы вопросом, ответ на
  // который он всё равно проверит на воротах. Теперь такое решение ЕДЕТ, но помечено:
  // ворота показывают его отдельной сводкой, и там же его можно отменить возвратом.
  return {
    ok: true,
    verdict: parsed.scope_change === true ? 'deferred' : 'resolve',
    card,
    instruction,
    scopeChange: parsed.scope_change === true,
  };
}

/**
 * Текст, который уезжает в `goto --reason` и оттуда в промпт узла и в журнал попытки.
 *
 * Порядок карточки тот же, что у решения агента в отчёте приёмки: первые строки читаются
 * без открытия репозитория. Подпись обязательна — человек на воротах должен видеть, что
 * это решение конвейера, а не его собственное.
 */
export function formatArbiterReason(decision: ArbiterDecision): string {
  return [
    'РЕШЕНИЕ АРБИТРА КОНВЕЙЕРА (принято автоматически, человек его не писал).',
    '',
    `Что решил: ${decision.card.what}`,
    `Почему: ${decision.card.why}`,
    `Чем доказал: ${decision.card.proof}`,
    `Чем грозит ошибка: ${decision.card.risk}`,
    '',
    'Что делать:',
    decision.instruction,
  ].join('\n');
}

// --- настройка арбитра ---

const PROVIDER_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const MODEL_MAX = 200;

// Ссылка на модель арбитра: провайдер и точное имя модели.
export interface ArbiterModelRef {
  provider: string;
  model: string;
}

// Настройка арбитра целиком: чем разбирать, с каким усилием и сам ли.
export interface ArbiterSettings {
  modelRef: ArbiterModelRef | null;
  effort: string;
  auto: boolean;
}

// Вход одного читающего хода. Конфигурация и журнал принадлежат адаптеру,
// арбитр передаёт их как есть и не добавляет инструментов или сессии.
export interface ArbiterRunInput extends ExecutorRunInput {
  signal: AbortSignal;
  message: string;
  cwd: string;
  extraDirs: string[];
  model: string;
  effort?: string;
  permissionMode: 'plan';
  providerSettings: Record<string, unknown>;
  log: unknown;
}

// Ответ остаётся недоверенным до parseArbiterDecision; прочая телеметрия хода
// здесь не нужна и принадлежит исполнителю.
export type ArbiterRunOutput = Pick<ExecutorRunResult, 'reply'>;

// Что арбитру нужно от исполнителя: запуск и объявленный каталог режимов.
export interface ArbiterExecutor {
  run: (input: ArbiterRunInput) => Promise<ArbiterRunOutput>;
  modes?: (config: unknown) => unknown;
}

// Ответ резолвера ссылки. Форма разная по исходу, поэтому это объединение, а не
// объект с необязательными полями: модель есть ровно тогда, когда ok.
export type ResolvedArbiterModel =
  | { ok: true; modelRef: ArbiterModelRef; model: unknown }
  | { ok: false; error: string };

// Соседи арбитра: каталог моделей и разрешение ссылки имеют одну проверяемую форму.
// Конфигурацию читает переданная функция каталога, а не сам арбитр.
export interface ArbiterTargetDeps {
  modelRef?: { provider?: unknown; model?: unknown; effort?: unknown } | null;
  config?: unknown;
  modelsRegistry: (config: unknown) => Promise<ModelRegistry>;
  executorResolver: (provider: string) => Promise<ArbiterExecutor | null>;
  resolveRef: (ref: ArbiterModelRef, registry: ModelRegistry) => ResolvedArbiterModel;
  log?: unknown;
}

// Куда уедет разбор: модель, её исполнитель и режим только чтения.
export type ArbiterTarget =
  | {
    ok: true;
    ref: ArbiterModelRef;
    model: unknown;
    effort: string;
    executor: ArbiterExecutor;
    log: unknown;
  }
  | { ok: false; error: string; message: string };

export const ARBITER_DEFAULTS = Object.freeze({
  // null = «модель по умолчанию из реестра исполнителей».
  modelRef: null,
  effort: '',
  // Автоматический разбор ВЫКЛЮЧЕН по умолчанию, и это не осторожность ради осторожности.
  // Арбитр — единственный механизм здесь, который действует сам: он двигает курсор чужой
  // задачи по решению модели. Включённый по умолчанию, он начал бы это делать на машинах,
  // где его никто не просил и где его решения ещё никто не читал. Кнопка доступна всегда.
  auto: false,
});

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function cleanString(value: unknown, max: number): string {
  if (typeof value !== 'string' || hasControlChars(value)) return '';
  const trimmed = value.trim();
  return trimmed.length && trimmed.length <= max ? trimmed : '';
}

/** Мягкая нормализация: испорченный prefs.json не должен ронять старт кокпита. */
export function normalizeArbiterSettings(value: unknown): ArbiterSettings {
  const raw = (value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}) as { modelRef?: unknown; effort?: unknown; auto?: unknown };
  const ref = (raw.modelRef && typeof raw.modelRef === 'object' && !Array.isArray(raw.modelRef)
    ? raw.modelRef
    : {}) as { provider?: unknown; model?: unknown };
  const provider = cleanString(ref.provider, 64).toLowerCase();
  const model = cleanString(ref.model, MODEL_MAX);
  const modelRef = PROVIDER_RE.test(provider) && model ? { provider, model } : null;
  return {
    modelRef,
    effort: cleanString(raw.effort, 32).toLowerCase(),
    auto: raw.auto === true,
  };
}

/**
 * Модель арбитра вместе с ТРАНСПОРТОМ, который ему нужен.
 *
 * Здесь, в отличие от разбора недоверенного ввода, нужен обычный `executor.run` с
 * инструментами: арбитр обязан проверить спорное утверждение в коде, а не рассудить о нём.
 * Ровно этого не хватило в живом случае — и проверяющему узлу (запретили права), и
 * человеку (не пошёл смотреть). Читающий режим `plan` обязателен и проверяется по живому
 * каталогу исполнителя: молча уйти в режим с правом записи арбитр не должен.
 */
export async function resolveArbiterTarget({
  modelRef, config = {}, modelsRegistry, executorResolver, resolveRef, log = console,
}: ArbiterTargetDeps): Promise<ArbiterTarget> {
  const ref = normalizeArbiterSettings({ modelRef }).modelRef;
  if (!ref) return { ok: false, error: 'no_model', message: 'модель арбитра не выбрана' };
  let registry;
  try {
    registry = await modelsRegistry(config);
  } catch {
    return { ok: false, error: 'registry_failed', message: 'реестр моделей не прочитан' };
  }
  const resolved = resolveRef(ref, registry);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error, message: 'модель арбитра не найдена в реестре' };
  }
  let executor: ArbiterExecutor | null;
  try {
    executor = await executorResolver(resolved.modelRef.provider);
  } catch {
    executor = null;
  }
  if (!executor || typeof executor.run !== 'function') {
    return { ok: false, error: 'executor_unavailable', message: 'исполнитель арбитра недоступен' };
  }
  let planDeclared = false;
  try {
    if (typeof executor.modes === 'function') {
      const catalog = await Promise.resolve(executor.modes(config));
      planDeclared = Array.isArray(catalog) && catalog.some((mode) => mode?.id === 'plan');
    }
  } catch {
    planDeclared = false;
  }
  if (!planDeclared) {
    return {
      ok: false,
      error: 'arbiter_plan_unavailable',
      message: 'исполнитель арбитра не объявил режим только чтения',
    };
  }
  return {
    ok: true,
    ref: resolved.modelRef,
    model: resolved.model,
    effort: cleanString(modelRef?.effort, 32) || '',
    executor,
    log,
  };
}
