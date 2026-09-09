// Контракт триажа задач. Оценку пишет модель, а её файл переживает и рестарт сервера,
// и обновление кокпита: поле, которого в старой оценке не было, — обычное дело, а не
// повреждённый ответ. Поэтому тело оценки описано необязательными полями, а конверт
// (задача, статус очереди, разведнота, протухание) — строгий: его собирает сервер.

import { contractDecoders } from './contractDecoders.ts';

export class AnalysisContractError extends Error {
  constructor(path: string) {
    super(`Некорректный ответ триажа: поле ${path}`);
    this.name = 'AnalysisContractError';
  }
}

const {
  boolean,
  listOf,
  numeric,
  objectOf,
  oneOf,
  optional,
  text,
  wholeNumber,
} = contractDecoders((path) => {
  throw new AnalysisContractError(path);
});

// Состояние очереди триажа. Прерван и упал — разные вещи: первое сделал рестарт
// сервера, второе — сам агент, и человек решает по ним по-разному.
const analysisState = oneOf('queued', 'running', 'done', 'failed', 'interrupted');

const analysisStatus = objectOf({
  task: wholeNumber,
  state: analysisState,
  queuedAt: optional(numeric),
  startedAt: optional(numeric),
  finishedAt: optional(numeric),
  durationMs: optional(numeric),
  error: optional(text),
  note: optional(text),
});

// Вопрос агента к человеку. Форму нормализует сервер: варианты ответа и рекомендация
// приходят уже разобранными, даже если модель написала их строками.
const questionOption = objectOf({
  id: text,
  label: text,
  description: optional(text),
});

const analysisQuestion = objectOf({
  id: text,
  text,
  options: listOf(questionOption),
  recommendation: optional(objectOf({
    option: text,
    reason: text,
  })),
});

const analysisMeta = objectOf({
  provider: optional(text),
  model: optional(text),
  effort: optional(text),
  requestedModel: optional(text),
  warning: optional(text),
  duration_ms: optional(numeric),
  cost_usd: optional(numeric),
  context_tokens: optional(numeric),
});

const analysis = objectOf({
  complexity: optional(numeric),
  risk: optional(numeric),
  diff_size: optional(text),
  confidence: optional(text),
  summary: optional(text),
  needs_clarification: optional(boolean),
  risk_markers: optional(listOf(text)),
  files: optional(listOf(text)),
  unknowns: optional(listOf(text)),
  questions: optional(listOf(analysisQuestion)),
  route_guess: optional(text),
  route_kind: optional(text),
  route_depth: optional(text),
  route_reason: optional(text),
  title: optional(text),
  generated_at: optional(text),
  meta: optional(analysisMeta),
});

const analysisRow = objectOf({
  task: wholeNumber,
  analysis: optional(analysis),
  status: optional(analysisStatus),
});

const analysisRows = listOf(analysisRow);

const analysisDetail = objectOf({
  task: wholeNumber,
  analysis: optional(analysis),
  note: optional(text),
  stale: optional(listOf(text)),
  status: optional(analysisStatus),
});

// Итог постановки в очередь. Дедуп — не отказ: задача уже стоит или уже считается.
const enqueueOutcome = oneOf(
  'queued',
  'busy',
  'already_queued',
  'already_running',
  'dismissed',
  'plugin_disabled',
);

const queueResponse = objectOf({
  outcome: enqueueOutcome,
  position: optional(wholeNumber),
});

const clarificationEntry = objectOf({
  id: text,
  questionId: text,
  actor: oneOf('human', 'cockpit-arbiter'),
  status: oneOf('answered', 'human_required'),
  selection: listOf(text),
  text,
  attachments: listOf(objectOf({
    file: text,
    name: text,
  })),
  proof: listOf(text),
});

const clarifications = objectOf({
  text,
  entries: listOf(clarificationEntry),
});

// Ответ арбитра: он либо разобрал вопросы, либо честно назвал, почему не смог.
const arbiterResult = objectOf({
  ok: boolean,
  outcome: optional(text),
  answered: optional(wholeNumber),
  error: optional(text),
});

export type AnalysisState = ReturnType<typeof analysisState>;
export type AnalysisStatus = ReturnType<typeof analysisStatus>;
export type AnalysisQuestionOption = ReturnType<typeof questionOption>;
export type AnalysisQuestion = ReturnType<typeof analysisQuestion>;
export type AnalysisMeta = ReturnType<typeof analysisMeta>;
export type Analysis = ReturnType<typeof analysis>;
export type AnalysisRow = ReturnType<typeof analysisRow>;
export type AnalysisDetail = ReturnType<typeof analysisDetail>;
export type AnalysisQueueOutcome = ReturnType<typeof enqueueOutcome>;
export type AnalysisQueueResponse = ReturnType<typeof queueResponse>;
export type AnalysisClarificationEntry = ReturnType<typeof clarificationEntry>;
export type AnalysisClarifications = ReturnType<typeof clarifications>;
export type AnalysisArbiterResult = ReturnType<typeof arbiterResult>;

// Ответ человека на вопрос агента: выбор вариантов, свой текст и вложения к нему.
// Ответ человека на вопрос триажа — то, что уходит НА сервер. Выбор здесь зовётся
// `optionIds`, а в сохранённой записи — `selection`: это разные стороны обмена, и
// сервер сам переводит одно в другое, сверив варианты с текущей оценкой.
export interface AnalysisAnswerInput {
  questionId: string;
  optionIds?: string[];
  text?: string;
  attachments?: { file: string; name: string }[];
}

// Пакет арбитра: те же поля плюс его собственные — свой id записи, вердикт «нужен
// человек» и ссылки-обоснования. Человеку они недоступны: actor и статус назначает
// сервер, и присланный клиентом `status` он игнорирует.
export interface AnalysisArbiterAnswerInput extends AnalysisAnswerInput {
  id?: string;
  status?: 'answered' | 'human_required';
  proof?: string[];
}

export function parseAnalysisRows(value: unknown): AnalysisRow[] {
  return analysisRows(value, 'analysisRows');
}

export function parseAnalysisDetail(value: unknown): AnalysisDetail {
  return analysisDetail(value, 'analysisDetail');
}

export function parseAnalysisQueue(value: unknown): AnalysisQueueResponse {
  return queueResponse(value, 'analysisQueue');
}

export function parseAnalysisClarifications(value: unknown): AnalysisClarifications {
  return clarifications(value, 'clarifications');
}

export function parseAnalysisArbiter(value: unknown): AnalysisArbiterResult {
  return arbiterResult(value, 'arbiter');
}
