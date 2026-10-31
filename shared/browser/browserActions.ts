import { isPlainRecord } from '../lib/objects.ts';
import { browserUrl } from './browserContract.ts';

const READ = Object.freeze(['list', 'snapshot', 'screenshot', 'console']);
const ALL = Object.freeze([...READ, 'open', 'click', 'fill', 'scroll', 'close']);

export type BrowserAction = {
  action: string;
  tabId?: string;
  url?: string;
  pageEpoch?: number;
  ref?: string;
  text?: string;
  deltaY?: number;
};

/**
 * Таблица едина для описания инструмента и проверки реального вызова.
 * Read-only исключает навигацию, ввод и закрытие вкладок.
 */
export function browserActions(mode: string): readonly string[] {
  return mode === 'read-only' || mode === 'plan' ? READ : ALL;
}

/**
 * Runtime parser независим от проверки JSON schema внешним исполнителем.
 * Любое поле полномочий и свободное имя CDP-команды отклоняются до брокера.
 */
export function parseBrowserAction(value: unknown): BrowserAction {
  if (!isPlainRecord(value) || typeof value.action !== 'string' || !ALL.includes(value.action)) {
    throw new Error('browser_action_invalid');
  }

  const keys: Record<string, string[]> = {
    list: ['action'],
    open: ['action', 'url'],
    snapshot: ['action', 'tabId'],
    screenshot: ['action', 'tabId'],
    console: ['action', 'tabId'],
    close: ['action', 'tabId'],
    click: ['action', 'tabId', 'pageEpoch', 'ref'],
    fill: ['action', 'tabId', 'pageEpoch', 'ref', 'text'],
    scroll: ['action', 'tabId', 'pageEpoch', 'deltaY'],
  };

  if (Object.keys(value).some((key) => !keys[value.action as string]!.includes(key))) {
    throw new Error('browser_action_invalid');
  }

  if (value.action === 'list') {
    return { action: value.action };
  }

  if (value.action === 'open') {
    return { action: value.action, url: browserUrl(value.url) };
  }

  if (typeof value.tabId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/u.test(value.tabId)) {
    throw new Error('browser_action_invalid');
  }

  const action: BrowserAction = { action: value.action, tabId: value.tabId };

  if (!['click', 'fill', 'scroll'].includes(value.action)) {
    return action;
  }

  if (!Number.isSafeInteger(value.pageEpoch) || Number(value.pageEpoch) < 1) {
    throw new Error('browser_action_invalid');
  }

  action.pageEpoch = Number(value.pageEpoch);

  if (value.action === 'scroll') {
    if (typeof value.deltaY !== 'number' || !Number.isFinite(value.deltaY) || Math.abs(value.deltaY) > 2000) {
      throw new Error('browser_action_invalid');
    }

    return { ...action, deltaY: value.deltaY };
  }

  if (typeof value.ref !== 'string' || !/^e[1-9][0-9]{0,5}$/u.test(value.ref)) {
    throw new Error('browser_action_invalid');
  }

  action.ref = value.ref;

  if (value.action === 'fill') {
    if (typeof value.text !== 'string' || value.text.length > 10000) {
      throw new Error('browser_action_invalid');
    }

    action.text = value.text;
  }

  return action;
}
