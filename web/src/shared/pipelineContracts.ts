import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from './uiLocalePort.ts';
import { isRecord } from '../../../shared/lib/objects.ts';
import type { StallPresentation } from '../../../shared/pipeline/stallPresentation.ts';
import type { AgentSilence } from '../../../shared/pipeline/agentActivity.ts';
import type { PipelineGraph } from '../../../shared/pipeline/pipelineWait.ts';

const t = localeTranslator(uiLocalePort);

export interface PipelineTask extends Record<string, unknown> {
  task: string | number;
  source?: 'grigdesk';
  title?: string;
  profile?: string;
  route?: string;
  workspaceMode?: string;
  readOnly?: boolean;
  arbitrating?: import('../../../shared/pipeline/factoryGraphContracts.ts').ArbiterRun | null;
  attempt?: string | number | null;
  daemonAlive?: boolean;
  result?: string | null;
  silence?: AgentSilence | null;
  stall?: {
    kind: string;
    title: string;
    hint?: string;
    stage?: string | null;
    node?: string | null;
    stop?: string;
    outcome?: string;
    fails?: number | null;
    presentation?: StallPresentation;
    phase?: string;
    since?: string | null;
    comment?: string | null;
    arbitrable?: boolean;
    arbiter?: ArbiterCard | null;
  } | null;
}

export interface LiveGraph extends PipelineGraph, Record<string, unknown> {
  nodes?: Record<string, [string | number, string?, string?]>;
  progress?: {
    current?: string | null;
    done?: number;
    total?: number;
  };
}

export interface PipelineNotice {
  task: string;
  taskTitle: string;
  kind?: string;
  title?: string;
  hint?: string;
  stage?: string;
  text?: string;
  premature?: boolean;
}

export interface TaskObservation {
  attempt: string | number | null;
  daemon: string;
  result: string | null;
  stall: string | null;
  gateKnown: boolean;
  gate: string | null;
  progress: { done: number; total: number } | null;
  stage: {
    id: string;
    label: string;
    state: string | null;
  } | null;
}

/**
 * Сводка допускает старые необязательные поля, сохраняя исходные объекты.
 * Проверяется до обхода задач и до отправки первого оповещения.
 */
function isPipelineTask(value: unknown): value is PipelineTask {
  return isRecord(value) && ['string', 'number'].includes(typeof value.task)
    && (value.source == null || value.source === 'grigdesk')
    && (value.title == null || typeof value.title === 'string')
    && (value.daemonAlive == null || typeof value.daemonAlive === 'boolean')
    && (value.attempt == null || ['string', 'number'].includes(typeof value.attempt))
    && (value.result == null || typeof value.result === 'string')
    && (value.silence == null || isRecord(value.silence))
    && (value.stall == null || (isRecord(value.stall)
      && typeof value.stall.kind === 'string' && typeof value.stall.title === 'string'
      && ['hint', 'stage'].every((key) => value.stall && isRecord(value.stall)
        && (value.stall[key] == null || typeof value.stall[key] === 'string'))));
}

/**
 * Некорректный контейнер не объявляется пустым успешным снимком.
 * Неизвестные расширения и отсутствие полей старого сервера сохраняются.
 */
export function decodePipelineTasks(value: unknown): { tasks?: PipelineTask[]; silenceWindow?: number } {
  if (!isRecord(value) || (value.tasks != null
    && (!Array.isArray(value.tasks) || !value.tasks.every(isPipelineTask)))
    || (value.silenceWindow != null && typeof value.silenceWindow !== 'number')) {
    throw new Error(t('core.invalidPipelineSnapshot'));
  }

  return value;
}

/**
 * Живой граф шире renderer DTO: здесь проверяется читаемый вотчером envelope.
 * Неверный граф остаётся неизвестным и не создаёт ложного ожидания на воротах.
 */
function isLiveGraph(value: unknown): value is LiveGraph {
  if (!isRecord(value)) {
    return false;
  }

  return (value.route == null || typeof value.route === 'string')
    && (value.nodes == null || (isRecord(value.nodes) && Object.values(value.nodes).every((node) => (
    Array.isArray(node) && node.every((part, index) => part == null || typeof part === 'string'
      || (index === 0 && typeof part === 'number'))
  )))) && (value.statuses == null || (isRecord(value.statuses)
    && Object.values(value.statuses).every((status) => typeof status === 'string')))
    && (value.pos == null || isRecord(value.pos))
    && (value.progress == null || (isRecord(value.progress)
      && (value.progress.current == null || typeof value.progress.current === 'string')
      && ['done', 'total'].every((key) => value.progress && isRecord(value.progress)
        && (value.progress[key] == null || typeof value.progress[key] === 'number'))));
}

