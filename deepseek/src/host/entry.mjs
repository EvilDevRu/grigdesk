// Host launcher использует исходный Loader и composition web/ACP.
// Он не ищет внешнюю установку DSH и не запускает браузер.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot';
import { provideCmdline } from '@deepseek-ai/dsh-cmdline';
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from '@deepseek-ai/dsh-launch-environment';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import yaml from 'js-yaml';

const root = path.dirname(fileURLToPath(import.meta.url));
const metadata = JSON.parse(await readFile(path.join(root, 'runtime.json'), 'utf8'));
const args = process.argv.slice(2);

if (args.length === 1 && ['-V', '--version'].includes(args[0])) {
  console.log(metadata.source.version);
  process.exit(0);
}

let profile;
const overlays = [];
const inner = [];

for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--profile') {
    profile = args[++index];
  } else if (args[index] === '--patch') {
    const patch = args[++index];

    if (!patch || !path.isAbsolute(patch)) {
      throw new Error('--patch требует абсолютный путь');
    }

    overlays.push(patch);
  } else {
    inner.push(args[index]);
  }
}

if (!['web', 'acp'].includes(profile)) {
  throw new Error('--profile должен быть web или acp');
}

const expression = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (value) => ({ __jsExpr: value }),
});
const schema = yaml.JSON_SCHEMA.extend(expression);
const layers = [];

for (const bundle of ['base', profile === 'web' ? 'web-app' : 'acp-app']) {
  const source = await readFile(path.join(root, `packages/bundle/${bundle}/cordis.patch.yml`), 'utf8');
  const patches = yaml.load(source, { schema });

  for (const patch of patches) {
    for (const row of patch.insert || []) {
      if (row.id === 'agent-presets') {
        row.name = new URL('./presetsHost.mjs', import.meta.url).href;
      }
    }
  }

  layers.push(...patches);
}

if (profile === 'web') {
  layers.push({ insert: [
    { id: 'grigdesk-web-auth', name: new URL('./webHost.mjs', import.meta.url).href },
  ] });
} else {
  layers.push({ insert: [
    { id: 'settings-controller', name: '@deepseek-ai/dsh-api-settings-controller' },
    { id: 'grigdesk-acp-settings', name: new URL('./acpSettingsBridge.mjs', import.meta.url).href },
  ] });
}

for (const overlay of overlays) {
  layers.push(...loadOverlayPatches('dsh', overlay));
}

if (process.env.DSH_TELEMETRY_DISABLED) {
  layers.push({ id: 'session-telemetry-otel', disabled: true });
}

const home = resolveDshHome();
const config = path.join(home, 'grigdesk-profile', profile, 'cordis.yml');

await mkdir(path.dirname(config), { recursive: true });
await writeFile(config, '[]\n');

let context;
let stopping = false;
let ready = false;
const readyListeners = new Set();

/**
 * Выход сначала освобождает сервисы и блокировки private home.
 * Ограничение времени предотвращает зависание supervisor на закрытии stdio.
 */
async function stop(code) {
  if (stopping) {
    return;
  }

  stopping = true;

  setTimeout(() => process.exit(75), 3000);

  await context?.fiber.dispose();
  process.exit(code);
}

process.once('SIGTERM', () => void stop(0));
process.once('SIGINT', () => void stop(130));

try {
  context = await boot('dsh', config, layers, (ctx) => {
    context = ctx;
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
      { source: 'process', values: { ...process.env } },
    ]));
    provideCmdline(ctx, {
      args: profile === 'web' && !inner.includes('--no-open') ? [...inner, '--no-open'] : inner,
      exit: (code) => void stop(code),
      ready: {
        onReady(listener) {
          if (ready) {
            listener();
          } else {
            readyListeners.add(listener);
          }

          return () => readyListeners.delete(listener);
        },
      },
    });
  }, new URL('./', import.meta.url).href);
  ready = true;

  for (const listener of readyListeners) {
    listener();
  }

  readyListeners.clear();
} catch (error) {
  console.error(error);
  await stop(1);
}
