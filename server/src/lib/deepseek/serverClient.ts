// Серверный клиент штатного профиля DSH web. Cookie получается только от URL
// запущенного нами процесса и никогда не выходит за loopback этого запуска.
import { randomUUID } from 'node:crypto';

export class DeepSeekWebError extends Error {
  readonly code: string;
  readonly uncertain: boolean;

  constructor(message: string, code: string, uncertain = false) {
    super(message);
    this.code = code;
    this.uncertain = uncertain;
  }
}

type RpcResult = {
  type?: string;
  rpcId?: string;
  result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } };
};

export class DeepSeekWebClient {
  readonly baseUrl: string;
  readonly cookie: string;

  private constructor(baseUrl: string, cookie: string) {
    this.baseUrl = baseUrl;
    this.cookie = cookie;
  }

  static async authenticate(authenticatedUrl: string): Promise<DeepSeekWebClient> {
    const url = new URL(authenticatedUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
      throw new Error('DeepSeek web должен слушать только локальный адрес');
    }
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    if (response.status !== 303 || !cookie) {
      throw new Error(`DeepSeek web не выдал cookie: HTTP ${response.status}`);
    }
    return new DeepSeekWebClient(url.origin, cookie);
  }

  async rpc(method: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    const rpcId = randomUUID();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/${method}`, {
        method: 'POST',
        headers: { cookie: this.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new DeepSeekWebError(String((error as Error)?.message || error), 'deepseek_transport_unknown', true);
    }
    if (!response.ok) {
      throw new DeepSeekWebError(`DeepSeek web HTTP ${response.status}`, 'deepseek_http_error', true);
    }
    let frame: RpcResult;
    try {
      frame = await response.json() as RpcResult;
    } catch {
      throw new DeepSeekWebError('DeepSeek web вернул повреждённый RPC-ответ',
        'deepseek_bad_response', true);
    }
    if (frame.type !== 'server-response' || frame.rpcId !== rpcId || !frame.result) {
      throw new DeepSeekWebError('DeepSeek web вернул неверный RPC-ответ', 'deepseek_bad_response', true);
    }
    if (!frame.result.ok) {
      throw new DeepSeekWebError(
        String(frame.result.error?.message || 'DeepSeek web отклонил запрос'),
        String(frame.result.error?.code || 'deepseek_rpc_error'),
      );
    }
    return frame.result.value;
  }

  async createSession(cwd: string, sessionId?: string | null): Promise<string> {
    const value = await this.rpc('session/create', {
      request: { cwd, ...(sessionId ? { sessionId } : {}) },
    }) as { sessionId?: unknown };
    const id = String(value?.sessionId || '');
    if (!id || (sessionId && id !== sessionId)) {
      throw new DeepSeekWebError('DeepSeek web не подтвердил сессию', 'deepseek_session_invalid');
    }
    return id;
  }

  async prompt(sessionId: string, text: string, requestId: string, mode: 'queue' | 'steer') {
    return this.rpc('session/prompt', {
      request: {
        requestId,
        sessionId,
        mode,
        content: [{ type: 'text', text }],
      },
    }) as Promise<{ accepted: true }>;
  }

  async cancel(sessionId: string): Promise<void> {
    await this.rpc('session/cancel', { request: { sessionId } }, 5_000);
  }

  async answerEvent(clientId: string, eventId: string, outcome: { kind: string; value?: unknown }) {
    return this.rpc('$events/result', { clientId, eventId, outcome }, 30_000);
  }
}
