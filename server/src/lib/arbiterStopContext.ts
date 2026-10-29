import {
  ArbiterConversationError,
  decodeStopIdentity,
} from '../../../shared/pipeline/arbiterConversation.ts';
import type { ArbiterTarget } from '../../../shared/pipeline/arbiterConversation.ts';
import { readFactoryStageEvents } from './factoryAttemptLedger.ts';
import type { FactoryStageEvent } from './factoryAttemptLedger.ts';
import type { FactoryStateAdapter } from '../adapters/factoryState.ts';
import { RoutesStore } from '../modules/routes/store.ts';
import { resolveNode } from './stages.ts';

type TrustedAttempt = Awaited<ReturnType<FactoryStateAdapter['readTrustedAttempt']>>;
type StopAttempt = Pick<TrustedAttempt, 'task' | 'profile' | 'attempt' | 'terminal' | 'bootstrapStop'
  | 'cursor' | 'stageIdentity'>;

interface StopEvidence {
  sequence: number;
  kind: string;
  node: string;
  reason?: string | null;
  outcome?: string | null;
  action?: { stop?: string; rewind?: string };
  verdict?: {
    owner?: string | null; findings?: {
      summary?: string;
      anchor?: string;
      id?: string
    }[]
  };
}

interface StopRoute {
  sequence: string[] | { main: string[]; tail: string[] };
  nodes: {
    id: string;
    executor: string;
    label?: string;
    title?: string;
    policy?: unknown
  }[];
}

/**
 * Bootstrap, ворота ожидания и терминал сохраняют собственный порядок продолжения.
 * Ранний отбор также не требует route pin у ещё не выбравшей маршрут разведки.
 */
function hasArbiterStop(trusted: StopAttempt) {
  return !trusted.terminal && !trusted.bootstrapStop && trusted.cursor?.state === 'stopped'
    && ['human', 'no-progress', 'rewind-limit'].includes(trusted.cursor.stop || '');
}

/**
 * Собирает источник из полного exact события, а цели — из закреплённого маршрута.
 * Mutable отчёт без существующей visit binding не приписывается новому визиту.
 */
export function buildArbiterStopContext(
  trusted: StopAttempt,
  events: readonly StopEvidence[],
  route: StopRoute,
) {
  const stop = trusted.cursor?.stop;
  const event = events.at(-1);

  if (!hasArbiterStop(trusted)
    || !trusted.stageIdentity || !event || event.sequence !== trusted.stageIdentity.sequence
    || (event.action?.stop !== stop && event.kind !== stop)
    || !route.nodes.some((node) => node.id === event.node && ['agent', 'command'].includes(node.executor))) {
    throw new ArbiterConversationError(
      'not_arbitrable',
      'Эта остановка имеет отдельный порядок продолжения.',
      409
    );
  }

  const identity = decodeStopIdentity({
    task: trusted.task,
    profile: trusted.profile,
    attempt: trusted.attempt,
    node: event.node,
    stop,
    stageSequence: trusted.stageIdentity.sequence,
    stageHeadHash: trusted.stageIdentity.headEventHash,
  });
  const visited = new Set(events.map((row) => row.node));
  const sequence = Array.isArray(route.sequence) ? route.sequence
    : [...route.sequence.main, ...route.sequence.tail];
  const labelOf = (node: string) => {
    const definition = route.nodes.find((row) => row.id === node);

    return definition?.label || definition?.title || resolveNode(node)[1];
  };
  const targets: ArbiterTarget[] = sequence.flatMap((node, index) => {
    const definition = route.nodes.find((row) => row.id === node);

    if (!definition || !visited.has(node)
      || !['agent', 'command'].includes(definition.executor)
      || (definition.executor === 'command' && node !== event.node)) {
      return [];
    }

    return [{
      node,
      label: labelOf(node),
      executorKind: definition.executor as 'agent' | 'command',
      acceptsInstruction: definition.executor === 'agent',
      canRetryUnchanged: definition.executor === 'command' && node === event.node,
      resetNodes: sequence.slice(index),
      resetLabels: sequence.slice(index).map(labelOf),
    }];
  });
  const command = route.nodes.find((row) => row.id === event.node)?.executor === 'command';
  const findings = (event.verdict?.findings || []).map((finding) => [
    finding.summary || '', finding.anchor ? `(${finding.anchor})` : '',
  ].filter(Boolean).join(' '));
  const sourceText = [
    event.reason,
    ...findings,
    'Исполнитель не оставил отдельного сообщения. Здесь показан вердикт текущего захода.',
  ].filter(Boolean).join('\n\n');

  return {
    identity,
    targets,
    sourceText,
    sourceLabel: command ? 'Сообщение проверки' : 'Исполнитель этапа',
    reportPath: null,
    evidence: event,
    policies: route.nodes.filter((row) => visited.has(row.id))
      .map((row) => ({ node: row.id, policy: row.policy })),
  };
}

export type ArbiterStopContext = ReturnType<typeof buildArbiterStopContext>;

/**
 * Читает graph authority и hash-chain для одной и той же trusted попытки.
 * Подмена каталога или новой остановки прерывает admission до вызова модели.
 */
export async function readArbiterStopContext(
  factoryState: FactoryStateAdapter,
  config: { factoryControlDir: string; routesDir: string },
  task: string,
): Promise<ArbiterStopContext> {
  const trusted = await factoryState.readTrustedAttempt(task);

  if (!hasArbiterStop(trusted)) {
    throw new ArbiterConversationError('not_arbitrable',
      'Эта остановка имеет отдельный порядок продолжения.', 409);
  }

  const { route } = await new RoutesStore({ baseDir: config.routesDir }).readRoute(
    trusted.profile || '', trusted.route || '', trusted.routeHash || '',
  );
  const events: FactoryStageEvent[] = await readFactoryStageEvents(config.factoryControlDir, trusted);

  return buildArbiterStopContext(trusted, events, route as unknown as StopRoute);
}
