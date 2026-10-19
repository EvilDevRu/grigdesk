import { createSettingsSession } from '../../../web/src/features/settings/session.ts';

/**
 * Управляемый ресурс хранит только синтетический снимок и историю обращений.
 * Тест подменяет чтение/запись отдельно и проверяет эффект через публичный контракт.
 */
export function settingsResource(id, values, options = {}) {
  const calls = {
    reads: [],
    writes: [],
  };
  const fields = options.fields ?? Object.keys(values).map((key) => ({
    key,
    address: {
      pageId: 'interface.behavior',
      fieldPath: [key],
    },
  }));
  const adapter = {
    id,
    chain: options.chain ?? id,
    order: options.order ?? 0,
    body: options.body ?? 'patch',
    supportsUnset: options.supportsUnset ?? false,
    async read(signal) {
      calls.reads.push(signal);

      return options.read ? options.read(signal) : structuredClone(values);
    },
    validate: options.validate ?? (() => []),
    async write(intents, baseline, signal) {
      calls.writes.push({
        intents: structuredClone(intents),
        baseline: structuredClone(baseline),
        signal,
      });

      return options.write ? options.write(intents, baseline, signal) : {
        status: 'success',
        fields: [...intents].map(([key, intent]) => ({
          key,
          status: 'success',
          ...(intent.op === 'set' ? { serverValue: structuredClone(intent.value) } : {}),
        })),
      };
    },
  };

  return {
    adapter,
    fields,
    calls,
  };
}

/**
 * Загрузка проходит тот же путь первого посещения, что и в продуктовой сессии.
 * Страницы и Vue для владения ресурсом не нужны.
 */
export async function settingsSession(...resources) {
  const session = createSettingsSession();

  session.begin();

  for (const resource of resources) {
    session.register(resource.adapter, resource.fields);
    await session.load(resource.adapter.id);
  }

  return session;
}
