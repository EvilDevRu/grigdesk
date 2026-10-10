import { readConfig } from './config.ts';
import { installCrashHandlers } from './crash.ts';
import { createRelayServer } from './relayServer.ts';

/**
 * Пишет только фиксированное событие и безопасные технические поля.
 * Адреса, токены и идентификаторы соединений в журнал не передаются.
 */
function log(ev: string, fields: { port?: number } = {}) {
  process.stdout.write(
    `${JSON.stringify({
      ts: Date.now(),
      ev,
      ...fields,
    })}\n`,
  );
}

installCrashHandlers(process, {
  log,
  exit: (code) => process.exit(code),
});

try {
  const config = readConfig(process.env);
  const server = createRelayServer(config, { log });
  const port = await server.listen();
  const heartbeat = setInterval(() => {
    if (process.connected) {
      process.send?.({ t: 'heartbeat' });
    }
  }, 1000);
  let stopping = false;

  /**
   * Прекращает приём и закрывает свои соединения при штатной остановке.
   * Внешний supervisor ограничивает ожидание на случай зависшего event loop.
   */
  async function stop() {
    if (stopping) {
      return;
    }

    stopping = true;
    clearInterval(heartbeat);
    await server.close();
    process.exit(0);
  }

  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  log('listening', { port });
} catch {
  log('configuration_error');
  process.exit(2);
}
