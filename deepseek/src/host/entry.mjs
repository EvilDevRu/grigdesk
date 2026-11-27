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
import { createSettingsProfile } from './settingsProfile.mjs';
import { validateToolPermissionPolicy } from './toolPermissionGate.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const metadata = JSON.parse(await readFile(path.join(root, 'runtime.json'), 'utf8'));
const args = process.argv.slice(2);

if (args.length === 1 && ['-V', '--version'].includes(args[0])) {
  console.log(metadata.source.version);
  process.exit(0);
}

let profile;
let toolPolicy;
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
  } else if (args[index] === '--grigdesk-tool-policy') {
    const file = args[++index];

    if (toolPolicy || !file || !path.isAbsolute(file)) {
      throw new Error('--grigdesk-tool-policy требует единственный абсолютный путь');
    }

    toolPolicy = validateToolPermissionPolicy(JSON.parse(await readFile(file, 'utf8')));
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
let layers = [];
const bundleRows = new Set();

// Id формы входит в сохранённые overrides GrigDesk.
const upstreamSubagentSettings = 'subagent-model-selection-settings';
const grigdeskSubagentSettings = 'subagent-model-selection';

for (const bundle of ['base', profile === 'web' ? 'web-app' : 'acp-app']) {
  const source = await readFile(path.join(root, `packages/bundle/${bundle}/cordis.patch.yml`), 'utf8');
  const patches = yaml.load(source, { schema });

  for (const patch of patches) {
    for (const row of patch.insert || []) {
      if (row.id === upstreamSubagentSettings) {
        row.id = grigdeskSubagentSettings;
      }

      bundleRows.add(row.id);
    }
  }

  layers.push(...patches);
}

if (profile === 'web') {
  layers.push({ insert: [
    { id: 'grigdesk-web-auth', name: new URL('./webHost.mjs', import.meta.url).href },
  ] }, { id: 'remote-connection', disabled: true });
} else {
  layers.push({ insert: [
    { id: 'settings-controller', name: '@deepseek-ai/dsh-api-settings-controller' },
    { id: 'grigdesk-acp-settings', name: new URL('./acpSettingsBridge.mjs', import.meta.url).href },
  ] });
}

/**
 * Переносит ровно профиль сервера с прежним именем реестра.
 * Закрытый запуск получает один объявленный preset и не читает пользовательские корни.
 */
function selectGlmPreset(patch) {
  if (patch.config?.default !== 'grigdesk-glm' || patch.config.includeUserRoot !== false
    || !bundleRows.has('agent-preset-registry') || !bundleRows.has('preset-grigdesk-glm')) {
    throw new Error('Незнакомая конфигурация закрытого GLM preset');
  }

  layers = layers.map((layer) => Array.isArray(layer.insert) ? {
    ...layer,
    insert: layer.insert.filter((row) => row.name !== '@deepseek-ai/dsh-agent-preset'
      || row.id === 'preset-grigdesk-glm'),
  } : layer);

  return {
    id: 'agent-preset-registry',
    config: {
      default: 'grigdesk-glm',
      selectedDefault: 'grigdesk-glm',
    },
  };
}

let legacySettingsPath;
const requiredMcp = new Map();

for (const overlay of overlays) {
  const patches = loadOverlayPatches('dsh', overlay).filter((patch) => {
    if (patch.id !== 'settings' || !Object.hasOwn(patch.config || {}, 'path')) {
      return true;
    }

    const file = patch.config.path;

    if (legacySettingsPath || typeof file !== 'string' || !path.isAbsolute(file)
      || Object.keys(patch).some((key) => !['id', 'config'].includes(key))
      || Object.keys(patch.config).length !== 1) {
      throw new Error('Настройки DeepSeek требуют единственный абсолютный путь документа');
    }

    legacySettingsPath = file;

    return false;
  });
  const hasGlmRoute = patches.some((patch) =>
    patch.insert?.some((row) => row.id === 'llm-pi-ai' && row.config?.providers?.zai));
  const disablesDeepSeek = patches.some((patch) => patch.id === 'llm-deepseek' && patch.disabled === true);

  if (hasGlmRoute && disablesDeepSeek) {
    if (!bundleRows.has('llm-deepseek') || !bundleRows.has('llm-deepseek-account')) {
      throw new Error('Не распознаны оба штатных маршрута DeepSeek');
    }

    patches.push({
      id: 'llm-deepseek-account',
      disabled: true,
    });
  }

  for (const patch of patches) {
    if (patch.id === upstreamSubagentSettings) {
      patch.id = grigdeskSubagentSettings;
    }

    for (const row of patch.insert || []) {
      if (row.name === '@deepseek-ai/dsh-mcp-client' && row.config?.failOnStartupError === true) {
        requiredMcp.set(row.id, row.config.serverName);
      }

      if (row.name === 'grigdesk:glm-gate') {
        row.name = new URL('./glmGate.mjs', import.meta.url).href;
      }
    }
  }

  const hostPatches = patches.map((patch) => patch.id === 'agent-presets' ? selectGlmPreset(patch) : patch);

  layers.push(...hostPatches);
}

if (toolPolicy) {
  layers.push({ insert: [{
    id: 'grigdesk-tool-permissions',
    name: new URL('./toolPermissionGate.mjs', import.meta.url).href,
    config: toolPolicy,
  }] });
}

if (process.env.DSH_TELEMETRY_DISABLED) {
  layers.push({ id: 'session-telemetry-otel', disabled: true });
}

const home = resolveDshHome();
const settingsDir = path.join(home, 'grigdesk-profile', profile);
const settingsPath = legacySettingsPath
  ? `${legacySettingsPath}.cordis.yml` : path.join(settingsDir, 'settings.patch.yml');
const config = path.join(root, 'empty-root.yml');

await mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
layers.push({ id: 'config-editor', disabled: false }, { id: 'settings', disabled: false });

const settingsStartup = Promise.withResolvers();
const settingsProfile = createSettingsProfile(
  layers, settingsPath, legacySettingsPath, settingsStartup.promise,
);

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

  const fiber = context?.fiber;

  await fiber?.dispose();

  // Подтверждаем только завершённый disposal: ошибка await не доходит до IPC.
  // Без живого launcher подтверждения нет; callback отправки предшествует native exit.
  if (fiber && (code === 0 || code === 130) && process.connected && process.send) {
    await new Promise((resolve) => {
      process.send({ type: 'worker-disposed', code }, () => resolve());
    });
  }

  process.exit(code);
}

