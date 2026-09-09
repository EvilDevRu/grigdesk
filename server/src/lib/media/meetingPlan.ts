// Разбор расшифровки встречи на черновики задач.
//
// Встреча — это разговор, а не постановка: в семнадцати минутах записи законно лежат
// несколько независимых поводов вперемешку с обсуждением, шутками и «созвонимся в
// понедельник». Поэтому модель отвечает не одним вердиктом, а ПЛАНОМ: список задач,
// у каждой свои номера реплик. Номера — единственный способ сказать, какая часть
// разговора относится к какой задаче; по ним же кокпит подставляет таймкоды, чтобы
// человек мог вернуться к месту записи и проверить формулировку.
//
// Отличия от плана Inbox (lib/inbox/triage.ts) намеренные, их два:
//  • НЕПОКРЫТЫЕ реплики здесь норма, а не исключение: большая часть встречи задачами
//    не является, и требовать распределить все номера значило бы просить модель
//    выдумывать поводы;
//  • ПЕРЕСЕЧЕНИЯ разрешены. У Inbox они запрещены контрактом decisions — там номер
//    сообщения назначается ровно одному durable-решению. Здесь решения нет вовсе:
//    план становится черновиками, которые человек правит перед созданием задач, и
//    одна реплика («сроки у обеих задач до пятницы») законно относится к двум.
//
// Транскрипт недоверенный: он собран из чужой речи и попадает в prompt, поэтому
// запуск идёт только через capability-gated runUntrusted без tools и workspace —
// тем же резолвером, что и у Inbox.
import { resolveInboxTriageTarget } from '../inbox/triage.ts';
import type { MeetingSegment } from './meetingFrames.ts';
import {
  boundedText,
  confidenceValue,
  exactKeys,
  jsonCandidates,
  modelText,
} from '../model-json.js';

type LogPort = {
  warn?: (details: unknown, message: string) => void;
};

// Черновик задачи из плана модели: формулировка и номера реплик, по которым
// человек возвращается к месту записи и проверяет её.
export interface MeetingPlanTask {
  title: string;
  description: string;
  reason: string;
  confidence: number;
  segments: number[];
}

// То же самое с уже подставленными таймкодами — в таком виде задачу видит человек.
export interface MeetingTaskDraft {
  title: string;
  description: string;
  confidence: number;
  reason: string;
  segments: number[];
}

// Исход разбора. Отказ назван машинным кодом: фразу для человека собирает
// вызывающий, как и в остальном кокпите.
export type MeetingPlanResult =
  | { ok: false; error: string }
  | {
    ok: true;
    model: string;
    effort: string | null;
    truncated: boolean;
    count: number;
    tasks: MeetingTaskDraft[];
  };

export const MEETING_PLAN_LIMITS = Object.freeze({
  // Час встречи — это примерно 36 000 символов расшифровки; потолок взят с запасом,
  // чтобы обычный созвон уезжал целиком, но не безграничным: у локальных моделей
  // окно контекста маленькое, и переполнить его молча нельзя.
  transcript: 60_000,
  title: 250,
  description: 4_000,
  reason: 2_000,
  tasks: 20,
});

const TASK_KEYS = ['segments', 'title', 'description', 'confidence', 'reason'];

/** `04:31` — тем же форматом, что таймкоды реплик в интерфейсе раздела. */
export function timecode(seconds: unknown): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** Реплики распознавания → нумерованный транскрипт с таймкодами. */
export function meetingTranscript(
  segments: MeetingSegment[] = [],
  { limit = MEETING_PLAN_LIMITS.transcript }: { limit?: number } = {},
): { transcript: string; count: number; total: number; truncated: boolean } {
  const rows: string[] = [];
  let used = 0;
  let truncated = false;
  const source = Array.isArray(segments) ? segments : [];
  for (const segment of source) {
    const value = modelText(segment?.text);
    if (!value) continue;
    const row = `#${rows.length + 1} [${timecode(segment?.start)}] ${value}`;
    if (used + row.length + 1 > limit) { truncated = true; break; }
    rows.push(row);
    used += row.length + 1;
  }
  return { transcript: rows.join('\n'), count: rows.length, total: source.length, truncated };
}

export function buildMeetingPlanPrompt(
  segments: MeetingSegment[] = [],
  { hint = '' }: { hint?: string } = {},
) {
  const ctx = meetingTranscript(segments);
  const extra = modelText(hint);
  return {
    count: ctx.count,
    truncated: ctx.truncated,
    system: [
      'Ты разбираешь расшифровку рабочей встречи и выделяешь из неё задачи.',
      'Ответь одним JSON-объектом без markdown и любого другого текста.',
      'Формат: {"tasks": [ … ]} — по одному элементу на каждую отдельную задачу.',
      'Поля элемента: segments (массив номеров реплик), title (одна строка, суть задачи),',
      'description (что нужно сделать, только по сказанному на встрече),',
      'confidence (число 0..1), reason (одно краткое предложение с причиной решения).',
      'Реплики пронумерованы (#1, #2 …). Указывай номера тех реплик, где повод обсуждали.',
      'Обсуждение, приветствия, отвлечения и решения «ничего не делаем» задачами не являются —',
      'их номера просто не указывай. Распределять все реплики не нужно.',
      'Одну и ту же реплику можно отнести к нескольким задачам, если она относится к обеим.',
      'Если задач не нашлось, верни {"tasks": []}.',
      'Ничего не додумывай: не бывшего на встрече в задаче быть не должно.',
      'Не уверен — снижай confidence, задачу проверит человек.',
      'Пиши по-русски.',
    ].join('\n'),
    user: [
      extra ? `Что человек просил учесть при разборе: ${extra}` : '',
      ctx.truncated
        ? `Показаны первые ${ctx.count} реплик из ${ctx.total}; остальные разберёт человек.`
        : `Реплик в расшифровке: ${ctx.count}.`,
      '',
      ctx.transcript,
    ].filter(Boolean).join('\n'),
  };
}

