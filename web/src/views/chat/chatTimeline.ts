import type { ChatMessage } from '../../shared/chatContracts.ts';
import type { ChatInTurnRun } from '../../stores/chatInTurn.ts';
import { isInTurnReceipt } from '../../stores/chatInTurn.ts';

interface TimelineStep {
  k: string;
  id?: string;
  at?: number;
  [field: string]: unknown;
}

interface TimelineMessage extends ChatMessage {
  role?: string;
  kind?: string;
  runId?: string;
  turnId?: string;
  parentTurnId?: string;
  messageId?: string;
  assistantMessageId?: string;
  finalAssistantMessageId?: string;
  sequence?: number;
  startedAt?: number;
  text?: string;
  steps?: TimelineStep[];
  queued?: boolean;
  [field: string]: unknown;
}

export interface ChatTimelineRow {
  key: string;
  turnKey: string;
  message: TimelineMessage;
  index: number;
  steps: TimelineStep[];
  heading: boolean;
  compact: boolean;
  live: boolean;
  current: boolean;
  thinking: boolean;
}

export interface ChatTimelineGroup {
  key: string;
  turn: boolean;
  current: boolean;
  agent: TimelineMessage;
  rows: ChatTimelineRow[];
}

interface TimelineTurn {
  key: string;
  messages: ChatTimelineRow[];
  steps: TimelineStep[];
  live: boolean;
  anchor: number;
}

interface CachedTurn {
  dependencies: unknown[][];
  rows: { row: ChatTimelineRow; slot: number }[];
}

const MESSAGE_DEPENDENCIES = [
  'role', 'kind', 'runId', 'turnId', 'parentTurnId', 'messageId', 'assistantMessageId',
  'finalAssistantMessageId', 'sequence', 'startedAt', 'text', 'complete', 'abandoned', 'revision',
  'model', 'actualModel', 'effort',
] as const;

function isIntermediate(message: TimelineMessage): boolean {
  return message.kind === 'assistant-block'
    && !message.finalAssistantMessageId && !Array.isArray(message.steps);
}

/**
 * Ключ сообщения не меняется при дописывании блока и переносе из SSE в историю.
 * Индекс остаётся исходным: копирование и продолжение хода работают с сообщением стора.
 */
function messageRow(message: TimelineMessage, index: number): ChatTimelineRow {
  const identity = message.assistantMessageId || message.messageId || message.turnId || index;

  return {
    key: `${message.runId || ''}:${message.role}:${identity}`,
    turnKey: '',
    message,
    index,
    steps: message.steps || [],
    heading: message.role === 'assistant' && !isIntermediate(message),
    compact: isIntermediate(message),
    live: false,
    current: false,
    thinking: false,
  };
}

/**
 * Текстовый шаг с общим id задаёт точное место реплики, даже в старой истории без времени.
 * Для уточнения берём серверное время приёма; неизвестное место ограничиваем соседями.
 */
function messageBoundary(message: TimelineMessage, steps: TimelineStep[]): number | null {
  if (Array.isArray(message.steps) || message.finalAssistantMessageId) {
    return steps.length;
  }

  const matched = steps.findIndex((step) => step.k === 'text'
    && step.id && step.id === message.assistantMessageId);

  if (matched >= 0) {
    return matched;
  }

  const at = message.receipt?.acceptedAt || message.startedAt;

  if (!at) {
    return null;
  }

  const later = steps.findIndex((step) => step.at && step.at > at);

  return later < 0 ? steps.length : later;
}

/**
 * Один запуск разворачивается в чередующиеся участки действий и реплик.
 * Результат и обновление инструмента остаются при первом вызове даже через уточнение.
 */
