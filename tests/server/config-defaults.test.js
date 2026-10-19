import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG_URL = pathToFileURL(path.join(ROOT, 'server/src/config.ts')).href;

test('по умолчанию сервер использует встроенный engine', async () => {
  const savedHome = process.env.FACTORY_HOME;
  const savedBin = process.env.GRIGDESK_FACTORY_BIN;
  const savedProfiles = process.env.FACTORY_PROFILES_DIR;
  delete process.env.FACTORY_HOME;
  delete process.env.GRIGDESK_FACTORY_BIN;
  delete process.env.FACTORY_PROFILES_DIR;
  try {
    const { config } = await import(`${CONFIG_URL}?defaults-test=${Date.now()}`);
    assert.equal(config.factoryHome, path.join(ROOT, 'engine'));
    assert.equal(config.factoryBin, path.join(ROOT, 'engine/bin/factory'));
    assert.equal(config.profilesDir, path.join(ROOT, 'profiles'));
  } finally {
    if (savedHome === undefined) delete process.env.FACTORY_HOME;
    else process.env.FACTORY_HOME = savedHome;
    if (savedBin === undefined) delete process.env.GRIGDESK_FACTORY_BIN;
    else process.env.GRIGDESK_FACTORY_BIN = savedBin;
    if (savedProfiles === undefined) delete process.env.FACTORY_PROFILES_DIR;
    else process.env.FACTORY_PROFILES_DIR = savedProfiles;
  }
});

// Конфигурацию читаем отдельным процессом с закрытым окружением: живые пути не наследуются.
// Импорт чистый: его вывод достаточно сравнить с ожидаемой раскладкой.
function dataConfig(t, extra = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-config-home-'));

  t.after(() => rmSync(home, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { config } from ${JSON.stringify(CONFIG_URL)}; console.log(JSON.stringify(config))`], {
    env: { 
      PATH: '/usr/bin:/bin', 
      HOME: home, 
      GRIGDESK_HOME: home + '/h', 
      NODE_ENV: 'test', 
      ...extra 
    },
    encoding: 'utf8',
  });

  return { 
    home, 
    result, 
    config: result.status === 0 ? JSON.parse(result.stdout) : null 
  };
}

test('CD-DH-1 вся раскладка данных отделена от кода и фабрики', (t) => {
  const { home, result, config: c } = dataConfig(t);

  assert.equal(result.status, 0, result.stderr);

  const h = home + '/h';
  const mapping = {
    sshConnectionsPath: 'state/ssh/connections.json', 
    sshKnownHostsPath: 'state/ssh/known-hosts.json',
    sshAuditDir: 'state/ssh/audit', 
    dbProfilesPath: 'state/db/profiles.json', 
    dbAuditDir: 'state/db/audit',
    dataHome: '', 
    dataStateDir: 'state', 
    envPath: '.env',
    chatsDir: 'chats', 
    telegramDir: 'telegram', 
    githubDir: 'github', 
    studio3dDir: '3d',
    agentsDir: 'agents', 
    userPluginsDir: 'plugins', 
    mobileDir: 'mobile', 
    chatBindingsDir: 'chats/.bindings',
    userPluginsDataDir: 'state/plugins', 
    mobileApkDir: 'state/mobile-apk',
    modelsPath: 'state/models.json',
    usageForecastPath: 'state/usage-forecast.json',
    claudeAuthPath: 'state/claude-auth.json',
    chatStoreLegacyPath: 'state/chats.json',
    telegramAccountCredsPath: 'state/telegram-account-creds.json',
    githubCredsPath: 'state/github-creds.json',
    webLogDir: 'state/web-log',
    b24CookiePath: 'state/b24-cookies.json',
    b24CredsPath: 'state/b24-creds.json',
    ticketsDir: 'state/tickets',
    sandboxJournalDir: 'state/sandboxes',
    showcaseDir: 'state/showcase',
    showcaseAuthDir: 'state/showcase-auth',
    showcaseVoiceDir: 'state/showcase-voice',
    showcaseBrowserDir: 'state/showcase-browser',
    prefsPath: 'state/prefs.json',
    taskFavoritesPath: 'state/task-favorites.json',
    arbiterCardsPath: 'state/arbiter-cards.json',
    taskShelfPath: 'state/task-shelf.json',
    taskSeenPath: 'state/task-seen.json',
    providerUsageSeenPath: 'state/provider-usage-seen.json',
    mediaDir: 'state/media',
    mediaHfDir: 'state/hf',
    authAccountPath: 'state/auth-account.json',
    authSessionsPath: 'state/auth-sessions.json',
    cliTokenPath: 'state/cli-token',
    grigDeskUpdateStatePath: 'state/grigdesk-update.json',
    pluginInstallsStatePath: 'state/plugin-installs.json',
  };

  for (const [key, suffix] of Object.entries(mapping)) {
    assert.equal(c[key], path.join(h, suffix), key);
  }
  for (const key of ['routesDir', 'stateDir', 'factoryControlDir', 'factoryConfigRoot', 'analysisDir']) {
    assert.ok(c[key].startsWith(home + '/.factory/'), key);
  }

  assert.equal(c.rootDir, ROOT);
  assert.equal(c.profilesDir, path.join(ROOT, 'profiles'));
  assert.equal('webDist' in c, false);
  assert.equal('uiReleasesDir' in c, false);
  assert.equal(c.deepseekGenerationRoot, path.join(ROOT, 'server/runtime/deepseek'));
  assert.equal(c.agentsSeedDir, path.join(ROOT, 'server/seed/agents'));
});

test('CD-DH-2 умолчание и CD-DH-5 чистый импорт не создаёт данных', (t) => {
  const { home, config: c, result } = dataConfig(t, { GRIGDESK_HOME: '' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(c.dataHome, home + '/.grigdesk');
  assert.equal(existsSync(home + '/.grigdesk'), false);
});

test('CD-DH-3 явный путь хранилища сильнее общего умолчания', (t) => {
  assert.equal(dataConfig(t, { GRIGDESK_CHATS_DIR: '/x/chats' }).config.chatsDir, '/x/chats');
});

test('CD-DH-4 относительная папка отвергается', (t) => {
  const { result } = dataConfig(t, { GRIGDESK_HOME: 'relative' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GRIGDESK_HOME должен быть абсолютным путём/);
});