/**
 * Возвращает проверенный исходный граф без проекции расширений движка.
 * Ошибка формы следует прежнему пути ошибки запроса.
 */
export function decodeLiveGraph(value: unknown): LiveGraph {
  if (!isLiveGraph(value)) {
    throw new Error(t('core.invalidPipelineGraph'));
  }

  return value;
}

export interface ArbiterCard {
  node?: string;
  verdict?: string;
  model?: string;
  card?: {
    what?: string;
    why?: string;
    proof?: string;
    risk?: string;
  };
}

export interface NodeVerdict {
  stop?: string;
  rewind?: string;
  reviewed?: string[];
  omitted?: number;
  findings?: Array<{
    id: string;
    summary: string;
    severity?: string;
    anchor?: string;
  }>;
}

export interface NodeMetadata {
  at?: string;
  dur?: number;
  fanout?: number;
  denials?: number;
  tokens?: number;
  fails?: number;
  comment?: string;
  stall?: {
    presentation?: StallPresentation;
    outcome?: string;
    title?: string;
    hint?: string;
  } | null;
  verdict?: NodeVerdict;
  bootstrapStop?: {
    reason: string;
    visitId: string;
    recordHash: string;
    state?: string;
    decision?: { recordHash?: string } | null;
    verdict?: { findings?: Array<{ id: string; summary: string }> } | null;
  };
  runner?: import('./runnerDisplay.ts').RunnerState & Record<string, unknown> & {
    source?: string;
    reason?: string;
    chain: string[];
    attempts?: Array<import('./runnerDisplay.ts').RunnerAttempt & {
      id?: string;
      epoch?: number;
      result?: string;
    }>;
  };
}

export interface PipelineViewGraphSource extends LiveGraph {
  pos: Record<string, [number, number]>;
  nodes: Record<string, [string | number, string?, string?]>;
  edges?: import('../../../shared/pipeline/factoryGraphContracts.ts').GraphEdge[];
  statuses: Record<string, string>;
  progress: {
    current?: string | null;
    done: number;
    total: number;
  };
  keys?: Record<string, string>;
  runnerKeys?: Record<string, string>;
  nodeMeta?: Record<string, NodeMetadata>;
  nodeOrigins?: Record<string, import('../../../shared/pipeline/factoryGraphContracts.ts').GraphNodeOrigin>;
  arbiterLog?: ArbiterCard[];
  daemonAlive?: boolean;
  readOnly?: boolean;
  halted?: string | null;
  runnerPolicy?: import('./runnerDisplay.ts').RunnerState;
  fePort?: number | null;
  apiPort?: number | null;
  sandbox?: {
    step: number;
    total: number;
    label: string;
  } | null;
  timing?: {
    workSec?: number;
    runningSinceMs?: number;
    approximate?: boolean;
    source?: string;
  };
  loops?: Record<string, number>;
}

export interface PipelineViewGraph extends PipelineViewGraphSource {
  edges: NonNullable<PipelineViewGraphSource['edges']>;
}

export interface PipelineViewTask extends PipelineTask {
  graph: PipelineViewGraph;
}

export interface PipelineActivity {
  journalFresh?: boolean;
  journalAgeSec?: number;
  live?: {
    model?: string;
    actions: Array<{
      type: string;
      status?: string;
      name?: string;
      desc?: string;
      tokens?: number;
      tools?: number;
      lastTool?: string;
      text?: string;
    }>;
  } | null;
  tail?: Array<{ ts: string; event: string }>;
}

/**
 * Полный экран требует контейнеров renderer и progress до публикации нового снимка.
 * Отказ одного графа сохраняет прежний список и следует обычной ошибке загрузки.
 */
