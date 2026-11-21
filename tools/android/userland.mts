import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { sha256File } from '../../shared/node/hash.ts';

const execute = promisify(execFile);
const lockPath = path.resolve(import.meta.dirname, 'userland.lock.json');
const builtPath = path.resolve(import.meta.dirname, 'userland-built.json');
const scriptPath = path.resolve(import.meta.dirname, 'build-userland.sh');
const hex64 = /^[a-f0-9]{64}$/u;
const httpsUrl = /^https:\/\/[^\s]+$/u;
const utilityNames = ['bash', 'flock', 'timeout', 'nohup', 'git', 'python3'];
const abiNames = ['arm64-v8a', 'x86_64'];
const componentNames = ['bash', 'coreutils', 'util-linux', 'git', 'python3'];

export interface UserlandEntry {
  libraryName: string;
  abis: readonly ['arm64-v8a', 'x86_64'];
  sha256ByAbi: Record<string, string>;
  version: string;
}

export interface AndroidUserland {
  entries: Record<string, UserlandEntry>;
  bashVersionMajor: number;
}

interface UserlandComponent {
  source: string;
  version: string;
  binaries: Record<string, string>;
}

interface BuiltEntry {
  version: string;
  sha256ByAbi: Record<string, string>;
}

/**
 * Читает и строго проверяет lock userland: закрытые списки утилит/ABI/компонентов,
 * SHA-256 и HTTPS-источники, лицензии. Сломанный pin не даёт описи движку.
 */
function readUserlandLock() {
  const raw: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('android_userland_lock_invalid');
  }

  const lock = raw as Record<string, unknown>;

  if (lock.format !== 1 || lock.apiLevel !== 30 || lock.ndkVersion !== 'r28c'
    || JSON.stringify(lock.abis) !== JSON.stringify(abiNames)
    || JSON.stringify(lock.utilities) !== JSON.stringify(utilityNames)
    || typeof lock.components !== 'object' || lock.components === null
    || typeof lock.sources !== 'object' || lock.sources === null
    || typeof lock.licenses !== 'object' || lock.licenses === null) {
    throw new Error('android_userland_lock_invalid');
  }

  const components = lock.components as Record<string, UserlandComponent>;
  const sources = lock.sources as Record<string, { url: string; sha256: string }>;

  if (JSON.stringify(Object.keys(components).sort()) !== JSON.stringify([...componentNames].sort())) {
    throw new Error('android_userland_lock_invalid');
  }

  for (const name of componentNames) {
    const component = components[name];

    if (typeof component.source !== 'string' || typeof component.version !== 'string'
      || typeof component.binaries !== 'object' || component.binaries === null
      || !sources[component.source]
      || !hex64.test(sources[component.source].sha256)
      || !httpsUrl.test(sources[component.source].url)) {
      throw new Error('android_userland_lock_invalid');
    }
  }

  return {
    components,
    licenses: lock.licenses as Record<string, string>,
  };
}

/**
 * Опись userland для движка: каждая несущая утилита названа lib<name>.so,
 * имеет SHA-256 по обоим ABI из манифеста фактических сборок. Без полного
 * манифеста опись не выдаётся — неизвестное не считается собранным.
 */
export function readAndroidUserland(): AndroidUserland {
  const { components } = readUserlandLock();
  let builtRaw: unknown;

  try {
    builtRaw = JSON.parse(readFileSync(builtPath, 'utf8'));
  }
  catch {
    throw new Error('android_userland_inventory_incomplete');
  }

  if (typeof builtRaw !== 'object' || builtRaw === null
    || (builtRaw as Record<string, unknown>).format !== 1
    || typeof (builtRaw as Record<string, unknown>).entries !== 'object') {
    throw new Error('android_userland_inventory_incomplete');
  }

  const built = (builtRaw as { entries: Record<string, BuiltEntry> }).entries;
  const entries: Record<string, UserlandEntry> = {};

  for (const utility of utilityNames) {
    const component = componentNames
      .map((name) => components[name])
      .find((entry) => Object.hasOwn(entry.binaries, utility));
    const record = built[utility];

    if (!component || !record || typeof record.sha256ByAbi !== 'object') {
      throw new Error('android_userland_inventory_incomplete');
    }

    for (const abi of abiNames) {
      if (!hex64.test(record.sha256ByAbi[abi] ?? '')) {
        throw new Error('android_userland_inventory_incomplete');
      }
    }

    entries[utility] = {
      libraryName: `lib${utility}.so`,
      abis: ['arm64-v8a', 'x86_64'],
      sha256ByAbi: {
        'arm64-v8a': record.sha256ByAbi['arm64-v8a'],
        'x86_64': record.sha256ByAbi.x86_64,
      },
      version: component.version,
    };
  }

  return {
    entries,
    bashVersionMajor: Number.parseInt(components.bash.version.split('.')[0], 10),
  };
}

/**
 * Сканирует каталог фактических сборок и пишет манифест SHA-256 по обоим ABI.
 * Отсутствующий бинарь останавливает запись — частичная опись не допускается.
 */
export async function scanUserland(outDir: string): Promise<AndroidUserland> {
  const { components } = readUserlandLock();
  const entries: Record<string, { version: string; sha256ByAbi: Record<string, string> }> = {};

  for (const utility of utilityNames) {
    const component = componentNames
      .map((name) => components[name])
      .find((entry) => Object.hasOwn(entry.binaries, utility));

    if (!component) {
      throw new Error('android_userland_lock_invalid');
    }

    const sha256ByAbi: Record<string, string> = {};

    for (const abi of abiNames) {
      const file = path.join(outDir, abi, `lib${utility}.so`);

      try {
        sha256ByAbi[abi] = await sha256File(file);
      }
      catch {
        throw new Error('android_userland_binary_missing');
      }
    }

    entries[utility] = {
      version: component.version,
      sha256ByAbi,
    };
  }

  await fs.writeFile(builtPath, `${JSON.stringify({ format: 1, entries }, null, 2)}\n`);

  return readAndroidUserland();
}

/**
 * CLI пробы: build запускает кросс-сборку цепочки, scan пишет манифест SHA,
 * inventory печатает опись. Все пути передаются явно, pin только из lock.
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const option = (name: string) => {
    const index = args.indexOf(name);

    if (index === -1 || index + 1 >= args.length) {
      throw new Error(`android_userland_cli_missing_${name}`);
    }

    return args[index + 1];
  };

  if (command === 'build') {
    const jobs = args.includes('--jobs') ? option('--jobs') : '4';

    await execute('bash', [scriptPath, option('--root'), option('--ndk'), option('--out'), jobs], {
      maxBuffer: 64 * 1024 * 1024,
    });

    return;
  }

  if (command === 'scan') {
    const inventory = await scanUserland(option('--out'));

    console.log(JSON.stringify(inventory, null, 2));

    return;
  }

  if (command === 'inventory') {
    console.log(JSON.stringify(readAndroidUserland(), null, 2));

    return;
  }

  throw new Error('android_userland_cli_unknown_command');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}