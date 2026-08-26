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

// Кто принял решение — уезжает в `factory goto --actor`. Движок пишет это поле в событие
// журнала, и машинное решение перестаёт быть неотличимым от человеческого.
export const ARBITER_ACTOR = 'cockpit-arbiter';

// Потолок на попытку. Возврат арбитра начинает новую серию дуги (как и человеческий),
// то есть обнуляет замкнутый набор замечаний — без своего потолка арбитр мог бы съесть
// весь общий бюджет возвратов попытки, и человек увидел бы уже исчерпанную задачу.
export const ARBITER_MAX_PER_ATTEMPT = 2;

// Остановки, которые арбитр вправе разбирать. `human` сюда не входит намеренно: это не
// топтание, а прямой вызов человека (провалившийся стенд, отказ прав, исчерпанный бюджет
// повторов) — там решение не выводится из вердиктов дуги.
const ARBITRABLE_STOPS = new Set(['no-progress']);

const EVENT_RE = /^event\.(\d{20})\.[0-9a-f]{64}\.json$/;
const CARD_FIELDS = ['what', 'why', 'proof', 'risk'];
const FIELD_LIMIT = 1200;
const INSTRUCTION_LIMIT = 8000;

/**
 * Чтение журнала попытки под конкретную дугу.
 *
 * Возвращает вердикты серии автоматических возвратов и число уже потраченных арбитражей.
 * Серия считается ровно так же, как её считает движок: решение человека (или прошлый
 * арбитраж) начинает новую. Иначе арбитр разбирал бы вердикты, уже отменённые решением.
 */
export async function readArbitrationContext({ controlDir, task, attempt }) {
  const dir = path.join(
    controlDir, 'protocol-v2', 'tasks', `t${task}`, 'attempts', attempt, 'stage-results',
  );
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return { ok: false, error: 'ledger_unreadable' };
  }
  const events = names
    .map((name) => [EVENT_RE.exec(name), name])
    .filter(([match]) => match)
    .sort((a, b) => Number(a[0][1]) - Number(b[0][1]))
    .map(([, name]) => name);

  let arbitrations = 0;
  let series = [];
  let stop = null;
  let node = null;
  let target = null;
  let reason = null;

  for (const name of events) {
    let event;
    try {
      event = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
    } catch {
      return { ok: false, error: 'ledger_unreadable' };
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
          node: event.node,
          owner: event.verdict.owner,
          findings: Array.isArray(event.verdict.findings) ? event.verdict.findings : [],
          reviewed: Array.isArray(event.verdict.reviewed) ? event.verdict.reviewed : [],
        });
      }
      continue;
    }
    if (event.kind === 'commit') {
      stop = null;
      if (event.verdict && event.action?.rewind) {
        series.push({
          node: event.node,
          owner: event.verdict.owner,
          findings: Array.isArray(event.verdict.findings) ? event.verdict.findings : [],
          reviewed: Array.isArray(event.verdict.reviewed) ? event.verdict.reviewed : [],
        });
      }
    }
  }

  return {
    ok: true, stop, node, target, reason, series, arbitrations,
  };
}

