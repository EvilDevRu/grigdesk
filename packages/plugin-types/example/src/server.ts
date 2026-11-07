import type { PluginServerAsync } from '@grigdesk/plugin-types/server';

/**
 * Пример пользуется только публичными портами и не запускает фоновых процессов.
 * Маршрут наследует prefix и авторизацию хоста; смена настроек имеет явный transition.
 */
const server: PluginServerAsync = async (app, options) => {
  app.get('/status', async (request) => ({
    plugin: options.plugin.id,
    authKind: request.authKind,
  }));

  app.get('/provider-usage', async () => ({
    resources: [{
      key: 'example',
      label: 'Пример',
      summary: 'Данные слота v1',
      controls: [],
    }],
  }));

  options.lifecycle.onEnable = () => options.core.emit('enabled');
  options.lifecycle.onDisable = () => options.core.emit('disabled');
  options.lifecycle.prepareChange = async (change, signal) => {
    signal.throwIfAborted();

    return {
      commit() {
        options.core.emit('settings', change.values);
      },
      async rollback() {},
      async afterCommit() {},
    };
  };

  options.core.emit('ready', { pluginId: options.plugin.id });
};

export default server;