function turnRows(turn: TimelineTurn): ChatTimelineRow[] {
  const messages = [...turn.messages].sort((left, right) => (
    (left.message.sequence ?? Infinity) - (right.message.sequence ?? Infinity)
  ));
  const displayed = new Set(messages
    .filter((row) => row.message.role === 'assistant' && row.message.text?.trim())
    .map((row) => row.message.assistantMessageId));
  const boundaries = messages.map((row) => messageBoundary(row.message, turn.steps));
  const metadata = [...messages].reverse().find((row) => row.message.steps)?.message;
  const result: ChatTimelineRow[] = [];
  const tools = new Map<string, ChatTimelineRow>();
  let section: ChatTimelineRow | null = null;
  let cursor = 0;

  const activity = (key: string): ChatTimelineRow => ({
    key: `${turn.key}:${key}`,
    turnKey: turn.key,
    message: {
      role: 'assistant',
      model: metadata?.model,
      actualModel: metadata?.actualModel,
      effort: metadata?.effort,
    },
    index: -1,
    steps: [],
    heading: result.length === 0,
    compact: true,
    live: turn.live,
    current: turn.live,
    thinking: false,
  });
  /**
   * У показанной реплики нет второй текстовой копии в действиях.
   * Поздние подробности инструмента обновляют уже созданный участок ленты.
   */
  const appendStep = (step: TimelineStep, index: number) => {
    if (step.k === 'text' && step.id && displayed.has(step.id)) {
      return;
    }

    const owner = step.id && (step.k === 'tool' || step.k === 'res') ? tools.get(step.id) : null;

    if (owner) {
      owner.steps.push(step);

      return;
    }
    if (!section || step.k === 'start' || section.steps.at(-1)?.k === 'start') {
      section = activity(`steps:${step.id || `${step.k}:${step.at || 0}:${index}`}`);
      result.push(section);
    }

    section.steps.push(step);

    if (step.k === 'start') {
      section.live = true;
    }
    if (step.k === 'tool' && step.id) {
      tools.set(step.id, section);
    }
  };

  for (const [index, row] of messages.entries()) {
    const nextKnown = boundaries.slice(index).find((boundary) => boundary !== null);
    const boundary = Math.max(cursor, boundaries[index] ?? nextKnown ?? turn.steps.length);

    while (cursor < boundary || (cursor === 0 && turn.steps[cursor]?.k === 'start')) {
      appendStep(turn.steps[cursor]!, cursor);
      cursor += 1;
    }

    result.push({
      ...row,
      turnKey: turn.key,
      current: turn.live,
      steps: [],
      heading: row.message.role === 'assistant' && result.length === 0,
    });
    section = null;
  }
  while (cursor < turn.steps.length) {
    appendStep(turn.steps[cursor]!, cursor);
    cursor += 1;
  }

  // Индикатор остаётся в конце своего запуска, рядом с правой сводкой.
  // До первого шага эта строка также сохраняет шапку нового хода.
  if (turn.live) {
    const tail = activity('thinking');

    tail.thinking = true;
    result.push(tail);
  }

  return result;
}

/**
 * Соседние строки одного запуска получают общий контейнер и одну непрерывную линию.
 * Модель группы берётся из её сообщений, поэтому смена ИИ не меняет знаки старых ответов.
 */
export function groupChatTimeline(rows: ChatTimelineRow[]): ChatTimelineGroup[] {
  const groups: ChatTimelineGroup[] = [];

  for (const row of rows) {
    const previous = groups.at(-1);

    if (row.turnKey && previous?.key === row.turnKey) {
      previous.rows.push(row);
      previous.current ||= row.current;

      if (row.message.model || row.message.actualModel) {
        previous.agent = row.message;
      }

      continue;
    }

    groups.push({
      key: row.turnKey || row.key,
      turn: !!row.turnKey || row.message.role === 'assistant',
      current: row.current,
      agent: row.message,
      rows: [row],
    });
  }

  return groups;
}

/**
 * История и активный запуск получают общую проекцию; исходные сообщения не переставляются.
 * Группа занимает место после своего запроса, поэтому ответы не оказываются выше старта.
 */
function projectTimeline(
  messages: TimelineMessage[],
  steps: TimelineStep[],
  sending: boolean,
  run: ChatInTurnRun | null,
  activeRunId: string,
  projectTurn: (turn: TimelineTurn) => ChatTimelineRow[],
): ChatTimelineRow[] {
  const rows = messages.map(messageRow);
  const turns = new Map<string, TimelineTurn>();
  const activeKey = sending ? (activeRunId || (run?.active ? run.runId : 'live')) : '';

  for (const row of rows) {
    const key = row.message.runId;

    if (!key) {
      continue;
    }

    const turn = turns.get(key) || {
      key,
      messages: [],
      steps: [],
      live: key === activeKey,
      anchor: row.index,
    };

    turn.messages.push(row);

    if (row.steps.length) {
      turn.steps = row.steps;
    }

    turns.set(key, turn);
  }

  if (activeKey && !turns.has(activeKey)) {
    const parent = run?.runId === activeKey
      ? messages.findIndex((message) => message.role === 'user'
        && !!run.parentTurnId && message.turnId === run.parentTurnId)
      : -1;

    turns.set(activeKey, {
      key: activeKey,
      messages: [],
      steps: [],
      live: true,
      anchor: parent < 0 ? rows.length : parent + 1,
    });
  }

  const current = turns.get(activeKey || run?.runId || '');

  if (current) {
    if (current.live && !current.steps.length) {
      current.steps = steps;
    }

    for (const entry of run?.runId === current.key ? run.entries : []) {
      if (isInTurnReceipt(entry)) {
        continue;
      }

      const known = current.messages.find((row) => row.message.assistantMessageId
        === entry.assistantMessageId);

      if (known) {
        // В историю попадает только законченный блок: сервер и окно переносят лишь complete.
        // Устаревшие флаги черновика из store её не перекрывают — иначе «Пишет…» до F5.
        const { complete: _complete, abandoned: _abandoned, ...meta } = entry;

        known.message = { ...meta, ...known.message };
      } else if (current.live && entry.text.trim() && run?.runId === current.key) {
        current.messages.push(messageRow({
          ...entry,
          role: 'assistant',
          kind: 'assistant-block',
        }, -1));
      }
    }
  }

  const result: ChatTimelineRow[] = [];
  const anchored = new Map<number, TimelineTurn[]>();

  for (const turn of turns.values()) {
    const group = anchored.get(turn.anchor) || [];

    group.push(turn);
    anchored.set(turn.anchor, group);
  }

  for (let index = 0; index <= rows.length; index += 1) {
    for (const turn of anchored.get(index) || []) {
      result.push(...projectTurn(turn));
    }

    const row = rows[index];

    if (row && !row.message.runId) {
      result.push(row);
    }
  }

  return result;
}

