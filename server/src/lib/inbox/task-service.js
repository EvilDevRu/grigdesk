// Единственный mutation path общего Inbox.
//
// Все ручные решения сериализуются в одном server writer process. Это намеренно
// шире mutex одного item: после пересклейки два разных item ref могут покрывать
// одно сообщение, а второй вызов B24 всё равно обязан увидеть decision первого
// ДО внешнего side effect.

import {
  buildInboxDraft,
  INBOX_DRAFT_LIMITS,
  safeInboxSourceUrl,
} from './draft.js';
import { toPublicInboxItem } from './coordinator.js';

const TASK_KEYS = new Set([
  'revision', 'messageRefs', 'title', 'description', 'allowUnanalyzedAttachments',
]);
const DECIDE_KEYS = new Set(['revision', 'messageRefs']);
const RESET_KEYS = new Set([
  'revision', 'messageRefs', 'decisionId', 'decisionVersion',
]);
const MAX_MESSAGE_REFS = 10_000;
const MAX_TASK_ID_BYTES = 512;
const MAX_PUBLIC_ATTACHMENT_TEXT = 4096;
const MAX_DECISION_NOTE_BYTES = 32 * 1024;
const MAX_DERIVED_DESCRIPTION = 8_000;
const SAFE_REASON_RE = /^[a-z0-9_]{1,80}$/u;
const ACTION_OPTION_KEYS = new Set(['by', 'note', 'requireAllAttachments']);
const lexical = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export class InboxTaskServiceError extends Error {
  constructor(code, message, statusCode = 400, cause, details = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'InboxTaskServiceError';
    this.code = code;
    this.statusCode = statusCode;
    if (details) this.details = structuredClone(details);
  }
}

const fail = (code, message, statusCode = 400, cause, details = null) => {
  throw new InboxTaskServiceError(code, message, statusCode, cause, details);
};

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

function exactBody(body, allowed, required, where) {
  if (!isPlainObject(body)) fail('invalid_request', `${where}: ожидался JSON object.`);
  const keys = Object.keys(body);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(body, key))) {
    fail('invalid_request', `${where}: поля запроса не совпадают с контрактом.`);
  }
}

function boundedText(value, where, limit, { optional = false } = {}) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string') fail('invalid_request', `${where}: ожидалась строка.`);
  const text = value.trim();
  if (text.length > limit || Buffer.byteLength(text, 'utf8') > limit * 4) {
    fail('invalid_request', `${where}: текст превышает допустимый размер.`);
  }
  return text;
}

function allowUnanalyzed(value) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    fail('invalid_request', 'allowUnanalyzedAttachments должен быть boolean.');
  }
  return value;
}

function truncateText(value, limit) {
  const text = String(value || '').trim();
  if (text.length <= limit) return text;
  return limit > 1 ? `${text.slice(0, limit - 1).trimEnd()}…` : '';
}

function appendBoundedSections(description, sections) {
  const body = String(description || '').trim();
  const pending = (Array.isArray(sections) ? sections : [])
    .map((section) => ({
      marker: `── ${String(section?.title || '').trim()} ──`,
      text: String(section?.text || '').trim(),
    }))
    // Исходное сообщение недоверенное: совпавший заголовок в нём не доказывает,
    // что системная секция уже добавлена. Эта функция вызывается ровно один раз.
    .filter((section) => section.text);
  if (!pending.length) return body;

  const overhead = pending.reduce((total, section) => total + section.marker.length + 1, 0)
    + Math.max(0, pending.length - 1) * 2;
  let remaining = Math.max(0, MAX_DERIVED_DESCRIPTION - overhead);
  const blocks = pending.map((section, index) => {
    const share = Math.floor(remaining / (pending.length - index));
    const text = truncateText(section.text, share);
    remaining -= text.length;
    return `${section.marker}\n${text}`;
  });
  const derived = blocks.join('\n\n');
  const bodyBudget = Math.max(
    0,
    INBOX_DRAFT_LIMITS.description - derived.length - (body ? 2 : 0),
  );
  return [truncateText(body, bodyBudget), derived].filter(Boolean).join('\n\n');
}

