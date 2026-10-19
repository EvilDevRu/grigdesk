import type { DbEngineLoader } from './engineDirectory.ts';
import { loadersFromDirectory } from './engineDirectory.ts';
import { dbEngineLoaders } from './engineTable.ts';

const REQUIRED = [
  'open', 'close', 'schema', 'analyze',
  'inspectRights', 'estimate', 'execute', 'cancel',
];

// Адаптер объявляет себя сам: ядро не знает ни одного имени СУБД и проверяет
// только то, что он умеет всё, что нужно надзорному разделу.
export interface DbEngineAdapter {
  id: string;
  label: string;
  capabilities: Record<string, unknown>;
  [method: string]: unknown;
}

export interface EngineRegistryOptions {
  dir?: string | null;
  loaders?: readonly DbEngineLoader[] | null;
}

/**
 * Реестр загружает self-describing адаптеры; ядро не знает ни одного имени СУБД.
 *
 * По умолчанию используется таблица своего режима: в исходниках — обход каталога,
 * в SEA — сгенерированные литеральные импорты. Явный dir сохраняет контракт тестов
 * и временных каталогов, loaders — проверки сгенерированной таблицы.
 */
export async function createEngineRegistry({
  dir = null,
  loaders = null,
}: EngineRegistryOptions = {}) {
  const engines = new Map<string, DbEngineAdapter>();
  const resolved = loaders ?? (dir ? await loadersFromDirectory(dir) : await dbEngineLoaders());

  for (const loader of resolved) {
    const module = await loader.load() as {
      default?: DbEngineAdapter;
    };
    const engine = module.default;

    if (!engine?.id || !engine?.label || !engine?.capabilities
      || REQUIRED.some((method) => typeof engine[method] !== 'function')) {
      throw new Error(`Движок ${loader.name} не соответствует DB SPI`);
    }

    if (engines.has(engine.id)) {
      throw new Error(`Движок DB с id ${engine.id} зарегистрирован дважды`);
    }

    engines.set(engine.id, engine);
  }

  return {
    get: (id: unknown) => engines.get(String(id || '')) || null,
    list: async () => [...engines.values()].map((engine) => ({
      id: engine.id,
      label: engine.label,
      capabilities: structuredClone(engine.capabilities),
    })),
  };
}

export default createEngineRegistry;
