// Обычный companion-ход из Telegram-пульта. Poller ждёт только server-owned
// preflight, durable user/turn marker и фактический старт POST, но не ответ модели.
import { randomBytes } from 'node:crypto';

import { resolveModelRef, sameModelRef } from '../../chat/modelRef.ts';
import { contextFill } from '../../../../../shared/chatContext.ts';
import { normalizeContextUsage } from '../../../../../shared/chatContextUsage.ts';
import {
  cbData,
  clipText,
  stopKeyboard,
  turnSummary,
} from './format.ts';
import {
  encodePultOwnerKey,
  pultOwnerKeyMatches,
} from './stateStore.ts';
import { transcribePultVoice } from './voice.ts';

const MESSAGE_LIMIT = 4_000;
type Payload = Record<string, unknown>;

interface ApiResponse {
  statusCode?: number;
  body?: unknown;
}

// Аренда аккаунта: пока она жива, владелец пульта и его токен не меняются.
interface AssistantLease {
  accountRef?: string;
  generation?: unknown;
  context: {
    botSettings: { read: () => Promise<Payload> };
    botApi: {
      callBotApi: (token: string, method: string, body?: Payload, opts?: Payload)
        => Promise<unknown>;
      sendChatAction: (token: string, chatId: unknown, action: string, opts?: Payload)
        => Promise<unknown>;
      getFile: (token: string, fileId: string, opts?: Payload) => Promise<unknown>;
      downloadFile: (token: string, filePath: string, opts?: Payload) => Promise<unknown>;
    };
    credentials?: { token?: string } | null;
  };
  isCurrent?: () => boolean;
  release?: () => unknown;
}

interface PultStateStorePort {
  read: () => Promise<{ turns: unknown[] } & Payload>;
  write: (patch: Payload) => Promise<unknown>;
}

// Владелец пульта: та самая подтверждённая личка, и никакая другая.
interface PultOwner {
  accountRef: string;
  generation: unknown;
  chatId: number;
  confirmedAtMs: number;
  ownerKey: string;
}

// Всё, что нужно одному ходу: разговор, модель и владелец. Собирается заново
// перед каждым ходом — настройки могли поменяться между сообщениями.
interface Prepared extends Payload {
  owner: PultOwner;
  record: Payload;
  chatKey: string;
  model: Payload;
  modelRef: Payload;
  initiallyBusy: boolean;
  store?: PultStateStorePort;
  userText?: string;
  heard?: string;
  seed?: string;
  message?: string;
  sentAt?: number;
  finalRecord?: Payload;
}

// Живой ход: то, что нельзя хранить на диске — таймеры, набранные файлы и
// обещания уже отправленных вызовов.
interface RunState extends Payload {
  id: string;
  chatId: number;
  owner: PultOwner;
  store: PultStateStorePort;
  startedAt: number;
  settled: boolean;
  tools: Map<string, string[]>;
  files: Set<string>;
  tokens: number;
  contextTokens: number;
  stopMessageId: number | null;
  typingInterval: ReturnType<typeof setInterval> | null;
  typingInFlight: boolean;
  typingPromise: Promise<unknown> | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
  stopInFlight: Promise<unknown> | null;
}

// Движок распознавания приходит снаружи как есть; форму его контракта знает
// сам `voice.ts`, а пульт лишь передаёт его дальше.
type SpeechRuntimeArg = NonNullable<Parameters<typeof transcribePultVoice>[0]>['speechRuntime'];

type LogPort = { warn?: (details: unknown, message: string) => void };

const errorCode = (err: unknown) => (err as { code?: unknown } | null)?.code;
const errorText = (err: unknown) => String((err as { message?: unknown } | null)?.message || '');

const STOP_AFTER_MS = 30_000;
const TYPING_EVERY_MS = 4_000;
const ACTIVE_POLL_MS = 1_000;
const TELEGRAM_HEALTH_POLL_MS = 1_000;
const CHAT_SAVE_ATTEMPTS = 3;

/** Повторная правка тем же текстом уже достигла нужного состояния. */
const isUnchangedEdit = (error: unknown) => /message is not modified/iu.test(errorText(error));

/** Сообщение «Стоп» удалено человеком — итог надо отправить новым сообщением. */
const isMissingMessage = (error: unknown) => /not found/iu.test(errorText(error));

