const TASK_ID_RE = /^[1-9][0-9]{0,18}$/;

function taskFromScope(scope) {
  if (scope?.kind !== 'task') return null;
  const taskId = String(scope.taskId || '').trim();
  return TASK_ID_RE.test(taskId) ? taskId : null;
}

/**
 * Фоновая политика между контекстом страницы и обычным стором чата. Она никогда не ищет
 * сессии по заголовку или задаче: логическую идентичность разрешает только атомарная серверная операция ensure.
 */
export function createCompanionChatBridge({ chat, uiContext, router, onTarget = null }) {
  if (!chat || !uiContext || !router) throw new TypeError('Companion bridge требует chat, uiContext и router');
  let currentChatId = null;
  let currentTaskId = null;
  let targetRevision = 0;

  async function ensureTask(taskId, targetToken = null) {
    const ownRevision = ++targetRevision;
    const targetTaskId = taskId == null ? null : String(taskId);
    // Незавершённый ensure для новой логической области не должен оставлять прежний точный id
    // допустимой целью Stop или глубокой ссылки. Новый id становится доступен только после успеха ensure.
    if (currentTaskId !== targetTaskId) currentChatId = null;
    currentTaskId = targetTaskId;
    const session = await chat.ensureCompanion({ taskId });
    if (!session?.id || session.purpose !== 'companion') {
      throw new Error('Не удалось выбрать companion-чат.');
    }
    if (ownRevision === targetRevision) {
      currentChatId = session.id;
      currentTaskId = session.taskId == null ? null : String(session.taskId);
    }
    // Даже устаревшая ревизия навигации уже может владеть настоящим ходом модели. Всегда
    // публикуем её точную идентичность с неизменяемым токеном, чтобы Stop мог к ней привязаться;
    // потребитель отдельно решает, можно ли показывать эту цель в видимом UI.
    try {
      onTarget?.({
        chatId: String(session.id),
        taskId: session.taskId == null ? null : String(session.taskId),
        targetToken,
      });
    } catch { /* Проекция в UI не может отменить уже подтверждённую точную цель. */ }
    return session;
  }

  function capture() {
    const snapshot = uiContext.capture(router.currentRoute?.value);
    if (!snapshot?.promptContext) throw new Error('Не удалось зафиксировать контекст страницы.');
    return snapshot;
  }

  function captureIntent(taskId = null) {
    const snapshot = capture();
    const exactTask = taskId == null ? null : String(taskId).trim();
    if (exactTask !== null && !TASK_ID_RE.test(exactTask)) throw new TypeError('Некорректный номер задачи');
    return Object.freeze({
      taskId: exactTask,
      promptContext: snapshot.promptContext,
    });
  }

  function normalizedIntent(intent) {
    if (!intent || typeof intent !== 'object' || !intent.promptContext) return null;
    const taskId = intent.taskId == null ? null : String(intent.taskId).trim();
    if (taskId !== null && !TASK_ID_RE.test(taskId)) return null;
    return { taskId, promptContext: intent.promptContext };
  }

  async function send(text, { voiceTurnId = null, intent = null, targetToken = null } = {}) {
    // Обе части фиксируются до первого await: последующая навигация не вправе сменить
    // worktree или prompt уже начатого хода.
    const pinned = normalizedIntent(intent);
    const snapshot = pinned || capture();
    const taskId = pinned ? pinned.taskId : taskFromScope(snapshot.routingScope);
    const session = await ensureTask(taskId, targetToken);
    const result = await chat.sendTurn(session.id, String(text || ''), [], {
      promptContext: snapshot.promptContext,
      modeOverride: 'plan',
      companionTurn: true,
    });
    const direct = {
      ...result,
      chatId: session.id,
      taskId: session.taskId == null ? null : String(session.taskId),
    };
    if (voiceTurnId && result?.directReply && !result.offline && !result.error) {
      direct.voiceTurnId = voiceTurnId;
    }
    return direct;
  }

  return Object.freeze({
    captureTaskIntent(taskId) { return captureIntent(taskId); },
    captureGlobalIntent() { return captureIntent(null); },
    sendText(text, { intent = null, targetToken = null } = {}) { return send(text, { intent, targetToken }); },
    sendVoice(text, { voiceTurnId, intent = null, targetToken = null } = {}) {
      return send(text, { voiceTurnId, intent, targetToken });
    },
    async openForTask(value, { targetToken = null } = {}) {
      const taskId = String(value || '').trim();
      if (!TASK_ID_RE.test(taskId)) throw new TypeError('Некорректный номер задачи');
      const session = await ensureTask(taskId, targetToken);
      return session.id;
    },
    async openGlobal({ targetToken = null } = {}) {
      const session = await ensureTask(null, targetToken);
      return session.id;
    },
    async openConversation(chatId = currentChatId) {
      if (!chatId) return false;
      chat.selectChat(chatId);
      await router.push('/chats');
      return true;
    },
    async openList() {
      await router.push('/chats');
      return true;
    },
    async stop(chatId = currentChatId) {
      if (!chatId) return false;
      await chat.stop(chatId);
      return true;
    },
    current() { return Object.freeze({ chatId: currentChatId, taskId: currentTaskId }); },
  });
}

export { taskFromScope };