function taskFields(raw: Record<string, unknown>, count: number): MeetingPlanTask | null {
  if (!exactKeys(raw, TASK_KEYS)) return null;
  const title = boundedText(raw.title, MEETING_PLAN_LIMITS.title);
  const description = boundedText(raw.description, MEETING_PLAN_LIMITS.description);
  const reason = boundedText(raw.reason, MEETING_PLAN_LIMITS.reason);
  if (!title || description === null || reason === null) return null;
  if (!Array.isArray(raw.segments) || raw.segments.length < 1 || raw.segments.length > count) {
    return null;
  }
  const segments: number[] = [];

  for (const index of raw.segments) {
    // Номер вне диапазона — это уже не «модель не уверена», а ответ не по контракту:
    // проверить такую ссылку человеку нечем, а таймкод для неё взять неоткуда.
    if (!Number.isSafeInteger(index) || index < 1 || index > count) return null;
    if (!segments.includes(index)) segments.push(index);
  }
  return {
    title,
    description,
    reason,
    confidence: confidenceValue(raw.confidence),
    segments: segments.sort((a, b) => a - b),
  };
}

/**
 * Пустой план (`tasks: []`) — законный ответ «задач на встрече не прозвучало»,
 * а не отказ: его отличие от `null` в том, что модель ответила по контракту.
 */
export function parseMeetingPlan(
  reply: unknown,
  { count = 0 }: { count?: number } = {},
): MeetingPlanTask[] | null {
  if (!Number.isSafeInteger(count) || count < 1) return null;
  for (const candidate of jsonCandidates(reply)) {
    let raw: Record<string, unknown>;

    try { raw = JSON.parse(String(candidate)); } catch { continue; }
    if (!exactKeys(raw, ['tasks'])) continue;
    if (!Array.isArray(raw.tasks) || raw.tasks.length > MEETING_PLAN_LIMITS.tasks) continue;
    const tasks: MeetingPlanTask[] = [];
    let broken = false;
    for (const item of raw.tasks) {
      const task = taskFields(item, count);
      if (!task) { broken = true; break; }
      tasks.push(task);
    }
    if (!broken) return tasks;
  }
  return null;
}

/**
 * Черновик задачи из элемента плана. Ссылку на место в записи оставляем всегда:
 * формулировку собрала модель по чужой речи, и проверить её человек может только
 * вернувшись к таймкоду.
 */
export function meetingTaskDraft(
  task: MeetingPlanTask,
  segments: MeetingSegment[] = [],
): MeetingTaskDraft {
  const marks = task.segments
    .map((index) => segments[index - 1])
    .filter((segment): segment is MeetingSegment => Boolean(segment))
    .map((segment) => timecode(segment.start));
  const unique = [...new Set(marks)];
  const source = unique.length ? `На записи: ${unique.join(', ')}` : '';
  return {
    title: task.title,
    description: [task.description, source].filter(Boolean).join('\n\n'),
    confidence: task.confidence,
    reason: task.reason,
    segments: task.segments,
  };
}

/**
 * Разбирает расшифровку моделью. Возвращает `{ok:false, error}` с машинным кодом —
 * фразу для человека собирает вызывающий, как и в остальном кокпите.
 */
export async function runMeetingPlan({
  segments = [],
  modelRef,
  hint = '',
  config = {},
  providerSettings = {},
  log = console,
  signal,
  resolveTarget = resolveInboxTriageTarget,
}: {
  segments?: MeetingSegment[];
  modelRef?: unknown;
  hint?: string;
  config?: Record<string, unknown>;
  providerSettings?: Record<string, Record<string, unknown>>;
  log?: LogPort;
  signal?: AbortSignal;
  resolveTarget?: typeof resolveInboxTriageTarget;
} = {}): Promise<MeetingPlanResult> {
  const prompt = buildMeetingPlanPrompt(segments, { hint });
  if (!prompt.count) return { ok: false, error: 'empty_transcript' };
  const target = await resolveTarget({ modelRef, config, requireImages: false, log });
  // Разрешённая цель — это модель ВМЕСТЕ с transport для недоверенного ввода:
  // без любой из двух половин запускать разбор чужой речи нечем.
  if (!target.ok || !target.ref || !target.executor?.runUntrusted) {
    return { ok: false, error: target.error || 'no_model' };
  }
  const { provider, model } = target.ref;
  let output: { reply?: unknown };
  try {
    output = await target.executor.runUntrusted({
      config,
      message: `${prompt.system}\n\n${prompt.user}`,
      model,
      // Уровень уже сверен резолвером с возможностями модели: неподдерживаемый снят,
      // и сюда приходит либо рабочий уровень, либо ничего.
      effort: target.effort || undefined,
      images: [],
      providerSettings: providerSettings?.[provider] || {},
      log,
      signal,
    });
  } catch (error) {
    // Причина обязана попасть в журнал: наружу уходит машинный код, и без записи
    // «модель не ответила» становится немым отказом, который нечем разбирать.
    log?.warn?.({ err: error, provider, model }, 'разбор встречи: модель не ответила');
    return { ok: false, error: 'run_failed' };
  }
  const plan = parseMeetingPlan(output?.reply, { count: prompt.count });
  if (!plan) return { ok: false, error: 'bad_plan' };
  return {
    ok: true,
    model: `${provider}/${model}`,
    effort: target.effort || null,
    truncated: prompt.truncated,
    count: prompt.count,
    tasks: plan.map((task) => meetingTaskDraft(task, segments)),
  };
}