const positive = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

const nonNegative = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

function clearSessionContext(record: Payload, { discardSeed = false }: {
  discardSeed?: boolean;
} = {}): void {
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

function applyContextUsage(record: Payload, result: Payload, run: RunState | null): void {
  Object.assign(record, normalizeContextUsage(run), normalizeContextUsage(result));
  const totalInputTokens = nonNegative(result.totalInputTokens);
  if (totalInputTokens !== null) record.totalInputTokens = totalInputTokens;
  const cachedInputTokens = nonNegative(result.cachedInputTokens);
  if (cachedInputTokens !== null) record.cachedInputTokens = cachedInputTokens;
  if (Object.hasOwn(result, 'contextCache')) record.contextCache = result.contextCache || null;
}

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });

  return { promise, resolve };
}

function responseError(response: ApiResponse | null, fallback?: string): Error {
  const body = (response?.body || {}) as Payload;
  const text = String(body.message || body.error || fallback || 'неизвестная ошибка');

  return Object.assign(new Error(text), {
    code: body.error || 'pult_api_failed',
    statusCode: response?.statusCode,
  });
}

function activeItems(body: unknown): Payload[] {
  const source = body as Payload | null;

  if (Array.isArray(source?.active)) return source.active as Payload[];
  if (Array.isArray(source?.runs)) return source.runs as Payload[];

  return [];
}

function cloneMessages(record: Payload | null | undefined): unknown[] {
  return Array.isArray(record?.messages) ? structuredClone(record.messages) as unknown[] : [];
}

export class TelegramPultAssistant {
  callApi: (method: string, url: string, payload?: unknown) => Promise<ApiResponse | null>;

  stateStoreFor: (lease: AssistantLease) => PultStateStorePort;

  acquireLease: () => AssistantLease;

  queue: { push: <Result>(job: () => Promise<Result>, opts?: Payload) => Promise<Result> };

  speechRuntime: unknown;

  readSpeechPrefs: () => Promise<unknown> | unknown;

  readCompactWindow: () => Promise<unknown> | unknown;

  readPollStatus: () => Payload | null;

  now: () => number;

  log: LogPort;

  runs: Map<string, RunState>;

  observing: Map<string, { turn: Payload; owner: PultOwner; store: PultStateStorePort }>;

  tails: Map<string, Promise<unknown>>;

  background: Set<Promise<unknown>>;

  closed: boolean;

  unsubscribe: (() => void) | null;

  constructor({
    callApi,
    stateStoreFor,
    acquireLease,
    queue,
    subscribe = null,
    speechRuntime = null,
    readSpeechPrefs = () => ({}),
    readCompactWindow = () => 0,
    readPollStatus = () => null,
    now = Date.now,
    log = console,
  }: {
    callApi?: (method: string, url: string, payload?: unknown) => Promise<ApiResponse | null>;
    stateStoreFor?: (lease: AssistantLease) => PultStateStorePort;
    acquireLease?: () => AssistantLease;
    queue?: { push: <Result>(job: () => Promise<Result>, opts?: Payload) => Promise<Result> };
    subscribe?: ((listener: (event: string, data?: unknown) => void) => (() => void)) | null;
    speechRuntime?: unknown;
    readSpeechPrefs?: () => Promise<unknown> | unknown;
    readCompactWindow?: () => Promise<unknown> | unknown;
    readPollStatus?: () => Payload | null;
    now?: () => number;
    log?: LogPort;
  } = {}) {
    if (typeof callApi !== 'function' || typeof stateStoreFor !== 'function'
        || typeof acquireLease !== 'function' || typeof readPollStatus !== 'function'
        || typeof now !== 'function') {
      throw new TypeError(
        'TelegramPultAssistant: callApi/stateStoreFor/acquireLease/readPollStatus/now обязательны.',
      );
    }
    this.callApi = callApi;
    this.stateStoreFor = stateStoreFor as (lease: AssistantLease) => PultStateStorePort;
    this.acquireLease = acquireLease as () => AssistantLease;
    this.queue = queue as {
      push: <Result>(job: () => Promise<Result>, opts?: Payload) => Promise<Result>;
    };
    this.speechRuntime = speechRuntime;
    this.readSpeechPrefs = readSpeechPrefs;
    this.readCompactWindow = readCompactWindow;
    this.readPollStatus = readPollStatus;
    this.now = now;
    this.log = log;
    this.runs = new Map();
    this.observing = new Map();
    this.tails = new Map();
    this.background = new Set();
    this.closed = false;
    this.unsubscribe = subscribe?.((event, data) => this._onEvent(event, data)) || null;
  }

