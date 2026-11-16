import type { ChatRunSnapshot } from '../../../../shared/chat/chatRun.ts';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


export interface ChatRuntimeRun {
  runId: string;
  turnId?: string;
  active: boolean;
  compact?: boolean;
  queuedCount?: number;
  source?: string;
  snapshot: ChatRunSnapshot | null;
}

interface StatusSession {
  id: string;
  sending?: boolean;
  compacting?: boolean;
  workdirChanging?: boolean;
  workdirProposal?: unknown;
  inflight?: number;
  messages?: {
    role?: string;
    queued?: boolean;
    delivery?: string;
  }[];
  workdirState?: { committed?: { cwd?: string; extraDirs?: string[] } | null } | null;
  workdirPreview?: { target?: { cwd?: string; extraDirs?: string[] } } | null;
}

export interface ChatStatusSelection {
  providerId: string;
  modelId: string;
  modelLabel: string;
}

export interface ChatStatus {
  phase: string;
  phaseLabel: string;
  thinking: boolean;
  runKey: string;
  providerId: string;
  modelId: string;
  modelLabel: string;
  modelKind: string;
  modelDetail: string;
  cwd: string;
  cwdLabel: string;
  cwdDetail: string;
  extraDirs: string[];
  detail: string;
}

function shortDirectory(cwd: string): string {
  return cwd.split('/').filter(Boolean).slice(-2).join('/') || cwd;
}

/**
 * Фаза запуска сильнее очереди следующей отправки и настроек селекта.
 * При неизвестной активности параметры не подставляются из изменяемого выбора чата.
 */
export function chatStatus(
  session: StatusSession,
  runtime: ChatRuntimeRun | null,
  selection: ChatStatusSelection,
): ChatStatus {
  const active = runtime?.active === true;
  const snapshot = active && runtime.snapshot?.chatKey === session.id
    && runtime.snapshot.runId === runtime.runId ? runtime.snapshot : null;
  let phase = 'idle';

  if (active) {
    phase = runtime.compact ? 'compact' : snapshot ? 'running'
      : runtime.source === 'background' ? 'background' : 'legacy';
  } else if (session.compacting) {
    phase = 'compact';
  } else if (session.workdirChanging) {
    phase = 'workdir';
  } else if (session.messages?.some((message) => message.role === 'user'
    && message.delivery === 'sending') || session.inflight) {
    phase = 'sending';
  } else if (runtime?.queuedCount || session.messages?.some((message) => message.role === 'user'
    && message.queued)) {
    phase = 'queued';
  } else if (session.sending && !runtime?.runId) {
    phase = 'legacy';
  }

  const unknown = ['background', 'legacy'].includes(phase) || (phase === 'compact' && !snapshot);
  const committed = session.workdirState?.committed;
  const preview = !session.workdirProposal && !session.workdirChanging
    ? session.workdirPreview?.target : null;
  const cwd = snapshot?.cwd || (unknown ? '' : committed?.cwd || preview?.cwd || '');
  const modelId = snapshot?.actualModelId || snapshot?.requestedModelId || (unknown ? '' : selection.modelId);
  const modelKind = snapshot
    ? snapshot.actualModelId
      ? translateUi('core.chatStatusReported')
      : translateUi('core.chatStatusRequested')
    : translateUi('core.chatStatusSelected');
  const modelDetail = snapshot?.modelSource === 'response' ? translateUi(
    'core.chatStatusMainAgentResponseModel',
  )
    : snapshot?.modelSource === 'session' ? translateUi('core.chatStatusTheExecutorReportedTheSessionModel')
      : snapshot ? translateUi('core.chatStatusTheModelWasRequestedFromTheExecutor')
        : translateUi('core.chatStatusSelectionForTheNextMessage');

  return {
    phase,
    phaseLabel: ({
      idle: '',
      running: '',
      compact: translateUi('core.chatStatusCompactingContext'),
      workdir: translateUi('core.chatStatusMovingTheFolder'),
      sending: translateUi('core.chatOtpravlyaetsya'),
      queued: translateUi('core.queued'),
      background: translateUi('core.chatStatusBackgroundActivity'),
      legacy: translateUi('core.chatStatusRunning'),
    } as Record<string, string>)[phase] || '',
    thinking: phase === 'running',
    runKey: `${session.id}:${runtime?.runId || phase}`,
    providerId: snapshot?.providerId || (unknown ? '' : selection.providerId),
    modelId,
    modelLabel: snapshot
      ? modelId
      : unknown ? translateUi('core.chatStatusTheCurrentTurnModelIsUnknown') : selection.modelLabel,
    modelKind: unknown ? '' : modelKind,
    modelDetail: unknown ? translateUi('core.chatStatusLaunchParametersAreNotConfirmed') : modelDetail,
    cwd,
    cwdLabel: cwd ? shortDirectory(cwd) : translateUi('core.chatStatusFolderNotSet'),
    cwdDetail: snapshot ? translateUi('core.chatStatusWorkingFolderAtLaunch')
      : committed?.cwd
        ? translateUi('core.chatStatusConfirmedWorkingFolder')
        : translateUi('core.chatStatusFolderForTheNextLaunch'),
    extraDirs: snapshot?.extraDirs || (unknown ? [] : committed?.extraDirs || preview?.extraDirs || []),
    detail: unknown ? translateUi('core.chatStatusLaunchParametersAreNotConfirmed')
      : session.workdirChanging || session.workdirProposal
        ? translateUi('core.chatStatusTheFolderChangeIsNotConfirmedYet')
        : '',
  };
}
