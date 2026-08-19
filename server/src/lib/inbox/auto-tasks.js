// Один provider-neutral auto-worker общего Inbox. Он читает server-only snapshot,
// но любые решения проводит через тот же InboxTaskService, что и HTTP-кнопки.

import { safeInboxSourceUrl, visibleInboxMessages } from './draft.js';
import {
  buildInboxAutoTask,
  countInboxAutoTasks,
  decideInboxAutoAction,
  decideInboxAutoPlan,
  inboxAutoNote,
  normalizeInboxTriageModel,
  resolveInboxTriageTarget,
  runInboxTriage,
} from './triage.js';

export const INBOX_AUTO_TICK = Object.freeze({
  perTick: 5,
  idleMs: 60_000,
  errorMs: 300_000,
  attachmentRetryMs: 6 * 60 * 60 * 1000,
});

const DAY_MS = 86_400_000;
const lexical = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const autoItemOrder = (a, b) => (
  b.lastAt - a.lastAt
  || lexical(a.ref, b.ref)
);
const QUIET_MUTATION_ERRORS = new Set([
  'account_changed',
  'attachment_analysis_required',
  'attachments_skipped',
  'channel_disabled',
  'channel_deactivated',
  'channel_disconnected',
  'inbox_disabled',
  'no_b24',
  'stale_item',
  'stale_policy',
]);
const ATTACHMENT_TRIAGE_ERRORS = new Set([
  'attachment_media_limit',
  'invalid_attachment_media',
  'invalid_attachment_path',
  'unsupported_media',
]);
const safeCode = (error, fallback = 'worker_failed') => (
  typeof error?.code === 'string' && /^[a-z0-9_]{1,80}$/u.test(error.code)
    ? error.code
    : fallback
);

const MAX_BLOCKED_ATTACHMENTS = 12;
const MAX_BLOCKED_TEXT = 240;
const publicLine = (value, limit = MAX_BLOCKED_TEXT) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim()
  .slice(0, limit);

/**
 * Какие именно вложения остались неразобранными и почему.
 *
 * Без этого списка человек видел «не удалось полностью разобрать» и не мог
 * отличить потолок Telegram (файл больше 20 МБ бот не скачает никогда) от
 * временной поломки — то есть не знал, ждать ли повтора или разбираться руками.
 * Наружу идут только те подписи, которые и так есть в карточке обращения:
 * тип, имя файла и наша же строка причины.
 */
function blockedAttachments(attachmentAnalysis) {
  const entries = Array.isArray(attachmentAnalysis?.entries) ? attachmentAnalysis.entries : [];
  return entries
    .filter((value) => value?.complete !== true)
    .slice(0, MAX_BLOCKED_ATTACHMENTS)
    // Формат тот же, что у отказа ручного создания: карточка рисует оба списка
    // одним компонентом, и второй формы для той же мысли заводить незачем.
    .map((value) => ({
      label: publicLine(
        [value?.displayLabel, value?.name].map((part) => String(part || '').trim())
          .filter(Boolean).join(' · '),
        200,
      ) || 'вложение',
      reason: publicLine(value?.reason),
    }));
}

async function releaseAttachmentAnalysis(analysis, log) {
  try {
    await analysis?.release?.();
  } catch (error) {
    // Сбой cleanup не должен ронять весь worker tick и закрывать остальную очередь.
    log.warn?.({ code: safeCode(error, 'attachment_release_failed') },
      'inbox: auto visual lease не удалось освободить');
  }
}

function positiveInteger(value, where, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new TypeError(`InboxAutoTasks: ${where} должен быть положительным целым.`);
  }
  return value;
}

function validNow(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('InboxAutoTasks: nowMs должен быть неотрицательным safe integer.');
  }
  return value;
}

