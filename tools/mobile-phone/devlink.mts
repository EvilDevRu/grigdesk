import { chmod, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { build, preview } from '../../mobile/node_modules/vite/dist/node/index.js';
import vue from '../../mobile/node_modules/@vitejs/plugin-vue/dist/index.mjs';
import { PhoneEmulator, startEmulator } from './emulator.mts';

const root = path.resolve(new URL('../../', import.meta.url).pathname);
const directory =
  process.env.GRIGDESK_MOBILE_DEVLINK_DIR || path.join(homedir(), '.config/grigdesk/mobile-devlink');
const port = Number(process.env.GRIGDESK_MOBILE_DEVLINK_PORT || 8150);
const deviceName = process.env.GRIGDESK_MOBILE_DEVLINK_NAME || 'DevLink в браузере';

/**
 * Собирает dev-интерфейс с токеном текущего запуска в приватный каталог вне дерева проекта.
 * Токен защищает loopback API эмулятора от чужих страниц браузера, поэтому сборка не кэшируется.
 */
async function buildInterface(token: string, outDir: string) {
  const version = JSON.parse(await readFile(path.join(root, 'mobile/package.json'), 'utf8')).version;

  process.env.VITE_LINK = 'dev';
  process.env.VITE_EMULATOR_TOKEN = token;
  await build({
    root: path.join(root, 'mobile'),
    configFile: false,
    logLevel: 'warn',
    plugins: [vue()],
    define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(version) },
    build: {
      outDir,
      emptyOutDir: true,
    },
  });
}

/**
 * Постоянный браузерный телефон владельца: эмулятор с прежним ключом и привязкой плюс
 * собранный DevLink UI. Оба входа слушают только 127.0.0.1; сеть к мозгу идёт через посредника.
 */
async function main() {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error('GRIGDESK_MOBILE_DEVLINK_PORT должен быть числом 1024–65535.');
  }

  await mkdir(directory, {
    recursive: true,
    mode: 0o700,
  });
  await chmod(directory, 0o700);

  const phone = new PhoneEmulator(path.join(directory, 'phone'));

  await phone.load();
  phone.state.deviceName = deviceName;

  const api = await startEmulator(phone);
  const outDir = path.join(directory, 'dist');

  await buildInterface(api.token, outDir);

  const server = await preview({
    root: path.join(root, 'mobile'),
    configFile: false,
    logLevel: 'warn',
    build: { outDir },
    preview: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      proxy: {
        '/__mobile': {
          target: `http://127.0.0.1:${api.port}`,
          rewrite: (value: string) => value.replace(/^\/__mobile/, ''),
        },
      },
    },
  });
  const state = phone.getState();

  console.log(
    JSON.stringify({
      ev: 'devlink_ready',
      url: `http://127.0.0.1:${port}/`,
      paired: state.paired,
      relays: state.relays.length,
    }),
  );

  let closing = false;

  /**
   * Остановка юнита сначала блокирует эмулятор: соединения через посредника закрываются,
   * а привязка и durable очередь остаются на диске до следующего запуска.
   */
  const close = async () => {
    if (closing) {
      return;
    }

    closing = true;
    phone.lock();
    await Promise.allSettled([api.close(), server.close()]);
    process.exit(0);
  };

  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}

main().catch((error: Error) => {
  console.error(JSON.stringify({ ev: 'devlink_failed', error: error.message }));
  process.exit(1);
});
