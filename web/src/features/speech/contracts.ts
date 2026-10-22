import { isRecord } from '../../../../shared/lib/objects.ts';
import type { createSpeechStream } from '../../shared/speechStream.ts';
import type { api } from '../../shared/apiClient.ts';

export type SpeechError = Error & { code?: string };
export type Timer = ReturnType<typeof setTimeout> | null;

export interface SpeechSettings extends Record<string, unknown> {
  engine?: string;
  browserProcessing?: string;
  browserAutoConsent?: boolean;
  language?: string;
  dictionary?: string;
  revision?: string;
  local?: { ready?: boolean; reason?: string };
}

export interface RecognitionOptions {
  langs: string[];
  processLocally: boolean;
}

export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  processLocally?: boolean;
  phrases?: unknown[];
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{
    isFinal?: boolean;
    0?: { transcript?: string };
    item?: (index: number) => { transcript?: string };
  }> }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface RecognitionCtor {
  new(): Recognition;
  prototype: Partial<Recognition>;
  available?: (options: RecognitionOptions) => Promise<string | boolean>;
  install?: (options: RecognitionOptions) => Promise<boolean>;
}

export interface SpeechWindow extends Window {
  SpeechRecognition?: RecognitionCtor;
  webkitSpeechRecognition?: RecognitionCtor;
  SpeechRecognitionPhrase?: new(text: string, boost: number) => unknown;
  webkitAudioContext?: typeof AudioContext;
}

export interface LeaseState {
  phase: string;
  busy: boolean;
  prompt: string | null;
  interim: string;
  notice: string;
  error: SpeechError | null;
  blockedByOther: boolean;
}

export interface LeaseHandlers {
  onState?: (state: LeaseState) => void;
  onCommit?: (text: string) => void;
  onInterim?: (text: string) => void;
  onFinal?: (text: string, detail: { generation: number }) => void;
  onError?: (error: SpeechError) => void;
}

export interface Lease {
  owner: unknown;
  handlers: LeaseHandlers;
  mutableState: LeaseState;
  state: Readonly<LeaseState>;
  released: boolean;
  start(): Promise<Lease>;
  stop(): Promise<boolean>;
  cancel(): Promise<boolean>;
  confirmBrowserConsent(): Promise<boolean>;
  useWhisper(): Promise<boolean>;
  installBrowserLanguage(): Promise<boolean>;
  release(): Promise<boolean>;
}

export interface SettingsContext {
  generation: number;
  epoch: number;
  revision: string;
  engine?: string;
  browserProcessing?: string;
  browserAutoConsent: boolean;
}

type LiveController = Awaited<ReturnType<typeof createSpeechStream>>;

export interface Capture {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  generation: number;
  completionGeneration: number;
  commit: boolean;
  stopped: boolean;
  released: boolean;
  warmupId: string;
  warmupPromise: Promise<string | null>;
  warmupStarted: boolean;
  warmupCancelled: boolean;
  warmupDeleteSent: boolean;
  warmupTimer: Timer;
  resolveWarmup: ((id: string | null) => void) | null;
  liveAbort: AbortController | null;
  livePromise: Promise<LiveController | null>;
  liveController: LiveController | null;
  liveSessionId: string;
  liveStopPromise: Promise<unknown> | null;
  liveError: Error | null;
  liveReady: boolean;
  liveFinalText: string;
  stopRequested: boolean;
  cancelled: boolean;
  livePreflightUnsupported: boolean;
  recorderStopTimer: Timer;
}

export interface Run {
  lease: Lease;
  generation: number;
  settingsEpoch: number;
  desired: boolean;
  cancelled: boolean;
  terminalSent: boolean;
  committed: string[];
  activeRecognition: Recognition | null;
  drainingRecognition: Recognition | null;
  browserDrainTimer: Timer;
  browserRestartTimer: Timer;
  browserRecognitionCtor: RecognitionCtor | null;
  browserRetries: {
    network: number;
    noSpeech: number;
  };
  phrasesDisabled: boolean;
  pendingBrowserInstall: {
    Ctor: RecognitionCtor;
    context: SettingsContext;
    options: RecognitionOptions;
  } | null;
  localCapture: Capture | null;
  localTranscription: Capture | null;
  transcriptionAbort: AbortController | null;
  pendingMutation: boolean;
}

export interface ControllerOptions {
  settings?: {
    read(): unknown;
    apply?: (value: unknown) => unknown;
  };
  apiClient?: Pick<typeof api, 'get' | 'post' | 'upload' | 'del'>;
  browser?: Partial<{
    isSecureContext(): boolean;
    recognitionCtor(): RecognitionCtor | null;
    phraseCtor(): SpeechWindow['SpeechRecognitionPhrase'] | null;
    uiLanguage(): string;
  }>;
  media?: Partial<{
    getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
    hasGetUserMedia(): boolean;
    recorderCtor(): typeof MediaRecorder | null;
    BlobCtor: typeof Blob;
    FormDataCtor: typeof FormData;
    AbortControllerCtor: typeof AbortController;
  }>;
  localStream?: Partial<{ supported(): boolean; open: typeof createSpeechStream }>;
  clock?: Partial<{
    now(): number;
    randomUUID(): string;
    setTimeout: typeof setTimeout;
    clearTimeout: (timer: Timer) => void;
  }>;
  limits?: Partial<Record<'browserDrainTimeoutMs' | 'localStreamLagNoticeMs'
    | 'localRecorderStopTimeoutMs' | 'localWarmupTimeoutMs', number>>;
}

/**
 * Настройки проверяются до использования consent и revision в контроллере.
 * Отсутствующие optional-поля старого ответа не достраиваются новым значением.
 */
export function isSpeechSettings(value: unknown): value is SpeechSettings {
  return isRecord(value)
    && ['engine', 'browserProcessing', 'language', 'dictionary', 'revision']
      .every((key) => value[key] == null || typeof value[key] === 'string')
    && (value.browserAutoConsent == null || typeof value.browserAutoConsent === 'boolean')
    && (value.local == null || (isRecord(value.local)
      && (value.local.ready == null || typeof value.local.ready === 'boolean')
      && (value.local.reason == null || typeof value.local.reason === 'string')));
}
