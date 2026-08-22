// Обычный companion-ход из Telegram-пульта. Poller ждёт только server-owned
// preflight, durable user/turn marker и фактический старт POST, но не ответ модели.
import { randomBytes } from 'node:crypto';

import { resolveModelRef, sameModelRef } from '../../chat/model-ref.js';
import { contextFill } from '../../../../../web/src/shared/chat-context.js';
import {
  cbData,
  clipText,
  stopKeyboard,
  turnSummary,
} from './format.js';
import {
  encodePultOwnerKey,
  pultOwnerKeyMatches,
} from './state-store.js';
import { transcribePultVoice } from './voice.js';

const MESSAGE_LIMIT = 4_000;
const STOP_AFTER_MS = 30_000;
const TYPING_EVERY_MS = 4_000;
const ACTIVE_POLL_MS = 1_000;
const CHAT_SAVE_ATTEMPTS = 3;

const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

const nonNegative = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

function clearSessionContext(record, { discardSeed = false } = {}) {
  record.sessionId = null;
  record.contextTokens = 0;
  record.contextWindow = 0;
  record.contextMetric = '';
  record.contextIsEstimate = false;
  record.totalInputTokens = 0;
  record.cachedInputTokens = 0;
  record.contextCache = null;
  record.liveContextCache = null;
  if (discardSeed) {
    record.pendingSeed = '';
    record.compactedAt = 0;
  }
}