function actionOptions(value, { attachments = false } = {}) {
  if (value === undefined) return { by: 'human', note: '', requireAllAttachments: false };
  if (!isPlainObject(value)
      || Object.keys(value).some((key) => !ACTION_OPTION_KEYS.has(key))) {
    fail('invalid_service_call', 'Internal action options не совпадают с контрактом.', 500);
  }
  const by = value.by ?? 'human';
  const note = value.note ?? '';
  const requireAllAttachments = value.requireAllAttachments ?? false;
  if (!['human', 'auto'].includes(by)
      || typeof note !== 'string'
      || Buffer.byteLength(note, 'utf8') > MAX_DECISION_NOTE_BYTES
      || typeof requireAllAttachments !== 'boolean'
      || (!attachments && requireAllAttachments)) {
    fail('invalid_service_call', 'Internal action options имеют неверные значения.', 500);
  }
  return { by, note, requireAllAttachments };
}

function assertRevision(value) {
  if (typeof value !== 'string' || !/^v1_[A-Za-z0-9_-]{43}$/u.test(value)) {
    fail('invalid_revision', 'revision имеет неверный формат.');
  }
  return value;
}

function validateSelection(messageRefs, item, refCodec) {
  if (!Array.isArray(messageRefs)
      || messageRefs.length < 1
      || messageRefs.length > MAX_MESSAGE_REFS) {
    fail('invalid_selection', 'Нужно выбрать хотя бы одно сообщение.');
  }
  const canonical = messageRefs.map((ref) => {
    try { return refCodec.decode(ref, 'message').ref; } catch (err) {
      fail('invalid_selection', `messageRefs содержит неверную ссылку: ${err.message}`, 400, err);
    }
  });
  if (new Set(canonical).size !== canonical.length) {
    fail('invalid_selection', 'messageRefs содержит повторяющиеся ссылки.');
  }
  const selectedRefs = new Set(canonical);
  const availableRefs = new Set(item.messages.map((message) => message.messageRef));
  if (canonical.some((messageRef) => !availableRefs.has(messageRef))) {
    fail('stale_item', 'Выбор содержит сообщение, которого больше нет в item.', 409);
  }
  return {
    refs: [...selectedRefs].sort(lexical),
    // Порядок transcript задаёт authoritative item, а не порядок refs из body.
    messages: item.messages.filter((message) => selectedRefs.has(message.messageRef)),
  };
}

function ensureNewSelection(selection) {
  if (selection.messages.some((message) => message.decision !== null)) {
    fail('stale_item', 'Хотя бы одно выбранное сообщение уже решено.', 409);
  }
}

function ensureWritable(resolved) {
  if (resolved.channelState.readOnly || resolved.channelState.connection !== 'connected') {
    fail(
      'channel_disconnected',
      'Канал отключён: ранее принятые обращения доступны только для чтения до переподключения.',
      409,
    );
  }
}

function materialized(value) {
  if (!isPlainObject(value)
      || !Array.isArray(value.files)
      || !Array.isArray(value.skipped)) {
    fail('channel_materialize_failed', 'Канал вернул неверный результат подготовки вложений.', 503);
  }
  return { files: value.files, skipped: value.skipped };
}

function boundedPublicText(value) {
  if (typeof value !== 'string') return '';
  return value.length <= MAX_PUBLIC_ATTACHMENT_TEXT
    ? value
    : `${value.slice(0, MAX_PUBLIC_ATTACHMENT_TEXT - 1)}…`;
}

function publicSkipped(entries) {
  return entries.map((entry) => {
    const envelope = isPlainObject(entry) ? entry : {};
    const attachment = isPlainObject(envelope.attachment) ? envelope.attachment : envelope;
    const rawReason = typeof envelope.reason === 'string' ? envelope.reason : '';
    return {
      kind: boundedPublicText(attachment.kind),
      displayLabel: boundedPublicText(attachment.displayLabel),
      name: boundedPublicText(attachment.name),
      size: Number.isSafeInteger(attachment.size) && attachment.size >= 0
        ? attachment.size
        : null,
      reason: SAFE_REASON_RE.test(rawReason) ? rawReason : 'attachment_failed',
    };
  });
}

function safeTaskId(value) {
  const taskId = String(value ?? '').trim();
  if (!taskId
      || Buffer.byteLength(taskId, 'utf8') > MAX_TASK_ID_BYTES
      || /[\u0000-\u001f\u007f]/u.test(taskId)) return null;
  return taskId;
}

