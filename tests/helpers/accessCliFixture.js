import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import protocols from '../fixtures/access-profiles/cli-protocols.json' with { type: 'json' };
import codex from '../../server/src/lib/executors/codex.ts';
import claude from '../../server/src/lib/executors/claude.ts';
import kimi from '../../server/src/lib/executors/kimi.ts';
import { base, eventually, profileFixture, profiles } from './accessProfiles.js';

export const CLI_VERSIONS = Object.fromEntries(Object.entries(protocols)
  .map(([provider, protocol]) => [provider, protocol.version]));

/**
 * Протокольный executable и прежние credentials создаются до миграции сервера.
 * Формат каждого home соответствует CLI, секреты принадлежат только фикстуре.
 */
export async function prepareCliFixture(root, provider, extra = {}) {
  const executable = path.join(root, 'login-cli.mjs');
  const source = await fs.readFile(new URL('../fixtures/access-profiles/login-cli.mjs', import.meta.url));
  const home = path.join(root, 'legacy-home');
  const credentials = {
    codex: ['auth.json', {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'synthetic-legacy-codex-token',
        id_token: 'synthetic-legacy-codex-identity',
        refresh_token: 'synthetic-legacy-codex-refresh',
        account_id: 'fixture-codex-account',
      },
      last_refresh: new Date().toISOString(),
    }],
    claude: ['.credentials.json', { claudeAiOauth: {
      accessToken: 'synthetic-legacy-claude-token',
      refreshToken: 'synthetic-legacy-claude-refresh',
      expiresAt: Date.now() + 3_600_000,
      scopes: ['user:profile', 'user:inference'],
    } }],
    kimi: ['credentials/kimi-code.json', {
      access_token: 'synthetic-legacy-kimi-token',
      refresh_token: 'synthetic-legacy-kimi-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      scope: 'kimi-code',
      token_type: 'Bearer',
    }],
  };
  const [relative, value] = credentials[provider];
  const credentialFile = path.join(home, relative);

  await fs.mkdir(path.dirname(credentialFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(credentialFile, JSON.stringify(value), { mode: 0o600 });
  await fs.writeFile(path.join(root, '.env'), '', { mode: 0o600 });
  await fs.writeFile(executable, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  await fs.writeFile(path.join(root, 'scenario.json'), JSON.stringify({
    provider,
    version: CLI_VERSIONS[provider],
    ...extra,
  }));

  return {
    executable,
    home,
    credentialFile,
  };
}

/**
 * Production CLI-driver получает исполняемую протокольную фикстуру вместо настоящего CLI.
 * Все homes и footprints находятся в одном одноразовом корне, доступ владельца не читается.
 */
export async function cliFixture(t, provider = 'codex', extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'access-cli-'));
  let f;
  const { executable, home, credentialFile } = await prepareCliFixture(root, provider, extra);
  const adapters = {
    codex,
    claude,
    kimi
  };
  const credentialBytes = await fs.readFile(credentialFile, 'utf8');

  t.after(async () => {
    await f?.app.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const env = {
    HOME: root,
    CODEX_HOME: home,
    CLAUDE_CONFIG_DIR: home,
    KIMI_CODE_HOME: home,
  };

  f = await profileFixture(t, {
    root,
    env,
    adapters: [{
      ...adapters[provider],
      externalCli: undefined,
      nativeSettings: undefined,
      prepareRuntime: undefined,
      latestVersion: undefined,
      commands: undefined,
      catalog: undefined,
      mcpStatus: undefined,
      usage: undefined,
      bin: () => executable,
      probe: async () => ({ ok: true, version: extra.version ?? CLI_VERSIONS[provider] }),
      auth: async () => ({
        available: true,
        mode: 'cli',
        label: 'Основной вход фикстуры'
      }),
      seedModels: () => [],
    }],
    config: { [`${provider}Bin`]: executable, kimiHome: home },
  });

  const list = await profiles(f, provider);
  const method = list.methods.find((item) => item.kind === 'cli');

  assert.ok(method, 'драйвер объявляет управляемый CLI-вход');

  return {
    ...f,
    home,
    credentialFile,
    credentialBytes,
    executable,
    method,
    provider,
    list
  };
}

/**
 * Состояние восстанавливается чтением; polling не пишет код повторно.
 * Возможность завершить login остаётся под управлением отдельного child.
 */
export async function cliStep(f, attempt, kind) {
  return eventually(
    () => f.request('GET', `${base(f.provider)}/attempts/${attempt.id}`),
    (value) => value.step?.kind === kind,
    `шаг ${kind}`,
  );
}

/**
 * Читает журнал только синтетического CLI текущего теста.
 * Записи stdin позволяют отличить повтор доставки от ввода другому процессу.
 */
export async function cliRecords(f) {
  const text = await fs.readFile(path.join(f.root, 'cli.jsonl'), 'utf8');

  return text.trim().split('\n').map((line) => JSON.parse(line));
}