process.once('SIGTERM', () => void stop(0));
process.once('SIGINT', () => void stop(130));

try {
  context = await boot('dsh', config, [
    ...settingsProfile.base,
    ...settingsProfile.read(),
  ], (ctx) => {
    context = ctx;
    ctx.provide('embeddedSettingsProfile', settingsProfile);

    if (profile === 'web') {
      ctx.provide('grigdeskResumeNamedSession', true);
      ctx.provide('grigdeskLegacyToolResult', true);
    }

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

  if (!context.get('settings') || !context.get('configEditor')) {
    throw new Error('Приватный редактор настроек DeepSeek не запущен');
  }

  // Loader alpha.2 предупреждает об отказе необязательных плагинов и запускает
  // остальные. Служебные MCP с failOnStartupError должны быть активны до web-ready.
  const entries = new Map([...context.loader.entries()].map((entry) => [entry.options.id, entry]));
  const activeFiber = 2; // Cordis FiberState.ACTIVE, как в аудите app-boot.

  for (const [id, server] of requiredMcp) {
    if (entries.get(id)?.fiber?.state !== activeFiber) {
      throw new Error(`mcp-client(${server}): initial connection or tool synchronization failed`);
    }
  }

  await context.get('settings').restoreEmbeddedDocument();
  await writeFile(settingsPath, '[]\n', { flag: 'wx', mode: 0o600 }).catch((error) => {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  });

  if (toolPolicy && context.get('grigdeskToolPermissions')?.ready !== true) {
    throw new Error('Обязательная проверка разрешений DeepSeek не установлена');
  }

  settingsStartup.resolve(true);
  ready = true;

  for (const listener of readyListeners) {
    listener();
  }

  readyListeners.clear();
} catch (error) {
  settingsStartup.resolve(false);
  console.error(error);
  await stop(1);
}
