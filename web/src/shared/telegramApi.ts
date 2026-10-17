import { objectOrEmpty } from '../../../shared/lib/objects.ts';

import { api } from './apiClient.ts';
import {
  parseTelegramBotResult,
  parseTelegramChats,
  parseTelegramPultResult,
  parseTelegramRules,
  parseTelegramRulesSaved,
  parseTelegramStatus,
  parseTelegramTopics,
} from '../../../shared/telegram/telegramContracts.ts';

/**
 * Единственная граница сети нативного раздела «Телеграм». Проверка здесь не
 * формальность: за отпечатком правил стоит CAS allowlist, и ответ без него
 * означал бы сохранение вслепую поверх чужой правки. Токен бота через эту
 * границу не проходит ни в одну сторону — наружу уходит только его маска.
 */
export const telegramApi = {
  async status() {
    const value: unknown = await api.get('/api/telegram/status');

    return parseTelegramStatus(value);
  },

  async chats() {
    const value: unknown = await api.get('/api/telegram/chats');

    return parseTelegramChats(value);
  },

  async topics(chatId: string | number) {
    const value: unknown = await api.get(
      `/api/telegram/chats/${encodeURIComponent(String(chatId))}/topics`,
    );

    return parseTelegramTopics(value);
  },

  async rules() {
    const value: unknown = await api.get('/api/telegram/rules');

    return parseTelegramRules(value);
  },

  /**
   * Сохранение allowlist под отпечатком. `agentSearch` этой ручкой не меняется:
   * у него своя CAS-операция, потому что доступ агента к переписке — отдельное
   * решение человека, а не побочный эффект правки соседнего поля.
   */
  async saveRules(rules: unknown[], botId: unknown, policyFingerprint: string) {
    const value: unknown = await api.put('/api/telegram/rules', {
      botId,
      rules,
      policyFingerprint,
    });

    return parseTelegramRulesSaved(value);
  },

  async setAgentSearch(body: {
    botId: unknown;
    rule: unknown;
    enabled: boolean;
    expectedPolicyFingerprint: string;
  }) {
    const value: unknown = await api.put('/api/telegram/rules/agent-search', body);

    return parseTelegramRulesSaved(value);
  },

  async connect(token: string) {
    const value: unknown = await api.post('/api/telegram/connect', { token });

    return parseTelegramBotResult(value);
  },

  async recheck() {
    const value: unknown = await api.post('/api/telegram/recheck', {});

    return parseTelegramBotResult(value);
  },

  async disconnect() {
    const value: unknown = await api.post('/api/telegram/disconnect', {});

    return parseTelegramBotResult(value);
  },

  async setServiceChat(botId: unknown, chatId: number | null) {
    const value: unknown = await api.post('/api/telegram/service-chat', { botId, chatId });

    return parseTelegramBotResult(value);
  },

  async requestPult(botId: unknown, chatId: number) {
    const value: unknown = await api.post('/api/telegram/pult', { botId, chatId });

    return parseTelegramPultResult(value);
  },

  async confirmPult(botId: unknown, code: string) {
    const value: unknown = await api.post('/api/telegram/pult/confirm', { botId, code });

    return parseTelegramPultResult(value);
  },

  async disablePult(botId: unknown) {
    const value: unknown = await api.post('/api/telegram/pult/disable', { botId });

    return parseTelegramPultResult(value);
  },
};

/**
 * Выключенный плагин отвечает своим кодом под 404. Раздел различает его с
 * поломкой: это штатное состояние, и красная ошибка вместо него врёт человеку.
 */
export function telegramPluginDisabled(error: unknown): boolean {
  const failure = objectOrEmpty(error);

  return failure.status === 404 && objectOrEmpty(failure.data).error === 'plugin_disabled';
}
