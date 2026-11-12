import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ExecutorRunInput, ExecutorRunResult } from '../executors/index.ts';
import { createStepSink } from '../chat/streamSteps.ts';
import { validateWorkdirPath } from '../chat/workdir.ts';
import { redactRunnerError } from '../factoryProviderRunner.ts';
import { AcpRpcError } from '../acp/client.ts';
import { readQwenSnapshot, qwenConfig } from './settings.ts';
import { openQwenTransport, record } from './transport.ts';
import { qwenToolAllowed } from './policy.ts';
import type { QwenMcpServer } from './sandbox.ts';

/**
 * Сессия принадлежит конкретным cwd, чату и снимку авторизации.
 * Внешний sessionId не назначает путь к durable home и проверяется до запуска CLI.
 */
export async function runQwenTurn(input: ExecutorRunInput): Promise<ExecutorRunResult> {
  input.signal?.throwIfAborted();

  if (input.extraDirs?.length) {
    throw new Error('Qwen: поддерживается одна рабочая папка');
  }

  if (Array.isArray(input.attachmentPaths) && input.attachmentPaths.length) {
    throw new Error('Qwen: вложения пока не поддерживаются; перенесите файлы в рабочую папку');
  }

  const config = qwenConfig(input.config);
  const snapshot = readQwenSnapshot(config);
  const model = snapshot.models.find((entry) => entry.id === input.model);

  if (!model) {
    throw new Error('Qwen: модель недоступна в конфигурации modelProviders');
  }

  const cwd = await validateWorkdirPath(input.cwd || config.rootDir || process.cwd());
  const binding = createHash('sha256').update(JSON.stringify([
    input.chatKey, cwd, snapshot.fingerprint,
  ])).digest('hex');
  const runtimeRoot = config.qwenRuntimeHome || path.join(config.dataHome || cwd, 'qwen-runtime');
  const home = path.join(runtimeRoot, binding);
  const saved = path.join(home, 'session.json');

  if (input.sessionId) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.sessionId)
      || await fs.readFile(saved, 'utf8').catch(() => '') !== input.sessionId) {
      throw new Error('Qwen: чужая или неверная identity сессии');
    }
  }

  const mode = input.permissionMode === 'auto' ? 'default' : input.permissionMode || 'default';

  if (!['default', 'plan', 'yolo'].includes(mode)) {
    throw new Error('Qwen: неизвестный режим прав');
  }

  const mcpServers = (Array.isArray(input.mcpServers) ? input.mcpServers : []) as QwenMcpServer[];
  const readonlyRoots = Array.isArray(input.readonlyRoots) ? input.readonlyRoots.map(String) : [];
  const sink = createStepSink(input.onStep);
  const promptId = randomUUID();
  const settings = record(input.providerSettings);
  let sessionId = '';
  let active = false;
  let reply = '';
  const tools = new Set<string>();
  const results = new Set<string>();
  const transport = await openQwenTransport(config, snapshot, {
    cwd,
    home,
    authType: model.authType,
    mode,
    mcpServers,
    readonlyRoots,
  }, {
    /**
     * Replay загрузки остаётся невидимым до начала нового prompt.
     * Идентификаторы tools связывают единственный результат с исходным вызовом.
     */
    onNotification(method, value) {
      const params = record(value);

      if (method !== 'session/update' || !active || params.sessionId !== sessionId) {
        return;
      }

      const update = record(params.update);
      const kind = update.sessionUpdate;
      const text = String(record(update.content).text || '');
      const id = String(update.toolCallId || '');


      if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
        const k = kind === 'agent_message_chunk' ? 'text' : 'think';

        if (k === 'text') {
          reply += text;
        }

        sink.emit({ k, text });
      } else if (kind === 'tool_call' && id && !tools.has(id)) {
        tools.add(id);
        sink.emit({
          k: 'tool',
          id,
          name: update.title,
          input: update.rawInput,
        });
      } else if (kind === 'tool_call_update' && id
        && ['completed', 'failed'].includes(String(update.status)) && !results.has(id)) {
        results.add(id);
        sink.emit({
          k: 'res',
          id,
          text: JSON.stringify(update.content || []),
          ok: update.status === 'completed',
          error: update.status === 'failed',
        });
      }
    },
    /**
     * Защитный reverse RPC проверяется до любого эффекта инструмента.
     * Человеческое разрешение не преодолевает отмену или чужую identity.
     */
    async onReverseRequest(method, value) {
      const params = record(value);

      if (method === 'qwen/control/external_tool_guard/prepare') {
        const allowed = active && await qwenToolAllowed(value, {
          sessionId,
          promptId,
          cwd,
          mode,
          readonlyRoots,
          mcpServers,
          blockDirectSsh: settings.blockDirectSsh !== false,
          signal: input.signal,
        });


        return { allowed: allowed && !input.signal?.aborted };
      }

      if (method === 'craft/drainMidTurnQueue') {
        return { messages: [] };
      }

      if (method !== 'session/request_permission' || !active || params.sessionId !== sessionId) {
        throw new Error('Qwen: неизвестный reverse RPC');
      }

      const options = Array.isArray(params.options) ? params.options.map(record) : [];
      const ask = input.onPermission as ((question: Record<string, unknown>) => Promise<unknown>) | undefined;
      const tool = record(params.toolCall);
      let allow = false;

      if (!input.factory && ask && !input.signal?.aborted) {
        const decision = await ask({
          name: tool.title,
          tool: tool.title,
          input: tool.rawInput,
          ...tool,
        });

        allow = record(decision).allow === true && !input.signal?.aborted;
      }

      const option = options.find((entry) => entry.kind === (allow ? 'allow_once' : 'reject_once'));

      return {
        outcome: option ? { outcome: 'selected', optionId: option.optionId }
          : { outcome: 'cancelled' },
      };
    },
  });
  let abort: (() => void) | undefined;

  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => {
        try {
          transport.client.notify('session/cancel', { sessionId });
        } catch {
          // Отмена могла прийти после EOF.
        }

        reject(new Error('Qwen: ход отменён'));
      };
      input.signal?.addEventListener('abort', abort, { once: true });

      if (input.signal?.aborted) {
        abort();
      }
    });
    const request = (method: string, params: unknown) =>
      Promise.race([transport.client.request(method, params), aborted]);
    const session = record(await request(input.sessionId ? 'session/load' : 'session/new', {
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      cwd,
      mcpServers,
    }));

    sessionId = input.sessionId || String(session.sessionId || '');

    if (!sessionId || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
      throw new Error('Qwen: неверная identity новой сессии');
    }

    const available = record(session.models).availableModels;

    if (!Array.isArray(available) || !available.some((entry) => record(entry).modelId === model.id)) {
      throw new Error('Qwen: native CLI не подтвердил выбранную модель');
    }

    await request('session/set_model', { sessionId, modelId: model.id });
    await request('session/set_mode', { sessionId, modeId: mode });
    await fs.writeFile(saved, sessionId, { mode: 0o600 });
    await input.onSessionCreated?.(sessionId);
    active = true;

    const result = record(await request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: input.message || '' }],
      _meta: {
        'qwen-code/invocation': {
          version: 1,
          sessionId,
          promptId,
        },
      },
    }));

    input.signal?.throwIfAborted();

    if (result.stopReason !== 'end_turn') {
      throw new Error(`Qwen: ход завершён без ответа (${String(result.stopReason)})`);
    }

    return {
      reply,
      sessionId,
      steps: sink.steps,
    };
  } catch (error) {
    const details = error instanceof AcpRpcError ? record(error.data).details : undefined;
    const reason = error instanceof AcpRpcError && typeof details === 'string'
      ? `${error.message}: ${details}` : error;

    throw new Error(redactRunnerError(reason, snapshot.envKeys.map((key) => process.env[key])));
  } finally {
    active = false;

    if (abort) {
      input.signal?.removeEventListener('abort', abort);
    }

    await transport.close();
  }
}
