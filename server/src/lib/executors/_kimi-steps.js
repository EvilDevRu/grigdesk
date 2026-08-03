import {
  base, cut, cutMiddle, lineCount, STEP_TEXT_LIMIT,
} from '../chat/stream-steps.js';

function textContent(content) {
  if (!Array.isArray(content)) return '';
  return content.map((entry) => {
    if (entry?.type === 'content' && entry.content?.type === 'text') return entry.content.text || '';
    if (entry?.type === 'diff') return entry.diff || '';
    return '';
  }).filter(Boolean).join('\n');
}

function inputText(update) {
  if (update?.rawInput !== undefined) {
    try { return JSON.stringify(update.rawInput); } catch { return String(update.rawInput); }
  }
  return textContent(update?.content);
}

function toolStep(update) {
  const raw = inputText(update);
  const title = String(update.title || update.kind || 'Действие');
  const kind = String(update.kind || 'other');
  if (kind === 'execute') {
    return { k: 'tool', id: update.toolCallId, name: 'Bash', title: cut(title, 200), command: cutMiddle(raw, STEP_TEXT_LIMIT), lang: 'bash' };
  }
  if (kind === 'edit') {
    const file = update.locations?.[0]?.path || update.rawInput?.path || '';
    return { k: 'tool', id: update.toolCallId, name: 'Edit', title: file ? base(file) : cut(title, 200), preview: cut(raw, 600) };
  }
  return {
    k: 'tool', id: update.toolCallId, name: title, title: cut(title, 200),
    preview: cut(raw, 600),
  };
}

/** Stateful ACP → provider-neutral ChatStep normalizer. */
export function createKimiStepNormalizer({ model = '', cwd = '', mode = 'manual' } = {}) {
  let started = false;
  const tools = new Map();

  return function normalize(params) {
    const update = params?.update;
    if (!update || typeof update !== 'object') return [];
    const out = [];
    if (!started && ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan'].includes(update.sessionUpdate)) {
      started = true;
      out.push({ k: 'start', model, cwd, mode });
    }

    // agent_thought_chunk может содержать внутреннюю цепочку рассуждений. В ленту
    // отдаём только факт работы, а не приватный reasoning text.
    if (update.sessionUpdate === 'agent_thought_chunk') {
      if (!tools.has('__thinking__')) {
        tools.set('__thinking__', true);
        out.push({ k: 'note', text: 'Kimi анализирует задачу…' });
      }
      return out;
    }

    if (update.sessionUpdate === 'tool_call') {
      const step = toolStep(update);
      tools.set(update.toolCallId, step);
      out.push(step);
      return out;
    }

    if (update.sessionUpdate === 'tool_call_update') {
      if (!tools.has(update.toolCallId)) {
        const step = toolStep(update);
        tools.set(update.toolCallId, step);
        out.push(step);
      }
      if (['completed', 'failed'].includes(update.status)) {
        const text = textContent(update.content);
        out.push({
          k: 'res', id: update.toolCallId, ok: update.status === 'completed',
          text: cut(text, update.status === 'completed' ? 400 : 600), lines: lineCount(text),
        });
      }
      return out;
    }

    if (update.sessionUpdate === 'plan') {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      const text = entries.map((entry) => `${entry.status || 'pending'}: ${entry.content || entry.title || ''}`).join('\n');
      if (text) out.push({ k: 'note', text: cut(text) });
    }
    return out;
  };
}

