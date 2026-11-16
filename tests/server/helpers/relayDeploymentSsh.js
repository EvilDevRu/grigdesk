import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

import { createSshTransport } from '../../../server/src/lib/ssh/transport.ts';

const require = createRequire(new URL('../../../server/package.json', import.meta.url));
const { Client, Server, utils } = require('ssh2');

/**
 * Журнал содержит фактически вызванные OS-команды и argv, а не текст installer-шаблона.
 * Поэтому упоминание useradd в read-only проверке command -v не считается созданием пользователя.
 */
export async function executedOsCommands(ssh) {
  const text = await fs.readFile(path.join(ssh.root, 'commands.log'), 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    return '';
  });

  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Настоящий ssh2.Server принимает только сгенерированный пароль или ключ этого теста.
 * Команды исполняются в bwrap: системные пути принадлежат временному VPS, /usr только читается.
 */
export async function relayDeploymentSsh(t, options = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'grigdesk-relay-deployment-ssh-'));
  const host = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const passphrase = 'RD_PASSPHRASE_SENTINEL_1024';
  const privateKey = key.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const encryptedKey = key.privateKey.export({
    type: 'pkcs1',
    format: 'pem',
    cipher: 'aes-256-cbc',
    passphrase,
  }).toString();
  const parsedKey = utils.parseKey(privateKey);
  const password = 'RD_PASSWORD_SENTINEL_1024';
  const sockets = new Set();
  const clients = new Set();
  const children = new Set();
  const commands = [];
  const authentications = [];
  const writes = [];
  const openingTimers = new Set();
  const platform = {
    id: 'ubuntu',
    arch: 'x86_64',
    glibc: '2.35',
    root: true,
    systemd: true,
    portBusy: false,
    missingLibrary: '',
    ...options.platform,
  };

  for (const directory of ['etc/systemd/system', 'opt', 'var/lib', 'tmp', 'run/systemd/system', 'stubs']) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
  }

  if (!platform.systemd) {
    await fs.rm(path.join(root, 'run/systemd'), { recursive: true });
  }

  await fs.writeFile(path.join(root, 'etc/os-release'),
    `ID=${platform.id}\nVERSION_ID="22.04"\n`);
  await fs.writeFile(path.join(root, 'platform.json'), JSON.stringify(platform));
  await fs.writeFile(path.join(root, 'stubs/os.cjs'), osAdapter);

  for (const command of ['id', 'getent', 'useradd', 'groupadd', 'userdel', 'groupdel',
    'systemctl', 'ss', 'uname', 'cut',
    'getconf', 'ldd', 'ldconfig', 'sudo', 'chown', 'mv', 'install',
    'apt', 'apt-get', 'npm', 'docker', 'ufw', 'iptables']) {
    await fs.writeFile(path.join(root, 'stubs', command),
      `#!/bin/sh\nexec /fixture-node /fixture/stubs/os.cjs ${command} "$@"\n`, { mode: 0o755 });
  }

  const server = new Server({ hostKeys: [host.privateKey.export({ type: 'pkcs1', format: 'pem' })] });
  // TCP принадлежит фикстуре: обрыв не зависит от внутренних полей ssh2.
  // injectSocket передаёт настоящий сокет серверу, не подменяя SSH-протокол.
  const listener = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    server.injectSocket(socket);
  });

  server.on('connection', (client) => {
    clients.add(client);
    client.on('error', () => { });
    client.once('close', () => clients.delete(client));
    client.on('authentication', (context) => {
      authentications.push({ method: context.method, username: context.username });

      if (context.method === 'password' && !options.keyOnly && context.password === password) {
        context.accept();

        return;
      }

      if (context.method === 'publickey' && context.key.data.equals(parsedKey.getPublicSSH())
        && (!context.signature || parsedKey.verify(context.blob, context.signature, context.hashAlgo))) {
        context.accept();

        return;
      }

      context.reject(['publickey', ...(options.keyOnly ? [] : ['password'])]);
    });
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept();

      session.on('exec', (acceptExec, _reject, info) => {
        const execute = () => {
          const channel = acceptExec();

          commands.push(info.command);
          run(info.command, channel);
        };

        // Самопроверка фикстуры всегда проходит; задержка относится только к исследуемой команде.
        if (info.command === 'printf fixture-ok') {
          execute();
        } else {
          openLater(client, 'exec', execute);
        }
      });
      session.on('sftp', (acceptSftp) => openLater(client, 'sftp', () =>
        serveSftp(acceptSftp(), root, writes, options)));
    }));
  });
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const timer of openingTimers) {
      clearTimeout(timer);
    }

    for (const client of clients) {
      client.end();
    }

    for (const socket of sockets) {
      socket.end();
    }

    await new Promise((resolve) => listener.close(resolve));

    // После закрытия SSH новые exec уже не могут добавить дочерний процесс.
    // Поэтому список остановки снимается только на этой границе.
    const stopped = [...children].map((child) => new Promise((resolve) => {
      child.once('close', resolve);
      child.kill('SIGKILL');
    }));

    await Promise.all(stopped);
    // Каталог удаляется после закрытия stdio всех OS-процессов временного VPS.
    // FIFO after-hooks иначе удаляют его одновременно с ещё работающей командой.
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 20,
    });
  });

  const port = listener.address().port;
  const transport = createSshTransport();
  const probed = await transport.probe({
    host: '127.0.0.1',
    port,
    user: 'root'
  });

  assert.ok(probed?.fingerprint.startsWith('SHA256:'), 'Проверка работоспособности SSH-фикстуры');

  const input = {
    host: '127.0.0.1',
    port,
    user: 'root',
    password,
    hostVerifier: (fp) => fp === probed.fingerprint
  };

  /**
   * SSH может принять login, но не подтвердить exec/subsystem; это не разрыв TCP.
   * Позднее подтверждение не вызывается после закрытия клиента и не запускает команды сиротой.
   */
  function openLater(client, kind, accept) {
    if (options[`${kind}Open`] === 'missing') {
      return;
    }

    const delay = options[`${kind}DelayMs`] ?? 0;

    if (!delay) {
      accept();

      return;
    }

    const timer = setTimeout(() => {
      openingTimers.delete(timer);

      if (clients.has(client)) {
        accept();
      }
    }, delay);

    openingTimers.add(timer);
  }

  const control = new Client();

  await new Promise((resolve, reject) => {
    control.once('error', reject);
    control.once('ready', resolve);
    control.connect({
      host: '127.0.0.1',
      port,
      username: 'root',
      privateKey,
      hostHash: 'sha256',
      hostVerifier: (hash) =>
        `SHA256:${Buffer.from(hash, 'hex').toString('base64')}` === probed.fingerprint,
    });
  });
  await new Promise((resolve, reject) => control.exec('printf fixture-ok', (error, stream) => {
    if (error) {
      reject(error);

      return;
    }

    let output = '';
    let errors = '';

    stream.on('data', (bytes) => output += bytes);
    stream.stderr.on('data', (bytes) => errors += bytes);
    stream.on('close', (code) => {
      try {
        assert.equal(code, 0, `Изоляция VPS недоступна: ${errors}`);
        assert.equal(output, 'fixture-ok');
        resolve();
      } catch (failure) {
        reject(failure);
      }
    });
  }));
  await new Promise((resolve) => {
    control.once('close', resolve);
    control.end();
  });
  commands.length = 0;
  authentications.length = 0;

  return {
    root,
    port,
    transport,
    input,
    privateKey,
    encryptedKey,
    passphrase,
    password,
    fingerprint: probed.fingerprint,
    commands,
    authentications,
    writes,
    disconnect: () => sockets.forEach((socket) => socket.destroy()),
    release: () => fs.writeFile(path.join(root, 'release'), ''),
    setPlatform: async (patch) => {
      Object.assign(platform, patch);
      await fs.writeFile(path.join(root, 'platform.json'), JSON.stringify(platform));
      await fs.writeFile(path.join(root, 'etc/os-release'), `ID=${platform.id}\nVERSION_ID="22.04"\n`);
    },
  };

  /**
   * Единственная исполняемая оболочка видит свой /etc, /opt, /var и /tmp.
   * Даже ошибка production script не может изменить системные файлы машины разработчика.
   */
  function run(command, channel) {
    // Отдельное дерево PID уничтожается вместе с bwrap даже при ошибке теста до release.
    // Иначе остановленный OS-адаптер держит stdio и не даёт завершиться node:test.
    const child = spawn('bwrap', [
      '--unshare-pid', '--die-with-parent',
      '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin',
      '--symlink', 'usr/sbin', '/sbin', '--symlink', 'usr/lib', '/lib',
      '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev',
      '--bind', root, '/fixture', '--bind', path.join(root, 'etc'), '/etc',
      '--bind', path.join(root, 'opt'), '/opt', '--bind', path.join(root, 'var'), '/var',
      '--bind', path.join(root, 'tmp'), '/tmp', '--bind', path.join(root, 'run'), '/run',
      '--ro-bind', process.execPath, '/fixture-node',
      '--setenv', 'PATH', '/fixture/stubs:/usr/sbin:/usr/bin:/bin',
      '--setenv', 'HOME', '/tmp', '--unshare-user', '--uid', '0', '--gid', '0',
      '/bin/sh', '-c', command,
    ], { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });

    children.add(child);
    channel.pipe(child.stdin);
    child.stdout.pipe(channel, { end: false });
    child.stderr.pipe(channel.stderr, { end: false });
    child.on('error', (error) => channel.destroy(error));
    child.on('close', (code) => {
      children.delete(child);
      channel.exit(code ?? 1);
      channel.end();
    });
  }
}

