import { defineStore } from 'pinia';

import type {
  AccessAttempt, AccessProfileList,
} from '../../../shared/chat/accessProfileContracts.ts';
import { isRecord } from '../../../shared/lib/objects.ts';
import { api, ApiError, failureText } from '../shared/apiClient.ts';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../shared/uiLocalePort.ts';

interface UnresolvedMutation {
  id: string;
  route: string;
  method: string;
  target: string;
}

const t = localeTranslator(uiLocalePort);
const OPERATIONS_STORAGE = 'grigdesk.access-profile-operations';

/**
 * Reload сохраняет только публичный адрес и ID неподтверждённой операции.
 * Тела запросов и секретный ввод никогда не попадают в это хранилище.
 */
function readUnresolved(): Record<string, UnresolvedMutation> {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(OPERATIONS_STORAGE) ?? '{}');

    if (isRecord(value)) {
      const entries = Object.entries(value).filter(([, item]) => isRecord(item)
        && typeof item.id === 'string' && typeof item.route === 'string'
        && typeof item.method === 'string' && typeof item.target === 'string');

      return Object.fromEntries(entries) as Record<string, UnresolvedMutation>;
    }
  } catch {
    // Недоступный storage не мешает удерживать исход операции в памяти окна.
  }

  return {};
}

/**
 * Декодер отсекает приватные поля даже при ошибке серверной проекции.
 * Состояние Pinia содержит только список, попытку и результат безопасного чтения.
 */
function publicList(value: unknown): AccessProfileList {
  if (!isRecord(value) || !Array.isArray(value.profiles) || !Array.isArray(value.methods)
    || typeof value.revision !== 'number') {
    throw new Error('Некорректный список профилей');
  }

  return {
    revision: value.revision,
    activeProfileId: typeof value.activeProfileId === 'string' ? value.activeProfileId : null,
    profiles: value.profiles.map((item) => {
      if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string') {
        throw new Error('Некорректный профиль');
      }

      return {
        id: item.id,
        name: item.name,
        methodId: String(item.methodId),
        authState: item.authState === 'needs-auth' ? 'needs-auth' as const : 'ready' as const,
        revision: Number(item.revision),
        accessRevision: Number(item.accessRevision ?? 0),
        accountGeneration: Number(item.accountGeneration ?? 0),
        ...(typeof item.mode === 'string' ? { mode: item.mode } : {}),
      };
    }),
    methods: value.methods as AccessProfileList['methods'],
  };
}

/**
 * Попытка не содержит секретного ввода; шаг получен только из защищённого API.
 * Неизвестное тело ответа не трактуется как успешный вход.
 */
function publicAttempt(value: unknown): AccessAttempt {
  if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.step)
    || typeof value.step.kind !== 'string' || typeof value.revision !== 'number') {
    throw new Error('Некорректное состояние входа');
  }

  return value as unknown as AccessAttempt;
}

