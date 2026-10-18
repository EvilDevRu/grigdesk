import { objectOrEmpty } from '../../../shared/lib/objects.ts';

import { api } from './apiClient.ts';
import {
  parseSandboxAction,
  parseSandboxJobLog,
  parseSandboxOverview,
} from '../../../shared/plugins/sandboxes/sandboxContracts';

export interface SandboxRaiseOptions {
  profile: string;
  task?: string | null;
}

/**
 * HTTP-клиент общий для приложения, но его JSON ещё не является данными раздела.
 * Каждый ответ проходит проверку контракта до попадания в реактивное состояние:
 * подъём и снос стенда — необратимые действия, и показывать по ним непроверенную
 * форму нельзя.
 */
export const sandboxApi = {
  async overview() {
    const value: unknown = await api.get('/api/sandboxes');

    return parseSandboxOverview(value);
  },

  async raise(options: SandboxRaiseOptions) {
    const value: unknown = await api.post('/api/sandboxes', {
      profile: options.profile,
      task: options.task ?? null,
    });

    return parseSandboxAction(value);
  },

  async dismantle(task: string, force = false) {
    const path = `/api/sandboxes/${encodeURIComponent(task)}/down`;
    const value: unknown = await api.post(path, { force });

    return parseSandboxAction(value);
  },

  // Действие профиля на стенде: аргументы — по ключам объявления, значения строками.
  async run(task: string, action: string, args: Record<string, string>) {
    const path = `/api/sandboxes/${encodeURIComponent(task)}/actions/${encodeURIComponent(action)}`;
    const value: unknown = await api.post(path, { args });

    return parseSandboxAction(value);
  },

  async jobLog(task: string) {
    const value: unknown = await api.get(`/api/sandboxes/${encodeURIComponent(task)}/log`);

    return parseSandboxJobLog(value);
  },
};

// Тексты нужны только там, где сервер отвечает ОДНИМ кодом без пояснения: остальные
// отказы он формулирует сам, и вторая формулировка на клиенте разошлась бы с первой
// (а склейка обеих давала бы «Стенд уже поднят. стенд 990000 уже поднят»).
const MESSAGES: Record<string, string> = {
  session_required: 'Песочницами управляет человек: нужен вход в GrigDesk.',
  bad_profile: 'Профиль выбран неверно.',
  bad_task: 'Номер стенда должен быть целым числом.',
  bad_action: 'Действие названо неверно.',
  sandbox_error: 'Сервер не смог выполнить действие — подробности в журнале GrigDesk.',
};

/**
 * Текст отказа для человека. Общий клиент кладёт тело ответа в `data`: текст сервера
 * точнее всего, а карта кодов закрывает те отказы, которые приходят без пояснения.
 */
export function sandboxErrorMessage(error: unknown, fallback = 'Действие не удалось.'): string {
  const data = objectOrEmpty(objectOrEmpty(error).data);
  const detail = typeof data.message === 'string' ? data.message : '';
  const code = typeof data.error === 'string' ? data.error : '';

  return detail || MESSAGES[code] || fallback;
}
