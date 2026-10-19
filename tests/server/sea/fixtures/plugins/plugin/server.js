// ESM-плагин фикстуры: относительный импорт, top-level await и защищённый маршрут.
import { value } from './lib/value.js';

const marker = await Promise.resolve('plugin-tla');

export { value, marker };

// Плагин отвечает только значениями своего ESM-графа, без внешних зависимостей.
// Маршрут проверяет исполнение top-level await и import соседнего файла в SEA.
export default async function plugin(app) {
  app.get('/plugin', async () => ({
    marker,
    value
  }));
}
