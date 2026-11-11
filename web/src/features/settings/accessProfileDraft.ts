import type { AccessMethod } from '../../../../shared/chat/accessProfileContracts.ts';
import type { useSettingsStore } from '../../stores/settings.ts';
import { messageRef } from '../../ui.ts';

type Settings = ReturnType<typeof useSettingsStore>;

/**
 * Незавершённый мастер принадлежит общему открытию настроек, включая секретный ввод.
 * Apply требует завершить или отменить мастер и никогда сам не создаёт профиль.
 */
export function accessProfileDraft(settings: Settings, provider: string, target: string,
  methods: AccessMethod[], initial: { name: string; methodId: string }) {
  const id = `access-profile-draft:${provider}:${target}`;

  return settings.sessionService(id, () => {
    const fields = new Map(methods.flatMap((method) => method.fields.map((field) => [field.id, field])));
    const keys = ['name', 'methodId', 'code', ...fields.keys()];
    const baseline = { name: initial.name, methodId: initial.methodId };

    settings.registerResource({
      id,
      chain: id,
      order: 0,
      body: 'per-field',
      supportsUnset: false,
      read: async () => baseline,
      validate: (intents) => [...intents.keys()].map((key) => ({
        key,
        message: messageRef('settings.accessProfilesFinishDraft'),
      })),
      write: async () => ({ status: 'failed', fields: [] }),
    }, [...new Set(keys)].map((key) => ({
      key,
      address: {
        pageId: 'agents.providers',
        entityId: provider,
        tabId: 'access',
        fieldPath: [key],
      },
      secret: key === 'code' || fields.get(key)?.kind === 'secret',
    })));

    const ready = settings.loadResource(id);
    const get = (key: string) => {
      // Чтение снимка даёт реактивный триггер, сами секреты остаются в сессии.
      void settings.snapshot.sessionId;
      void settings.snapshot.dirtyCount;

      return String(settings.getValue(id, key) ?? '');
    };
    const set = (key: string, value: string) => settings.setField(id, key, value);
    /**
     * Отправленный шаг удаляет секрет, отмена — весь незавершённый ввод мастера.
     * Сохранённый профиль меняется сервером, общий Apply этих данных не повторяет.
     */
    const clear = (secretsOnly = false) => {
      for (const key of keys) {
        if (!secretsOnly || key !== 'name' && key !== 'methodId') {
          settings.discardField(id, key);
        }
      }
    };

    return {
      ready,
      get,
      set,
      clear,
      discard: (key: string) => settings.discardField(id, key),
    };
  });
}
