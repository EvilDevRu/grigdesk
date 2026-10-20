import * as fs from 'node:fs';
import path from 'node:path';

import { dataHome, envFilePath } from '../../../shared/runtime/dataHome.ts';
import { packagedChildEnvironment } from '../../../shared/node/packagedEnvironment.ts';
import {
  discoverUserCliDirectories,
  type UserCliFileSystem,
} from '../../../shared/node/userCliPaths.ts';
import { checkDataHome, loadDataHomeEnv } from './dataHomeBoot.ts';

/**
 * Ранние настройки запуска: placement D против корня установки и .env с приоритетом env.
 * NODE_OPTIONS удаляется независимо от источника; служебный режим D не читает.
 */
function earlyLaunchEnvironment(codeRoot: string, parent: NodeJS.ProcessEnv, home: string,
  loadFile: boolean): Record<string, string> {
  const env = Object.fromEntries(Object.entries(parent)
    .filter((entry): entry is [string, string] => entry[1] !== undefined));

  if (loadFile) {
    const input = {
      codeRoot,
      env,
      home,
    };

    checkDataHome(input, fs);
    loadDataHomeEnv(envFilePath(input), env, fs);
  }

  delete env.NODE_OPTIONS;

  return env;
}

/**
 * Передаёт ранние настройки SEA до его Node bootstrap, сохраняя приоритет env.
 * Служебные argv обходят D; NODE_OPTIONS удалён независимо от источника значения.
 */
export function seaLaunchEnvironment(root: string, parent: NodeJS.ProcessEnv, home: string,
  loadFile: boolean): Record<string, string> {
  const env = earlyLaunchEnvironment(root, parent, home, loadFile);

  if (loadFile) {
    return packagedChildEnvironment({
      node: root + '/runtime/node/bin/node',
      env,
      home,
    });
  }

  return env;
}

/**
 * Окружение запуска внешнего ELF: ранняя .env, однократный поиск CLI и общий PATH.
 * Manual, unit и launcher S21 зовут одну функцию; PTY и фабрика наследуют результат.
 * Placement D сверяется с корнем установки I, ресурсы и свой Node берутся из R.
 */
export async function packagedLaunchEnvironment(input: {
  root: string;
  installationBin: string;
  parent: NodeJS.ProcessEnv;
  home: string;
  saved?: readonly string[];
  fileSystem?: UserCliFileSystem;
}): Promise<Record<string, string>> {
  const installationRoot = path.dirname(input.installationBin);
  const env = earlyLaunchEnvironment(installationRoot, input.parent, input.home, true);
  const selected = dataHome({
    env,
    home: input.home,
  });
  const cli = await discoverUserCliDirectories({
    env,
    home: input.home,
    dataHome: selected,
    fileSystem: input.fileSystem,
  });

  return packagedChildEnvironment({
    node: path.join(input.root, 'runtime/node/bin/node'),
    env,
    home: input.home,
    cli: {
      ...cli,
      installationBin: input.installationBin,
      saved: input.saved ?? [],
    },
  });
}
