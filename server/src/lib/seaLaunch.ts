import * as fs from 'node:fs';

import { envFilePath } from '../../../shared/runtime/dataHome.ts';
import { packagedChildEnvironment } from '../../../shared/node/packagedEnvironment.ts';
import { checkDataHome, loadDataHomeEnv } from './dataHomeBoot.ts';

/**
 * Передаёт ранние настройки SEA до его Node bootstrap, сохраняя приоритет env.
 * Служебные argv обходят D; NODE_OPTIONS удалён независимо от источника значения.
 */
export function seaLaunchEnvironment(root: string, parent: NodeJS.ProcessEnv, home: string,
  loadFile: boolean): Record<string, string> {
  const env = Object.fromEntries(Object.entries(parent)
    .filter((entry): entry is [string, string] => entry[1] !== undefined));

  if (loadFile) {
    const input = {
      codeRoot: root,
      env,
      home,
    };

    checkDataHome(input, fs);
    loadDataHomeEnv(envFilePath(input), env, fs);
  }

  delete env.NODE_OPTIONS;

  if (loadFile) {
    return packagedChildEnvironment({
      node: root + '/runtime/node/bin/node',
      env,
      home,
    });
  }

  return env;
}
