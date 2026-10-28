import { contractDecoders } from '../lib/contractDecoders.ts';

export const ARBITER_LIMITS = Object.freeze({
  humanText: 16_000,
  summary: 2_000,
  instruction: 20_000,
  proposals: 4,
  questions: 4,
  options: 6,
  page: 100,
  contextMessages: 20,
  context: 48_000,
  technicalDetails: 16_000,
  message: 48_000,
});

export type ConversationState = 'idle' | 'analyzing' | 'awaiting_user' | 'applying'
  | 'resolved' | 'interrupted' | 'stale';
export type OperationOutcome = 'queued' | 'running' | 'completed' | 'accepted' | 'resumed'
  | 'resume_failed' | 'failed' | 'unknown';
export type IntentKind = 'start' | 'discuss' | 'diagnose' | 'apply' | 'resume';

export interface StopIdentity {
  task: string;
  profile: string;
  attempt: string;
  node: string;
  stop: string;
  stageSequence: number;
  stageHeadHash: string;
}

export interface StageIdentity {
  sequence: number;
  headEventHash: string;
}

export interface ArbiterTarget {
  node: string;
  label: string;
  executorKind: 'agent' | 'command';
  acceptsInstruction: boolean;
  canRetryUnchanged: boolean;
  resetNodes: string[];
  resetLabels?: string[];
}

export type ArbiterAction = {
  kind: 'replay_current' | 'return_to_node';
  targetNode: string;
  instruction: string;
} | {
  kind: 'retry_command';
  targetNode: string;
};

export interface ArbiterQuestion {
  id: string;
  text: string;
  options: { id: string; label: string }[];
  allowCustom: true;
}

interface ProposalDescription {
  id: string;
  label: string;
  explanation: string;
  expectedResult: string;
  recommended: boolean;
}

export type ArbiterProposal = ProposalDescription & ({
  kind: 'diagnose';
  diagnosticInstruction: string;
} | {
  kind: 'apply';
  action: ArbiterAction;
});

export interface ArbiterResult {
  summary: string;
  questions: ArbiterQuestion[];
  proposals: ArbiterProposal[];
  technicalDetails: string;
}

export interface ArbiterMessage {
  id: string;
  sequence: number;
  author: 'node' | 'arbiter' | 'human' | 'system';
  text: string;
  status: 'partial' | 'complete' | 'interrupted';
  createdAt: string;
  turnId?: string;
  sourceId?: string;
  sourceRevision?: number;
  sourceKind?: 'agent' | 'command';
  revision: number;
}

export interface ApplyReceipt {
  stage: StageIdentity;
  originalStage: StageIdentity;
  targetNode: string;
  reason: string;
}

export interface ArbiterOperation {
  id: string;
  requestId: string;
  fingerprint: string;
  kind: IntentKind;
  outcome: OperationOutcome;
  createdAt: string;
  updatedAt: string;
  error?: string;
  message?: string;
  action?: ArbiterAction;
  originalProposal?: ArbiterProposal;
  receipt?: ApplyReceipt;
  reason?: string;
  originalStage?: StageIdentity;
  observedSequence?: number;
  observation?: 'waiting' | 'running' | 'completed' | 'stopped' | 'superseded';
  nextStop?: StopIdentity;
  result?: ArbiterResult;
  applyOperationId?: string;
  acceptedEvent?: StageIdentity;
  expectedCurrentStage?: StageIdentity;
}

export interface ArbiterCapabilities {
  status: 'supported' | 'unsupported' | 'unknown' | 'unavailable';
  message: string;
  targets: ArbiterTarget[];
}

export interface ArbiterConversation {
  schemaVersion: 1;
  id: string;
  identity: StopIdentity;
  revision: number;
  decisionRevision: number;
  state: ConversationState;
  automatic: boolean;
  createdAt: string;
  messages: ArbiterMessage[];
  operations: ArbiterOperation[];
  result: ArbiterResult | null;
  capabilities: ArbiterCapabilities;
}

export interface ConversationSnapshot extends ArbiterConversation {
  afterSequence: number;
  hasMore: boolean;
  readOnly: boolean;
}

export class ArbiterConversationError extends Error {
  readonly code: string;

  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'ArbiterConversationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface ArbiterConversationSummary {
  conversationId: string;
  identity: StopIdentity;
  revision: number;
  state: ConversationState;
  automatic: boolean;
  started: boolean;
}

const { record, wholeNumber, boolean } = contractDecoders((field) => {
  throw new ArbiterConversationError('invalid_request', `Некорректное поле разбора: ${field}`);
});

/**
 * Закрывает набор ключей для сетевого запроса и ответа модели.
 * Произвольные исполняемые поля не могут пройти вместе с известными полями.
 */
