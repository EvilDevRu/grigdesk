import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dataHomeUrl = new URL('../../../shared/runtime/dataHome.ts', import.meta.url).href;
const stubUrl = pathToFileURL(path.join(import.meta.dirname, 'stub.mjs')).href;

// Сервер-фикстура: заглушка GrigDesk на GRIGDESK_PORT, ключ окна после listen, журнал событий.
// SIGTERM и разрыв IPC закрывают её с кодом 0, SIGUSR2 изображает перезапуск кодом 75.
const FIXTURE_APP = `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { startStub } from '${stubUrl}';
import os from 'node:os';
import { dataHome, dataPath } from '${dataHomeUrl}';

const log = process.env.GRIGDESK_E2E_FIXTURE_LOG;
const record = (entry) => {
  if (log) {
    appendFileSync(log, JSON.stringify({ pid: process.pid, ...entry }) + '\\n');
  }
};

record({
  event: 'start',
  names: Object.keys(process.env).sort(),
  path: process.env.PATH ?? null,
  ldLibraryPath: process.env.LD_LIBRARY_PATH ?? null,
  desktopChild: process.env.GRIGDESK_DESKTOP_CHILD ?? null,
  connected: typeof process.send === 'function' && process.connected === true,
});

const delay = Number(process.env.GRIGDESK_E2E_FIXTURE_DELAY_MS) || 0;

if (delay > 0) {
  await new Promise((resolve) => setTimeout(resolve, delay));
}

const authKey = randomBytes(32).toString('base64url');
const stub = await startStub({
  port: Number(process.env.GRIGDESK_PORT),
  authKey,
  packagedCookie: process.env.GRIGDESK_E2E_FIXTURE_PACKAGED_COOKIE || null,
  uiReleasesDir: process.env.GRIGDESK_UI_RELEASES_DIR
    || dataPath(dataHome({ env: process.env, home: os.homedir() }), 'uiReleases'),
});
const keyFile = process.env.GRIGDESK_WINDOW_KEY_PATH;

mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
writeFileSync(keyFile, authKey, { mode: 0o600 });
record({ event: 'listen' });

let closing = false;
const close = async (code) => {
  if (closing) {
    return;
  }

  closing = true;
  record({ event: 'exit', code });
  await stub.close().catch(() => undefined);
  process.exit(code);
};

process.on('SIGTERM', () => void close(0));
process.on('disconnect', () => void close(0));
process.on('SIGUSR2', () => void close(75));
process.channel?.unref?.();
`;

// Ворота фикстуры: без режима hold пропускают; в режиме hold пишут pid и ждут SIGTERM.
// С GRIGDESK_E2E_GATE_OPEN_FILE отказывают строкой настоящих ворот, пока файла нет, — «ждём VPN».
const FIXTURE_GATE = `#!/usr/bin/env bash
if [ -n "\${GRIGDESK_E2E_GATE_OPEN_FILE:-}" ] && [ ! -e "$GRIGDESK_E2E_GATE_OPEN_FILE" ]; then
  echo "VPN-ворота: нет маршрута до 1.1.1.1 — запуск запрещён" >&2
  exit 1
fi

if [ -z "\${GRIGDESK_E2E_GATE_HOLD:-}" ]; then
  exit 0
fi

echo "$$" > "$GRIGDESK_E2E_GATE_HOLD"
sleep 600 &
holder=$!
trap 'kill "$holder" 2>/dev/null; exit 1' TERM
wait "$holder"
`;

/**
 * Корень-фикстура повторяет то, что проверяет приложение перед своим запуском:
 * app.ts, node_modules, ворота VPN, собранный web и пустой .env.
 */
export async function writeServerFixture(root) {
  await mkdir(path.join(root, 'server/src'), { recursive: true });
  await mkdir(path.join(root, 'server/node_modules'), { recursive: true });
  await mkdir(path.join(root, 'deploy'), { recursive: true });
  await mkdir(path.join(root, 'web/dist'), { recursive: true });
  await writeFile(path.join(root, 'server/package.json'), '{"type":"module"}\n');
  await writeFile(path.join(root, 'server/src/app.ts'), FIXTURE_APP);
  await writeFile(path.join(root, 'deploy/require-vpn.sh'), FIXTURE_GATE, { mode: 0o755 });
  await writeFile(path.join(root, 'web/dist/index.html'), '<!doctype html><title>GrigDesk</title>\n');
  await writeFile(path.join(root, '.env'), '');
}

/**
 * Журнал фикстуры: по строке JSON на событие start, listen и exit каждого процесса.
 * Нет файла — фикстура ещё не запускалась.
 */
export async function fixtureEntries(logPath) {
  try {
    const text = await readFile(logPath, 'utf8');

    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

/**
 * Descriptor установки для приложения в XDG_DATA_HOME одноразовой сессии.
 * Корень — фикстура, Node — тот же, что исполняет проверку.
 */
export async function writeRuntimeDescriptor(file, root) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    version: 1,
    root,
    node: process.execPath,
  }), { mode: 0o600 });
}
