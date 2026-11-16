import { BROWSER_DESCRIPTOR } from '../../../../../shared/browser/browserTool.ts';
import { parseBrowserAction } from '../../../../../shared/browser/browserActions.ts';

interface BrowserOptions {
  browserAvailable?: () => boolean;
  browserOwner?: string;
  browserInvoke?: (owner: string, input: unknown) => Promise<unknown>;
}

/**
 * Rich image проходит bounded-проверку до MCP или dynamic tool transport.
 * Сайт и native renderer не могут добавить произвольные инструкции в служебные поля.
 */
export function browserToolResult(value: unknown, action: string) {
  const source = value as Record<string, unknown> | null;

  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { ok: false, error: 'browser_result_invalid' };
  }

  if (source.format === 'grigdesk-work-content-v1') {
    const content = source.content as {
      type?: string;
      mimeType?: string;
      data?: string;
    }[];

    if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'image'
      || content[0].mimeType !== 'image/jpeg' || typeof content[0].data !== 'string'
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(content[0].data)
      || Buffer.byteLength(content[0].data, 'base64') > 2 * 1024 * 1024) {
      return { ok: false, error: 'browser_result_invalid' };
    }

    return { format: 'grigdesk-work-content-v1', content: structuredClone(content) };
  }

  const keys = ['ok', 'error', 'tabId', 'url', 'pageEpoch', 'text', 'elements',
    'console', 'truncated', 'tabs', 'width', 'height'];
  const result = Object.fromEntries(keys.filter((key) => source[key] !== undefined)
    .map((key) => [key, structuredClone(source[key])]));

  if (['snapshot', 'console'].includes(action)) {
    result.untrusted = true;
  }

  return result;
}

/**
 * Возможность проверяется повторно при каждом вызове даже у живой старой CLI-сессии.
 * Owner замыкает сервер; поля owner/project/task из аргументов parser отклоняет.
 */
async function invoke(options: BrowserOptions, raw: Record<string, unknown>) {
  if (!options.browserAvailable?.() || !options.browserOwner || !options.browserInvoke) {
    return { ok: false, error: 'browser_unavailable' };
  }

  try {
    const input = parseBrowserAction(raw);
    const result = await options.browserInvoke(options.browserOwner, input);

    return browserToolResult(result, input.action);
  } catch (error) {
    const message = (error as Error).message;

    return { ok: false, error: /^(browser_[a-z_]+|outcome_unknown|access_revoked|stale_page)$/u.test(message)
      ? message : 'browser_unavailable' };
  }
}

export default {
  descriptor: BROWSER_DESCRIPTOR,
  enabled: (options: BrowserOptions) => options.browserAvailable?.() === true,
  invoke,
};