/**
 * SFTP обрабатывает реальные файлы временного VPS, включая modes и атомарный rename.
 * Пути нормализуются до временного корня, открытие конечного симлинка запрещено.
 */
function serveSftp(stream, root, writes, options) {
  const handles = new Map();
  let sequence = 0;
  const safe = (remote) => path.join(root, path.posix.resolve('/', remote));
  const respond = (id, promise, done = () => stream.status(id, 0)) => {
    Promise.resolve(promise).then(done, (error) =>
      stream.status(id, error.code === 'ENOENT' ? 2 : error.code === 'EACCES' ? 3 : 4));
  };

  stream.on('OPEN', (id, remote, flags, attrs) => {
    const mode = (flags & 2 ? constants.O_RDWR : constants.O_RDONLY)
      | (flags & 4 ? constants.O_APPEND : 0)
      | (flags & 8 ? constants.O_CREAT : 0)
      | (flags & 16 ? constants.O_TRUNC : 0)
      | (flags & 32 ? constants.O_EXCL : 0)
      | constants.O_NOFOLLOW;

    respond(id, fs.open(safe(remote), mode, attrs.mode ?? 0o600), (file) => {
      const handle = Buffer.alloc(4);

      handle.writeUInt32BE(++sequence);
      handles.set(sequence, file);
      stream.handle(id, handle);
    });
  });
  stream.on('WRITE', (id, handle, offset, data) => {
    writes.push({ size: data.length });

    if (options.failUpload) {
      stream.status(id, 4);

      return;
    }

    respond(id, handles.get(handle.readUInt32BE()).write(data, 0, data.length, offset));
  });
  stream.on('READ', (id, handle, offset, length) => {
    const bytes = Buffer.alloc(length);

    respond(id, handles.get(handle.readUInt32BE()).read(bytes, 0, length, offset), (result) => {
      if (result.bytesRead) {
        stream.data(id, bytes.subarray(0, result.bytesRead));
      } else {
        stream.status(id, 1);
      }
    });
  });
  stream.on('CLOSE', (id, handle) => {
    const file = handles.get(handle.readUInt32BE());

    handles.delete(handle.readUInt32BE());
    respond(id, file.close());
  });
  stream.on('MKDIR', (id, remote, attrs) => respond(id, fs.mkdir(safe(remote), { mode: attrs.mode })));
  stream.on('RENAME', (id, source, target) => respond(id, fs.rename(safe(source), safe(target))));
  stream.on('REMOVE', (id, remote) => respond(id, fs.unlink(safe(remote))));
  stream.on('RMDIR', (id, remote) => respond(id, fs.rmdir(safe(remote))));
  stream.on('SETSTAT', (id, remote, attrs) => respond(id, fs.chmod(safe(remote), attrs.mode)));
  stream.on('FSETSTAT', (id, handle, attrs) =>
    respond(id, handles.get(handle.readUInt32BE()).chmod(attrs.mode)));
  stream.on('FSTAT', (id, handle) => respond(id, handles.get(handle.readUInt32BE()).stat(),
    (value) => stream.attrs(id, {
      mode: value.mode,
      uid: 0,
      gid: 0,
      size: value.size,
      atime: Math.floor(value.atimeMs / 1000),
      mtime: Math.floor(value.mtimeMs / 1000),
    })));

  for (const event of ['STAT', 'LSTAT']) {
    stream.on(event, (id, remote) => respond(id, fs.lstat(safe(remote)), (stat) => stream.attrs(id, {
      mode: stat.mode,
      uid: 0,
      gid: 0,
      size: stat.size,
      atime: Math.floor(stat.atimeMs / 1000),
      mtime: Math.floor(stat.mtimeMs / 1000),
    })));
  }

  stream.on('REALPATH', (id, remote) => stream.name(id, [{
    filename: path.posix.resolve('/', remote),
    longname: remote,
    attrs: {},
  }]));
  stream.on('error', () => { });
  stream.on('close', () => {
    for (const file of handles.values()) {
      void file.close();
    }
  });
}

