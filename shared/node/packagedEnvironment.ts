import path from 'node:path';

import { dataHome, dataPath } from '../runtime/dataHome.ts';

/**
 * Дети используют Node пользователя, вложенный Node остаётся последним запасным.
 * Python и глобальный npm не должны изменять проверенный серверный комплект.
 */
export function packagedChildEnvironment(input: {
  node: string;
  env: NodeJS.ProcessEnv;
  home: string;
}): Record<string, string> {
  const env = Object.fromEntries(Object.entries(input.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  const nodeDirectory = path.dirname(input.node);
  const root = path.resolve(nodeDirectory, '../../..');
  const entries = (env.PATH?.split(':') ?? [])
    .filter((entry) => entry && path.resolve(entry) !== nodeDirectory);

  env.PATH = [...new Set([...entries, nodeDirectory])].join(':');
  env.PYTHONDONTWRITEBYTECODE = '1';

  const prefix = env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX;

  if (!prefix || !path.isAbsolute(prefix) || path.resolve(prefix) === root
    || path.resolve(prefix).startsWith(root + path.sep)) {
    env.npm_config_prefix = path.join(dataPath(dataHome(input), 'state'), 'npm-global');
  } else {
    env.npm_config_prefix = prefix;
  }

  delete env.NPM_CONFIG_PREFIX;

  return env;
}