export class InboxAutoTasks {
  constructor({
    coordinator,
    taskService,
    b24,
    attachmentAnalyzer = null,
    triage = runInboxTriage,
    triageReadiness = resolveInboxTriageTarget,
    modelRef,
    isEnabled,
    config = {},
    providerSettings = {},
    perTick = INBOX_AUTO_TICK.perTick,
    idleMs = INBOX_AUTO_TICK.idleMs,
    errorMs = INBOX_AUTO_TICK.errorMs,
    attachmentRetryMs = INBOX_AUTO_TICK.attachmentRetryMs,
    now = Date.now,
    onChanged = () => {},
    log = console,
  } = {}) {
    if (!coordinator || typeof coordinator.workerSnapshot !== 'function'
        || typeof coordinator.workerGate !== 'function'
        // resolveItem нужен не только вложениям: разбитая карточка перечитывает
        // revision и ссылку источника перед каждым решением плана.
        || typeof coordinator.resolveItem !== 'function'
        || !taskService || typeof taskService.task !== 'function'
        || typeof taskService.dismiss !== 'function'
        || !b24 || typeof b24.isConfigured !== 'function'
        || typeof triage !== 'function'
        || typeof triageReadiness !== 'function'
        || typeof modelRef !== 'function'
        || typeof isEnabled !== 'function'
        || (attachmentAnalyzer !== null && typeof attachmentAnalyzer?.analyze !== 'function')
        || !['object', 'function'].includes(typeof providerSettings)
        || typeof now !== 'function'
        || typeof onChanged !== 'function') {
      throw new TypeError('InboxAutoTasks получил неполный dependency contract.');
    }
    this.coordinator = coordinator;
    this.taskService = taskService;
    this.b24 = b24;
    this.attachmentAnalyzer = attachmentAnalyzer;
    this.triage = triage;
    this.triageReadiness = triageReadiness;
    this.modelRef = modelRef;
    this.isEnabled = isEnabled;
    this.config = config;
    this.providerSettings = providerSettings;
    this.perTick = positiveInteger(perTick, 'perTick', 100);
    this.idleMs = positiveInteger(idleMs, 'idleMs');
    this.errorMs = positiveInteger(errorMs, 'errorMs');
    this.attachmentRetryMs = positiveInteger(
      attachmentRetryMs,
      'attachmentRetryMs',
      7 * DAY_MS,
    );
    this.now = now;
    this.onChanged = onChanged;
    this.log = log;

    this.running = false;
    this.timer = null;
    this.controller = null;
    this.tickQueue = Promise.resolve();
    this.lastTickAt = null;
    this.lastReason = '';
    this.lastError = null;
    // Карточка, которую модель разбирает ПРЯМО СЕЙЧАС. Между обратным отсчётом
    // тишины и готовым решением проходят минуты (Whisper + model call), и без
    // этого поля человек смотрел на карточку без единого признака работы.
    this.judging = null;
    this.created = 0;
    this.dismissed = 0;
    this.failed = 0;
    this.blockedChannels = new Set();
    this.analysisBlocks = new Map();
    // `perTick` ограничивает model calls, а не видимую worker-у глубину очереди.
    // Cursor привязан к runtime generation: нерешённые первые items не могут
    // навсегда закрыть хвост, а account switch всегда начинает новый обход.
    this.fairCursors = new Map();
    this.fairChannelCursor = null;
    this.loopGeneration = 0;
  }

  status() {
    return {
      running: this.running,
      lastTickAt: this.lastTickAt,
      lastReason: this.lastReason,
      lastError: this.lastError,
      judging: this.judging ? { ...this.judging } : null,
      created: this.created,
      dismissed: this.dismissed,
      failed: this.failed,
      blockedChannels: [...this.blockedChannels].sort(),
      analysisRequired: [...this.analysisBlocks.entries()]
        .map(([ref, value]) => ({ ref, ...value }))
        .sort((left, right) => lexical(left.ref, right.ref)),
    };
  }

  /** Живые ворота для UI: lastReason после смены настройки может быть уже устаревшим. */
  async publicStatus() {
    let readiness = 'unavailable';
    try {
      const gates = await this._liveGates();
      readiness = gates.reason || (this.running ? 'ready' : 'stopped');
    } catch {
      readiness = 'unavailable';
    }
    return { ...this.status(), readiness };
  }

  tick({ nowMs = this.now(), signal = this.controller?.signal } = {}) {
    const operation = () => this._tick({ nowMs: validNow(nowMs), signal });
    const result = this.tickQueue.then(operation, operation);
    this.tickQueue = result.catch(() => {});
    return result;
  }