function isPipelineViewGraph(value: unknown): value is PipelineViewGraphSource {
  return isLiveGraph(value) && isRecord(value.pos) && isRecord(value.nodes)
    && (value.edges == null || Array.isArray(value.edges))
    && isRecord(value.statuses) && isRecord(value.progress)
    && typeof value.progress.done === 'number' && typeof value.progress.total === 'number'
    && ['keys', 'runnerKeys', 'nodeMeta', 'nodeOrigins', 'timing', 'runnerPolicy', 'loops']
      .every((key) => value[key] == null || isRecord(value[key]))
    && (value.arbiterLog == null || (Array.isArray(value.arbiterLog) && value.arbiterLog.every(isRecord)))
    && (value.nodeMeta == null || (isRecord(value.nodeMeta)
      && Object.values(value.nodeMeta).every((meta) => isRecord(meta)
        && (meta.verdict == null || (isRecord(meta.verdict)
          && (meta.verdict.findings == null || Array.isArray(meta.verdict.findings))))
        && (meta.runner == null || (isRecord(meta.runner)
          && (meta.runner.chain == null || Array.isArray(meta.runner.chain))
          && (meta.runner.attempts == null || Array.isArray(meta.runner.attempts)))))));
}

/**
 * Возвращаем тот же граф с расширениями движка и прежними optional-полями.
 * Клиент не подменяет полный live graph узким DTO визуальной схемы.
 */
export function decodePipelineViewGraph(value: unknown): PipelineViewGraph {
  if (!isPipelineViewGraph(value)) {
    throw new Error(t('core.invalidPipelineGraph'));
  }

  return { ...value, edges: value.edges || [] };
}

/**
 * Список исполнителей проверяется перед заполнением выбора override.
 * Повреждённый ответ оставляет блок выбора скрытым, как при отказе запроса.
 */
export function decodeFactoryRunners(value: unknown): string[] {
  if (!isRecord(value) || (value.runners != null && (!Array.isArray(value.runners)
    || !value.runners.every((item) => typeof item === 'string')))) {
    throw new Error(t('core.invalidPipelineSnapshot'));
  }

  return Array.isArray(value.runners) ? value.runners : [];
}

/**
 * Активность проверяется до замены живой ленты и журнала открытого узла.
 * Неверный контейнер остаётся ошибкой чтения, без нового опроса или сброса графа.
 */
function isPipelineActivity(value: unknown): value is PipelineActivity {
  if (!isRecord(value)
    || (value.live != null && (!isRecord(value.live) || !Array.isArray(value.live.actions)
      || !value.live.actions.every((action) => isRecord(action) && typeof action.type === 'string')))
    || (value.tail != null && (!Array.isArray(value.tail)
      || !value.tail.every((line) => isRecord(line) && typeof line.ts === 'string'
        && typeof line.event === 'string')))) {
    return false;
  }

  return true;
}

/**
 * Оболочка ошибки сохраняет прежнюю политику компонента.
 * Проверенный объект ленты не проецируется и не теряет расширения.
 */
export function decodePipelineActivity(value: unknown): PipelineActivity {
  if (!isPipelineActivity(value)) {
    throw new Error(t('core.invalidPipelineSnapshot'));
  }

  return value;
}

export interface PipelineReply {
  resumed?: boolean;
  resumeError?: string;
  downOutput?: string;
  note?: string;
  text?: string;
  branches?: Array<{ repo: string; state: string }>;
  resolved?: boolean;
  node?: string;
  card?: ArbiterCard['card'];
}

/**
 * Читаемые поля команды проверяются после единственного POST.
 * Неверный ACK не означает откат сервера и не вызывает повторную мутацию.
 */
function isPipelineReply(value: unknown): value is PipelineReply {
  if (!isRecord(value)
    || !['resumeError', 'downOutput', 'note', 'text', 'node']
      .every((key) => value[key] == null || typeof value[key] === 'string')
    || (value.branches != null && (!Array.isArray(value.branches)
      || !value.branches.every((item) => isRecord(item) && typeof item.repo === 'string'
        && typeof item.state === 'string')))
    || (value.card != null && !isRecord(value.card))) {
    return false;
  }

  return true;
}

/**
 * Ошибка формы ACK показывается прежним обработчиком команды.
 * Запрос не повторяется, даже если сервер уже применил действие.
 */
export function decodePipelineReply(value: unknown): PipelineReply {
  if (!isPipelineReply(value)) {
    throw new Error(t('core.invalidPipelineSnapshot'));
  }

  return value;
}