export function arbiterRecord(value: unknown, required: string[], optional: string[] = []) {
  const source = record(value, 'object');
  const allowed = new Set([...required, ...optional]);

  if (required.some((key) => !(key in source)) || Object.keys(source).some((key) => !allowed.has(key))) {
    throw new ArbiterConversationError('invalid_request', 'Набор полей разбора не соответствует контракту.');
  }

  return source;
}

/**
 * Проверяет длину без молчаливого усечения указаний человека.
 * Пустое содержимое допустимо только для явно необязательного текста.
 */
export function arbiterText(value: unknown, limit: number, empty = false): string {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim())
    || /[\u0000\u0008\u000b\u000c]/u.test(value)) {
    throw new ArbiterConversationError('invalid_request', 'Текст пуст, слишком длинный или повреждён.');
  }

  return value;
}

/**
 * Сохраняет порядок вариантов, проверяя их количество и уникальность id.
 * Повтор идентификатора делает выбор неоднозначным и отклоняет весь ответ.
 */
function uniqueList<T extends { id: string }>(
  value: unknown,
  limit: number,
  decode: (row: unknown) => T
): T[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new ArbiterConversationError('invalid_request', 'Слишком много вопросов или вариантов.');
  }

  const rows = value.map(decode);

  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new ArbiterConversationError('invalid_request', 'Идентификаторы вариантов повторяются.');
  }

  return rows;
}

/**
 * Exact identity содержит head и sequence доверенного журнала.
 * Повторный визит того же узла не совпадает с предыдущим разбором.
 */
export function decodeStopIdentity(value: unknown): StopIdentity {
  const row = arbiterRecord(value, [
    'task', 'profile', 'attempt', 'node', 'stop', 'stageSequence', 'stageHeadHash',
  ]);
  const patterns: Record<string, RegExp> = {
    task: /^[1-9][0-9]{0,18}$/,
    profile: /^[a-z0-9][a-z0-9_-]{0,63}$/,
    attempt: /^a_[a-f0-9]{32}$/,
    node: /^[a-z0-9][a-z0-9_-]{0,63}$/,
    stop: /^[a-z][a-z0-9_-]{0,63}$/,
    stageHeadHash: /^[a-f0-9]{64}$/,
  };

  for (const [key, pattern] of Object.entries(patterns)) {
    if (typeof row[key] !== 'string' || !pattern.test(row[key] as string)) {
      throw new ArbiterConversationError('invalid_request', `Некорректная идентичность остановки: ${key}`);
    }
  }

  wholeNumber(row.stageSequence, 'stageSequence');

  return row as unknown as StopIdentity;
}

/**
 * Одинаковая пара sequence/hash связывает resume с принятым событием и текущим курсором.
 * Декодер общий для HTTP-намерения, durable записи и проверки сохранённого receipt.
 */
export function decodeStageIdentity(value: unknown): StageIdentity {
  const row = arbiterRecord(value, ['sequence', 'headEventHash']);

  wholeNumber(row.sequence, 'sequence');

  if (typeof row.headEventHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.headEventHash)) {
    throw new ArbiterConversationError('invalid_request', 'Некорректный hash этапа.');
  }

  return row as unknown as StageIdentity;
}

/**
 * Сравнивает все составляющие остановки без опоры на порядок ключей JSON.
 * Используется и admission сервера, и защитой поздних ответов окна.
 */
export function sameStop(left: StopIdentity | null | undefined, right: StopIdentity | null | undefined) {
  return Boolean(left && right && Object.keys(decodeStopIdentity(left))
    .every((key) => left[key as keyof StopIdentity] === right[key as keyof StopIdentity]));
}

/**
 * Разрешает только цели, подтверждённые закреплённым маршрутом и визитами.
 * Command повторяется с прежними параметрами и не принимает текст как инструкцию.
 */
export function decodeArbiterAction(value: unknown, targets: readonly ArbiterTarget[], currentNode: string) {
  const raw = record(value, 'action');
  const command = raw.kind === 'retry_command';
  const row = arbiterRecord(raw, command ? ['kind', 'targetNode'] : ['kind', 'targetNode', 'instruction']);
  const target = targets.find((item) => item.node === row.targetNode);
  const kind = row.kind;

  if (!target || !['replay_current', 'return_to_node', 'retry_command'].includes(String(kind))
    || (kind !== 'return_to_node' && row.targetNode !== currentNode)
    || (command && (target.executorKind !== 'command' || !target.canRetryUnchanged))
    || (!command && (target.executorKind !== 'agent' || !target.acceptsInstruction))) {
    throw new ArbiterConversationError('invalid_target', 'Выбранный этап не может выполнить это указание.');
  }

  if (!command) {
    const instruction = arbiterText(row.instruction, ARBITER_LIMITS.instruction);

    if (/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(instruction)) {
      throw new ArbiterConversationError('invalid_instruction',
        'Указание может содержать печатные символы и переводы строки.');
    }
  }

  return row as unknown as ArbiterAction;
}