  async _liveGates(expectedRef = null, signal = null) {
    if (signal?.aborted) return { reason: 'stopped', ref: null };
    if (!await this.isEnabled()) return { reason: 'plugin_disabled', ref: null };
    const ref = normalizeInboxTriageModel(await this.modelRef());
    if (!ref) return { reason: 'no_model', ref: null };
    if (expectedRef
        && (ref.provider !== expectedRef.provider || ref.model !== expectedRef.model)) {
      return { reason: 'model_changed', ref: null };
    }
    const readiness = await this.triageReadiness({
      modelRef: ref,
      config: this.config,
      requireImages: true,
    });
    if (!readiness?.ok) {
      return { reason: safeCode({ code: readiness?.error }, 'model_unavailable'), ref: null };
    }
    if (!this.b24.isConfigured()) return { reason: 'no_b24', ref: null };
    return { reason: '', ref };
  }

  async _tick({ nowMs, signal = null }) {
    const gates = await this._liveGates(null, signal);
    if (gates.reason) return this._quiescent(gates.reason);
    const ref = gates.ref;

    let snapshot;
    try {
      snapshot = await this.coordinator.workerSnapshot({ nowMs });
    } catch (error) {
      const code = safeCode(error, 'snapshot_failed');
      this.lastReason = 'snapshot_failed';
      this.lastError = code;
      this.log.error?.({ code }, 'inbox: auto snapshot failed');
      return { ran: false, reason: 'snapshot_failed' };
    }
    const channels = Array.isArray(snapshot?.channels) ? snapshot.channels : [];
    let queues = channels.map((channel) => ({
      id: channel?.state?.id,
      state: channel?.state || {},
      generation: channel?.generation,
      decisions: Array.isArray(channel?.decisions) ? channel.decisions : [],
      items: Array.isArray(channel?.items) ? [...channel.items] : [],
      error: channel?.error || null,
    })).filter((channel) => typeof channel.id === 'string');
    this._pruneAnalysisBlocks(queues);
    for (const channel of queues) this._rotateAfterCursor(channel);
    const lastChannel = queues.findIndex((channel) => channel.id === this.fairChannelCursor);
    if (lastChannel >= 0 && queues.length > 1) {
      const next = (lastChannel + 1) % queues.length;
      queues = [...queues.slice(next), ...queues.slice(0, next)];
    }

    const made = new Map();
    const sinceMs = Math.max(0, nowMs - DAY_MS);
    const out = {
      ran: true,
      judged: 0,
      created: [],
      dismissed: [],
      failed: [],
      analysisRequired: [],
      left: 0,
    };

    let progress = true;
    let halted = false;
    let haltedReason = '';
    while (progress && !halted) {
      progress = false;
      for (const channel of queues) {
        if (!this._channelRunnable(channel)) continue;
        const candidate = this._nextCandidate(channel, made, sinceMs, nowMs);
        if (!candidate) continue;
        progress = true;
        if (out.judged >= this.perTick) {
          out.left += 1;
          continue;
        }
        const judgedBefore = out.judged;
        // SSE на входе и выходе: пока карточка у модели, все окна показывают
        // «разбирается сейчас», а не тишину после сгоревшего обратного отсчёта.
        this.judging = {
          ref: candidate.item.ref,
          channel: channel.id,
          startedAtMs: this.now(),
        };
        this._notifyStatusChanged('judging');
        let handled;
        try {
          handled = await this._handle({
            channel, candidate, ref, made, out, nowMs, signal,
          });
        } finally {
          this.judging = null;
          this._notifyStatusChanged('judging-done');
        }
        if (out.judged > judgedBefore || handled?.advance) {
          this._advanceCursor(channel, candidate.item);
          this.fairChannelCursor = channel.id;
        }
        if (handled?.haltAll) {
          halted = true;
          haltedReason = handled.haltAll;
          break;
        }
      }
    }

    this.lastTickAt = nowMs;
    const reasonChanged = this.lastReason !== haltedReason;
    this.lastReason = haltedReason;
    this.lastError = out.failed[0]?.code || null;
    if (haltedReason) out.haltedReason = haltedReason;
    if (reasonChanged) this._notifyStatusChanged('worker-state');
    return out;
  }

