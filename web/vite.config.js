import path from 'node:path';
import os from 'node:os';
import { parseEnv } from 'node:util';
import { envFilePath } from '../shared/runtime/dataHome.ts';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import pluginRuntimePlugin from './scripts/pluginRuntimePlugin.mjs';

const envDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function buildMetadata() {
  let version = process.env.VITE_GRIGDESK_VERSION || 'dev';
  let sha = process.env.VITE_GRIGDESK_SHA || 'dev';
  try { if (version === 'dev') version = readFileSync(path.join(envDir, 'VERSION'), 'utf8').trim(); }
  catch { /* dev checkout без VERSION */ }
  try {
    if (sha === 'dev') sha = execFileSync('git', ['-C', envDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch { /* source archive может собираться без .git; worker передаёт SHA через env */ }
  return { version, sha };
}

// base './' — чтобы собранная статика работала и на корне сервера, и в поддиректории.
// В dev проксируем API/статику фабрики на настроенный порт сервера, чтобы фронт ходил
// на тот же origin, что и в проде.
export default defineConfig(({ command }) => {
  let filePort;

  if (command === 'serve' && process.env.GRIGDESK_PORT === undefined) {
    try {
      const file = envFilePath({ env: process.env, home: os.homedir() });

      filePort = parseEnv(readFileSync(file, 'utf8')).GRIGDESK_PORT;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  const grigDeskPort = Number(process.env.GRIGDESK_PORT ?? filePort) || 8140;
  const proxyTarget = `http://localhost:${grigDeskPort}`;
  const metadata = buildMetadata();

  return {
    plugins: [vue(), pluginRuntimePlugin()],
    base: './',
    define: {
      __GRIGDESK_VERSION__: JSON.stringify(metadata.version),
      __GRIGDESK_SHA__: JSON.stringify(metadata.sha),
    },
    // envDir — корень репозитория (VERSION, git, VITE_*); .env GrigDesk лежит в папке данных.
    envDir,
    server: {
      port: 5180,
      proxy: {
        // Чатовая live-диктовка использует WebSocket под /api; HTTP-маршруты
        // продолжают проксироваться тем же правилом. Сервер сверяет Origin с
        // Host fail-closed, поэтому dev-proxy переписывает оба к :8140.
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
          ws: true,
          rewriteWsOrigin: true,
        },
        '/vscode': { target: proxyTarget, changeOrigin: true, ws: true },
        '/shots': proxyTarget,
      },
    },
    build: { outDir: 'dist', emptyOutDir: true },
  };
});