function applyContextUsage(record, result, run) {
  const metric = typeof result.contextMetric === 'string' ? result.contextMetric : '';
  const contextTokens = nonNegative(result.contextTokens);
  if (contextTokens !== null && (contextTokens > 0 || metric)) record.contextTokens = contextTokens;
  else if (positive(run?.contextTokens)) record.contextTokens = positive(run.contextTokens);
  const contextWindow = positive(result.contextWindow);
  if (contextWindow) record.contextWindow = contextWindow;
  if (metric) record.contextMetric = metric;
  if (Object.hasOwn(result, 'contextIsEstimate')) record.contextIsEstimate = result.contextIsEstimate === true;
  const totalInputTokens = nonNegative(result.totalInputTokens);
  if (totalInputTokens !== null) record.totalInputTokens = totalInputTokens;
  const cachedInputTokens = nonNegative(result.cachedInputTokens);
  if (cachedInputTokens !== null) record.cachedInputTokens = cachedInputTokens;
  if (Object.hasOwn(result, 'contextCache')) record.contextCache = result.contextCache || null;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function responseError(response, fallback) {
  const text = String(response?.body?.message || response?.body?.error || fallback || 'неизвестная ошибка');
  return Object.assign(new Error(text), {
    code: response?.body?.error || 'pult_api_failed',
    statusCode: response?.statusCode,
  });
}

function activeItems(body) {
  if (Array.isArray(body?.active)) return body.active;
  if (Array.isArray(body?.runs)) return body.runs;
  return [];
}

function cloneMessages(record) {
  return Array.isArray(record?.messages) ? structuredClone(record.messages) : [];
}

export class TelegramPultAssistant {
  constructor({
    callApi,
    stateStoreFor,
    acquireLease,
    queue,
    subscribe = null,
    speechRuntime = null,
    readSpeechPrefs = () => ({}),
    readCompactWindow = () => 0,
    now = Date.now,
    log = console,
  } = {}) {
    if (typeof callApi !== 'function' || typeof stateStoreFor !== 'function'
        || typeof acquireLease !== 'function' || typeof now !== 'function') {
      throw new TypeError('TelegramPultAssistant: callApi/stateStoreFor/acquireLease/now обязательны.');
    }
    this.callApi = callApi;
    this.stateStoreFor = stateStoreFor;
    this.acquireLease = acquireLease;
    this.queue = queue;
    this.speechRuntime = speechRuntime;
    this.readSpeechPrefs = readSpeechPrefs;
    this.readCompactWindow = readCompactWindow;
    this.now = now;
    this.log = log;
    this.runs = new Map();
    this.observing = new Map();
    this.tails = new Map();
    this.background = new Set();
    this.closed = false;
    this.unsubscribe = subscribe?.((event, data) => this._onEvent(event, data)) || null;
  }

  _owner(lease, settings) {
    return {
      accountRef: String(lease.accountRef || ''),
      generation: lease.generation,
      chatId: Number(settings.pultChatId),
      confirmedAtMs: Number(settings.pultConfirmedAtMs),
      ownerKey: encodePultOwnerKey(lease.accountRef, settings.pultConfirmedAtMs, settings.pultChatId),
    };
  }

  async _api(method, url, payload) {
    const response = await this.callApi(method, url, payload);
    if (!response || response.statusCode >= 400) throw responseError(response, `${method} ${url}`);
    return response.body || {};
  }

  async _readRecord(chatKey) {
    const body = await this._api('GET', `/api/chat/store/chat/${encodeURIComponent(chatKey)}`);
    if (!body.chat || body.chat.id !== chatKey) throw new Error('Сервер не вернул exact companion-чат.');
    return body.chat;
  }

  async _saveRecord(record, owner) {
    let candidate = record;
    for (let attempt = 0; attempt < CHAT_SAVE_ATTEMPTS; attempt += 1) {
      const saved = await this._api('PUT', '/api/chat/store/chat', {
        chat: candidate,
        archived: false,
        origin: `telegram-pult:${owner.accountRef}`,
      });
      if (!saved.stale) return this._readRecord(record.id);
      candidate = {
        ...candidate,
        ...(Number.isSafeInteger(saved.revision) ? { revision: saved.revision } : {}),
        ...(Number.isSafeInteger(saved.schema) ? { schema: saved.schema } : {}),
        ...(saved.surface ? { surface: saved.surface } : {}),
      };
    }
    throw Object.assign(
      new Error('Чат одновременно меняется в другом окне. Повтори сообщение.'),
      { code: 'chat_revision_conflict' },
    );
  }

  async _resolveRecord(record) {
    const providersBody = await this._api('GET', '/api/providers');
    const providers = Array.isArray(providersBody.providers) ? providersBody.providers : [];
    const registry = Object.fromEntries(providers.map((provider) => [provider.id, provider.models || []]));
    const resolved = resolveModelRef(record.modelRef, registry);
    const provider = resolved.ok
      ? providers.find((candidate) => candidate?.id === resolved.modelRef.provider)
      : null;
    const modes = Array.isArray(provider?.modes) ? provider.modes : [];
    const hasAuto = modes.some((mode) => (typeof mode === 'string' ? mode : mode?.id) === 'auto');
    if (!resolved.ok || provider?.available !== true || provider?.chatEnabled !== true || !hasAuto) {
      throw new Error('Выбранный исполнитель недоступен в режиме auto. Открой /chats и выбери совместимую модель.');
    }
    return { model: resolved.model, modelRef: resolved.modelRef };
  }

  async _prepare(lease, settings) {
    const owner = this._owner(lease, settings);
    const ensured = await this._api('POST', '/api/chat/store/ensure', {
      purpose: 'companion',
      taskId: null,
      origin: `telegram-pult:${owner.accountRef}`,
    });
    const chatKey = String(ensured?.chat?.id || '');
    if (!chatKey) throw new Error('Общий разговор «Компаньон» не найден.');
    const record = await this._readRecord(chatKey);
    if (record.purpose !== 'companion' || record.taskId !== null) {
      throw new Error('Сервер вернул не global companion-чат.');
    }

    const resolved = await this._resolveRecord(record);

    const active = await this._api('GET', '/api/chat/active');
    return {
      owner,
      record,
      chatKey,
      ...resolved,
      initiallyBusy: activeItems(active).some((run) => run?.chatKey === chatKey),
    };
  }

  async _mutateTurns(store, mutate) {
    const state = await store.read();
    const turns = mutate([...state.turns]);
    await store.write({ turns });
    return turns;
  }

  async _putTurn(store, turn) {
    await this._mutateTurns(store, (turns) => [...turns.filter((item) => item.id !== turn.id), turn]);
  }

  async _patchTurn(store, id, patch) {
    await this._mutateTurns(store, (turns) => turns.map((turn) => (
      turn.id === id ? { ...turn, ...patch } : turn
    )));
  }

  async _dropTurn(store, id) {
    await this._mutateTurns(store, (turns) => turns.filter((turn) => turn.id !== id));
  }

  _newTurn(prepared) {
    return {
      id: `t${randomBytes(4).toString('hex')}`,
      ownerKey: prepared.owner.ownerKey,
      chatId: prepared.owner.chatId,
      chatKey: prepared.chatKey,
      acceptedAt: this.now(),
      startedAt: null,
      phase: 'accepted',
      stopMessageId: null,
    };
  }

  async acceptText({ text, lease, settings }) {
    const userText = String(text || '');
    if (!userText.trim()) return false;
    try {
      const prepared = await this._prepare(lease, settings);
      prepared.userText = userText;
      prepared.sentAt = this.now();
      const turn = this._newTurn(prepared);
      prepared.store = this.stateStoreFor(lease);
      await this._putTurn(prepared.store, turn);
      const queued = this.tails.has(prepared.chatKey) || prepared.initiallyBusy;
      const started = this._enqueue(prepared, turn, { kind: 'message' });
      if (!queued) await started;
      return true;
    } catch (error) {
      this.log.warn?.({ code: error?.code }, 'telegram-pult: ход ассистента не принят');
      await this._sendTo(this._owner(lease, settings), `⚠ ${error?.message || 'Не удалось начать ход ассистента.'}`);
      return false;
    }
  }

  async acceptVoice({ media, lease, settings }) {
    const voice = (Array.isArray(media) ? media : []).find((item) => item?.kind === 'voice');
    if (!voice?.fileId) return false;
    let prepared;
    let turn;
    try {
      prepared = await this._prepare(lease, settings);
      prepared.store = this.stateStoreFor(lease);
      turn = this._newTurn(prepared);
      await this._putTurn(prepared.store, turn);
    } catch (error) {
      await this._sendTo(this._owner(lease, settings), `⚠ ${error?.message || 'Не удалось принять голосовое.'}`);
      return false;
    }

    this._track((async () => {
      try {
        const file = await this._withOwner(prepared.owner, (context, token) => (
          context.botApi.getFile(token, voice.fileId, { retries: 2 })
        ), { queued: false });
        if (!file?.filePath) throw new Error('Telegram не вернул путь голосового сообщения.');
        const bytes = await this._withOwner(prepared.owner, (context, token) => (
          context.botApi.downloadFile(token, file.filePath, { retries: 2 })
        ), { queued: false });
        const downloaded = { bytes, filePath: file.filePath };
        const heard = await transcribePultVoice({
          bytes: downloaded.bytes,
          fileName: downloaded.filePath,
          speechRuntime: this.speechRuntime,
          settings: await this.readSpeechPrefs(),
        });
        if (!heard) throw new Error('Не удалось разобрать голосовое сообщение.');
        prepared.userText = heard;
        prepared.heard = heard;
        prepared.sentAt = this.now();
        this._enqueue(prepared, turn, { kind: 'message' });
      } catch (error) {
        await this._dropTurn(prepared.store, turn.id).catch(() => {});
        await this._sendTo(prepared.owner, `⚠ ${error?.message || 'Не удалось обработать голосовое.'}`);
      }
    })());
    return true;
  }

  _enqueue(prepared, turn, operation) {
    const start = deferred();
    const previous = this.tails.get(prepared.chatKey) || Promise.resolve();
    const job = previous.catch(() => {}).then(() => this._run(prepared, turn, operation, start.resolve));
    this.tails.set(prepared.chatKey, job);
    this._track(job.finally(() => {
      if (this.tails.get(prepared.chatKey) === job) this.tails.delete(prepared.chatKey);
    }));
    return start.promise;
  }

  async _waitForFree(chatKey) {
    while (!this.closed) {
      const active = await this._api('GET', '/api/chat/active');
      if (!activeItems(active).some((item) => item?.chatKey === chatKey)) return;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, ACTIVE_POLL_MS);
        timer.unref?.();
      });
    }
    throw new Error('Пульт выключается.');
  }

  async _refreshPrepared(prepared) {
    const record = await this._readRecord(prepared.chatKey);
    const resolved = await this._resolveRecord(record);
    prepared.record = record;
    prepared.model = resolved.model;
    prepared.modelRef = resolved.modelRef;
    return record;
  }

  async _saveUserBeforeRun(prepared) {
    const current = await this._refreshPrepared(prepared);
    const seed = String(current.pendingSeed || '');
    prepared.seed = seed;
    prepared.message = seed
      ? `[Выжимка предыдущего разговора — продолжаем с этого места]\n${seed}\n[/Выжимка]\n\n${prepared.userText}`
      : prepared.userText;
    prepared.record = await this._saveRecord({
      ...current,
      messages: [
        ...cloneMessages(current),
        { role: 'user', text: prepared.userText, sentAt: prepared.sentAt },
      ],
      updatedAt: this.now(),
      ...(seed ? { pendingSeed: '' } : {}),
    }, prepared.owner);
  }

  async _run(prepared, turn, operation, signalStarted) {
    let run = null;
    try {
      await this._waitForFree(prepared.chatKey);
      if (operation.kind === 'message') {
        await this._saveUserBeforeRun(prepared);
      } else {
        await this._refreshPrepared(prepared);
        if (!prepared.record.sessionId) {
          throw new Error('Сжимать пока нечего: у разговора нет активной памяти.');
        }
      }
      const startedAt = this.now();
      await this._patchTurn(prepared.store, turn.id, { phase: 'started', startedAt });
      run = {
        ...turn,
        owner: prepared.owner,
        store: prepared.store,
        startedAt,
        settled: false,
        tools: new Map(),
        files: new Set(),
        tokens: 0,
        contextTokens: 0,
        stopMessageId: null,
        typingInterval: null,
        typingInFlight: false,
        typingPromise: null,
        stopTimer: null,
        stopInFlight: null,
      };
      this.runs.set(prepared.chatKey, run);
      await this._typing(run);
      run.typingInterval = setInterval(() => { void this._typing(run); }, TYPING_EVERY_MS);
      run.typingInterval.unref?.();
      run.stopTimer = setTimeout(() => {
        const job = this._showStop(run);
        run.stopInFlight = job;
        void job.finally(() => {
          if (run.stopInFlight === job) run.stopInFlight = null;
        }).catch(() => {});
      }, STOP_AFTER_MS);
      run.stopTimer.unref?.();

      const request = operation.kind === 'compact'
        ? this.callApi('POST', '/api/chat/compact', {
          chatKey: prepared.chatKey,
          model: prepared.modelRef.model,
          modelRef: prepared.modelRef,
          effort: prepared.record.effort || '',
          sessionId: prepared.record.sessionId,
          mode: 'auto',
        })
        : this.callApi('POST', '/api/chat', {
          message: prepared.message,
          model: prepared.modelRef.model,
          modelRef: prepared.modelRef,
          effort: prepared.record.effort || '',
          mode: 'auto',
          sessionId: prepared.record.sessionId || null,
          context: { page: 'Telegram-пульт', path: '/telegram/pult' },
          chatKey: prepared.chatKey,
          sentAt: prepared.sentAt,
        });
      signalStarted();
      const response = await request;
      if (!response || response.statusCode >= 400) throw responseError(response, 'Ход ассистента завершился ошибкой.');
      if (operation.kind === 'compact') {
        if (response.body?.stopped) {
          if (response.body.sessionReset) await this._saveSessionReset(prepared);
        } else {
          await this._saveCompactResult(prepared, response.body || {});
        }
        await this._settle(run);
        await this._sendTo(
          prepared.owner,
          response.body?.stopped
            ? (response.body.sessionReset
              ? '⏹ Сжатие остановлено; сессия сброшена, следующий ход начнётся с нуля.'
              : '⏹ Сжатие остановлено; память не изменена.')
            : '✓ Память разговора сжата.',
        );
      } else {
        await this._saveAssistantResult(prepared, response.body || {}, run);
        await this._settle(run);
        await this._sendResult(prepared, response.body || {}, run);
      }
    } catch (error) {
      signalStarted();
      if (prepared.seed) await this._restoreSeed(prepared).catch(() => {});
      if (run) await this._settle(run);
      else await this._dropTurn(prepared.store, turn.id).catch(() => {});
      this.log.warn?.({ code: error?.code }, 'telegram-pult: ход ассистента завершился ошибкой');
      await this._sendTo(prepared.owner, `⚠ Ошибка хода ассистента: ${error?.message || 'неизвестный сбой'}`);
    } finally {
      if (this.runs.get(prepared.chatKey) === run) this.runs.delete(prepared.chatKey);
    }
  }

  async _restoreSeed(prepared) {
    const current = await this._readRecord(prepared.chatKey);
    if (!current.pendingSeed) await this._saveRecord({ ...current, pendingSeed: prepared.seed }, prepared.owner);
  }

  async _saveAssistantResult(prepared, result, run) {
    const current = await this._readRecord(prepared.chatKey);
    const text = String(result.reply || '(пусто)');
    const message = {
      role: 'assistant',
      text,
      ...(result.cost !== undefined ? { cost: result.cost } : {}),
      ...(Array.isArray(result.steps) ? { steps: result.steps } : {}),
      model: result.model || prepared.modelRef.model,
      actualModel: result.actualModel || '',
      effort: Object.hasOwn(result, 'effort') ? (result.effort || '') : (current.effort || ''),
      ...(result.stopped ? { stopped: true } : {}),
    };
    const next = {
      ...current,
      messages: [...cloneMessages(current), message],
      updatedAt: this.now(),
    };
    if (result.sessionReset) {
      if (prepared.seed && !next.pendingSeed) next.pendingSeed = prepared.seed;
      clearSessionContext(next);
    } else {
      if (result.sessionId) next.sessionId = result.sessionId;
      applyContextUsage(next, result, run);
    }
    prepared.finalRecord = await this._saveRecord(next, prepared.owner);
  }

  async _saveCompactResult(prepared, result) {
    const current = await this._readRecord(prepared.chatKey);
    const messages = cloneMessages(current);
    const compact = result.compact || result.compaction || {};
    const seed = String(compact.seed || compact.text || '');
    if (!['summary', 'native'].includes(compact.kind)) {
      throw new Error('Сервер не вернул результат сжатия — память не изменена.');
    }
    const next = { ...current, messages, updatedAt: this.now() };
    if (compact.kind === 'summary') {
      if (!seed) throw new Error('Сервер не вернул выжимку — память не сжата.');
      next.pendingSeed = seed;
    }
    clearSessionContext(next);
    if (compact.kind !== 'summary') next.sessionId = result.sessionId || current.sessionId || null;
    next.compactedAt = this.now();
    await this._saveRecord(next, prepared.owner);
  }

  async _saveSessionReset(prepared, { discardSeed = false } = {}) {
    const current = await this._readRecord(prepared.chatKey);
    const next = { ...current, messages: cloneMessages(current), updatedAt: this.now() };
    clearSessionContext(next, { discardSeed });
    await this._saveRecord(next, prepared.owner);
  }

  _contextWindow(prepared, result) {
    const runtime = positive(result.contextWindow);
    if (runtime) return runtime;
    const record = prepared.finalRecord || prepared.record;
    if (sameModelRef(record?.modelRef, prepared.modelRef)) {
      const stored = positive(record?.contextWindow);
      if (stored) return stored;
    }
    return prepared.model?.contextUnverified === true ? 0 : positive(prepared.model?.context);
  }

  async _sendResult(prepared, result, run) {
    const contextTokens = positive(result.contextTokens) || positive(run.contextTokens);
    const contextWindow = this._contextWindow(prepared, result);
    const compactWindow = Math.max(0, Number(await this.readCompactWindow()) || 0);
    const summary = turnSummary({
      files: [...run.files],
      tokens: run.tokens,
      contextTokens,
      contextWindow,
      compactWindow,
    });
    const fill = contextTokens && contextWindow
      ? contextFill({ tokens: contextTokens, window: contextWindow, compactWindow })
      : null;
    const warning = fill?.tone === 'hi' ? 'Контекст достиг порога сжатия.' : '';
    const main = [prepared.heard ? `услышал: ${prepared.heard}` : '', String(result.reply || '(пусто)')]
      .filter(Boolean)
      .join('\n\n');
    const tail = [summary, warning].filter(Boolean).join('\n');
    const budget = Math.max(1, MESSAGE_LIMIT - [...tail].length - (tail ? 2 : 0));
    const text = `${clipText(main, budget)}${tail ? `\n\n${tail}` : ''}`;
    await this._sendTo(prepared.owner, text, warning ? [[{
      text: '🗜 Сжать',
      callback_data: cbData.agentCompact(),
    }]] : null);
  }

  async _typing(run) {
    if (run.settled || run.typingInFlight) return;
    run.typingInFlight = true;
    const job = this._withOwner(run.owner, (context, token) => (
      context.botApi.sendChatAction(token, run.chatId, 'typing', { timeoutMs: 15_000 })
    ));
    run.typingPromise = job;
    try {
      await job;
    } catch (error) {
      this.log.warn?.({ code: error?.code }, 'telegram-pult: typing не доставлен');
    } finally {
      run.typingInFlight = false;
      if (run.typingPromise === job) run.typingPromise = null;
    }
  }

  async _showStop(run) {
    if (run.settled || run.stopMessageId) return;
    const sent = await this._sendTo(run.owner, '⏹ Стоп', stopKeyboard(run.id));
    if (run.settled) {
      if (sent?.message_id) await this._deleteFrom(run.owner, sent.message_id);
      return;
    }
    const messageId = Number(sent?.message_id);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return;
    run.stopMessageId = messageId;
    await this._patchTurn(run.store, run.id, { stopMessageId: messageId }).catch(() => {});
  }

  async _settle(run) {
    run.settled = true;
    if (run.stopTimer) clearTimeout(run.stopTimer);
    if (run.typingInterval) clearInterval(run.typingInterval);
    if (run.typingPromise) await run.typingPromise.catch(() => {});
    if (run.stopInFlight) await run.stopInFlight.catch(() => {});
    if (run.stopMessageId) await this._deleteFrom(run.owner, run.stopMessageId);
    await this._dropTurn(run.store, run.id).catch(() => {});
  }

  _onEvent(event, data) {
    if (!['chat-turn-start', 'chat-progress', 'chat-step', 'chat-done'].includes(event)) return;
    const chatKey = String(data?.chatKey || '');
    if (event === 'chat-done' && this.observing.has(chatKey)) {
      const observed = this.observing.get(chatKey);
      this.observing.delete(chatKey);
      this._track((async () => {
        if (observed.turn.stopMessageId) {
          await this._deleteFrom(observed.owner, observed.turn.stopMessageId);
        }
        await this._dropTurn(observed.store, observed.turn.id);
      })());
    }
    const run = this.runs.get(chatKey);
    if (!run || run.settled) return;
    if (event === 'chat-progress') {
      run.tokens = positive(data?.tokens) || run.tokens;
      run.contextTokens = positive(data?.contextTokens) || run.contextTokens;
      return;
    }
    if (event !== 'chat-step') return;
    const step = data?.step;
    if (step?.k === 'tool' && ['Edit', 'Write'].includes(step.name) && Array.isArray(step.files)) {
      run.tools.set(String(step.id || ''), step.files.filter((file) => typeof file === 'string' && file));
    } else if (step?.k === 'res' && step.ok === true) {
      for (const file of run.tools.get(String(step.id || '')) || []) run.files.add(file);
    }
  }

  async handleStop({ turnId, callback, lease, settings }) {
    const store = this.stateStoreFor(lease);
    const state = await store.read().catch(() => null);
    const turn = state?.turns?.find((candidate) => candidate.id === turnId);
    if (!turn || turn.stopMessageId !== callback.messageId
        || !['started', 'observing'].includes(turn.phase)) return false;
    if (!pultOwnerKeyMatches(
      turn.ownerKey,
      lease.accountRef,
      settings.pultConfirmedAtMs,
      settings.pultChatId,
    )) return false;
    await this._api('POST', '/api/chat/stop', { chatKey: turn.chatKey });
    return true;
  }

  async compact({ lease, settings }) {
    try {
      const prepared = await this._prepare(lease, settings);
      if (!prepared.record.sessionId) throw new Error('Сжимать пока нечего: у разговора нет активной памяти.');
      prepared.store = this.stateStoreFor(lease);
      const turn = this._newTurn(prepared);
      await this._putTurn(prepared.store, turn);
      const queued = this.tails.has(prepared.chatKey) || prepared.initiallyBusy;
      const started = this._enqueue(prepared, turn, { kind: 'compact' });
      if (!queued) await started;
      return { ok: true, text: 'Сжатие начато.' };
    } catch (error) {
      return { ok: false, text: error?.message || 'Сжатие не началось.' };
    }
  }

  async reset({ lease, settings }) {
    try {
      const prepared = await this._prepare(lease, settings);
      await this._api('POST', '/api/chat/session/reset', {
        chatKey: prepared.chatKey,
        modelRef: prepared.modelRef,
      });
      await this._saveSessionReset(prepared, { discardSeed: true });
      return { ok: true, text: 'Память ассистента сброшена; история переписки сохранена.' };
    } catch (error) {
      return { ok: false, text: error?.message || 'Память не сбросилась.' };
    }
  }

  async _withOwner(owner, operation, { queued = true } = {}) {
    const execute = async () => {
      const lease = this.acquireLease();
      try {
        if (!lease.isCurrent?.()) throw new Error('Привязка Telegram изменилась.');
        if (owner.generation !== undefined && lease.generation !== undefined
            && owner.generation !== lease.generation) throw new Error('Привязка Telegram изменилась.');
        const settings = await lease.context.botSettings.read();
        if (!pultOwnerKeyMatches(
          owner.ownerKey,
          lease.accountRef,
          settings.pultConfirmedAtMs,
          settings.pultChatId,
        )) throw new Error('Пульт уже привязан к другой личке.');
        const token = lease.context.credentials?.token || '';
        if (!token) throw new Error('Telegram-бот отключён.');
        return await operation(lease.context, token);
      } finally {
        await lease?.release?.();
      }
    };
    return queued ? this.queue.push(execute) : execute();
  }

  _sendTo(owner, text, keyboard = null) {
    return this._withOwner(owner, (context, token) => context.botApi.callBotApi(token, 'sendMessage', {
      chat_id: owner.chatId,
      text: clipText(text, MESSAGE_LIMIT),
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    }, { timeoutMs: 15_000 })).catch((error) => {
      this.log.warn?.({ code: error?.code }, 'telegram-pult: ответ ассистента не доставлен');
      return null;
    });
  }

  _deleteFrom(owner, messageId) {
    return this._withOwner(owner, (context, token) => context.botApi.callBotApi(token, 'deleteMessage', {
      chat_id: owner.chatId,
      message_id: messageId,
    }, { timeoutMs: 15_000 })).catch(() => null);
  }

  _track(promise) {
    this.background.add(promise);
    promise.finally(() => this.background.delete(promise)).catch(() => {});
    return promise;
  }

  async reconcile() {
    let lease;
    try { lease = this.acquireLease(); } catch { return; }
    try {
      const settings = await lease.context.botSettings.read();
      if (settings.pultConfirmedAtMs == null || settings.pultChatId == null) return;
      const owner = this._owner(lease, settings);
      const store = this.stateStoreFor(lease);
      const state = await store.read();
      const active = activeItems(await this._api('GET', '/api/chat/active'));
      for (const turn of state.turns) {
        if (!pultOwnerKeyMatches(
          turn.ownerKey,
          lease.accountRef,
          settings.pultConfirmedAtMs,
          settings.pultChatId,
        )) continue;
        // Accepted-marker ещё не запускал модель: живой ход того же chatKey может
        // принадлежать предыдущей записи очереди и не делает этот marker своим.
        if (turn.phase !== 'accepted' && active.some((run) => run?.chatKey === turn.chatKey)) {
          await this._patchTurn(store, turn.id, { phase: 'observing' });
          this.observing.set(turn.chatKey, { turn: { ...turn, phase: 'observing' }, owner, store });
          continue;
        }
        if (turn.stopMessageId) await this._deleteFrom(owner, turn.stopMessageId);
        await this._sendTo(owner, '⚠ Ход оборвался при перезапуске сервера. Повтори вопрос.');
        await this._dropTurn(store, turn.id);
      }
    } catch (error) {
      this.log.warn?.({ code: error?.code }, 'telegram-pult: незавершённые ходы не сверились');
    } finally {
      await lease?.release?.();
    }
  }

  stop() {
    this.closed = true;
    try { this.unsubscribe?.(); } catch { /* уже снята */ }
    this.unsubscribe = null;
    this.observing.clear();
    for (const run of this.runs.values()) {
      if (run.stopTimer) clearTimeout(run.stopTimer);
      if (run.typingInterval) clearInterval(run.typingInterval);
      run.settled = true;
    }
  }
}

export default TelegramPultAssistant;
