import { api } from './apiClient.ts';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from './uiLocalePort.ts';
import {
  ARBITER_LIMITS,
  ArbiterConversationError,
  arbiterRecord,
  arbiterText,
  decodeStopIdentity,
  decodeArbiterResult,
} from '../../../shared/pipeline/arbiterConversation.ts';
import type {
  ArbiterCapabilities,
  ConversationSnapshot,
  StopIdentity,
} from '../../../shared/pipeline/arbiterConversation.ts';

const t = localeTranslator(uiLocalePort);

export interface CurrentArbiterStop {
  identity: StopIdentity | null;
  conversationId: string | null;
  capabilities: ArbiterCapabilities | null;
}

const taskPath = (task: string) => `/api/tasks/${encodeURIComponent(task)}/arbiter-conversations`;

/**
 * Проверяет ограниченную страницу истории на границе сети.
 * Служебный action остаётся данными; клиент выбирает только сохранённый proposalId.
 */
export function decodeConversationSnapshot(value: unknown): ConversationSnapshot {
  const raw = arbiterRecord(value, ['schemaVersion', 'id', 'identity', 'revision', 'decisionRevision',
    'state', 'automatic', 'createdAt', 'messages', 'operations', 'result', 'capabilities',
    'afterSequence', 'hasMore', 'readOnly']);
  const doc = raw as unknown as ConversationSnapshot;

  decodeStopIdentity(doc.identity);

  if (doc.schemaVersion !== 1 || !/^c_[a-f0-9]{32}$/.test(doc.id)
    || !Number.isSafeInteger(doc.revision) || !Number.isSafeInteger(doc.decisionRevision)
    || !Array.isArray(doc.messages) || doc.messages.length > ARBITER_LIMITS.page
    || !Array.isArray(doc.operations) || doc.operations.length > 5000
    || typeof doc.hasMore !== 'boolean' || typeof doc.readOnly !== 'boolean') {
    throw new ArbiterConversationError('bad_snapshot', t('core.arbiterPageFailed'));
  }

  for (const row of doc.messages) {
    arbiterText(row.text, ARBITER_LIMITS.message, true);
    arbiterText(row.id, 500);

    if (!Number.isSafeInteger(row.sequence) || !Number.isSafeInteger(row.revision)
      || !['node', 'human', 'arbiter', 'system'].includes(row.author)
      || !['partial', 'complete', 'interrupted'].includes(row.status)) {
      throw new ArbiterConversationError('bad_snapshot', t('core.arbiterPageFailed'));
    }
  }

  if (doc.result) {
    decodeArbiterResult(doc.result, doc.capabilities.targets, doc.identity.node);
  }

  return doc;
}

export const arbiterConversationApi = {
  stop(task: string, operationId: string) {
    return api.post(`${taskPath(task)}/stop`, { operationId }, { timeoutMs: 30_000 });
  },

  /**
   * Текущая остановка проверяется отдельно от сохранённого исторического диалога.
   * GET не создаёт модельный ход и не содержит намерения применить действие.
   */
  async current(task: string): Promise<CurrentArbiterStop> {
    const raw = await api.get(`${taskPath(task)}/current`) as CurrentArbiterStop;

    if (!raw || typeof raw !== 'object') {
      throw new ArbiterConversationError('bad_snapshot', t('core.arbiterReadFailed'));
    }

    if (raw.identity) {
      decodeStopIdentity(raw.identity);
    }

    return raw;
  },

  async snapshot(task: string, id: string, afterSequence = 0, knownRevision = 0) {
    return decodeConversationSnapshot(await api.get(`${taskPath(task)}/${encodeURIComponent(id)}`
      + `?afterSequence=${afterSequence}&knownRevision=${knownRevision}`));
  },

  /**
   * Вид намерения выбирает отдельный серверный вход с коротким durable подтверждением.
   * Тело содержит сохранённый UUID и передаётся без классификации свободного текста.
   */
  post(task: string, id: string | null, kind: string, body: Record<string, unknown>) {
    const suffix = kind === 'start' ? '' : `/${encodeURIComponent(id
      || '')}/${kind === 'discuss' ? 'messages' : kind}`;

    return api.post(`${taskPath(task)}${suffix}`, body, { timeoutMs: 30_000 });
  },
};
