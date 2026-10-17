// Транспорт базы агентов.
//
// Сеть отдаёт `unknown`; форму подтверждает декодер раздела. Отдельный файл нужен,
// чтобы вид не разбирал JSON сам: пока он это делал, «список агентов» был просто
// массивом неизвестно чего, и ошибка формы всплывала уже в разметке.

import {
  parseAgentCard,
  parseAgentInstallResult,
  parseAgentList,
} from '../../../shared/pipeline/agentsContracts.ts';
import type { AgentCard, AgentDraft, AgentInstallResult } from '../../../shared/pipeline/agentsContracts.ts';
import { parseProviderEfforts } from '../../../shared/chat/providersContracts.ts';
import { api } from './apiClient.ts';

function agentPath(id: string): string {
  return `/api/agents/${encodeURIComponent(id)}`;
}

export const agentsApi = {
  async list(): Promise<AgentCard[]> {
    const value: unknown = await api.get('/api/agents');

    return parseAgentList(value);
  },

  async create(draft: AgentDraft): Promise<AgentCard> {
    const value: unknown = await api.post('/api/agents', draft);

    return parseAgentCard(value);
  },

  async update(id: string, draft: AgentDraft): Promise<AgentCard> {
    const value: unknown = await api.put(agentPath(id), draft);

    return parseAgentCard(value);
  },

  async remove(id: string): Promise<void> {
    await api.del(agentPath(id));
  },

  async install(): Promise<AgentInstallResult> {
    const value: unknown = await api.post('/api/agents/install');

    return parseAgentInstallResult(value);
  },

  /**
   * Ступени усилия для выбора в карточке. Реестр исполнителей — соседний раздел, и
   * его недоступность не должна мешать правке агента: селект просто останется пустым.
   */
  async efforts(): Promise<string[]> {
    const value: unknown = await api.get('/api/providers');

    return parseProviderEfforts(value);
  },
};
