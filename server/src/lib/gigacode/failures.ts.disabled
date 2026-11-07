import { cleanRunnerFailureMessage } from '../runnerFailure.ts';
import type { RunnerFailure } from '../runnerFailure.ts';

const KNOWN_EVENTS = new Set([
  'run_start', 'prompt_started', 'agent_message_chunk', 'agent_thought_chunk',
  'tool_call', 'tool_call_update', 'permission', 'turn_end', 'run_error',
]);

/**
 * Анализируется только versioned журнал host-wrapper, а не похожие слова в tool output.
 * Неполный поток или новая форма закрывают доказательство отсутствия уже сделанной работы.
 */
export function inspectGigaCodeFailure(raw: string) {
  let valid = true;
  let activity = false;
  let failure: RunnerFailure | null = null;
  let earlyAuth = false;

  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    try {
      const row = JSON.parse(line);

      if (!row || typeof row !== 'object' || !KNOWN_EVENTS.has(row.event)) {
        valid = false;
        continue;
      }

      if (['prompt_started', 'agent_message_chunk', 'agent_thought_chunk',
        'tool_call', 'tool_call_update', 'permission'].includes(row.event)) {
        activity = true;
      }

      if (row.event === 'run_error' && row.schema === 'gigacode-acp-v1') {
        const code = typeof row.code === 'string' ? row.code.slice(0, 100) : 'gigacode_wrapper_error';

        failure = {
          code: /^[a-zA-Z0-9_-]+$/u.test(code) ? code : 'gigacode_wrapper_error',
          message: cleanRunnerFailureMessage(String(row.message || 'Ошибка GigaCode')),
        };
        earlyAuth = row.phase === 'pre-prompt'
          && ['gigacode_auth_required', 'gigacode_not_installed'].includes(code);
      } else if (row.event === 'turn_end') {
        failure = null;
        earlyAuth = false;
      }
    } catch {
      valid = false;
    }
  }

  return {
    valid,
    activity,
    failure,
    classification: valid && !activity && earlyAuth ? 'provider_unavailable' : 'unknown',
  };
}

/**
 * Счётчик читает реальные уникальные toolCallId, включая update без отдельного старта.
 * Описание Agent в тексте и повтор terminal того же вызова не увеличивают значение.
 */
export function gigaCodeFanoutCount(raw: string): number {
  const ids = new Set<string>();

  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    const row = JSON.parse(line);

    if (['tool_call', 'tool_call_update'].includes(row.event) && row.name === 'agent'
      && typeof row.toolCallId === 'string' && row.toolCallId) {
      ids.add(row.toolCallId);
    }
  }

  return ids.size;
}