  _quiescent(reason) {
    this.lastReason = reason;
    this.lastError = null;
    return { ran: false, reason };
  }

  _channelRunnable(channel) {
    if (this.blockedChannels.has(channel.id) || channel.halted) return false;
    if (channel.error) {
      this.log.warn?.({ channel: channel.id, code: channel.error.code }, 'inbox: auto channel unreadable');
      channel.halted = true;
      return false;
    }
    return channel.state.plugin === 'enabled'
      && channel.state.connection === 'connected'
      && channel.state.participation === 'active'
      && channel.state.readOnly === false;
  }

  _rotateAfterCursor(channel) {
    const cursor = this.fairCursors.get(channel.id);
    if (!cursor || cursor.generation !== channel.generation || channel.items.length < 2) {
      if (cursor && cursor.generation !== channel.generation) this.fairCursors.delete(channel.id);
      return;
    }

    const exact = channel.items.findIndex((item) => item.ref === cursor.ref);
    let next = exact >= 0
      ? (exact + 1) % channel.items.length
      : channel.items.findIndex((item) => autoItemOrder(item, cursor) > 0);
    if (next < 0) next = 0;
    if (next > 0) {
      channel.items = [...channel.items.slice(next), ...channel.items.slice(0, next)];
    }
  }

  _advanceCursor(channel, item) {
    this.fairCursors.set(channel.id, {
      generation: channel.generation,
      ref: item.ref,
      lastAt: item.lastAt,
    });
  }

  _pruneAnalysisBlocks(channels) {
    const live = new Map();
    for (const channel of channels) {
      for (const item of channel.items) live.set(item.ref, item);
    }
    let changed = false;
    for (const [ref, block] of this.analysisBlocks) {
      const item = live.get(ref);
      if (!item || item.status !== 'new' || item.revision !== block.revision
          || !Array.isArray(item.attachments) || item.attachments.length === 0) {
        this.analysisBlocks.delete(ref);
        changed = true;
      }
    }
    if (changed) this._notifyStatusChanged('attachment-analysis-cleared');
  }

  _notifyStatusChanged(reason) {
    try {
      Promise.resolve(this.onChanged({ reason })).catch(() => {
        this.log.warn?.({ reason }, 'inbox: worker status SSE не отправлен');
      });
    } catch {
      this.log.warn?.({ reason }, 'inbox: worker status SSE не отправлен');
    }
  }

  _nextCandidate(channel, made, sinceMs, nowMs) {
    while (channel.items.length) {
      const item = channel.items.shift();
      const analysisBlock = this.analysisBlocks.get(item?.ref);
      if (analysisBlock?.revision === item?.revision && analysisBlock.retryAtMs > nowMs) continue;
      const scopeRef = item?.policy?.scopeRef;
      const createdToday = countInboxAutoTasks(channel.decisions, { scopeRef, sinceMs })
        + (made.get(scopeRef) || 0);
      const pre = decideInboxAutoAction({ item, createdToday, nowMs });
      if (pre.action === 'judge') return { item, scopeRef, createdToday };
    }
    return null;
  }