function validDecisionResult(value) {
  return isPlainObject(value)
    && typeof value.decisionId === 'string'
    && value.decisionId.length > 0
    && Number.isSafeInteger(value.version)
    && value.version > 0;
}

function sameSelection(left, right) {
  if (left.item.revision !== right.item.revision) return false;
  if (left.accountRef !== right.accountRef || left.generation !== right.generation) return false;
  return true;
}

async function releaseAttachmentAnalysis(analysis, log) {
  try {
    await analysis?.release?.();
  } catch (error) {
    // Cleanup не должен превращать уже готовый разбор в потерю решения человека.
    log.warn?.({ code: error?.code }, 'inbox: visual lease не удалось освободить');
  }
}

/**
 * Общий mutation service. `coordinator.resolveItem()` возвращает server-only item
 * и передаёт владение account lease до обязательного release() в finally.
 */
export class InboxTaskService {
  constructor({
    coordinator,
    b24,
    listProjects = async () => [],
    taskUrlFor = async () => '',
    onChanged = () => {},
    isEnabled,
    attachmentAnalyzer = null,
    attachmentTriage = null,
    now = Date.now,
    log = console,
  } = {}) {
    if (!coordinator || typeof coordinator.resolveItem !== 'function') {
      fail('invalid_service_config', 'InboxTaskService требует coordinator.', 500);
    }
    if (!b24 || typeof b24.isConfigured !== 'function' || typeof b24.createTask !== 'function') {
      fail('invalid_service_config', 'InboxTaskService требует B24 port с readiness.', 500);
    }
    if (typeof listProjects !== 'function' || typeof taskUrlFor !== 'function'
        || typeof onChanged !== 'function' || typeof isEnabled !== 'function'
        || (attachmentAnalyzer !== null && typeof attachmentAnalyzer?.analyze !== 'function')
        || (attachmentTriage !== null && typeof attachmentTriage !== 'function')
        || typeof now !== 'function') {
      fail('invalid_service_config', 'InboxTaskService получил неверные callbacks.', 500);
    }
    this.coordinator = coordinator;
    this.b24 = b24;
    this.listProjects = listProjects;
    this.taskUrlFor = taskUrlFor;
    this.onChanged = onChanged;
    this.isEnabled = isEnabled;
    this.attachmentAnalyzer = attachmentAnalyzer;
    this.attachmentTriage = attachmentTriage;
    this.now = now;
    this.log = log;
    this.queue = Promise.resolve();
    // После B24 success + store failure автоматический повтор опасен. До явной
    // operator reconciliation этот process блокирует весь decisions channel,
    // а item/message keys сохраняет для точной диагностики пересклейки.
    this.indeterminateChannels = new Map();
    this.indeterminateItems = new Set();
    this.indeterminateMessages = new Set();
    this.indeterminateDetails = new Map();
  }