/** Разбирает ли арбитр эту остановку. Ответ словами: он уезжает человеку. */
export function arbitrationGate(context, cursor) {
  if (!context?.ok) {
    return { ok: false, error: 'ledger_unreadable', message: 'журнал попытки не прочитан' };
  }
  if (cursor?.state !== 'stopped' || !ARBITRABLE_STOPS.has(cursor?.stop)) {
    return {
      ok: false,
      error: 'not_arbitrable',
      message: 'арбитр разбирает только остановку по отсутствию прогресса',
    };
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

function findingLine(finding) {
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
  task, node, target, reason, series, stateDir,
}) {
  const rounds = series.map((entry, index) => {
    const lines = entry.findings.map(findingLine).join('\n');
    const reviewed = entry.reviewed.length
      ? `  просмотрено: ${entry.reviewed.join(', ')}`
      : '  охват прохода не объявлен';
    return `Круг ${index + 1} (узел ${entry.node}, адресовано ${entry.owner}):\n${lines}\n${reviewed}`;
  }).join('\n\n');

  return `Ты арбитр конвейера задачи ${task}. Маршрут ОСТАНОВЛЕН и ждёт решения.

Что произошло: узел «${node}» несколько раз подряд возвращал работу узлу «${target}», и
движок счёл, что возвраты перестали давать прогресс. Причина остановки дословно:

${reason || '(движок причину не назвал)'}

Вердикты дуги по кругам:

${rounds}

Артефакты узлов лежат в ${stateDir} — файлы вида t${task}.<узел>.md. Рабочее дерево задачи
открыто тебе на чтение.

Твои возможности: читать файлы, искать по коду и обходить дерево. Запускать команды ты НЕ
можешь — режим только для чтения. Если вопрос без запуска не решается, так и скажи: это
законный исход, и решение тогда за человеком.

ТВОЯ ЗАДАЧА — не чинить работу, а СНЯТЬ ТУПИК. Спорное утверждение проверь ПО КОДУ, а не
рассуждением о нём. Именно этого не хватило: проверяющий узел вынес блокирующим вопрос,
который ему не дали проверить правами, а человек потом ответил на него по комментарию в
коде — и ошибся, хотя поиск по тому же каталогу давал ответ за десять секунд.

Реши одно из двух:

1. Тупик снимается инженерным решением — какой вариант верен, что считать доказанным,
   какое из замечаний не подтверждается фактами. Тогда напиши указание узлу «${target}».
2. Решение меняет ГРАНИЦУ ЗАДАЧИ — снять критерий приёмки, отказаться от проверки,
   расширить или сузить объём работы, выбрать приоритет между несравнимыми вариантами.
   Это решает только человек. Тогда verdict = "human" и назови, что именно ему решать.

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

function cleanField(value, limit) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[ --]/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Разбор ответа арбитра.
 *
 * Строгий: пустая карточка, отсутствующий вердикт или пропавшее указание означают, что
 * решения нет. Молча превратить такой ответ в возврат нельзя — узел получил бы пустое
 * задание, а журнал утверждал бы, что решение принято и обосновано.
 */
export function parseArbiterDecision(text) {
  const source = String(text || '');
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : source.slice(source.indexOf('{'));
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, error: 'bad_model_reply', message: 'арбитр ответил не разбираемым JSON' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'bad_model_reply', message: 'арбитр ответил не объектом' };
  }

  const card = {};
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

  // Граница задачи — не арбитражный вопрос. Проверяем ОБА признака: объявленный самим
  // арбитром `scope_change` и вердикт. Первый честнее (арбитр видел контекст), второй
  // страхует от ответа, где поле забыли.
  if (parsed.verdict === 'human' || parsed.scope_change === true) {
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
  return {
    ok: true, verdict: 'resolve', card, instruction, scopeChange: false,
  };
}

/**
 * Текст, который уезжает в `goto --reason` и оттуда в промпт узла и в журнал попытки.
 *
 * Порядок карточки тот же, что у решения агента в отчёте приёмки: первые строки читаются
 * без открытия репозитория. Подпись обязательна — человек на воротах должен видеть, что
 * это решение конвейера, а не его собственное.
 */
export function formatArbiterReason(decision) {
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
// Отдельная от companion: у той свой смысл (чем отвечает голосовой ход), и общий ключ
// связал бы два независимых решения человека.

const PROVIDER_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const MODEL_MAX = 200;

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

function hasControlChars(value) {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function cleanString(value, max) {
  if (typeof value !== 'string' || hasControlChars(value)) return '';
  const trimmed = value.trim();
  return trimmed.length && trimmed.length <= max ? trimmed : '';
}

/** Мягкая нормализация: испорченный prefs.json не должен ронять старт кокпита. */
export function normalizeArbiterSettings(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const ref = raw.modelRef && typeof raw.modelRef === 'object' && !Array.isArray(raw.modelRef)
    ? raw.modelRef
    : {};
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
} = {}) {
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
  let executor;
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