/**
 * Чистая проекция остаётся доступна потребителям без жизненного цикла сессии.
 * Кэш включается только явно созданным владельцем через фабрику ниже.
 */
export function chatTimeline(
  messages: TimelineMessage[],
  steps: TimelineStep[],
  sending: boolean,
  run: ChatInTurnRun | null,
  activeRunId = '',
): ChatTimelineRow[] {
  return projectTimeline(messages, steps, sending, run, activeRunId, turnRows);
}

/**
 * Снимок читает скаляры каждый раз, сохраняя подписки computed при попадании в кэш.
 * Тела исторических шагов неизменяемы; достаточно ссылки и длины их массива.
 */
function turnDependencies(turn: TimelineTurn): unknown[][] {
  return [[turn.steps, turn.steps.length], ...turn.messages.map(({ message }) => [
    ...MESSAGE_DEPENDENCIES.map((key) => message[key]),
    message.receipt?.acceptedAt,
    message.steps,
    message.steps?.length,
  ])];
}

/**
 * Кэш одной сессии хранит разбиение шагов, а сообщения и индексы получает из текущей истории.
 * Текущий запуск пересчитывается всегда; исчезнувшие группы освобождаются после проекции.
 */
export function createChatTimelineProjector() {
  const cache = new Map<string, CachedTurn>();

  return {
    /**
     * Каждая проекция перечитывает зависимости и текущие ссылки на сообщения.
     * Переиспользуются только исторические массивы участков, нужные неизменившимся StepList.
     */
    project(
      messages: TimelineMessage[],
      steps: TimelineStep[],
      sending: boolean,
      run: ChatInTurnRun | null,
      activeRunId = '',
    ): ChatTimelineRow[] {
      const alive = new Set<string>();
      /**
       * Текущий запуск остаётся живым, а исторический разворачивается один раз на набор зависимостей.
       * Кэш хранит позиции сообщений и не удерживает их устаревшие метаданные.
       */
      const projectTurn = (turn: TimelineTurn): ChatTimelineRow[] => {
        alive.add(turn.key);

        if (turn.live || turn.key === run?.runId) {
          cache.delete(turn.key);

          return turnRows(turn);
        }

        const dependencies = turnDependencies(turn);
        const previous = cache.get(turn.key);
        const equal = previous?.dependencies.length === dependencies.length
          && dependencies.every((values, index) => values.every((value, field) => (
            value === previous.dependencies[index]![field]
          )));

        if (equal && previous) {
          return previous.rows.map(({ row, slot }) => slot < 0 ? row : {
            ...row,
            message: turn.messages[slot]!.message,
            index: turn.messages[slot]!.index,
          });
        }

        const rows = turnRows(turn);

        cache.set(turn.key, {
          dependencies,
          rows: rows.map((row) => ({
            // Сообщения не удерживаются кэшем: только позиции и участки действий.
            row: row.index < 0 ? row : { ...row, message: { role: row.message.role } },
            slot: turn.messages.findIndex((message) => message.index === row.index),
          })),
        });

        return rows;
      };
      const result = projectTimeline(messages, steps, sending, run, activeRunId, projectTurn);

      for (const key of cache.keys()) {
        if (!alive.has(key)) {
          cache.delete(key);
        }
      }

      return result;
    },
    clear(): void {
      cache.clear();
    },
  };
}
