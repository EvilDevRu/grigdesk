export const SPEECH_ERROR_CODES = Object.freeze({
  MODEL_MISSING: 'speech_model_missing',
  UNAVAILABLE: 'speech_unavailable',
  WARMUP_BUSY: 'speech_warmup_busy',
  STREAM_BUSY: 'speech_stream_busy',
});

export class SpeechRuntimeError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'SpeechRuntimeError';
    this.code = code;
  }
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  let current = error as { message?: unknown; stderr?: unknown; code?: unknown; cause?: unknown };
  for (let depth = 0; current && depth < 5; depth += 1) {
    parts.push(String(current.message || ''), String(current.stderr || ''), String(current.code || ''));
    current = current.cause as typeof current;
  }
  return parts.join('\n');
}

export function isCudaRuntimeFailure(error: unknown): boolean {
  return /cuda|cublas|cudnn|out of memory|memory allocation|driver version|shared object/i
    .test(errorText(error));
}

export function speechUnavailable(message: string, cause: unknown = undefined): SpeechRuntimeError {
  return new SpeechRuntimeError(message, SPEECH_ERROR_CODES.UNAVAILABLE, cause ? { cause } : {});
}

export function speechModelMissing(message: string, cause: unknown = undefined): SpeechRuntimeError {
  return new SpeechRuntimeError(message, SPEECH_ERROR_CODES.MODEL_MISSING, cause ? { cause } : {});
}

export function speechWarmupBusy(
  message = 'Достигнут лимит одновременных прогревов речи',
): SpeechRuntimeError {
  return new SpeechRuntimeError(message, SPEECH_ERROR_CODES.WARMUP_BUSY);
}

export function speechStreamBusy(
  message = 'Достигнут лимит одновременных потоков речи',
): SpeechRuntimeError {
  return new SpeechRuntimeError(message, SPEECH_ERROR_CODES.STREAM_BUSY);
}
