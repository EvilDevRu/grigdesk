import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.dirname(fileURLToPath(import.meta.url));
const scenario = JSON.parse(fs.readFileSync(path.join(root, 'scenario.json'), 'utf8'));
const record = (value) => fs.appendFileSync(path.join(root, 'cli.jsonl'), `${JSON.stringify(value)}\n`);
const homeKey = {
  codex: 'CODEX_HOME',
  claude: 'CLAUDE_CONFIG_DIR',
  kimi: 'KIMI_CODE_HOME',
};
const home = process.env[homeKey[scenario.provider]];
const args = process.argv.slice(2);

record({
  pid: process.pid,
  args,
  home
});

if (args.includes('--version') || args.includes('-v')) {
  while (scenario.holdVersion && !fs.existsSync(path.join(root, 'release-version'))) {
    await delay(10);
  }

  const label = scenario.provider === 'claude' ? `${scenario.version} (Claude Code)`
    : `${scenario.provider === 'codex' ? 'codex-cli' : 'kimi'} ${scenario.version}`;

  process.stdout.write(`${label}\n`);
  process.exit(0);
}

/**
 * Успех записывается только в home текущего login-процесса.
 * Повторная программная проверка читает результат, а не считает кнопку успехом.
 */
function saveLogin() {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  if (scenario.provider === 'claude') {
    fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: 'synthetic-cli-secret-token',
        refreshToken: 'synthetic-cli-new-refresh',
        expiresAt: Date.now() + 3_600_000,
        scopes: ['user:profile', 'user:inference'],
      },
    }), { mode: 0o600 });
  } else if (scenario.provider === 'kimi') {
    fs.mkdirSync(path.join(home, 'credentials'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, 'credentials/kimi-code.json'), JSON.stringify({
      access_token: 'synthetic-cli-secret-token',
      refresh_token: 'synthetic-cli-new-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      scope: 'kimi-code',
      token_type: 'Bearer',
    }), { mode: 0o600 });
  } else {
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'synthetic-cli-secret-token',
        id_token: 'synthetic-cli-identity-token',
        refresh_token: 'synthetic-cli-new-refresh',
        account_id: 'fixture-codex-account',
      },
      last_refresh: new Date().toISOString(),
    }), { mode: 0o600 });
  }
}

const say = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const lines = readline.createInterface({ input: process.stdin });

if (scenario.provider === 'claude' && args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(`${JSON.stringify({
    loggedIn: fs.existsSync(path.join(home, '.credentials.json')),
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'fixture@example.test',
    orgId: 'fixture-organization',
    orgName: 'Fixture',
    subscriptionType: 'max',
  })}\n`);
  process.exit(0);
}

const supported = scenario.provider === 'codex' ? args.includes('app-server')
  : scenario.provider === 'claude' ? args.includes('/login')
    : args[0] === 'login' && (!args.includes('--region')
      || ['global', 'mainland-cn'].includes(args[args.indexOf('--region') + 1]));

if (!supported) {
  process.stderr.write('Фикстура отвергла команду вне подтверждённого протокола\n');
  process.exit(64);
}

if (args.includes('app-server')) {
  lines.on('line', (line) => {
    const message = JSON.parse(line);

    record({
      pid: process.pid,
      method: message.method,
      params: message.params
    });

    if (message.method === 'initialize') {
      say({ id: message.id, result: {
        userAgent: 'access-fixture',
        codexHome: home,
        platformFamily: 'unix',
        platformOs: 'linux',
      } });
    } else if (message.method === 'account/login/start') {
      say({ id: message.id, result: {
        type: 'chatgptDeviceCode',
        loginId: 'fixture-login',
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'CLI-SITE-1234',
      } });
    } else if (message.method === 'account/read') {
      say({ id: message.id, result: {
        account: fs.existsSync(path.join(home, 'auth.json'))
          ? {
            type: 'chatgpt',
            email: 'fixture@example.test',
            planType: 'plus'
          } : null,
        requiresOpenaiAuth: true,
      } });
    } else if (message.method === 'account/login/cancel') {
      say({ id: message.id, result: { status: 'cancelled' } });
    }
  });
  fs.watchFile(path.join(root, 'complete'), { interval: 20 }, (stat) => {
    if (stat.size > 0) {
      fs.unwatchFile(path.join(root, 'complete'));
      saveLogin();
      say({ method: 'account/login/completed', params: { loginId: 'fixture-login', success: true } });
    }
  });
} else {
  if (scenario.unknown) {
    process.stdout.write('\u001b[31mUnknown authentication prompt synthetic-cli-secret-token\u001b[0m\n');
  } else if (scenario.provider === 'kimi') {
    const region = args.includes('--region') ? args[args.indexOf('--region') + 1] : 'mainland-cn';
    const host = region === 'global' ? 'auth.kimi.ai' : 'auth.kimi.com';

    process.stderr.write(`Opening browser for Kimi device login: https://${host}/device\n`);
    process.stderr.write('If the browser did not open, paste the URL above and enter code: CLI-SITE-1234\n');
    process.stderr.write('Code expires in 600s.\nWaiting for authorization to complete…\n');
    fs.watchFile(path.join(root, 'complete'), { interval: 20 }, (stat) => {
      if (stat.size > 0) {
        saveLogin();
        process.stderr.write('Logged in to kimi-code.\n');
        process.exit(0);
      }
    });
  } else {
    process.stdout.write('Open https://claude.ai/oauth/authorize\n');
    setTimeout(() => process.stdout.write('Paste code here if prompted > '), 20);
  }

  lines.on('line', (line) => {
    record({ pid: process.pid, input: line });

    if (line === 'SITE-CLI-5678#fixture-state') {
      saveLogin();
      process.stdout.write('Login successful. Press Enter to continue…\n');
    }
  });
}
