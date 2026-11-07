import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import * as files from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as realTimeout } from 'node:timers';

import { SystemAdapter } from '../../../server/src/adapters/system.ts';

export const GB = 1024 ** 3;

let pendingFiles = 0;
let fileSequence = 0;

/**
 * Даёт фоновому файловому обходу закончить цепочку настоящих async I/O.
 * Часы опроса при этом остаются под контролем теста, без ожидания пяти секунд.
 */
export async function settle() {
  let quiet = 0;
  let previous = fileSequence;

  for (let turn = 0; turn < 2000; turn += 1) {
    await new Promise((resolve) => realTimeout(resolve, 1));
    quiet = pendingFiles === 0 && previous === fileSequence ? quiet + 1 : 0;
    previous = fileSequence;

    if (quiet >= 4) {
      return;
    }
  }

  assert.fail('Файловая фикстура не завершила собственный обход');
}

/**
 * Незавершённый порт позволяет проверять порядок событий вместо скорости машины.
 * Тест сам разрешает ответ после проверки доступности кеша и single-flight.
 */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

/**
 * Подменяет только входы старого адаптера: память, CPU и внешний IP.
 * Системные файлы владельца и геосервисы не используются даже на исходном коде.
 */
export function legacyPorts(t) {
  const state = {
    idle: 100,
    user: 100,
    procMissing: false,
    calls: {
      cpu: 0,
      load: 0,
      memory: 0,
    },
  };
  const readFileSync = fs.readFileSync.bind(fs);

  t.mock.method(os, 'cpus', () => {
    state.calls.cpu += 1;

    return Array.from({ length: 4 }, () => ({
      model: 'Fixture CPU',
      speed: 1000,
      times: {
        user: state.user,
        idle: state.idle,
        nice: 0,
        sys: 0,
        irq: 0,
      },
    }));
  });
  t.mock.method(os, 'loadavg', () => {
    state.calls.load += 1;

    return [1.234, 0, 0];
  });
  t.mock.method(os, 'totalmem', () => 16 * GB);
  t.mock.method(os, 'freemem', () => 4 * GB);
  t.mock.method(fs, 'readFileSync', (filename, ...args) => {
    if (filename !== '/proc/meminfo') {
      return readFileSync(filename, ...args);
    }

    state.calls.memory += 1;

    if (state.procMissing) {
      throw Object.assign(new Error('Нет proc в фикстуре'), { code: 'ENOENT' });
    }

    return [
      'MemTotal: 16777216 kB',
      'MemAvailable: 4194304 kB',
      'SwapTotal: 8388608 kB',
      'SwapFree: 4194304 kB',
    ].join('\n');
  });
  t.mock.method(SystemAdapter.prototype, '_refreshNet', async function () {
    this.net = {
      ip: '192.0.2.1',
      country: 'Фикстура',
      countryCode: 'ZZ',
    };
  });
  syncBuiltinESMExports();

  return state;
}

/**
 * Фальшивый child живёт до явного close, включая время после kill.
 * Это отличает отправку SIGKILL от освобождения блокировки запуска NVIDIA.
 */
function fakeChild() {
  const child = new EventEmitter();

  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  child.closed = false;
  child.kill = (signal) => {
    child.signals.push(signal);

    return true;
  };
  child.finish = (output = '', code = 0) => {
    if (child.closed) {
      return;
    }

    child.closed = true;
    child.stdout.emit('data', Buffer.from(output));
    child.emit('close', code, null);
  };

  return child;
}

/**
 * Создаёт отдельные proc/sys/dev и файловый порт с подставным statfs.
 * resourcesOptions задаёт корни, fs и spawn; часы стандартных таймеров подменены node:test.
 */
