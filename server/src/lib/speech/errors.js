export const SPEECH_ERROR_CODES = Object.freeze({
  MODEL_MISSING: 'speech_model_missing',
  UNAVAILABLE: 'speech_unavailable',
  WARMUP_BUSY: 'speech_warmup_busy',
  STREAM_BUSY: 'speech_stream_busy',
});

export class SpeechRuntimeError extends Error {
  constructor(message, code, options = {}) {
    super(message, options);
    this.name = 'SpeechRuntimeError';
    this.code = code;
  }
}

function errorText(error) {
  const parts = [];
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    parts.push(current.message || '', current.stderr || '', current.code || '');
    current = current.cause;
  }
  return parts.join('\n');
}

export function isCudaRuntimeFailure(error) {
  return /cuda|cublas|cudnn|out of memory|memory allocation|driver version|shared object/i
    .test(errorText(error));
}

export function speechUnavailable(message, cause = undefined) {
  return new SpeechRuntimeError(message, SPEECH_ERROR_CODES.UNAVAILABLE, cause ? { cause } : {});
}

export function speechModelMissing(message, cause = undefined) {
  return new SpeechRuntimeError(message, SPEECH_ERROR_CODES.MODEL_MISSING, cause ? { cause } : {});
}

export function speechWarmupBusy(message = 'Достигнут лимит одновременных прогревов речи') {
  return new SpeechRuntimeError(message, SPEECH_ERROR_CODES.WARMUP_BUSY);
}

export function speechStreamBusy(message = 'Достигнут лимит одновременных потоков речи') {
  return new SpeechRuntimeError(message, SPEECH_ERROR_CODES.STREAM_BUSY);
}
