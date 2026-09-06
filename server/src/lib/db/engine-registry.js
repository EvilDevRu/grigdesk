import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_DIR = fileURLToPath(new URL('./engines/', import.meta.url));
const REQUIRED = ['open', 'close', 'schema', 'analyze', 'inspectRights', 'estimate', 'execute', 'cancel'];

/** Реестр загружает self-describing адаптеры; ядро не знает ни одного имени СУБД. */
export async function createEngineRegistry({ dir = DEFAULT_DIR } = {}) {
  const engines = new Map();
  const names = (await readdir(dir)).filter((name) => /\.(?:m?js)$/u.test(name)).sort();
  for (const name of names) {
    const module = await import(pathToFileURL(path.join(dir, name)).href);
    const engine = module.default;
    if (!engine?.id || !engine?.label || !engine?.capabilities
      || REQUIRED.some((method) => typeof engine[method] !== 'function')) {
      throw new Error(`Движок ${name} не соответствует DB SPI`);
    }
    if (engines.has(engine.id)) {
      throw new Error(`Движок DB с id ${engine.id} зарегистрирован дважды`);
    }
    engines.set(engine.id, engine);
  }

  return {
    get: (id) => engines.get(String(id || '')) || null,
    list: async () => [...engines.values()].map((engine) => ({
      id: engine.id,
      label: engine.label,
      capabilities: structuredClone(engine.capabilities),
    })),
  };
}

export default createEngineRegistry;
