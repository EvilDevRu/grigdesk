import path from 'node:path';
import { Buffer } from 'node:buffer';

import { isPlainRecord } from '../../../../shared/lib/objects.ts';
import { BROWSER_DESCRIPTOR } from '../../../../shared/browser/browserTool.ts';
import { BROWSER_TAB_LIMIT_FAILURE } from '../../../../shared/browser/browserLimits.ts';
import { parseBrowserAction } from '../../../../shared/browser/browserActions.ts';
import { browserMailboxRequest, readBrowserReady } from './browserMailbox.ts';
import type { MailboxContext } from './browserMailbox.ts';
import { factoryBrowserReady } from './factoryBrowserCapability.ts';

type RequestPort = (options: {
  context: MailboxContext;
  input: unknown;
  signal?: AbortSignal;
}) => Promise<unknown>;

interface McpImage {
  type: 'image';
  mimeType: 'image/jpeg';
  data: string;
}

interface McpText {
  type: 'text';
  text: string;
}

export interface FactoryBrowserMcpResult {
  content: (McpImage | McpText)[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Browser identity строит MCP host, не аргументы tools/call.
 * Неполный transport просто не публикует capability, сохраняя обычные status tools.
 */
function browserContext(env: NodeJS.ProcessEnv): MailboxContext | null {
  if (!factoryBrowserReady(env)) {
    return null;
  }

  const stateDir = env.FACTORY_STATE || env.STATE_DIR || '';
  const task = env.FACTORY_RUN_TASK || '';
  const stage = env.FACTORY_RUN_STAGE || '';
  const runId = env.FACTORY_RUN_ID || '';
  const epoch = env.FACTORY_RUN_EPOCH || '';

  if (!path.isAbsolute(stateDir) || stateDir.includes('\0')
    || !/^[1-9][0-9]{0,18}$/u.test(task) || !/^[A-Z][A-Z0-9_]*$/u.test(stage)
    || !/^[A-Za-z0-9._-]{1,160}$/u.test(runId) || !/^[1-9][0-9]*$/u.test(epoch)
    || env.FACTORY_STATUS_MODE !== 'request') {
    return null;
  }

  const expected = path.join(stateDir, 'logs', 'runs', `t${task}`, stage, runId, 'control-requests');

  if (env.FACTORY_STATUS_REQUEST_DIR !== expected) {
    return null;
  }

  return {
    stateDir,
    task,
    stage,
    runId,
    epoch,
    nonce: env.FACTORY_BROWSER_NONCE!
  };
}

/**
 * Ошибка протокола не отражает stack, путь, nonce или текст внешнего сайта.
 * Непредвиденный отказ получает один stable code для модели и человека.
 */
const PUBLIC_ERRORS = new Set([
  'browser_unavailable', 'browser_action_invalid', 'browser_result_invalid',
  'browser_access_denied', 'browser_owner_forbidden', 'browser_cancelled',
  'browser_tab_missing', 'browser_tab_limit', 'browser_origin_forbidden',
  'browser_navigation_pending', 'browser_debugger_unavailable', 'browser_load_failed',
  'browser_renderer_gone', 'browser_image_too_large', 'browser_queue_full',
  'browser_timeout', 'browser_run_stale', 'browser_run_limit',
  'outcome_unknown', 'access_revoked', 'stale_page', 'stale_element',
]);

/**
 * Стабильный код ошибки выбирается из закрытого публичного набора.
 * Текст исключения с nonce, путём или stack не пересылается модели.
 */
function failure(error: unknown): FactoryBrowserMcpResult {
  const message = error instanceof Error ? error.message : '';
  const code = PUBLIC_ERRORS.has(message) ? message : 'browser_unavailable';
  const result = code === 'browser_tab_limit'
    ? { ...BROWSER_TAB_LIMIT_FAILURE } : { ok: false, error: code };

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError: true,
  };
}

/**
 * JPEG передаётся стандартным MCP image block, а не строкой внутри text payload.
 * Остальные ответы имеют только bounded публичные поля и явную недоверенность сайта.
 */
function response(value: unknown, action: string): FactoryBrowserMcpResult {
  if (!isPlainRecord(value)) {
    throw new Error('browser_result_invalid');
  }

  if (value.ok === false) {
    return failure(new Error(typeof value.error === 'string' ? value.error : 'browser_unavailable'));
  }

  if (action === 'screenshot') {
    const content = value.content;

    if (value.format !== 'grigdesk-work-content-v1' || !Array.isArray(content)
      || content.length !== 1 || !isPlainRecord(content[0]) || content[0].type !== 'image'
      || content[0].mimeType !== 'image/jpeg' || typeof content[0].data !== 'string'
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(content[0].data)
      || Buffer.byteLength(content[0].data, 'base64') > 2 * 1024 * 1024) {
      throw new Error('browser_result_invalid');
    }

    return {
      content: [{
        type: 'image',
        mimeType: 'image/jpeg',
        data: content[0].data
      }],
      structuredContent: { ok: true, untrusted: true },
    };
  }

  const allowed = ['ok', 'error', 'tabId', 'url', 'pageEpoch', 'text', 'elements',
    'console', 'truncated', 'tabs'];
  const clean: Record<string, unknown> = { untrusted: true };

  for (const key of allowed) {
    if (Object.hasOwn(value, key)) {
      clean[key] = structuredClone(value[key]);
    }
  }

  const text = JSON.stringify(clean);

  if (Buffer.byteLength(text, 'utf8') > 256 * 1024) {
    throw new Error('browser_result_invalid');
  }

  return {
    content: [{ type: 'text', text }],
    structuredContent: clean,
    ...(clean.ok === false ? { isError: true } : {}),
  };
}

/**
 * Один host-owned MCP закрыто держит контекст своего запуска и per-run mailbox key.
 * Внешний descriptor и runtime parser оба запрещают подстановку owner/task/project.
 */
export function createFactoryBrowserMcp(env: NodeJS.ProcessEnv, deps: {
  request?: RequestPort;
  ready?: (context: MailboxContext) => Promise<'legacy' | 'grigdesk'>;
} = {}) {
  const context = browserContext(env);
  const request = deps.request ?? browserMailboxRequest;
  const ready = deps.ready ?? readBrowserReady;

  return {
    descriptors: context ? [structuredClone(BROWSER_DESCRIPTOR)] : [],
    /**
     * Вызов требует своего host context, строгого action parser и проверенного ready.
     * Неизвестный исход не повторяет mailbox запрос и не включает другой браузер.
     */
    async invoke(input: unknown, signal?: AbortSignal): Promise<FactoryBrowserMcpResult> {
      if (!context) {
        return failure(new Error('browser_unavailable'));
      }

      try {
        const parsed = parseBrowserAction(input);

        // ENABLED задаёт transport; только проверенный ready подтверждает существование relay.
        if (await ready(context).catch(() => null) !== 'grigdesk') {
          return failure(new Error('browser_unavailable'));
        }

        const result = await request({
          context,
          input: parsed,
          signal
        });

        return response(result, parsed.action);
      } catch (error) {
        return failure(error);
      }
    },
  };
}
