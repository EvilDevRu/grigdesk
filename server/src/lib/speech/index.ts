export {
  SPEECH_MODEL_CATALOG,
  SPEECH_MODEL_IDS,
  isSpeechModelId,
  speechModel,
} from './catalog.ts';
export {
  DEFAULT_VIDEO_INITIAL_PROMPT,
  INITIAL_PROMPT_MAX_CHARS,
  SPEECH_PRESETS,
  SPEECH_SCENARIOS,
  normalizeSpeechOptions,
  resolveSpeechOptions,
} from './options.ts';
export {
  INGEST_JOB_SCHEMA_VERSION,
  SPEECH_TIMESTAMP_END_TOLERANCE_SECONDS,
  buildTranscribeArgv,
  decodeSpeechTranscript,
  decodeIngestJob,
  encodeIngestJob,
  pythonEnv,
} from './transport.ts';
export type {
  SpeechTranscript,
  SpeechTranscriptSpan,
  SpeechWordTimingStatus,
} from './transport.ts';
export {
  SPEECH_ERROR_CODES,
  SpeechRuntimeError,
  isCudaRuntimeFailure,
  speechModelMissing,
  speechStreamBusy,
  speechUnavailable,
  speechWarmupBusy,
} from './errors.ts';
export {
  CUDA_PROBE_PY,
  CUDA_STATES,
  MODEL_CACHE_PROBE_PY,
  SPEECH_LANGUAGES,
  inspectSpeechModelCache,
  probeSpeechModelCache,
  residentUnavailable,
  runCudaCanary,
} from './capabilities.ts';
export {
  WARMUP_WORKER_PY,
  buildWarmupArgv,
  createWarmupProcess,
  readProcessIdentity,
  sameProcessIdentity,
  speechOptionsRevision,
} from './warmup.ts';
export {
  SPEECH_STREAM_AUDIO,
  SPEECH_STREAM_PROTOCOL_VERSION,
  STREAM_WORKER_PY,
  buildSpeechStreamArgv,
  createSpeechStreamProcess,
} from './streamProcess.ts';
export {
  SpeechStreamSession,
  advanceLocalAgreement,
  createSpeechStreamSession,
  speechWordsText,
} from './stream.ts';
export {
  ACTIVE_MODEL_JOB_STATUSES,
  MODEL_JOB_KINDS,
  MODEL_JOB_STATUSES,
  TERMINAL_MODEL_JOB_STATUSES,
  ModelJobError,
  ModelJobManager,
  decodeModelJob,
  encodeModelJob,
  publicModelJob,
  readModelJobFile,
  writeModelJobFile,
} from './modelJobs.ts';
export { SpeechRuntime } from './runtime.ts';