  async _settings() {
    const value = typeof this.providerSettings === 'function'
      ? await this.providerSettings()
      : this.providerSettings;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  async _materializeForAnalysis(item, channel) {
    const resolved = await this.coordinator.resolveItem(item.ref, { nowMs: this.now() });
    try {
      if (resolved.generation !== channel.generation
          || resolved.item.revision !== item.revision
          || resolved.item.status !== 'new') {
        const error = new Error('Inbox item изменился до подготовки вложений.');
        error.code = 'stale_item';
        throw error;
      }
      if (resolved.channelState.readOnly
          || resolved.channelState.connection !== 'connected'
          || resolved.channelState.participation !== 'active') {
        const error = new Error('Канал больше не готов к автоматическому разбору.');
        error.code = 'channel_deactivated';
        throw error;
      }
      if (typeof resolved.context.materializeAttachments !== 'function') {
        const error = new Error('Канал не умеет подготовить вложения для разбора.');
        error.code = 'channel_materialize_failed';
        throw error;
      }
      const prepared = await resolved.context.materializeAttachments(resolved.item.attachments);
      if (resolved.context.isCurrent && !await resolved.context.isCurrent()) {
        const error = new Error('Account generation изменилась при подготовке вложений.');
        error.code = 'account_changed';
        throw error;
      }
      return prepared;
    } finally {
      await resolved.release();
    }
  }

  async _analyzeAttachments(item, channel, signal) {
    if (!Array.isArray(item.attachments) || item.attachments.length === 0) return null;
    if (!this.attachmentAnalyzer) {
      return { ok: false, complete: false, error: 'attachment_analysis_unavailable' };
    }
    try {
      return await this.attachmentAnalyzer.analyze({
        item,
        signal,
        materialize: () => this._materializeForAnalysis(item, channel),
      });
    } catch (error) {
      return { ok: false, complete: false, error: safeCode(error, 'attachment_analysis_failed') };
    }
  }

  async _handle({ channel, candidate, ref, made, out, nowMs, signal }) {
    const { item, scopeRef, createdToday } = candidate;
    let gates = await this._liveGates(ref, signal);
    if (gates.reason) return { haltAll: gates.reason };
    try {
      await this.coordinator.workerGate(item.ref, { generation: channel.generation });
    } catch (error) {
      channel.halted = true;
      this.log.info?.({ channel: channel.id, itemRef: item.ref, code: safeCode(error) },
        'inbox: auto channel gate changed before model');
      return 'channel_halted';
    }
    gates = await this._liveGates(ref, signal);
    if (gates.reason) return { haltAll: gates.reason };
    const attachmentAnalysis = await this._analyzeAttachments(item, channel, signal);
    let triaged;
    try {
      if (attachmentAnalysis && (!attachmentAnalysis.ok || !attachmentAnalysis.complete)) {
        // Подготовка медиа тоже дорогая операция. Считаем её попыткой текущего tick,
        // чтобы очередь с неподдержанными файлами оставалась bounded и fair.
        out.judged += 1;
        const code = safeCode(
          { code: attachmentAnalysis.error },
          'attachment_analysis_required',
        );
        const attachments = blockedAttachments(attachmentAnalysis);
        out.analysisRequired.push({ ref: item.ref, channel: channel.id, code });
        this.analysisBlocks.set(item.ref, {
          revision: item.revision,
          code,
          attachments,
          checkedAtMs: nowMs,
          retryAtMs: nowMs + this.attachmentRetryMs,
        });
        this._notifyStatusChanged('attachment-analysis-required');
        this.log.info?.({
          channel: channel.id,
          itemRef: item.ref,
          code,
          // Причина каждого вложения — первое, что спросят при разборе жалобы
          // «висит и не объясняет»; без неё в журнале остаётся один общий код.
          attachments: attachments.map((value) => `${value.label}: ${value.reason}`),
        }, 'inbox: attachment analysis left item for human');
        return { advance: true };
      }
      if (attachmentAnalysis) {
        gates = await this._liveGates(ref, signal);
        if (gates.reason) return { haltAll: gates.reason };
        try {
          await this.coordinator.workerGate(item.ref, { generation: channel.generation });
        } catch (error) {
          channel.halted = true;
          this.log.info?.({ channel: channel.id, itemRef: item.ref, code: safeCode(error) },
            'inbox: auto channel gate changed after attachment analysis');
          return 'channel_halted';
        }
      }
      try {
        triaged = await this.triage({
          item,
          attachmentAnalysis,
          modelRef: ref,
          config: this.config,
          providerSettings: await this._settings(),
          log: this.log,
          signal,
          mode: 'plan',
        });
      } catch (error) {
        triaged = { ok: false, error: safeCode(error, 'triage_failed') };
      }
    } finally {
      // Модель уже получила visualPaths; дальнейшее решение использует лишь текст
      // анализа, поэтому lease можно отпустить до внешней mutation.
      await releaseAttachmentAnalysis(attachmentAnalysis, this.log);
    }
    out.judged += 1;
    gates = await this._liveGates(ref, signal);
    if (gates.reason) return { haltAll: gates.reason };
    if (!triaged?.ok) {
      const code = safeCode({ code: triaged?.error }, 'triage_failed');
      if (attachmentAnalysis && ATTACHMENT_TRIAGE_ERRORS.has(code)) {
        this.analysisBlocks.set(item.ref, {
          revision: item.revision,
          code,
          // Разбор прошёл, не потянула модель: перечислять нечего, объясняет код.
          attachments: [],
          checkedAtMs: nowMs,
          retryAtMs: nowMs + this.attachmentRetryMs,
        });
        this._notifyStatusChanged('attachment-analysis-required');
        out.analysisRequired.push({ ref: item.ref, channel: channel.id, code });
        this.log.info?.({ channel: channel.id, itemRef: item.ref, code },
          'inbox: attachment model compatibility left item for human');
        return { advance: true };
      }
      this.log.warn?.({ channel: channel.id, itemRef: item.ref, code: triaged?.error },
        'inbox: auto triage returned no verdict');
      if (['executor_unavailable', 'unsafe_model_provider'].includes(code)) {
        return { haltAll: code };
      }
      return;
    }
    if (this.analysisBlocks.delete(item.ref)) {
      this._notifyStatusChanged('attachment-analysis-ready');
    }
    try {
      await this.coordinator.workerGate(item.ref, { generation: channel.generation });
    } catch (error) {
      channel.halted = true;
      this.log.info?.({ channel: channel.id, itemRef: item.ref, code: safeCode(error) },
        'inbox: auto channel gate changed after model');
      return;
    }
    gates = await this._liveGates(ref, signal);
    if (gates.reason) return { haltAll: gates.reason };

    const plan = triaged.plan ?? null;
    const outcome = decideInboxAutoPlan({ item, plan, createdToday, nowMs });
    const model = triaged.model || `${ref.provider}/${ref.model}`;
    if (outcome.action !== 'run') {
      this.log.info?.({ channel: channel.id, itemRef: item.ref, action: outcome.action },
        'inbox: auto оставил обращение человеку');
      return;
    }

    // Номера плана считаются по тому же списку, что видела модель в transcript.
    const visible = visibleInboxMessages(item.messages);
    for (const entry of outcome.statements) {
      if (!['create', 'dismiss'].includes(entry.action)) continue;
      const messageRefs = entry.statement.messages.map((index) => visible[index - 1]?.messageRef);
      if (messageRefs.some((value) => typeof value !== 'string')) {
        this.log.warn?.({ channel: channel.id, itemRef: item.ref },
          'inbox: номер сообщения из плана не разрешился в messageRef');
        continue;
      }
      const stop = await this._decideStatement({
        channel,
        item,
        entry,
        messageRefs,
        whole: messageRefs.length === visible.length,
        model,
        made,
        out,
        scopeRef,
      });
      if (stop) return;
    }
  }

  /**
   * Одно решение плана. Возвращает `true`, когда карточку дальше трогать нельзя:
   * оставшиеся поводы честно уходят человеку вместо попытки проехать по уже
   * изменившемуся состоянию.
   */
  async _decideStatement({
    channel, item, entry, messageRefs, whole, model, made, out, scopeRef,
  }) {
    const note = inboxAutoNote({ model, verdict: entry.statement, reason: entry.reason });
    let revision = item.revision;
    let sourceUrl = item.sourceUrl;
    if (!whole) {
      // Каждое решение меняет revision карточки, а ссылка задачи обязана вести на
      // первое сообщение ИМЕННО этого повода. И то и другое известно только из
      // свежего снимка, поэтому разбитая карточка перечитывается перед каждым шагом.
      try {
        const context = await this._statementContext(item, channel, messageRefs);
        revision = context.revision;
        sourceUrl = context.sourceUrl;
      } catch (error) {
        this.log.info?.({
          channel: channel.id,
          itemRef: item.ref,
          code: safeCode(error, 'statement_context_failed'),
        }, 'inbox: остаток обращения оставлен человеку — состояние изменилось');
        return true;
      }
    }
    const body = { revision, messageRefs };

    try {
      if (entry.action === 'create') {
        const draft = buildInboxAutoTask({ item, verdict: entry.statement, sourceUrl });
        const created = await this.taskService.task(item.ref, {
          ...body,
          title: draft.title,
          description: draft.description,
        }, {
          by: 'auto',
          note,
          requireAllAttachments: true,
        });
        made.set(scopeRef, (made.get(scopeRef) || 0) + 1);
        this.created += 1;
        out.created.push({ ref: item.ref, channel: channel.id, taskId: created?.taskId ?? null });
      } else {
        await this.taskService.dismiss(item.ref, body, { by: 'auto', note });
        this.dismissed += 1;
        out.dismissed.push({ ref: item.ref, channel: channel.id });
      }
    } catch (error) {
      const code = safeCode(error);
      if (QUIET_MUTATION_ERRORS.has(code)) {
        this.log.info?.({ channel: channel.id, itemRef: item.ref, code },
          'inbox: auto result became stale or unsafe');
        return true;
      }
      if (code === 'indeterminate_task_commit') {
        this.blockedChannels.add(channel.id);
        this.log.error?.({
          channel: channel.id,
          itemRef: item.ref,
          taskId: error?.details?.taskId ?? null,
          code,
        }, 'inbox: auto channel blocked after indeterminate B24 commit');
      } else {
        this.log.error?.({ channel: channel.id, itemRef: item.ref, code },
          'inbox: auto mutation failed');
      }
      this.failed += 1;
      out.failed.push({ ref: item.ref, channel: channel.id, code });
      return true;
    }
    return false;
  }

  /** Свежие revision и ссылка на источник для подмножества сообщений карточки. */
  async _statementContext(item, channel, messageRefs) {
    const resolved = await this.coordinator.resolveItem(item.ref, { nowMs: this.now() });
    try {
      if (resolved.generation !== channel.generation) {
        throw Object.assign(new Error('Account generation изменилась.'), { code: 'account_changed' });
      }
      if (resolved.channelState.readOnly
          || resolved.channelState.connection !== 'connected'
          || resolved.channelState.participation !== 'active') {
        throw Object.assign(new Error('Канал больше не участвует в разборе.'), {
          code: 'channel_deactivated',
        });
      }
      const byRef = new Map(resolved.item.messages.map((message) => [message.messageRef, message]));
      const messages = messageRefs.map((messageRef) => byRef.get(messageRef));
      if (messages.some((message) => !message || message.decision !== null)) {
        throw Object.assign(new Error('Сообщения повода уже решены.'), { code: 'stale_item' });
      }
      const head = messages[0];
      let sourceUrl = item.sourceUrl;
      try {
        sourceUrl = safeInboxSourceUrl(
          await resolved.context.sourceUrl({ source: head.source, message: head }),
        ) || item.sourceUrl;
      } catch {
        // Небезопасная или несобранная ссылка не отменяет задачу: остаётся ссылка карточки.
      }
      return { revision: resolved.item.revision, sourceUrl };
    } finally {
      await resolved.release();
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    const generation = ++this.loopGeneration;
    const controller = new AbortController();
    this.controller = controller;
    const loop = async () => {
      if (!this.running || generation !== this.loopGeneration) return;
      let pause = this.idleMs;
      try {
        const result = await this.tick({ signal: controller.signal });
        // Отсутствие настройки — штатное изменяемое состояние. После выбора
        // модели/подключения B24 автомат должен проснуться максимум через минуту,
        // а не ждать пятиминутный backoff настоящей ошибки.
        if (result.ran === false && result.reason === 'snapshot_failed') pause = this.errorMs;
      } catch (error) {
        const code = safeCode(error);
        this.lastError = code;
        this.lastReason = 'tick_failed';
        this.log.error?.({ code }, 'inbox: auto tick failed');
        pause = this.errorMs;
      }
      if (!this.running || generation !== this.loopGeneration) return;
      this.timer = setTimeout(loop, pause);
      this.timer.unref?.();
    };
    void loop();
  }

  stop() {
    this.running = false;
    this.loopGeneration += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
  }
}
