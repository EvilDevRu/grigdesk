const FORBIDDEN_ENV = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|PROXY|SSH|GIT|NPM|AWS|AZURE|GOOGLE|ANTHROPIC|OPENAI|CLAUDE|CODEX)/i;

/** Окружение runtime строится только из server-owned значений. */
export function buildKimiRuntimeEnv({ proxyUrl }: { proxyUrl?: string } = {}): Record<string, string> {
  const env: Record<string, string> = {
    HOME: '/home/kimi',
    KIMI_CODE_HOME: '/kimi-home',
    XDG_CONFIG_HOME: '/home/kimi/.config',
    XDG_CACHE_HOME: '/home/kimi/.cache',
    XDG_DATA_HOME: '/home/kimi/.local/share',
    TMPDIR: '/tmp',
    PATH: '/opt/node/bin:/usr/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
    CI: '1',
    KIMI_DISABLE_TELEMETRY: '1',
    KIMI_LOG_LEVEL: 'off',
    KIMI_DISABLE_CRON: '1',
    SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt',
  };
  if (proxyUrl) {
    env.HTTPS_PROXY = proxyUrl;
    env.HTTP_PROXY = proxyUrl;
    env.NO_PROXY = '';
  }
  return env;
}

export function assertKimiRuntimeEnv(
  env: Record<string, string>,
  { proxyConfigured = false } = {},
): Record<string, string> {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.includes('\0')) throw new Error(`invalid_env:${key}`);
    if (FORBIDDEN_ENV.test(key) && !['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'].includes(key)) {
      throw new Error(`forbidden_env:${key}`);
    }
  }
  if (!proxyConfigured && ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'].some((key) => key in env)) {
    throw new Error('proxy_env_without_egress_boundary');
  }
  for (const required of ['HOME', 'KIMI_CODE_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) {
    if (!env[required]) throw new Error(`missing_env:${required}`);
  }
  return env;
}
