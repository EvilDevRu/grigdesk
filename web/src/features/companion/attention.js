// Сводит снимки чата и конвейера к краткому состоянию внимания голосового компаньона.
const INTERACTION_PRIORITY = ['listening', 'transcribing', 'speaking', 'thinking', 'open'];

function taskIds(values) {
  const ids = new Set();
  for (const value of values || []) {
    const id = String(value?.task ?? '').trim();
    if (/^[1-9][0-9]{0,18}$/.test(id)) ids.add(id);
  }
  return [...ids].sort((a, b) => Number(a) - Number(b));
}

function attentionState({ pipeline = {}, chat = {} }) {
  const stalled = taskIds([...(pipeline.stalled || []), ...(pipeline.silent || [])]);
  const waitingTasks = taskIds(pipeline.waiting);
  const running = taskIds(pipeline.running);
  const chatId = typeof chat.id === 'string' ? chat.id : '';
  const chatWait = !!chatId && (chat.pending || []).some((item) => (
    (item?.kind === 'perm' || item?.kind === 'question') && item.chatKey === chatId
  ));

  if (stalled.length) {
    return { kind: 'stall', count: stalled.length, taskIds: stalled, chatId: null };
  }
  if (chatWait || waitingTasks.length) {
    return {
      kind: 'wait',
      count: waitingTasks.length + (chatWait ? 1 : 0),
      taskIds: waitingTasks,
      chatId: chatWait ? chatId : null,
    };
  }
  if (chat.unread || running.length) {
    return {
      kind: 'info',
      count: running.length + (chat.unread ? 1 : 0),
      taskIds: running,
      chatId: chat.unread && chatId ? chatId : null,
    };
  }
  return { kind: 'none', count: 0, taskIds: [], chatId: null };
}

/** Чистая проекция поверх уже загруженных снимков чата и notify-watch. */
export function reduceCompanionState(input = {}) {
  const interaction = INTERACTION_PRIORITY.find((name) => input.interaction?.[name]) || 'idle';
  const attention = attentionState(input);
  Object.freeze(attention.taskIds);
  Object.freeze(attention);
  return Object.freeze({ interaction, attention });
}