export const useAccessProfilesStore = defineStore('accessProfiles', {
  state: () => ({
    lists: {} as Record<string, AccessProfileList>,
    attempts: {} as Record<string, AccessAttempt | null>,
    errors: {} as Record<string, string>,
    pending: {} as Record<string, boolean>,
    generations: {} as Record<string, number>,
    unresolved: readUnresolved(),
  }),

  actions: {
    /**
     * До отправки окна запоминают только публичную identity мутации.
     * Секретные значения не сохраняются даже при транспортном отказе.
     */
    remember(provider: string, operation: UnresolvedMutation | null) {
      if (operation) {
        this.unresolved[provider] = operation;
      } else {
        delete this.unresolved[provider];
      }

      try {
        sessionStorage.setItem(OPERATIONS_STORAGE, JSON.stringify(this.unresolved));
      } catch {
        // В памяти текущего окна блокировка повторной операции остаётся действующей.
      }
    },

    /**
     * Потерянный ACK восстанавливается по production DTO с attemptId/profileId.
     * 404 не доказывает отказ исходного запроса и не освобождает его operationId.
     */
    async reconcile(provider: string): Promise<boolean> {
      const operation = this.unresolved[provider];

      if (!operation) {
        return true;
      }

      const root = this.root(provider);
      let outcome: unknown;

      try {
        outcome = await api.get(`${root}/operations/${encodeURIComponent(operation.id)}`);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          return false;
        }

        throw error;
      }

      if (!isRecord(outcome) || outcome.state !== 'completed') {
        return false;
      }

      const attempt = typeof outcome.attemptId === 'string'
        ? publicAttempt(await api.get(
          `${root}/attempts/${encodeURIComponent(outcome.attemptId)}`,
        )) : null;

      if (this.unresolved[provider]?.id !== operation.id) {
        return false;
      }

      if (attempt) {
        this.attempts[provider] = attempt;
      }

      this.remember(provider, null);

      return true;
    },

    root(provider: string) {
      return `/api/providers/${encodeURIComponent(provider)}/access-profiles`;
    },

    /**
     * Reconnect перечитывает состояние, не повторяя ни одну мутацию.
     * Поколение чтения не позволяет старому окну откатить свежий список.
     */
    async load(provider: string) {
      const generation = (this.generations[provider] ?? 0) + 1;

      this.generations[provider] = generation;

      try {
        const reconciled = await this.reconcile(provider);
        const list = publicList(await api.get(this.root(provider)));
        const response = await api.get(`${this.root(provider)}/attempts`);

        if (this.generations[provider] !== generation) {
          return;
        }

        this.lists[provider] = list;
        this.errors[provider] = reconciled ? '' : t('settings.accessProfilesOutcomeUnknown');

        if (isRecord(response) && Array.isArray(response.attempts)) {
          const attempts = response.attempts.map(publicAttempt);
          const current = this.attempts[provider];

          this.attempts[provider] = attempts.find((item) => item.id === current?.id)
            ?? attempts.find((item) => !['saved', 'failed', 'cancelled', 'expired', 'interrupted']
              .includes(item.state)) ?? null;
        }
      } catch (error) {
        if (this.generations[provider] === generation) {
          this.errors[provider] = failureText(error);
        }
      }
    },

    /**
     * Один operationId соответствует одному нажатию, включая потерянный ACK.
     * Сначала читается исход; явный повтор неизвестной доставки сохраняет прежний ID и цель.
     */
    async mutate(provider: string, route: string, body: Record<string, unknown>, method = 'POST') {
      if (this.pending[provider]) {
        return;
      }

      this.pending[provider] = true;
      this.errors[provider] = '';

      const root = this.root(provider);
      const target = JSON.stringify([body.profileId ?? null, body.methodId ?? null]);

      try {
        const previous = this.unresolved[provider];

        if (previous) {
          const reconciled = await this.reconcile(provider);

          if (reconciled || previous.route !== route || previous.method !== method
            || previous.target !== target) {
            await this.load(provider);

            return;
          }
        }

        const operationId = previous?.id ?? crypto.randomUUID();

        this.remember(provider, {
          id: operationId,
          route,
          method,
          target,
        });

        let result: unknown;

        try {
          const payload = { ...body, operationId };

          result = method === 'PATCH' ? await api.patch(`${root}${route}`, payload)
            : method === 'DELETE' ? await api.del(`${root}${route}`, payload)
              : await api.post(`${root}${route}`, payload);
        } catch (error) {
          if (error instanceof ApiError && error.status < 500) {
            this.remember(provider, null);

            throw error;
          }

          if (!await this.reconcile(provider)) {
            this.errors[provider] = t('settings.accessProfilesOutcomeUnknown');

            return;
          }
        }

        this.remember(provider, null);

        if (isRecord(result) && isRecord(result.step)) {
          this.attempts[provider] = publicAttempt(result);
        }

        await this.load(provider);
      } catch (error) {
        this.errors[provider] = this.unresolved[provider]
          ? t('settings.accessProfilesOutcomeUnknown') : failureText(error);
      } finally {
        this.pending[provider] = false;
      }
    },
  },
});