/**
 * Декодирует публичный итог отдельно от транспортных кадров.
 * Модель предлагает действия, а разрешение цели и последствия принадлежат серверу.
 */
export function decodeArbiterResult(
  value: unknown,
  targets: readonly ArbiterTarget[],
  currentNode: string,
): ArbiterResult {
  const row = arbiterRecord(value, ['summary', 'questions', 'proposals', 'technicalDetails']);
  const questions = uniqueList(row.questions, ARBITER_LIMITS.questions, (value) => {
    const question = arbiterRecord(value, ['id', 'text', 'options', 'allowCustom']);

    if (question.allowCustom !== true) {
      throw new ArbiterConversationError('invalid_request', 'Вопрос должен допускать свой ответ.');
    }

    return {
      id: arbiterText(question.id, 80),
      text: arbiterText(question.text, ARBITER_LIMITS.summary),
      allowCustom: true as const,
      options: uniqueList(question.options, ARBITER_LIMITS.options, (value) => {
        const option = arbiterRecord(value, ['id', 'label']);

        return { id: arbiterText(option.id, 80), label: arbiterText(option.label, 500) };
      }),
    };
  });
  const proposals = uniqueList<ArbiterProposal>(row.proposals, ARBITER_LIMITS.proposals, (value) => {
    const raw = record(value, 'proposal');
    const proposal = arbiterRecord(raw, [
      'id', 'kind', 'label', 'explanation', 'recommended', 'expectedResult',
      raw.kind === 'diagnose' ? 'diagnosticInstruction' : 'action',
    ]);
    const description = {
      id: arbiterText(proposal.id, 80),
      label: arbiterText(proposal.label, 500),
      explanation: arbiterText(proposal.explanation, ARBITER_LIMITS.summary),
      expectedResult: arbiterText(proposal.expectedResult, ARBITER_LIMITS.summary),
      recommended: boolean(proposal.recommended, 'recommended'),
    };

    if (proposal.kind === 'diagnose') {
      return {
        ...description,
        kind: 'diagnose',
        diagnosticInstruction: arbiterText(proposal.diagnosticInstruction, ARBITER_LIMITS.humanText)
      };
    }

    if (proposal.kind !== 'apply') {
      throw new ArbiterConversationError('invalid_request', 'Неизвестный вид предложения.');
    }

    return {
      ...description,
      kind: 'apply',
      action: decodeArbiterAction(proposal.action, targets, currentNode)
    };
  });

  if (!questions.length && !proposals.length) {
    throw new ArbiterConversationError(
      'bad_model_reply',
      'Арбитр не предложил следующего действия или вопроса.'
    );
  }

  return {
    summary: arbiterText(row.summary, ARBITER_LIMITS.summary),
    questions,
    proposals,
    technicalDetails: arbiterText(row.technicalDetails, ARBITER_LIMITS.technicalDetails, true),
  };
}

/**
 * Обсуждение, диагностика и применение имеют разные входные контракты.
 * Свободный текст обсуждения никогда не классифицируется как разрешение движения.
 */
export function decodeHumanIntent(kind: string, value: unknown): Record<string, unknown> {
  const raw = record(value, 'intent');

  if (kind === 'discuss') {
    if ('text' in raw) {
      const row = arbiterRecord(raw, ['text']);

      return { text: arbiterText(row.text, ARBITER_LIMITS.humanText) };
    }

    const row = arbiterRecord(raw, ['questionId', 'optionId' in raw ? 'optionId' : 'customAnswer']);

    return Object.fromEntries(Object.entries(row).map(([key, value]) => [
      key, arbiterText(value, key === 'customAnswer' ? ARBITER_LIMITS.humanText : 80),
    ]));
  }

  const row = arbiterRecord(raw, kind === 'apply' && 'customAction' in raw
    ? ['customAction'] : ['proposalId']);

  if ('proposalId' in row) {
    arbiterText(row.proposalId, 80);
  }

  return row;
}

/**
 * Принятый следующий ход сразу лишает старые варианты силы.
 * Ошибка новой модели не может восстановить прежнее решение.
 */
export function invalidateDecision<T extends { decisionRevision: number; result: unknown }>(value: T) {
  const { result: _previousResult, decisionRevision, ...rest } = value;

  return {
    ...rest,
    decisionRevision: decisionRevision + 1,
    result: null
  };
}
