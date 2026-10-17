// Клиент локального сервера Kimi Code (`kimi web`) — транспорт ввода в активный ход.
//
// В ACP-поверхности steering нет: `session/steer` отвечает -32601. Зато собственный
// REST/WS-сервер Kimi умеет ровно нужное: `POST /sessions/{id}/prompts` принимает
// сообщение, а `prompts:steer` превращает поставленный в очередь prompt в указание
// активному ходу. Модуль знает только про этот HTTP-контракт: ни процессов, ни sandbox —
// ими владеет runtime, который поднимает сервер и выдаёт токен.
import type { InTurnDeliverResult } from '../../../../shared/chat/chatInTurnContracts.ts';
import { readSettingsJson } from '../executorSettings/probe.ts';

export interface KimiServerOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface KimiSession {
  id: string;
  [field: string]: unknown;
}

export interface KimiPromptReceipt {
  promptId: string;
  userMessageId: string;
  status: string;
}

// Ответ сервера об ошибке: код и HTTP-статус важны вызывающему, текст — человеку.
export class KimiServerError extends Error {
  readonly code: number | null;

  readonly status: number;

  constructor(message: string, status: number, code: number | null) {
    super(message);
    this.name = 'KimiServerError';
    this.status = status;
    this.code = code;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/**
 * Тело prompt в wire-форме сервера: текстовый блок в `content` плюс необязательные
 * режимы. Лишние поля не отправляем — сервер валидирует их сам.
 */
export function kimiPromptBody(input: {
  text: string;
  promptId?: string;
  userMessageId?: string;
  model?: string;
  permissionMode?: string;
  planMode?: boolean;
  thinking?: string;
}): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: String(input.text ?? '') }],
    ...(input.promptId ? { prompt_id: input.promptId } : {}),
    ...(input.userMessageId ? { user_message_id: input.userMessageId } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.permissionMode ? { permission_mode: input.permissionMode } : {}),
    ...(input.planMode !== undefined ? { plan_mode: input.planMode } : {}),
    ...(input.thinking ? { thinking: input.thinking } : {}),
  };
}

export class KimiServerClient {
  readonly baseUrl: string;

  readonly token: string;

  private readonly timeoutMs: number;

  private readonly fetchImpl: typeof fetch;

