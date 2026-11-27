import { isDeepStrictEqual } from 'node:util';

import { composeEntries, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot';

// Этими настройками владеет launcher. Они действуют и после settings/mutate.
const LAUNCH_OWNED = new Set([
  'acp', 'agent-default-model', 'agent-instructions', 'agent-preset-registry', 'approval',
  'authorization', 'bash-sandbox', 'config-editor', 'hooks-claude-code', 'llm-deepseek-account',
  'llm-pi-ai', 'permission', 'pwsh-sandbox', 'sandbox', 'sandbox-policy', 'settings', 'settings-controller',
  'host-authentication-token', 'web-runtime', 'web-startup', 'webserver',
]);

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Проверяет конфигурацию из приватного документа перед передачей в Loader.
 * Выражения разрешены только на тех же путях и с тем же значением, что при запуске.
 */
function validateData(value, inherited) {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Object.hasOwn(value, '__jsExpr') && !isDeepStrictEqual(value, inherited)) {
    throw new Error('Приватный документ настроек содержит постороннее выражение');
  }

  for (const [key, child] of Object.entries(value)) {
    if (RESERVED_KEYS.has(key)) {
      throw new Error('Приватный документ настроек содержит запрещённый ключ');
    }

    validateData(child, inherited && Object.hasOwn(inherited, key) ? inherited[key] : undefined);
  }
}

/**
 * Запоминает подготовленные слои для запуска и последующей перезагрузки.
 * Приватный документ правит только config существующих разрешённых строк.
 */
export function createSettingsProfile(layers, path, legacyPath, ready) {
  const base = structuredClone(layers);
  const rows = new Map(composeEntries([base]).map((row) => [row.id, row]));
  const accepts = (id) => {
    const row = rows.get(id);

    return Boolean(row && !row.group && row.disabled !== true && !LAUNCH_OWNED.has(id)
      && !id.startsWith('grigdesk-') && !id.startsWith('tool-'));
  };

  return {
    path,
    legacyPath,
    ready,
    base,
    accepts,
    /**
     * Читает сохранённую правку или проверяет документ перед атомарной записью.
     * Идентификатор и имя плагина в каждой строке сверяются с базовой композицией.
     */
    read(patches = loadOptionalPatches('dsh', path) ?? []) {
      const seen = new Set();

      for (const patch of patches) {
        const row = rows.get(patch.id);

        if (!accepts(patch.id) || seen.has(patch.id) || patch.name !== row.name
          || Object.keys(patch).some((key) => !['id', 'name', 'config'].includes(key))
          || !patch.config || typeof patch.config !== 'object' || Array.isArray(patch.config)) {
          throw new Error('Приватный документ настроек содержит недопустимую правку');
        }

        seen.add(patch.id);
        validateData(patch.config, row.config);
      }

      return patches;
    },
  };
}
