import { objectOrEmpty } from '../../../shared/lib/objects.ts';

import { api } from './apiClient.ts';
import {
  parseInboxActivation,
  parseInboxBlockedAttachments,
  parseInboxDecisionResult,
  parseInboxList,
  parseInboxSummary,
} from '../../../shared/inbox/inboxContracts.ts';
import type { InboxDecisionInput } from '../../../shared/inbox/inboxContracts.ts';

function itemPath(ref: string, action: string): string {
  return `/api/inbox/items/${encodeURIComponent(ref)}/${action}`;
}

/**
 * Единственная граница сети общего Inbox. Проверка здесь не формальность: по этой
 * проекции человек решает, ставить ли задачу в Битрикс24, а решение необратимо —
 * непроверенная форма превратила бы чужую карточку в его собственное решение.
 */
export const inboxApi = {
  async list() {
    const value: unknown = await api.get('/api/inbox');

    return parseInboxList(value);
  },

  async summary() {
    const value: unknown = await api.get('/api/inbox/summary');

    return parseInboxSummary(value);
  },

  /**
   * Решение по выбранным сообщениям: задача, пропуск или возврат к разбору. Ревизия
   * карточки и версия решения едут в теле как оптимистичная блокировка — без них
   * ответ лёг бы поверх чужого разбора, сделанного в соседней вкладке.
   */
  async decide(ref: string, action: string, body: InboxDecisionInput) {
    const value: unknown = await api.post(itemPath(ref, action), body);

    return parseInboxDecisionResult(value);
  },

  async changeParticipation(channelId: string, action: string, activationVersion: number) {
    const path = `/api/inbox/channels/${encodeURIComponent(channelId)}/${action}`;
    const value: unknown = await api.post(path, { activationVersion });

    return parseInboxActivation(value);
  },
};

/**
 * Выключенный плагин отвечает своим кодом под 404. Раздел различает его с поломкой:
 * это штатное состояние, и показывать вместо него красную ошибку нельзя.
 */
export function inboxPluginDisabled(error: unknown): boolean {
  const failure = objectOrEmpty(error);

  return failure.status === 404 && objectOrEmpty(failure.data).error === 'plugin_disabled';
}

/**
 * Машинный код отказа. По нему раздел различает протухшую карточку, нехватку
 * разбора вложений и настоящий сбой: у каждого свой следующий шаг, и общий
 * красный текст вместо кода отправил бы человека нажимать наугад.
 */
export function inboxErrorCode(error: unknown): string {
  const code = objectOrEmpty(objectOrEmpty(error).data).error;

  return typeof code === 'string' ? code : '';
}

/**
 * Список вложений, помешавших поставить задачу. Он приезжает в теле отказа: человек
 * видел их в самом канале и может пересказать суть, а для этого их надо показать.
 */
export function inboxBlockedAttachments(error: unknown) {
  return parseInboxBlockedAttachments(objectOrEmpty(objectOrEmpty(error).data).attachments);
}