  constructor({ baseUrl, token, timeoutMs = 15_000, fetchImpl = fetch }: KimiServerOptions) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.token = String(token || '');
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || 15_000);
    this.fetchImpl = fetchImpl;
  }

  /** Мета сервера: версия и объявленные возможности; заодно проверка токена и живости. */
  async meta(): Promise<Record<string, unknown>> {
    return this.request('GET', '/api/v1/meta');
  }

  /**
   * Нативные схемы и конфигурация читаются с пределом размера и abort probe.
   * Обёртка протокола не становится частью нормализованного каталога.
   */
  async settingsRequest(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const answer = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
        : AbortSignal.timeout(this.timeoutMs),
    });
    const response = asRecord(await readSettingsJson(answer));

    if (response.code !== undefined && response.code !== 0) {
      throw new Error('Kimi отклонил запрос конфигурации');
    }

    return response.data ?? response;
  }

  settingsSchema(signal?: AbortSignal): Promise<unknown> {
    return this.settingsRequest('GET', '/openapi.json', undefined, signal);
  }

  readSettings(signal?: AbortSignal): Promise<unknown> {
    return this.settingsRequest('GET', '/api/v1/config', undefined, signal);
  }

  updateSettings(patch: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.settingsRequest('POST', '/api/v1/config', patch, signal);
  }

  /**
   * Новая сессия разговора. Рабочая папка едет в `metadata.cwd`, модель — в
   * `agent_config.model`: сервер сверяет их со своим каталогом, а не доверяет клиенту.
   */
  async createSession(input: {
    cwd?: string;
    model?: string;
    title?: string;
  } = {}): Promise<KimiSession> {
    const body = {
      ...(input.cwd !== undefined ? { metadata: { cwd: input.cwd } } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.model !== undefined ? { agent_config: { model: input.model } } : {}),
    };
    const answer = await this.request('POST', '/api/v1/sessions', body);

    return { ...answer, id: String(answer.id || answer.session_id || '') };
  }

  async getSession(sessionId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  async snapshot(sessionId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/snapshot`);
  }

  /**
   * Основной prompt хода. Сразу после отправки сервер отвечает статусом: `queued`
   * означает, что ход ещё не подхвачен, и такое сообщение можно увести в steer.
   */
  async submitPrompt(sessionId: string, input: {
    text: string;
    promptId?: string;
    userMessageId?: string;
    model?: string;
    permissionMode?: string;
    planMode?: boolean;
    thinking?: string;
  }): Promise<KimiPromptReceipt> {
    const answer = await this.request(
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`,
      kimiPromptBody(input),
    );

    return {
      promptId: String(answer.prompt_id || ''),
      userMessageId: String(answer.user_message_id || ''),
      status: String(answer.status || ''),
    };
  }

  /**
   * Ввод в активный ход: сервер забирает перечисленные (ещё не начатые) prompt'ы и
   * отдаёт их идущему ходу как уточнение. Возвращается только факт приёма — ответ
   * модели придёт событиями сессии.
   */
  async steerPrompts(sessionId: string, promptIds: readonly string[]): Promise<{
    steered: boolean;
    promptIds: string[];
  }> {
    const answer = await this.request(
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts:steer`,
      { prompt_ids: [...promptIds] },
    );

    return {
      steered: answer.steered === true,
      promptIds: Array.isArray(answer.prompt_ids) ? answer.prompt_ids.map(String) : [],
    };
  }

  async abortPrompt(sessionId: string, promptId: string): Promise<{ aborted: boolean; atSeq: unknown }> {
    const answer = await this.request(
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(promptId)}:abort`,
      undefined,
      { allowCodes: [40903] },
    );

    return { aborted: answer.aborted === true, atSeq: answer.at_seq ?? null };
  }

  /**
   * Ответ на запрос разрешения. `decision` — вердикт человека, остальные поля уточняют
   * область действия и пояснение; сервер сам решает, применимо ли это к инструменту.
   */
  async respondApproval(sessionId: string, approvalId: string, input: {
    decision: string;
    scope?: string;
    feedback?: string;
    selectedLabel?: string;
  }): Promise<{ resolved: boolean; resolvedAt: unknown }> {
    const answer = await this.request(
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
      {
        decision: String(input.decision),
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
        ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
        ...(input.selectedLabel !== undefined ? { selected_label: input.selectedLabel } : {}),
      },
    );

    return { resolved: answer.resolved === true, resolvedAt: answer.resolved_at ?? null };
  }

  /**
   * Ответ на вопрос агента: `answers` — карта «id вопроса → выбранные значения», плюс
   * способ ответа и свободная заметка. Форму ответа проверяет сервер.
   */
  async respondQuestion(sessionId: string, questionId: string, input: {
    answers: Record<string, unknown>;
    method?: string;
    note?: string;
  }): Promise<{ resolved: boolean; resolvedAt: unknown }> {
    const answer = await this.request(
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}`,
      {
        answers: input.answers || {},
        ...(input.method !== undefined ? { method: input.method } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
    );

    return { resolved: answer.resolved === true, resolvedAt: answer.resolved_at ?? null };
  }

  async abortSession(sessionId: string): Promise<{ aborted: boolean }> {
    const answer = await this.request(
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sessionId)}:abort`,
      {},
    );

    return { aborted: answer.aborted === true };
  }

  /**
   * Доставка уточнения целиком: сначала prompt, затем steer. Если сервер уже успел
   * начать ход (статус не `queued`), steer не поможет — это честный отказ, а не
   * молчаливая потеря: сообщение останется обычным следующим ходом.
   */
  async deliverInTurn(sessionId: string, input: {
    text: string;
    userMessageId?: string;
    model?: string;
    permissionMode?: string;
    planMode?: boolean;
    thinking?: string;
  }): Promise<InTurnDeliverResult> {
    let prompt: KimiPromptReceipt;

    try {
      prompt = await this.submitPrompt(sessionId, input);
    } catch (error) {
      const failure = error as KimiServerError;

      return {
        ok: false,
        code: `kimi_${failure.code ?? failure.status ?? 'error'}`,
        message: failure.message,
        uncertain: failure.status >= 500,
      };
    }

    if (!prompt.promptId) {
      return {
        ok: false,
        code: 'kimi_prompt_missing',
        message: 'Сервер не назвал id сообщения.',
      };
    }
    if (prompt.status !== 'queued') {
      await this.abortPrompt(sessionId, prompt.promptId).catch(() => {});

      return {
        ok: false,
        code: 'kimi_turn_taken',
        message: 'Ход уже подхватил сообщение: в активный ход оно не попало.',
      };
    }

    try {
      const steered = await this.steerPrompts(sessionId, [prompt.promptId]);

      if (!steered.steered) {
        await this.abortPrompt(sessionId, prompt.promptId).catch(() => {});

        return {
          ok: false,
          code: 'kimi_steer_rejected',
          message: 'Сервер не принял сообщение в активный ход.',
        };
      }

      return { ok: true, state: 'forwarded' };
    } catch (error) {
      const failure = error as KimiServerError;

      if (failure.status === 409) {
        await this.abortPrompt(sessionId, prompt.promptId).catch(() => {});
      }

      return {
        ok: false,
        code: `kimi_${failure.code ?? failure.status ?? 'error'}`,
        message: failure.message,
        uncertain: failure.status >= 500,
      };
    }
  }

  /**
   * Один HTTP-вызов сервера: bearer-токен, таймаут, разбор `{code, msg, data}` и
   * типизированная ошибка. `allowCodes` оставлен для ответов, которые вызывающий считает
   * не ошибкой, а состоянием (например, прерванный prompt).
   */
  private async request(
    method: string,
    path: string,
    body?: unknown,
    options: { allowCodes?: number[] } = {},
  ): Promise<Record<string, unknown>> {
    const answer = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await answer.text();
    let payload: Record<string, unknown> = {};

    try {
      payload = asRecord(JSON.parse(text));
    } catch {
      payload = {};
    }

    if (!answer.ok) {
      const code = Number.isSafeInteger(payload.code) ? Number(payload.code) : null;
      const allowed = (options.allowCodes || []).includes(code ?? -1);

      if (!allowed) {
        throw new KimiServerError(
          String(payload.message || payload.error || `Kimi server ${answer.status}`),
          answer.status,
          code,
        );
      }
    }

    return payload.data && typeof payload.data === 'object'
      ? asRecord(payload.data)
      : payload;
  }
}