// Адаптеры представляют ОС VPS, а не успешный результат установки: production shell
// действительно создаёт ELF/env/unit и выполняет rollback в изолированной файловой системе.
const osAdapter = `
const fs = require('node:fs');
const command = process.argv[2];
const args = process.argv.slice(3);
const platform = JSON.parse(fs.readFileSync('/fixture/platform.json', 'utf8'));
const stateFile = '/fixture/var/lib/os-state.json';
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : { users: [], units: {} };
// Наблюдатель службы читает состояние параллельно с OS-командами.
// Переименование публикует целый снимок без окна между truncate и записью JSON.
const save = () => {
  const pending = stateFile + '.' + process.pid + '.tmp';

  fs.writeFileSync(pending, JSON.stringify(state));
  fs.renameSync(pending, stateFile);
};
const fail = () => process.exit(1);
fs.appendFileSync('/fixture/commands.log', JSON.stringify({ command, args }) + '\\n');
if (platform.pauseCommand && (platform.pauseCommand === command || args.includes(platform.pauseCommand))) {
  fs.writeFileSync('/fixture/barrier', command);
  while (!fs.existsSync('/fixture/release')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
if (command === 'uname') console.log(args.includes('-s') ? 'Linux' : platform.arch);
else if (command === 'getconf') console.log('glibc ' + platform.glibc);
else if (command === 'ldd') console.log(platform.missingLibrary
  ? platform.missingLibrary + ' => not found' : 'ldd (GNU libc) ' + platform.glibc);
else if (command === 'ldconfig') console.log(platform.missingLibrary ? '' :
  'libdl.so.2 libstdc++.so.6 libm.so.6 libgcc_s.so.1 libpthread.so.0 libc.so.6 ld-linux-x86-64.so.2');
else if (command === 'ss') console.log(platform.portBusy
  ? 'LISTEN 0 128 0.0.0.0:443 0.0.0.0:* users:(("relay",pid=777,fd=10))' : '');
else if (command === 'cut') {
  if (args.at(-1) === '/proc/777/cgroup') console.log(platform.listenerGroup || '/foreign');
  else {
    const child = require('node:child_process').spawnSync('/usr/bin/cut', args, { stdio: 'inherit' });
    process.exit(child.status || 0);
  }
}
else if (command === 'id') {
  if (args.includes('-u') && args.length === 1) console.log(platform.root ? '0' : '1000');
  else if (state.users.includes(args.at(-1))) console.log('uid=991 gid=991');
  else fail();
} else if (command === 'getent') {
  if (state.users.includes(args.at(-1))) {
    console.log(args.at(-1) + ':x:991:991::/nonexistent:/usr/sbin/nologin');
  }
  else fail();
} else if (command === 'useradd' || command === 'groupadd') {
  if (!state.users.includes(args.at(-1))) state.users.push(args.at(-1));
  save();
} else if (command === 'userdel' || command === 'groupdel') {
  // Настоящие Debian/Ubuntu всегда содержат userdel/groupdel: rollback обязан уметь уборку.
  state.users = state.users.filter((name) => name !== args.at(-1));
  save();
} else if (command === 'sudo') {
  if (platform.sudoDenied) fail();
  const child = require('node:child_process').spawnSync(args.filter(arg => arg !== '-n')[0],
    args.filter(arg => arg !== '-n').slice(1), { stdio: 'inherit' });
  process.exit(child.status || 0);
} else if (command === 'mv' || command === 'install') {
  if (platform.failCommand === command) fail();
  const child = require('node:child_process').spawnSync('/usr/bin/' + command, args, { stdio: 'inherit' });
  process.exit(child.status || 0);
} else if (command === 'systemctl') {
  if (!platform.systemd) fail();
  const unit = args.find(arg => arg.endsWith('.service')) || 'default';
  if (platform.failStop && args.includes('stop')) fail();
  if (platform.failCommand && args.includes(platform.failCommand)) fail();
  if (args.includes('--version')) { console.log('systemd 249'); process.exit(0); }
  if (unit === 'default') process.exit(0);
  if (args.includes('show')) {
    console.log(state.units[unit]?.active ? '/system.slice/' + unit : '');
    process.exit(0);
  }
  state.units[unit] ||= { active: false, enabled: false };
  if (args.includes('is-active')) { console.log(state.units[unit].active ? 'active' : 'inactive');
    process.exit(state.units[unit].active ? 0 : 3); }
  if (args.includes('is-enabled')) { console.log(state.units[unit].enabled ? 'enabled' : 'disabled');
    process.exit(state.units[unit].enabled ? 0 : 1); }
  if (args.includes('restart') || args.includes('start') && !state.units[unit].active) {
    state.generations ||= {};
    state.generations[unit] = (state.generations[unit] || 0) + 1;
    state.units[unit].active = true;
  }
  if (args.includes('stop')) state.units[unit].active = false;
  if (args.includes('enable')) state.units[unit].enabled = true;
  if (args.includes('disable')) state.units[unit].enabled = false;
  save();
}
`;
