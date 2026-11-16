import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ClaudeAuthStore } from '../../claudeAuthStore.ts';
import { accessError } from '../service.ts';
import type { AccessCapability } from '../types.ts';

/**
 * Поддержка мастера ограничена проверенным протоколом конкретной версии.
 * Legacy home остаётся ссылкой на прежний доступ, изоляция keyring не предполагается.
 */
export function cliAccess(homeKey: string, homeName: string,
  cli: NonNullable<AccessCapability['cli']>): AccessCapability {
  return {
    envKeys: [homeKey],
    homeKey,
    runtimeEnvKeys: [homeKey, 'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'],
    cli,
    /**
     * Отпечаток нужен только для публикации новой ревизии после штатного refresh.
     * Байты credential и сам отпечаток остаются внутри серверного lifecycle.
     */
    async credentialFingerprint(env) {
      try {
        const file = path.join(String(env[homeKey]), cli.credentialFile);
        const content = await fs.readFile(file);

        return createHash('sha256').update(content).digest('hex');
      } catch {
        return null;
      }
    },
    methods: [{
      id: 'cli-login',
      kind: 'cli',
      label: 'CLI',
      fields: [],
      isolated: false,
      limitation: 'Добавление доступно только без работы исполнителя; общие хранилища CLI не изолированы.',
    }],
    legacy: (env) => [{
      methodId: 'cli-login',
      env: { [homeKey]: env[homeKey] ?? path.join(env.HOME ?? os.homedir(), homeName) },
      active: true,
    }],
  };
}

export const codexAccess = cliAccess('CODEX_HOME', '.codex', {
  version: '0.166.0',
  versions: ['0.167.1'],
  protocolSchemas: [
    {
      'v1/InitializeResponse.json': '62ad689c2cb6379913c1d72749cfd8de5089d35760214123518eb92eef11acc9',
      'v2/LoginAccountParams.json': '48fb9bea54d7e0890052653ac06737efb3200ba2261515b2c4014027f36bea3d',
      'v2/LoginAccountResponse.json': '72e6d77f49bc5809c3af50f183e2a0862dd8f7836816d4796ff69bb13eae0e89',
      'v2/GetAccountResponse.json': '1d44d4274ea35e1f866c4b0e3db64678fab108914c276353bdc3b1b0de286459',
      'v2/AccountLoginCompletedNotification.json': 'd81e8821fd5a4a9ad118dfc3506ea156d32dcb18da388b336501bbc6a5ccb4a6',
    },
    {
      'v1/InitializeResponse.json': '62ad689c2cb6379913c1d72749cfd8de5089d35760214123518eb92eef11acc9',
      'v2/LoginAccountParams.json': '48fb9bea54d7e0890052653ac06737efb3200ba2261515b2c4014027f36bea3d',
      'v2/LoginAccountResponse.json': '72e6d77f49bc5809c3af50f183e2a0862dd8f7836816d4796ff69bb13eae0e89',
      'v2/GetAccountResponse.json': '7abd8b4da37ad1ea748df40adb47d30529afb16eba71d190f8fff5322e9520ab',
      'v2/AccountLoginCompletedNotification.json': 'd81e8821fd5a4a9ad118dfc3506ea156d32dcb18da388b336501bbc6a5ccb4a6',
    },
  ],
  args: ['app-server'],
  protocol: 'codex-rpc',
  hosts: ['auth.openai.com'],
  credentialFile: 'auth.json',
});

const claudeCli = cliAccess('CLAUDE_CONFIG_DIR', '.claude', {
  version: '2.1.80',
  args: ['/login'],
  protocol: 'manual-code',
  hosts: ['claude.ai', 'console.anthropic.com', 'platform.claude.com'],
  credentialFile: '.credentials.json',
});

export const claudeAccess: AccessCapability = {
  ...claudeCli,
  envKeys: ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'],
  methods: [...claudeCli.methods, {
    id: 'api-key',
    kind: 'api-key',
    label: 'API',
    fields: [{
      id: 'ANTHROPIC_API_KEY',
      kind: 'secret',
      label: 'API-ключ',
    }],
    isolated: true,
  }],
  /**
   * Прежний собственный API-ключ GrigDesk имеет приоритет над окружением и CLI.
   * Импорт сохраняет этот выбор, не изменяя исходный файл или стандартный CLI home.
   */
  legacy(env, config) {
    const stored = typeof config?.claudeAuthPath === 'string'
      ? new ClaudeAuthStore({ authPath: config.claudeAuthPath }).read()?.apiKey : undefined;
    const key = stored || env.ANTHROPIC_API_KEY;
    const cli = claudeCli.legacy(env);

    return key ? [{
      methodId: 'api-key',
      active: true,
      env: { ANTHROPIC_API_KEY: key,
        ...(env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL } : {}) },
    }, ...cli.map((profile) => ({ ...profile, active: false }))] : cli;
  },
  /**
   * Проверка API использует безопасный список моделей без платного модельного хода.
   * При повторном входе API не доказывает владельца и требует общего unknown-confirm.
   */
  async verify(input, context) {
    const key = input.ANTHROPIC_API_KEY;

    if (typeof key !== 'string' || !key.trim() || /[\r\n\0]/u.test(key)) {
      throw accessError(400, 'invalid_key', 'Укажите API-ключ.');
    }

    let response;

    try {
      response = await context.fetchImpl('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': key.trim(), 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw accessError(503, 'unavailable', 'Нет связи с поставщиком. Повторите проверку.');
    }

    if (!response.ok) {
      throw accessError(400, response.status === 401 || response.status === 403
        ? 'auth_required' : response.status === 429 ? 'limited' : 'unavailable',
      'Не удалось проверить API-доступ.');
    }

    return { env: { ANTHROPIC_API_KEY: key.trim() }, evidence: { kind: 'unknown' } };
  },
};

export const kimiAccess = cliAccess('KIMI_CODE_HOME', '.kimi', {
  version: '2.4.1',
  args: ['login', '--region', 'global'],
  protocol: 'device-code',
  hosts: ['auth.kimi.ai', 'auth.kimi.com'],
  credentialFile: 'credentials/kimi-code.json',
});