export async function resourcesFixture(t, overrides = {}) {
  const root = await files.mkdtemp(path.join(os.tmpdir(), 'grigdesk-resources-'));
  const procRoot = path.join(root, 'proc');
  const sysRoot = path.join(root, 'sys');
  const devRoot = path.join(root, 'dev');
  const dataHome = path.join(root, 'mounts/data/app');
  const legacy = legacyPorts(t);
  const io = [];
  const readErrors = new Map();
  const stats = new Map();
  const spawns = [];
  const adapters = [];
  const nvidia = { mode: 'missing', output: '' };

  await Promise.all([procRoot, sysRoot, devRoot, dataHome].map((dir) => files.mkdir(dir, {
    recursive: true,
  })));
  await files.writeFile(path.join(procRoot, 'mounts'), '');
  await files.mkdir(path.join(sysRoot, 'class/hwmon'), { recursive: true });
  await files.mkdir(path.join(sysRoot, 'class/drm'), { recursive: true });
  await files.mkdir(path.join(sysRoot, 'class/block'), { recursive: true });

  const filePort = {};

  for (const method of ['readFile', 'readdir', 'readlink', 'realpath', 'access', 'stat', 'lstat']) {
    filePort[method] = async (...args) => {
      io.push({ method, path: String(args[0]) });
      pendingFiles += 1;
      fileSequence += 1;

      try {
        const denied = readErrors.get(path.basename(String(args[0])));

        if (method === 'readFile' && denied) {
          throw denied;
        }

        const result = await files[method](...args);

        if (method === 'stat' && String(args[0]).startsWith(`${devRoot}/`) && result.isFile()) {
          result.isBlockDevice = () => true;
        }

        return result;
      } finally {
        pendingFiles -= 1;
      }
    };
  }

  filePort.statfs = async (mountpoint) => {
    io.push({ method: 'statfs', path: String(mountpoint) });

    const result = stats.get(String(mountpoint));

    assert.ok(result, `statfs вызван только для разрешённой фикстуры: ${mountpoint}`);

    if (result instanceof Error) {
      throw result;
    }

    return await result;
  };

  /**
   * Команда заменена управляемым child с отдельными error и close.
   * Удержание close проверяет владение процессом после срока завершения.
   */
  const spawn = (command, args, options) => {
    const child = fakeChild();

    child.pid = 1_000_000 + spawns.length;
    spawns.push({
      command,
      args,
      options,
      child,
    });
    queueMicrotask(() => {
      if (nvidia.mode === 'missing') {
        child.emit('error', Object.assign(new Error('Нет nvidia-smi'), { code: 'ENOENT' }));
        child.finish('', -2);
      } else if (nvidia.mode === 'success') {
        child.finish(nvidia.output);
      }
    });

    return child;
  };

  t.mock.method(childProcess, 'spawn', spawn);
  t.mock.method(process, 'kill', (pid, signal) => {
    const owned = spawns.find((entry) => entry.child.pid === pid);

    assert.ok(owned, 'сборщик может послать сигнал только собственному child');

    return owned.child.kill(signal);
  });
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  t.after(async () => {
    for (const adapter of adapters) {
      adapter.stop();
    }

    t.mock.timers.reset();
    await files.rm(root, { recursive: true, force: true });
  });

  const options = {
    procRoot,
    sysRoot,
    devRoot,
    fs: filePort,
    spawn,
    ...overrides,
  };

  return {
    root,
    procRoot,
    sysRoot,
    devRoot,
    dataHome,
    legacy,
    io,
    readErrors,
    stats,
    spawns,
    nvidia,
    options,
    /**
     * Подготовка файла не использует проверяемый порт и не меняет его счётчики.
     * Родитель создаётся только внутри временного корня текущего теста.
     */
    async put(relative, value) {
      const filename = path.join(root, relative);

      await files.mkdir(path.dirname(filename), { recursive: true });
      await files.writeFile(filename, String(value));

      return filename;
    },
    /**
     * Ссылки воспроизводят идентичность sysfs без настоящих устройств.
     * Оба конца ссылки принадлежат одному временному корню.
     */
    async link(relative, target) {
      const filename = path.join(root, relative);

      await files.mkdir(path.dirname(filename), { recursive: true });
      await files.symlink(path.join(root, target), filename);

      return filename;
    },
    async remove(relative) {
      await files.rm(path.join(root, relative), { recursive: true, force: true });
    },
    start(extra = {}) {
      const adapter = new SystemAdapter({
        dataHome,
        resourcesOptions: options,
        ...extra,
      });

      adapters.push(adapter);

      return adapter;
    },
    async advance(ms) {
      t.mock.timers.tick(ms);
      await settle();
    },
  };
}

/**
 * Настоящие ссылки sysfs связывают hwmon с устройством, а не номером каталога.
 * Фикстура сохраняет типичный путь PCI/NVMe/DRM без доступа к машине тестировщика.
 */
export async function hwmon(fixture, index, driver, device, channels) {
  const directory = `sys/${device}/hwmon/hwmon${index}`;

  await fixture.put(`${directory}/name`, driver);

  for (const [key, value] of Object.entries(channels)) {
    await fixture.put(`${directory}/${key}`, value);
  }

  await fixture.link(`sys/class/hwmon/hwmon${index}`, directory);
  await fixture.link(`${directory}/device`, `sys/${device}`);

  return directory;
}

/**
 * Два раздела одного NVMe имеют разные block identity и общего контроллера.
 * Размеры задаются statfs-портом, поэтому не зависят от свободного места хоста.
 */
export async function partition(fixture, name, mountpoint, sizes = {}) {
  const controller = name.match(/^nvme\d+/)?.[0];
  const namespace = name.replace(/p\d+$/, '');
  const parent = controller
    ? `devices/pci0000:00/0000:01:00.0/nvme/${controller}/${namespace}`
    : 'devices/virtual/block';
  const directory = `sys/${parent}${name === namespace && controller ? '' : `/${name}`}`;

  await fixture.put(`${directory}/dev`, '259:1');
  await fixture.put(`dev/${name}`, '');
  await fixture.link(`sys/class/block/${name}`, directory);

  if (controller && name !== namespace) {
    const namespaceLink = path.join(fixture.sysRoot, 'class/block', namespace);

    if (!fs.existsSync(namespaceLink)) {
      await fixture.link(`sys/class/block/${namespace}`, `sys/${parent}`);
    }
  }

  const target = path.join(fixture.root, 'mounts', mountpoint);

  await files.mkdir(target, { recursive: true });
  fixture.stats.set(target, {
    bsize: GB,
    blocks: 100,
    bfree: 20,
    bavail: 10,
    ...sizes,
  });

  return {
    device: path.join(fixture.devRoot, name),
    mountpoint: target,
    controller,
    parent,
  };
}

export const mountLine = (disk, type = 'ext4') =>
  `${disk.device} ${disk.mountpoint.replaceAll(' ', '\\040')} ${type} rw 0 0`;
