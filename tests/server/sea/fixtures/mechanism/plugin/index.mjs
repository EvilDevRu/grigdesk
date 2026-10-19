// Плагин с top-level await и относительным импортом соседнего файла.
import { value } from './lib/value.mjs';

const marker = await Promise.resolve('relative-import+tla');

export { marker };

// Экспорт регистрируется настоящим Fastify из SEA после разрешения ESM-графа.
// Ответ маршрута доказывает и top-level await, и относительный import.
export default async function plugin(app) {
  app.get('/plugin', async () => ({
    plugin: marker,
    value
  }));
}