  _serialize(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async _resolve(ref) {
    try {
      return await this.coordinator.resolveItem(ref, { nowMs: this.now() });
    } catch (err) {
      if (err?.statusCode) throw err;
      fail('inbox_failed', 'Inbox не смог заново проверить item.', 503, err);
    }
  }

  async _assertInboxEnabled() {
    if (!await this.isEnabled()) {
      fail('inbox_disabled', 'Плагин Inbox выключен во время операции.', 409);
    }
  }

  async _assertContextCurrent(resolved) {
    if (resolved.context.isCurrent && !await resolved.context.isCurrent()) {
      fail('account_changed', 'Account generation изменилась перед mutation.', 409);
    }
  }

  _validateItem(resolved, revision, { requireActive = false } = {}) {
    ensureWritable(resolved);
    if (requireActive && resolved.channelState.participation !== 'active') {
      fail('channel_deactivated', 'Автомат остановлен для деактивированного канала.', 409);
    }
    if (resolved.item.revision !== assertRevision(revision)) {
      fail('stale_item', 'Item изменился; перечитайте Inbox перед решением.', 409);
    }
  }

  async _publicItem(ref) {
    const refreshed = await this._resolve(ref);
    try {
      return toPublicInboxItem(refreshed.item);
    } finally {
      await refreshed.release();
    }
  }

  async _publicItemSafe(ref) {
    try {
      return await this._publicItem(ref);
    } catch (err) {
      this.log.warn?.({ code: err?.code }, 'inbox: решение записано, но public item не перечитан');
      return null;
    }
  }

  async _release(resolved) {
    try {
      await resolved?.release();
    } catch (err) {
      this.log.error?.({ code: err?.code }, 'inbox: account lease не удалось освободить');
    }
  }

  _markIndeterminate(channel, itemRef, messageRefs, details) {
    const safe = {
      retryable: false,
      taskId: safeTaskId(details?.taskId),
      taskUrl: details?.taskUrl || '',
    };
    this.indeterminateChannels.set(channel, safe);
    this.indeterminateItems.add(itemRef);
    this.indeterminateDetails.set(itemRef, safe);
    for (const messageRef of messageRefs) {
      this.indeterminateMessages.add(messageRef);
      this.indeterminateDetails.set(messageRef, safe);
    }
    return safe;
  }

  _existingIndeterminate(channel, itemRef, messageRefs) {
    if (this.indeterminateChannels.has(channel)) return this.indeterminateChannels.get(channel);
    if (this.indeterminateItems.has(itemRef)) return this.indeterminateDetails.get(itemRef);
    const messageRef = messageRefs.find((candidate) => this.indeterminateMessages.has(candidate));
    return messageRef ? this.indeterminateDetails.get(messageRef) : null;
  }

  async _taskUrl(taskId) {
    try {
      const raw = await this.taskUrlFor(taskId);
      return safeInboxSourceUrl(raw) || '';
    } catch (err) {
      this.log.warn?.({ taskId, code: err?.code }, 'inbox: безопасная ссылка на B24-задачу не собрана');
      return '';
    }
  }

  _notify(payload) {
    try {
      const result = this.onChanged(payload);
      Promise.resolve(result).catch((err) => {
        this.log.warn?.({ code: err?.code }, 'inbox: решение записано, но SSE не отправлен');
      });
    } catch (err) {
      this.log.warn?.({ code: err?.code }, 'inbox: решение записано, но SSE не отправлен');
    }
  }

  async _deliverTaskNotification(receipt) {
    if (!receipt) return;
    try {
      await receipt.resolved.context.notifyTaskCreated(receipt.payload);
    } catch (err) {
      // B24 и durable decision уже состоялись. Ошибка обратного сообщения не
      // имеет права превратить успех в повтор создания задачи.
      this.log.warn?.(
        { channel: receipt.channel, taskId: receipt.payload.taskId, code: err?.code },
        'inbox: задача создана, но channel confirmation не отправлен',
      );
    } finally {
      await this._release(receipt.resolved);
    }
  }

  async task(ref, body, internalOptions) {
    // Самый ранний gate: без B24 не читаем даже channel archive и текст.
    await this._assertInboxEnabled();
    if (!this.b24.isConfigured()) {
      fail('no_b24', 'Битрикс24 не подключён — задачу ставить негде.', 503);
    }
    exactBody(body, TASK_KEYS, ['revision', 'messageRefs'], 'task body');
    const titleOverride = boundedText(body.title, 'title', INBOX_DRAFT_LIMITS.title, { optional: true });
    const descriptionOverride = boundedText(
      body.description,
      'description',
      INBOX_DRAFT_LIMITS.description,
      { optional: true },
    );
    const allowWithoutAnalysis = allowUnanalyzed(body.allowUnanalyzedAttachments);
    const action = actionOptions(internalOptions, { attachments: true });
    if (action.by === 'auto' && allowWithoutAnalysis) {
      fail('invalid_service_call', 'Автомат не может обходить разбор вложений.', 500);
    }

    const committed = await this._serialize(async () => {
      await this._assertInboxEnabled();
      if (!this.b24.isConfigured()) fail('no_b24', 'Битрикс24 больше не подключён.', 503);
      const first = await this._resolve(ref);
      let firstReleased = false;
      let second = null;
      try {
        this._validateItem(first, body.revision, { requireActive: action.by === 'auto' });
        const selection = validateSelection(body.messageRefs, first.item, first.refCodec);
        ensureNewSelection(selection);
        const priorIndeterminate = this._existingIndeterminate(
          first.channel.id,
          first.item.ref,
          selection.refs,
        );
        if (priorIndeterminate) {
          fail(
            'indeterminate_task_commit',
            'Для этого обращения B24 уже мог создать задачу; нужен operator reconciliation.',
            503,
            null,
            priorIndeterminate,
          );
        }

        const selectedHead = selection.messages[0];
        const selectedSourceUrl = await first.context.sourceUrl({
          source: selectedHead.source,
          message: selectedHead,
        });
        const selectedDraft = buildInboxDraft({
          source: selectedHead.source,
          messages: selection.messages,
        }, {
          kind: first.item.policy.kind,
          channelLabel: first.channel.label,
          sourceUrl: selectedSourceUrl,
        });
        const rawAttachments = selectedDraft.attachments;
        await this._assertInboxEnabled();
        if (rawAttachments.length && typeof first.context.materializeAttachments !== 'function') {
          fail('channel_materialize_failed', 'Канал не умеет подготовить свои вложения.', 503);
        }
        const prepared = rawAttachments.length
          ? materialized(await first.context.materializeAttachments(rawAttachments))
          : { files: [], skipped: [] };
        if ((action.requireAllAttachments || !allowWithoutAnalysis) && prepared.skipped.length) {
          fail(
            'attachments_skipped',
            'Не все вложения удалось подготовить и разобрать.',
            409,
          );
        }

        // Долгий Whisper/model call не должен держать account lease. Байты уже
        // получены под generation checks, а второй resolve ниже заново проверит
        // revision, policy и generation непосредственно перед B24.
        await this._release(first);
        firstReleased = true;

        const analysisItem = {
          ...first.item,
          messages: selection.messages,
          attachments: rawAttachments,
          draft: selectedDraft,
        };
        let attachmentAnalysis = null;
        let finalTitle = titleOverride || selectedDraft.title;
        let finalDescription = descriptionOverride || selectedDraft.description;
        try {
          if (rawAttachments.length && !allowWithoutAnalysis) {
            if (this.attachmentAnalyzer) {
              try {
                attachmentAnalysis = await this.attachmentAnalyzer.analyze({
                  item: analysisItem,
                  materialize: async () => prepared,
                });
              } catch (error) {
                this.log.warn?.({ code: error?.code }, 'inbox: разбор вложений завершился ошибкой');
                attachmentAnalysis = {
                  ok: false,
                  complete: false,
                  error: 'attachment_analysis_failed',
                };
              }
            } else {
              attachmentAnalysis = {
                ok: false,
                complete: false,
                error: 'attachment_analysis_unavailable',
              };
            }
            if (!attachmentAnalysis?.ok || !attachmentAnalysis?.complete) {
              fail(
                'attachment_analysis_required',
                'Содержимое вложений не удалось полностью разобрать.',
                409,
              );
            }
          }

          const derivedSections = [];
          if (attachmentAnalysis?.ok && attachmentAnalysis.complete) {
            if (action.by === 'human') {
              derivedSections.push({ title: 'Разбор вложений', text: attachmentAnalysis.text });
            }

            // Речь и безопасный текст уже понятны без vision-модели. Изображения и
            // кадры видео считаются разобранными лишь после содержательного model call.
            if (action.by === 'human' && attachmentAnalysis.visualPaths?.length) {
              let triaged = null;
              try {
                triaged = this.attachmentTriage
                  ? await this.attachmentTriage({
                    item: analysisItem,
                    attachmentAnalysis,
                  })
                  : null;
              } catch (error) {
                this.log.warn?.({ code: error?.code }, 'inbox: vision-разбор вложений завершился ошибкой');
              }
              if ((!triaged?.ok || !triaged.verdict) && !allowWithoutAnalysis) {
                fail(
                  'attachment_analysis_required',
                  'Визуальные вложения не удалось разобрать выбранной моделью.',
                  409,
                );
              }
              if (triaged?.ok && triaged.verdict) {
                const verdict = triaged.verdict;
                if (!titleOverride && verdict.kind !== 'none' && verdict.title) {
                  finalTitle = boundedText(
                    verdict.title,
                    'analysis title',
                    INBOX_DRAFT_LIMITS.title,
                  ) || finalTitle;
                }
                const summary = [verdict.description, verdict.reason]
                  .map((part) => String(part || '').trim())
                  .filter(Boolean)
                  .join('\n\n');
                derivedSections.push({ title: 'Выжимка визуального разбора', text: summary });
              }
            }
          }
          finalDescription = appendBoundedSections(finalDescription, derivedSections);
        } finally {
          // Analyzer держит lease на visualPaths до последнего потребителя. Без
          // release cache GC не может безопасно убрать кадры и изображения.
          await releaseAttachmentAnalysis(attachmentAnalysis, this.log);
        }

        // Список проектов читается до финального resolve: последний channel lookup
        // остаётся максимально близко к необратимому B24 side effect.
        if (!this.b24.isConfigured()) fail('no_b24', 'Битрикс24 больше не подключён.', 503);
        const projects = await this.listProjects();
        if (!Array.isArray(projects)) {
          fail('stale_policy', 'Список проектов временно недоступен.', 409);
        }

        // Rules, archive contents, assignments, activation и generation могли
        // измениться во время materialize. Второй resolve — обязательный pre-B24 CAS.
        second = await this._resolve(ref);
        this._validateItem(second, body.revision, { requireActive: action.by === 'auto' });
        if (!sameSelection(first, second)) {
          fail('stale_item', 'Account generation или item изменились во время подготовки.', 409);
        }
        const verified = validateSelection(body.messageRefs, second.item, second.refCodec);
        ensureNewSelection(verified);
        if (!projects.includes(second.item.policy.project)) {
          fail('stale_policy', 'Проект правила больше не существует.', 409);
        }
        await this._assertContextCurrent(second);
        await this._assertInboxEnabled();
        if (!this.b24.isConfigured()) fail('no_b24', 'Битрикс24 больше не подключён.', 503);

        let created;
        try {
          created = await this.b24.createTask({
            title: finalTitle,
            description: finalDescription,
            groupId: second.item.policy.b24.groupId,
            responsibleId: second.item.policy.b24.responsibleId,
            priority: second.item.policy.b24.priority,
            // Автомат уже fail-closed разобрал содержимое. В B24 ему нужны
            // сформулированная постановка и source URL, а не копия provider-файла.
            images: action.by === 'human' ? prepared.files : [],
          });
        } catch (err) {
          fail(
            'b24_failed',
            'Портал не принял задачу. Обращение осталось новым.',
            502,
            err,
          );
        }

        const taskId = safeTaskId(created?.id);
        if (!taskId) {
          const details = this._markIndeterminate(second.channel.id, second.item.ref, verified.refs, {
            taskId: null,
            taskUrl: '',
          });
          fail(
            'indeterminate_task_commit',
            'Портал принял создание, но не вернул id задачи. Не повторяйте действие до сверки.',
            503,
            null,
            details,
          );
        }
        const taskUrl = await this._taskUrl(taskId);

        let decision;
        try {
          decision = await second.context.inboxState.decide({
            activationEpoch: second.item.activationEpoch,
            originItemRef: second.item.ref,
            messageRefs: verified.refs,
            scopeRef: second.item.policy.scopeRef,
            status: 'task',
            taskId,
            taskUrl,
            by: action.by,
            note: action.note,
            decidedAtMs: this.now(),
          });
          if (!validDecisionResult(decision)) {
            throw Object.assign(new Error('Inbox state вернул невалидный decision result.'), {
              code: 'invalid_state_result',
            });
          }
        } catch (err) {
          const details = this._markIndeterminate(
            second.channel.id,
            second.item.ref,
            verified.refs,
            { taskId, taskUrl },
          );
          this.log.error?.({ itemRef: second.item.ref, taskId, code: err?.code },
            'inbox: B24 task создана, decision commit неопределён');
          fail(
            'indeterminate_task_commit',
            'B24-задача создана, но Inbox не подтвердил запись решения. Не повторяйте действие.',
            503,
            err,
            details,
          );
        }

        this._notify({
          itemRef: second.item.ref,
          channel: second.channel.id,
          status: 'task',
          taskId,
        });
        const result = {
          taskId,
          taskUrl,
          decision: {
            decisionId: decision.decisionId,
            version: decision.version,
          },
          skipped: publicSkipped(prepared.skipped),
          item: await this._publicItemSafe(ref),
        };
        let notification = null;
        if (typeof second.context.notifyTaskCreated === 'function') {
          const anchor = verified.messages[0];
          const payload = {
            source: structuredClone(anchor.source),
            message: structuredClone(anchor),
            taskId,
            taskUrl,
          };
          const resolved = second;
          notification = {
            channel: resolved.channel.id,
            resolved,
            payload,
          };
          second = null; // ownership переходит post-commit доставке ниже
        }
        return { result, notification };
      } finally {
        await this._release(second);
        if (!firstReleased) await this._release(first);
      }
    });
    // Network confirmation не держит глобальную очередь Inbox: следующий
    // decision может начаться, пока Telegram отвечает. Account lease остаётся
    // жив до конца вызова и не даёт switch подменить bot/token на полпути.
    await this._deliverTaskNotification(committed.notification);
    return committed.result;
  }

  async dismiss(ref, body, internalOptions) {
    exactBody(body, DECIDE_KEYS, ['revision', 'messageRefs'], 'dismiss body');
    const action = actionOptions(internalOptions);
    return this._serialize(async () => {
      await this._assertInboxEnabled();
      const resolved = await this._resolve(ref);
      try {
        this._validateItem(resolved, body.revision, { requireActive: action.by === 'auto' });
        const selection = validateSelection(body.messageRefs, resolved.item, resolved.refCodec);
        ensureNewSelection(selection);
        const priorIndeterminate = this._existingIndeterminate(
          resolved.channel.id,
          resolved.item.ref,
          selection.refs,
        );
        if (priorIndeterminate) {
          fail(
            'indeterminate_task_commit',
            'Для выбранных сообщений B24 уже мог создать задачу; нужен operator reconciliation.',
            503,
            null,
            priorIndeterminate,
          );
        }
        await this._assertInboxEnabled();
        await this._assertContextCurrent(resolved);
        await this._assertInboxEnabled();
        const decision = await resolved.context.inboxState.decide({
          activationEpoch: resolved.item.activationEpoch,
          originItemRef: resolved.item.ref,
          messageRefs: selection.refs,
          scopeRef: resolved.item.policy.scopeRef,
          status: 'skipped',
          taskId: null,
          taskUrl: '',
          by: action.by,
          note: action.note,
          decidedAtMs: this.now(),
          requireActive: action.by === 'auto',
        });
        this._notify({
          itemRef: resolved.item.ref,
          channel: resolved.channel.id,
          status: 'skipped',
          taskId: null,
        });
        return {
          decision: { decisionId: decision.decisionId, version: decision.version },
          item: await this._publicItemSafe(ref),
        };
      } finally {
        await this._release(resolved);
      }
    });
  }

  async reset(ref, body) {
    exactBody(body, RESET_KEYS, [
      'revision', 'messageRefs', 'decisionId', 'decisionVersion',
    ], 'reset body');
    if (typeof body.decisionId !== 'string' || !body.decisionId) {
      fail('invalid_request', 'decisionId обязателен.');
    }
    if (!Number.isSafeInteger(body.decisionVersion) || body.decisionVersion < 1) {
      fail('invalid_request', 'decisionVersion должен быть положительным целым.');
    }
    return this._serialize(async () => {
      await this._assertInboxEnabled();
      const resolved = await this._resolve(ref);
      try {
        this._validateItem(resolved, body.revision);
        const selection = validateSelection(body.messageRefs, resolved.item, resolved.refCodec);
        const priorIndeterminate = this._existingIndeterminate(
          resolved.channel.id,
          resolved.item.ref,
          selection.refs,
        );
        if (priorIndeterminate) {
          fail(
            'indeterminate_task_commit',
            'Decisions канала заблокированы до operator reconciliation.',
            503,
            null,
            priorIndeterminate,
          );
        }
        const own = selection.messages.every((message) => (
          message.decision?.status === 'skipped'
          && message.decision.decisionId === body.decisionId
          && message.decision.version === body.decisionVersion
        ));
        if (!own) fail('stale_decision', 'Выбор больше не принадлежит указанной skipped decision.', 409);
        await this._assertInboxEnabled();
        await this._assertContextCurrent(resolved);
        await this._assertInboxEnabled();
        const residual = await resolved.context.inboxState.reset({
          decisionId: body.decisionId,
          expectedVersion: body.decisionVersion,
          messageRefs: selection.refs,
          nowMs: this.now(),
        });
        this._notify({
          itemRef: resolved.item.ref,
          channel: resolved.channel.id,
          status: residual ? 'mixed' : 'new',
          taskId: null,
        });
        return {
          decision: residual
            ? { decisionId: residual.decisionId, version: residual.version }
            : null,
          item: await this._publicItemSafe(ref),
        };
      } finally {
        await this._release(resolved);
      }
    });
  }
}
