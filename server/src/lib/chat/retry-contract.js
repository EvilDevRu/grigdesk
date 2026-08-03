// Executor сам объявляет границу допустимого автоматического повтора. Для ACP после
// принятого prompt повтор опасен: действие могло выполниться, даже если ответ потерян.

export const RETRY_CONTRACT = Object.freeze({
  LEGACY_EMPTY_RUN_ONCE: 'legacy_empty_run_once',
  PRE_PROMPT_ONLY: 'pre_prompt_only',
  NEVER: 'never',
});

export function mayRetryEmptyRun(executor, out, { compact = false } = {}) {
  if (compact || !out?.emptyRun) return false;
  const contract = executor?.retryContract || RETRY_CONTRACT.LEGACY_EMPTY_RUN_ONCE;
  if (contract === RETRY_CONTRACT.NEVER) return false;
  if (contract === RETRY_CONTRACT.PRE_PROMPT_ONLY) return out.retryState === 'pre_prompt';
  return contract === RETRY_CONTRACT.LEGACY_EMPTY_RUN_ONCE;
}

// Контракт кандидата фиксируется до подключения executor-а, чтобы fake/offline tests
// не могли случайно унаследовать legacy-поведение Claude/Codex.
export const KIMI_RETRY_CONTRACT = RETRY_CONTRACT.PRE_PROMPT_ONLY;
