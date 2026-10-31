import type { FastifyInstance } from 'fastify';

import type { PluginInstallPort } from '../../lib/packageInstall/service.ts';
import registerInstallRoutes from '../plugins/installRoutes.ts';

/**
 * Драйверы используют общий строгий HTTP допуск установки, но отдельный сервис.
 * Каталог, настройки и точки расширения плагинов сюда не подключаются.
 */
export default async function driverInstallRoutes(
  app: FastifyInstance,
  options: { installs: PluginInstallPort },
): Promise<void> {
  await registerInstallRoutes(app, { ...options, driver: true });
}
