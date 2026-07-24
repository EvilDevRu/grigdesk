// Модуль providers — реестр LLM-исполнителей кокпита.
// Единая точка правды о том, какие исполнители есть, доступны ли и какие у них модели:
// топбар рисует иконки, чат строит выбор модели/эффорта, схемы выбирают исполнителя по id.
// ПОДКЛЮЧЕНИЕ НОВОГО ИИ — МОДУЛЬНОЕ: один файл в server/src/lib/executors/ (контракт там),
// этот модуль ничего не знает про конкретных вендоров.
// Не путать с /api/agents — там база агентов-стадий конвейера (промпты).
import fp from 'fastify-plugin';
import { getExecutors } from '../../lib/executors/index.js';
import { getModelsRegistry } from '../../lib/models-registry.js';

// Список меняется редко — кэшируем, чтобы не гонять probe-подпроцессы на каждый запрос.
const CACHE_MS = 60_000;

async function providersModule(fastify, opts) {
  const { config, claudeAuth } = opts;
  const deps = { claudeAuth };

  /**
   * Реестр: для каждого исполнителя — probe бинаря, авторизация, модели
   * (из models-registry: редактируемый файл + динамическое обнаружение эффортов).
   */
  async function buildRegistry() {
    const executors = await getExecutors();
    const models = await getModelsRegistry(config);
    const providers = [];
    for (const ex of executors.values()) {
      const [{ ok, version }, auth] = await Promise.all([ex.probe(config), ex.auth(config, deps)]);
      providers.push({
        id: ex.id,
        name: ex.name,
        vendor: ex.vendor,
        kind: 'cli',
        bin: ex.bin(config),
        color: ex.color,
        version,
        auth: auth.mode,
        authLabel: auth.label,
        available: ok && auth.available,
        installed: ok,
        install: ex.install || null,
        models: models[ex.id] || [],
      });
    }
    return providers;
  }

  let cache = null; // { at, providers }

  fastify.get('/api/providers', async (request) => {
    const force = request.query?.refresh === '1';
    if (!force && cache && Date.now() - cache.at < CACHE_MS) return { providers: cache.providers };
    const providers = await buildRegistry();
    cache = { at: Date.now(), providers };
    return { providers };
  });
}

export default fp(providersModule, { name: 'module-providers' });