  _owner(lease: AssistantLease, settings: Payload): PultOwner {
    return {
      accountRef: String(lease.accountRef || ''),
      generation: lease.generation,
      chatId: Number(settings.pultChatId),
      confirmedAtMs: Number(settings.pultConfirmedAtMs),
      ownerKey: encodePultOwnerKey(lease.accountRef, settings.pultConfirmedAtMs, settings.pultChatId),
    };
  }

  async _api(method: string, url: string, payload?: unknown): Promise<Payload> {
    const response = await this.callApi(method, url, payload);

    if (!response || Number(response.statusCode) >= 400) {
      throw responseError(response, `${method} ${url}`);
    }

    return (response.body || {}) as Payload;
  }

  async _readRecord(chatKey: string): Promise<Payload> {
    const body = await this._api('GET', `/api/chat/store/chat/${encodeURIComponent(chatKey)}`);
    const chat = body.chat as Payload | undefined;

    if (!chat || chat.id !== chatKey) throw new Error('Сервер не вернул exact companion-чат.');

    return chat;
  }

  async _saveRecord(record: Payload, owner: PultOwner): Promise<Payload> {
    let candidate = record;
    for (let attempt = 0; attempt < CHAT_SAVE_ATTEMPTS; attempt += 1) {
      const saved = await this._api('PUT', '/api/chat/store/chat', {
        chat: candidate,
        archived: false,
        origin: `telegram-pult:${owner.accountRef}`,
      });
      if (!saved.stale) return this._readRecord(String(record.id));
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

  async _resolveRecord(record: Payload): Promise<{ model: Payload; modelRef: Payload }> {
    const providersBody = await this._api('GET', '/api/providers');
    const providers = (Array.isArray(providersBody.providers)
      ? providersBody.providers
      : []) as Payload[];
    const registry = Object.fromEntries(providers.map((provider) => (
      [provider.id, provider.models || []]
    )));
    const resolved = resolveModelRef(record.modelRef, registry) as {
      ok?: boolean;
      modelRef?: Payload;
      model?: Payload;
    };
    const provider = resolved.ok
      ? providers.find((candidate) => candidate?.id === (resolved.modelRef as Payload).provider)
      : null;
    const modes = Array.isArray(provider?.modes) ? provider.modes : [];
    const hasAuto = (modes as Payload[]).some((mode) => (
      (typeof mode === 'string' ? mode : (mode as Payload)?.id) === 'auto'
    ));
    if (!resolved.ok || provider?.available !== true || provider?.chatEnabled !== true || !hasAuto) {
      throw new Error('Выбранный исполнитель недоступен в режиме auto. Открой /chats и выбери совместимую модель.');
    }
    return {
      model: {
        ...resolved.model,
        chatAutoCompact: (provider.capabilities as Payload | undefined)?.chatAutoCompact === true,
      },
      modelRef: resolved.modelRef as Payload,
    };
  }

  async _prepare(lease: AssistantLease, settings: Payload): Promise<Prepared> {
    const owner = this._owner(lease, settings);
    const ensured = await this._api('POST', '/api/chat/store/ensure', {
      purpose: 'companion',
      taskId: null,
      origin: `telegram-pult:${owner.accountRef}`,
    });
    const chatKey = String((ensured?.chat as Payload | undefined)?.id || '');
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
    } as Prepared;
  }

  async _mutateTurns(
    store: PultStateStorePort,
    mutate: (turns: Payload[]) => Payload[],
  ): Promise<Payload[]> {
    const state = await store.read();
    const turns = mutate([...state.turns] as Payload[]);
    await store.write({ turns });
    return turns;
  }

  async _putTurn(store: PultStateStorePort, turn: Payload): Promise<void> {
    await this._mutateTurns(store, (turns) => [...turns.filter((item) => item.id !== turn.id), turn]);
  }

  async _patchTurn(store: PultStateStorePort, id: unknown, patch: Payload): Promise<void> {
    await this._mutateTurns(store, (turns) => turns.map((turn) => (
      turn.id === id ? { ...turn, ...patch } : turn
    )));
  }

  async _dropTurn(store: PultStateStorePort, id: unknown): Promise<void> {
    await this._mutateTurns(store, (turns) => turns.filter((turn) => turn.id !== id));
  }

  _newTurn(prepared: Prepared): Payload {
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

  async acceptText({ text, lease, settings }: {
    text?: unknown;
    lease: AssistantLease;
    settings: Payload;
  }): Promise<boolean> {
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
      this.log.warn?.({ code: errorCode(error) }, 'telegram-pult: ход ассистента не принят');
      await this._sendTo(
        this._owner(lease, settings),
        `⚠ ${errorText(error) || 'Не удалось начать ход ассистента.'}`,
      );
      return false;
    }
  }

  async acceptVoice({ media, lease, settings }: {
    media?: unknown;
    lease: AssistantLease;
    settings: Payload;
  }): Promise<boolean> {
    const voice = (Array.isArray(media) ? media as Payload[] : [])
      .find((item) => item?.kind === 'voice');

    if (!voice?.fileId) return false;

    let prepared: Prepared;
    let turn: Payload;

    try {
      prepared = await this._prepare(lease, settings);
      prepared.store = this.stateStoreFor(lease);
      turn = this._newTurn(prepared);
      await this._putTurn(prepared.store, turn);
    } catch (error) {
      await this._sendTo(
        this._owner(lease, settings),
        `⚠ ${errorText(error) || 'Не удалось принять голосовое.'}`,
      );

      return false;
    }

    this._track((async () => {
      try {
        const file = await this._withOwner(prepared.owner, (context, token) => (
          context.botApi.getFile(token, String(voice.fileId), { retries: 2 })
        ), { queued: false }) as Payload | null;

        if (!file?.filePath) throw new Error('Telegram не вернул путь голосового сообщения.');

        const bytes = await this._withOwner(prepared.owner, (context, token) => (
          context.botApi.downloadFile(token, String(file.filePath), { retries: 2 })
        ), { queued: false }) as Buffer;
        const downloaded = { bytes, filePath: String(file.filePath) };
        const heard = await transcribePultVoice({
          bytes: downloaded.bytes,
          fileName: downloaded.filePath,
          speechRuntime: this.speechRuntime as SpeechRuntimeArg,
          settings: await this.readSpeechPrefs(),
        });
        if (!heard) throw new Error('Не удалось разобрать голосовое сообщение.');
        prepared.userText = heard;
        prepared.heard = heard;
        prepared.sentAt = this.now();
        this._enqueue(prepared, turn, { kind: 'message' });
      } catch (error) {
        await this._dropTurn(prepared.store as PultStateStorePort, turn.id).catch(() => {});
        await this._sendTo(
          prepared.owner,
          `⚠ ${errorText(error) || 'Не удалось обработать голосовое.'}`,
        );
      }
    })());
    return true;
  }

  _enqueue(prepared: Prepared, turn: Payload, operation: { kind: string }): Promise<void> {
    const start = deferred();
    const previous = this.tails.get(prepared.chatKey) || Promise.resolve();
    const job = previous.catch(() => {}).then(() => this._run(prepared, turn, operation, start.resolve));
    this.tails.set(prepared.chatKey, job);
    this._track(job.finally(() => {
      if (this.tails.get(prepared.chatKey) === job) this.tails.delete(prepared.chatKey);
    }));
    return start.promise;
  }

  async _waitForFree(chatKey: string): Promise<void> {
    while (!this.closed) {
      const active = await this._api('GET', '/api/chat/active');
      if (!activeItems(active).some((item) => item?.chatKey === chatKey)) return;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, ACTIVE_POLL_MS);

        (timer as { unref?: () => void }).unref?.();
      });
    }
    throw new Error('Пульт выключается.');
  }

  async _refreshPrepared(prepared: Prepared): Promise<Payload> {
    const record = await this._readRecord(prepared.chatKey);
    const resolved = await this._resolveRecord(record);
    prepared.record = record;
    prepared.model = resolved.model;
    prepared.modelRef = resolved.modelRef;
    return record;
  }

  async _saveUserBeforeRun(prepared: Prepared): Promise<void> {
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

  async _run(
    prepared: Prepared,
    turn: Payload,
    operation: { kind: string },
    signalStarted: () => void,
  ): Promise<void> {
    let run: RunState | null = null;
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
      await this._patchTurn(
        prepared.store as PultStateStorePort,
        turn.id,
        { phase: 'started', startedAt },
      );
      run = {
        ...turn,
        id: String(turn.id),
        chatId: Number(turn.chatId),
        owner: prepared.owner,
        store: prepared.store as PultStateStorePort,
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
      const live = run;

      live.typingInterval = setInterval(() => { void this._typing(live); }, TYPING_EVERY_MS);
      (live.typingInterval as { unref?: () => void }).unref?.();
      live.stopTimer = setTimeout(() => {
        const job = this._showStop(live);

        live.stopInFlight = job;
        void job.finally(() => {
          if (live.stopInFlight === job) live.stopInFlight = null;
        }).catch(() => {});
      }, STOP_AFTER_MS);
      (live.stopTimer as { unref?: () => void }).unref?.();

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

      if (!response || Number(response.statusCode) >= 400) {
        throw responseError(response, 'Ход ассистента завершился ошибкой.');
      }

      const body = (response.body || {}) as Payload;

      if (operation.kind === 'compact') {
        if (body.stopped) {
          if (body.sessionReset) await this._saveSessionReset(prepared);
        } else {
          await this._saveCompactResult(prepared, body);
        }
        await this._settle(run, { deleteStop: false, dropTurn: false });
        const delivery = await this._deliverText(
          run,
          prepared.owner,
          body.stopped
            ? (body.sessionReset
              ? '⏹ Сжатие остановлено; сессия сброшена, следующий ход начнётся с нуля.'
              : '⏹ Сжатие остановлено; память не изменена.')
            : '✓ Память разговора сжата.',
        );
        await this._completeDelivery(run, delivery);
      } else {
        await this._saveAssistantResult(prepared, body, run);
        await this._settle(run, { deleteStop: false, dropTurn: false });

        const delivery = await this._sendResult(prepared, body, run);
        await this._completeDelivery(run, delivery);
      }
    } catch (error) {
      signalStarted();
      if (prepared.seed) await this._restoreSeed(prepared).catch(() => {});
      this.log.warn?.({ code: errorCode(error) }, 'telegram-pult: ход ассистента завершился ошибкой');
      if (run) {
        await this._settle(run, { deleteStop: false, dropTurn: false });
        const delivery = await this._deliverText(
          run,
          prepared.owner,
          `⚠ Ошибка хода ассистента: ${errorText(error) || 'неизвестный сбой'}`,
        );

        await this._completeDelivery(run, delivery);
      } else {
        await this._dropTurn(prepared.store as PultStateStorePort, turn.id).catch(() => {});
        await this._sendTo(
          prepared.owner,
          `⚠ Ошибка хода ассистента: ${errorText(error) || 'неизвестный сбой'}`,
        );
      }
    } finally {
      if (this.runs.get(prepared.chatKey) === run) this.runs.delete(prepared.chatKey);
    }
  }

  async _restoreSeed(prepared: Prepared): Promise<void> {
    const current = await this._readRecord(prepared.chatKey);
    if (!current.pendingSeed) await this._saveRecord({ ...current, pendingSeed: prepared.seed }, prepared.owner);
  }

  async _saveAssistantResult(prepared: Prepared, result: Payload, run: RunState): Promise<void> {
    const current = await this._readRecord(prepared.chatKey);
    const text = String(result.reply || '(пусто)');
    const message: Payload = {
      role: 'assistant',
      text,
      ...(result.cost !== undefined ? { cost: result.cost } : {}),
      ...(Array.isArray(result.steps) ? { steps: result.steps } : {}),
      model: result.model || (prepared.modelRef as Payload).model,
      actualModel: result.actualModel || '',
      effort: Object.hasOwn(result, 'effort') ? (result.effort || '') : (current.effort || ''),
      ...(result.stopped ? { stopped: true } : {}),
    };
    const next: Payload = {
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

  async _saveCompactResult(prepared: Prepared, result: Payload): Promise<void> {
    const current = await this._readRecord(prepared.chatKey);
    const messages = cloneMessages(current);
    const compact = (result.compact || result.compaction || {}) as Payload;
    const seed = String(compact.seed || compact.text || '');
    if (!['summary', 'native'].includes(String(compact.kind))) {
      throw new Error('Сервер не вернул результат сжатия — память не изменена.');
    }
    const next: Payload = { ...current, messages, updatedAt: this.now() };

    if (compact.kind === 'summary') {
      if (!seed) throw new Error('Сервер не вернул выжимку — память не сжата.');
      next.pendingSeed = seed;
    }
    clearSessionContext(next);
    if (compact.kind !== 'summary') next.sessionId = result.sessionId || current.sessionId || null;
    next.compactedAt = this.now();
    await this._saveRecord(next, prepared.owner);
  }

  async _saveSessionReset(prepared: Prepared, { discardSeed = false }: {
    discardSeed?: boolean;
  } = {}): Promise<void> {
    const current = await this._readRecord(prepared.chatKey);
    const next: Payload = { ...current, messages: cloneMessages(current), updatedAt: this.now() };
    clearSessionContext(next, { discardSeed });
    await this._saveRecord(next, prepared.owner);
  }

  _contextWindow(prepared: Prepared, result: Payload): number {
    const runtime = positive(result.contextWindow);
    if (runtime) return runtime;
    const record = (prepared.finalRecord || prepared.record) as Payload;

    if (sameModelRef(record?.modelRef, prepared.modelRef)) {
      const stored = positive(record?.contextWindow);
      if (stored) return stored;
    }
    return (prepared.model as Payload)?.contextUnverified === true
      ? 0
      : positive((prepared.model as Payload)?.context);
  }

  async _sendResult(prepared: Prepared, result: Payload, run: RunState) {
    const usage = { ...normalizeContextUsage(run), ...normalizeContextUsage(result) };
    const unavailable = ['unavailable', 'legacy-unavailable'].includes(usage.contextMetric || '');
    const contextTokens = unavailable ? 0 : (usage.contextTokens || 0);
    const contextWindow = this._contextWindow(prepared, { ...result, ...usage });
    const compactWindow = prepared.model.chatAutoCompact === true
      ? Math.max(0, Number(await this.readCompactWindow()) || 0) : 0;
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
    return this._deliverText(run, prepared.owner, text, warning ? [[{
      text: '🗜 Сжать',
      callback_data: cbData.agentCompact(),
    }]] : null);
  }

  async _typing(run: RunState): Promise<void> {
    if (run.settled || run.typingInFlight) return;
    run.typingInFlight = true;
    const job = this._withOwner(run.owner, (context, token) => (
      context.botApi.sendChatAction(token, run.chatId, 'typing', { timeoutMs: 15_000 })
    ), { priority: 'background' });
    run.typingPromise = job;
    try {
      await job;
    } catch (error) {
      this.log.warn?.({ code: errorCode(error) }, 'telegram-pult: typing не доставлен');
    } finally {
      run.typingInFlight = false;
      if (run.typingPromise === job) run.typingPromise = null;
    }
  }

  async _showStop(run: RunState): Promise<void> {
    if (run.settled || run.stopMessageId) return;

    const sent = await this._sendTo(run.owner, '⏹ Стоп', stopKeyboard(run.id)) as Payload | null;

    if (run.settled) {
      if (sent?.message_id) await this._deleteFrom(run.owner, sent.message_id);

      return;
    }

    const messageId = Number(sent?.message_id);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return;
    run.stopMessageId = messageId;
    await this._patchTurn(run.store, run.id, { stopMessageId: messageId }).catch(() => {});
  }

  /**
   * Остановить локальный lifecycle хода. Финальная доставка может оставить
   * сообщение «Стоп» как стабильный адрес для безопасной правки результата.
   */
  async _settle(run: RunState, { deleteStop = true, dropTurn = true }: {
    deleteStop?: boolean;
    dropTurn?: boolean;
  } = {}): Promise<void> {
    run.settled = true;
    if (run.stopTimer) clearTimeout(run.stopTimer);
    if (run.typingInterval) clearInterval(run.typingInterval);
    if (run.typingPromise) await run.typingPromise.catch(() => {});
    if (run.stopInFlight) await run.stopInFlight.catch(() => {});
    if (deleteStop && run.stopMessageId) await this._deleteFrom(run.owner, run.stopMessageId);
    if (dropTurn) await this._dropTurn(run.store, run.id).catch(() => {});
  }

  /** После подтверждённой доставки убрать лишний «Стоп» и durable marker хода. */
  async _completeDelivery(
    run: RunState,
    delivery: { delivered?: boolean; replaced?: boolean } | null,
  ): Promise<void> {
    if (run.stopMessageId && delivery?.delivered === true && delivery.replaced !== true) {
      await this._deleteFrom(run.owner, run.stopMessageId);
    }
    await this._dropTurn(run.store, run.id).catch(() => {});
  }

  _onEvent(event: string, data?: unknown): void {
    if (!['chat-turn-start', 'chat-progress', 'chat-step', 'chat-done'].includes(event)) return;

    const payload = (data || {}) as Payload;
    const chatKey = String(payload.chatKey || '');

    if (event === 'chat-done' && this.observing.has(chatKey)) {
      const observed = this.observing.get(chatKey) as {
        turn: Payload;
        owner: PultOwner;
        store: PultStateStorePort;
      };

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
      run.tokens = positive(payload.tokens) || run.tokens;
      Object.assign(run, normalizeContextUsage(payload));

      return;
    }
    if (event !== 'chat-step') return;

    const step = payload.step as Payload | undefined;

    if (step?.k === 'tool' && ['Edit', 'Write'].includes(String(step.name))
        && Array.isArray(step.files)) {
      run.tools.set(
        String(step.id || ''),
        (step.files as unknown[]).filter((file): file is string => (
          typeof file === 'string' && Boolean(file)
        )),
      );
    } else if (step?.k === 'res' && step.ok === true) {
      for (const file of run.tools.get(String(step.id || '')) || []) run.files.add(file);
    }
  }

  async handleStop({ turnId, callback, lease, settings }: {
    turnId?: unknown;
    callback: Payload;
    lease: AssistantLease;
    settings: Payload;
  }): Promise<boolean> {
    const store = this.stateStoreFor(lease);
    const state = await store.read().catch(() => null);
    const turn = (state?.turns as Payload[] | undefined)
      ?.find((candidate) => candidate.id === turnId);
    if (!turn || turn.stopMessageId !== callback.messageId
        || !['started', 'observing'].includes(String(turn.phase))) return false;
    if (!pultOwnerKeyMatches(
      turn.ownerKey,
      lease.accountRef,
      settings.pultConfirmedAtMs,
      settings.pultChatId,
    )) return false;
    await this._api('POST', '/api/chat/stop', { chatKey: turn.chatKey });
    return true;
  }

  async compact({ lease, settings }: { lease: AssistantLease; settings: Payload }) {
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
      return { ok: false, text: errorText(error) || 'Сжатие не началось.' };
    }
  }

  async reset({ lease, settings }: { lease: AssistantLease; settings: Payload }) {
    try {
      const prepared = await this._prepare(lease, settings);
      await this._api('POST', '/api/chat/session/reset', {
        chatKey: prepared.chatKey,
        modelRef: prepared.modelRef,
      });
      await this._saveSessionReset(prepared, { discardSeed: true });
      return { ok: true, text: 'Память ассистента сброшена; история переписки сохранена.' };
    } catch (error) {
      return { ok: false, text: errorText(error) || 'Память не сбросилась.' };
    }
  }

  async _withOwner(
    owner: PultOwner,
    operation: (context: AssistantLease['context'], token: string) => Promise<unknown>,
    { queued = true, priority = 'interactive' }: { queued?: boolean; priority?: string } = {},
  ): Promise<unknown> {
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
    return queued ? this.queue.push(execute, { priority }) : execute();
  }

  /**
   * Не тратить единственную неидемпотентную попытку финального sendMessage,
   * пока long polling уже знает, что api.telegram.org недоступен. После первого
   * успешного poll lastError очищается, и ответ получает ближайший слот очереди.
   */
  async _waitForTelegram(): Promise<boolean> {
    while (!this.closed) {
      const status = this.readPollStatus();
      const lastError = status?.lastError as Payload | undefined;

      if (status?.running !== true || lastError?.code !== 'poll_unreachable') {
        return true;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, TELEGRAM_HEALTH_POLL_MS);

        (timer as { unref?: () => void }).unref?.();
      });
    }
    return false;
  }

  /**
   * Длинный ход уже имеет сообщение «Стоп» с известным message_id. Правка этого
   * сообщения идемпотентна по результату и не создаёт дубль при повторе после
   * оборванного ответа Telegram; без такого адреса остаётся один sendMessage.
   */
  async _deliverText(
    run: RunState | null,
    owner: PultOwner,
    text: string,
    keyboard: unknown[] | null = null,
  ): Promise<{ delivered: boolean; replaced: boolean }> {
    if (!await this._waitForTelegram()) return { delivered: false, replaced: false };

    if (run?.stopMessageId) {
      const edited = await this._editTo(owner, run.stopMessageId, text, keyboard);
      if (edited.status === 'delivered') return { delivered: true, replaced: true };
      if (edited.status !== 'missing') return { delivered: false, replaced: false };
    }

    const sent = await this._sendTo(owner, text, keyboard);
    return { delivered: Boolean(sent), replaced: false };
  }

  _sendTo(owner: PultOwner, text: string, keyboard: unknown[] | null = null) {
    return this._withOwner(owner, (context, token) => context.botApi.callBotApi(token, 'sendMessage', {
      chat_id: owner.chatId,
      text: clipText(text, MESSAGE_LIMIT),
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    }, { timeoutMs: 15_000 })).catch((error: unknown) => {
      this.log.warn?.({
        code: errorCode(error),
        kind: (error as { kind?: unknown } | null)?.kind,
        reason: errorText(error),
      }, 'telegram-pult: ответ ассистента не доставлен');

      return null;
    });
  }

  /**
   * Править известный адрес результата с безопасными transport-повторами.
   * Повторный успех Telegram выражает отказом «message is not modified».
   */
  _editTo(
    owner: PultOwner,
    messageId: unknown,
    text: string,
    keyboard: unknown[] | null = null,
  ) {
    return this._withOwner(owner, (context, token) => context.botApi.callBotApi(
      token,
      'editMessageText',
      {
        chat_id: owner.chatId,
        message_id: messageId,
        text: clipText(text, MESSAGE_LIMIT),
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: keyboard || [] },
      },
      { timeoutMs: 15_000, retries: 2 },
    )).then(() => ({ status: 'delivered' })).catch((error: unknown) => {
      if (isUnchangedEdit(error)) return { status: 'delivered' };
      if (isMissingMessage(error)) return { status: 'missing' };
      this.log.warn?.({
        code: errorCode(error),
        kind: (error as { kind?: unknown } | null)?.kind,
        reason: errorText(error),
      }, 'telegram-pult: сообщение Стоп не обновилось до ответа');

      return { status: 'failed' };
    });
  }

  _deleteFrom(owner: PultOwner, messageId: unknown) {
    return this._withOwner(owner, (context, token) => context.botApi.callBotApi(token, 'deleteMessage', {
      chat_id: owner.chatId,
      message_id: messageId,
    }, { timeoutMs: 15_000 })).catch(() => null);
  }

  _track<Result>(promise: Promise<Result>): Promise<Result> {
    this.background.add(promise);
    promise.finally(() => this.background.delete(promise)).catch(() => {});
    return promise;
  }

  async reconcile(): Promise<void> {
    let lease: AssistantLease | undefined;

    try { lease = this.acquireLease(); } catch { return; }
    try {
      const settings = await lease.context.botSettings.read();
      if (settings.pultConfirmedAtMs == null || settings.pultChatId == null) return;
      const owner = this._owner(lease, settings);
      const store = this.stateStoreFor(lease);
      const state = await store.read();
      const active = activeItems(await this._api('GET', '/api/chat/active'));

      for (const turn of state.turns as Payload[]) {
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
          this.observing.set(String(turn.chatKey), {
            turn: { ...turn, phase: 'observing' },
            owner,
            store,
          });
          continue;
        }
        if (turn.stopMessageId) await this._deleteFrom(owner, turn.stopMessageId);
        await this._sendTo(owner, '⚠ Ход оборвался при перезапуске сервера. Повтори вопрос.');
        await this._dropTurn(store, turn.id);
      }
    } catch (error) {
      this.log.warn?.({ code: errorCode(error) }, 'telegram-pult: незавершённые ходы не сверились');
    } finally {
      await lease?.release?.();
    }
  }

  stop(): void {
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
