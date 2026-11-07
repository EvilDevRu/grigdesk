import { spawn } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  GIGACODE_DISTRIBUTION_VERSION,
  GIGACODE_PACKAGE_NAME,
  GIGACODE_PACKAGED_UNSUPPORTED,
} from './contract.ts';
import type { GigaCodeConfig, GigaCodeProbe } from './contract.ts';

/**
 * Команда разрешается без shell, затем проверяется реальный соседний package.json.
 * Чужой одноимённый CLI не запускается ради узнавания его версии.
 */
export async function resolveGigaCodeInstallation(config: GigaCodeConfig) {
  const requested = config.gigacodeBin || 'gigacode';
  const candidates = requested.includes(path.sep)
    ? [path.resolve(requested)]
    : (process.env.PATH || '').split(path.delimiter).map((dir) => path.resolve(dir, requested));

  for (const candidate of candidates) {
    try {
      if (!(await fs.stat(candidate)).isFile()) {
        continue;
      }

      await fs.access(candidate, constants.X_OK);
    } catch {
      continue;
    }

    const bin = await fs.realpath(candidate);
    const root = path.dirname(bin);
    const manifest = await fs.readFile(path.join(root, 'package.json'), 'utf8')
      .then((value) => JSON.parse(value), () => null);

    if (manifest?.name !== GIGACODE_PACKAGE_NAME) {
      throw Object.assign(new Error('Пакет GigaCode не подтверждён'), {
        code: 'gigacode_identity_unverified',
      });
    }

    return { bin, root };
  }

  throw Object.assign(new Error('GigaCode CLI не найден'), { code: 'gigacode_not_installed' });
}

/**
 * Metadata работает в отдельном home/cwd без ключей, hooks и проектных MCP.
 * Даже успешный процесс теряет своё дерево; зависший ограничен общим сроком пробы.
 */
async function metadataVersion(bin: string, home: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['--version'], {
      cwd: home,
      detached: true,
      env: {
        HOME: home,
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        NO_COLOR: '1',
        NO_BROWSER: '1',
        GIGACODE_DISABLE_AUTO_ENCRYPT: 'true',
        GIGACODE_SYSTEM_SETTINGS_PATH: path.join(home, 'system.json'),
        GIGACODE_SYSTEM_DEFAULTS_PATH: path.join(home, 'defaults.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;

    /**
     * Один итог пробы освобождает таймер, pipes и только собственную process group.
     * Поздний exit после timeout больше не меняет результат и не оставляет потомков.
     */
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Завершённое собственное дерево могло уже исчезнуть.
        }
      }

      child.stdout.destroy();
      child.stderr.destroy();

      if (error) {
        reject(error);
      } else {
        resolve(output.trim());
      }
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('Истёк срок metadata probe'), {
      code: 'gigacode_probe_timeout',
    })), timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');

      if (output.length > 64 * 1024) {
        finish(Object.assign(new Error('Metadata превысила лимит'), { code: 'gigacode_probe_invalid' }));
      }
    });
    child.stderr.resume();
    child.once('error', finish);
    child.once('exit', (code) => {
      setImmediate(() => finish(code === 0 ? undefined : Object.assign(
        new Error('Metadata probe завершилась ошибкой'), { code: 'gigacode_probe_failed' },
      )));
    });
  });
}

/**
 * Probe подтверждает только установку и политику версии; OAuth не запускается.
 * Private install marker нужен самому CLI даже для --version и удаляется вместе с home.
 */
export async function probeGigaCode(
  config: GigaCodeConfig,
  { timeoutMs = 5000 } = {},
): Promise<GigaCodeProbe> {
  // В комплекте нет node для CLI и мостов: отказ виден в карточке до любого spawn.
  if (config.gigacodePackaged) {
    return {
      ok: false,
      version: null,
      code: 'gigacode_packaged_unsupported',
      warning: GIGACODE_PACKAGED_UNSUPPORTED,
    };
  }

  let home: string | undefined;

  try {
    const installation = await resolveGigaCodeInstallation(config);

    home = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-gigacode-probe-'));
    await fs.mkdir(path.join(home, '.gigacode'), { mode: 0o700 });
    await fs.writeFile(path.join(home, '.gigacode/.install-dir'), installation.root, { mode: 0o600 });

    const raw = await metadataVersion(installation.bin, home, timeoutMs);
    const version: unknown = JSON.parse(raw);

    if (typeof version !== 'string' || !version || version.length > 100 || /[\x00-\x1f]/u.test(version)) {
      return {
        ok: false,
        version: null,
        code: 'gigacode_probe_invalid',
      };
    }

    return {
      ok: true,
      version,
      ...(version === GIGACODE_DISTRIBUTION_VERSION ? {} : {
        warning: `Версия ${version} не проверена, проверена ${GIGACODE_DISTRIBUTION_VERSION}`,
      }),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code || 'gigacode_probe_invalid';

    return {
      ok: false,
      version: null,
      code,
    };
  } finally {
    if (home) {
      await fs.rm(home, { recursive: true, force: true });
    }
  }
}
