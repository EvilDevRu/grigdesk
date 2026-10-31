type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Public флаги существуют только для identity текущего host-owned Factory запуска.
 * Файловый state-only режим не участвует: браузер разрешает отдельная policy узла.
 */
export function factoryBrowserPublicEnabled(env: Environment): boolean {
  return env.FACTORY_BROWSER_ENABLED === '1'
    && env.FACTORY_ROUTE_BROWSER_POLICY === 'allow';
}

/**
 * Готовность secret transport подтверждается до публикации browser флагов MCP.
 * Возвращается только boolean: nonce не становится частью descriptor или YAML.
 */
export function factoryBrowserReady(env: Environment): boolean {
  return factoryBrowserPublicEnabled(env)
    && /^[a-f0-9]{64}$/u.test(env.FACTORY_BROWSER_NONCE ?? '');
}
