import { isPlainRecord } from '../../../../../shared/lib/objects.ts';
import { messageRef } from '../../../../../shared/i18n/core.ts';
import { normalizeBrowserPreferences } from '../../../../../shared/browser/browserContract.ts';
import { resourceWriteFailure } from '../contracts.ts';
import type { JsonValue, ResourceAdapter } from '../contracts.ts';

/**
 * Черновик относится к компьютеру и записывается только общей очередью Apply.
 * Native ACK проходит проверку формы, повреждённый ответ не считается успехом записи.
 */
export function createBrowserSettingsAdapter(port: {
  read(signal: AbortSignal): Promise<unknown>;
  write(value: unknown, signal: AbortSignal): Promise<unknown>;
  disablePreference(): Promise<void>;
}): ResourceAdapter {
  return {
    id: 'browser',
    chain: 'device',
    order: 8100,
    body: 'full-record',
    supportsUnset: false,
    read: async (signal) => ({ ...normalizeBrowserPreferences(await port.read(signal)) }),
    validate(intents) {
      return [...intents].flatMap(([key, intent]) => {
        const valid = intent.op === 'set' && (
          key === 'open' && ['internal', 'external'].includes(String(intent.value))
          || key === 'agents' && typeof intent.value === 'boolean'
          || key === 'external' && typeof intent.value === 'string'
            && /^(system|app:[A-Za-z0-9._-]{1,160})$/u.test(intent.value)
        );

        return valid ? [] : [{ key, message: messageRef('settings.browserInvalidPreference') }];
      });
    },
    /**
     * Скрытое поле external сохраняется из baseline полной записи ресурса.
     * Отказ/обрыв не подтверждает ни одно намерение и проходит общую классификацию.
     */
    async write(intents, baseline, signal) {
      const value: Record<string, JsonValue> = { ...baseline };

      for (const [key, intent] of intents) {
        if (intent.op === 'set') {
          value[key] = intent.value;
        }
      }

      try {
        const response = await port.write(value, signal);

        if (!isPlainRecord(response) || !Number.isSafeInteger(response.revision)
          || Number(response.revision) < 0 || !isPlainRecord(response.preferences)
          || Object.keys(response.preferences).sort().join(',') !== 'agents,external,open'
          || !['internal', 'external'].includes(String(response.preferences.open))
          || typeof response.preferences.external !== 'string'
          || !/^(system|app:[A-Za-z0-9._-]{1,160})$/u.test(response.preferences.external)
          || typeof response.preferences.agents !== 'boolean') {
          throw new Error('browser_preferences_ack_invalid');
        }

        const saved = normalizeBrowserPreferences(response.preferences);
        const agents = intents.get('agents');

        if (agents?.op === 'set' && agents.value === false) {
          await port.disablePreference();
        }

        return {
          status: 'success',
          fields: [...intents.keys()].map((key) => ({
            key,
            status: 'success' as const,
            serverValue: { ...saved }[key as keyof typeof saved],
          })),
        };
      } catch (error) {
        return resourceWriteFailure(error);
      }
    },
  };
}
