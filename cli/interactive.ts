import { existsSync } from 'node:fs';
import path from 'node:path';

import { runtimeInstallationRoot } from '../server/src/lib/runtimePaths.ts';
import { isPortableBundle } from '../shared/node/bundleLayout.ts';
import { insideUnit, runCli } from './commands.ts';
import { UNIT } from './server.ts';
import { readText, runAttached } from './system.ts';
import { runMenu } from './menu.ts';
import { runBuildProgress } from './buildProgress.ts';
import { runPresentedCommand } from './presentation.ts';

/**
 * Наличие обоих терминальных потоков необходимо даже при явном build.
 * Сторож службы читается заново и не расширяет существующее распознавание агентов.
 */
export async function canUseInteractive(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.GRIGDESK_CTL_SOURCE_FALLBACK === '1') {
    return false;
  }

  const cgroup = await readText(process.env.GRIGDESK_CLI_CGROUP_FILE || '/proc/self/cgroup');

  return !insideUnit(cgroup ?? '', UNIT);
}

/**
 * Готовая поставка важнее случайно оставленных рядом маркеров исходников.
 * Предикат управляет доступностью групп, а фактические команды проверяют себя сами.
 */
export function sourceInstallation(root: string): boolean {
  return !isPortableBundle(root) && !existsSync(path.join(root, 'release.json'))
    && ['server/src/app.ts', 'web/package.json', 'desktop/package.json']
      .every((file) => existsSync(path.join(root, file)));
}

/**
 * Единственный вход выбирает новый экран только для человеческого терминала.
 * Внутренний build всегда делегируется старой оболочке без рекурсивного UI.
 */
export async function runEntry(argv: readonly string[]): Promise<number> {
  const root = runtimeInstallationRoot();
  const interactive = await canUseInteractive();

  if (argv.length === 0 && interactive) {
    return runMenu(root);
  }

  if (argv[0] === 'build' && argv.length <= 2
    && ['all', 'server', 'web', 'window', 'deepseek', 'apk'].includes(argv[1] ?? 'all')
    && sourceInstallation(root)) {
    if (interactive && process.env.GRIGDESK_CTL_BUILD_CHILD !== '1') {
      return runBuildProgress(root, argv[1] ?? 'all');
    }

    return runAttached('/bin/bash', [path.join(root, 'bin/grigdesk-ctl'), ...argv], {
      ...process.env,
      GRIGDESK_CTL_BUILD_CHILD: '1',
    });
  }

  return interactive && !argv.includes('--json') ? runPresentedCommand(root, argv) : runCli(argv);
}
