/**
 * Scoped mailbox credential остаётся в памяти host-процесса и его MCP child.
 * Обычный чат, forbid и неготовый browser не наследуют его даже из случайного base env.
 */
export function factoryBrowserChildEnv(base: Record<string, string>,
  source: NodeJS.ProcessEnv | Record<string, string | undefined>, factory: boolean,
): Record<string, string> {
  const target = { ...base };

  delete target.FACTORY_BROWSER_NONCE;

  const nonce = source.FACTORY_BROWSER_NONCE;

  if (factory && source.FACTORY_BROWSER_ENABLED === '1'
    && source.FACTORY_ROUTE_BROWSER_POLICY === 'allow'
    && typeof nonce === 'string' && /^[a-f0-9]{64}$/u.test(nonce)) {
    target.FACTORY_BROWSER_NONCE = nonce;
  }

  return target;
}
