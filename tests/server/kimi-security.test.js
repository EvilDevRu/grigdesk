import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { stageKimiAttachments } from '../../server/src/lib/kimi/attachments.ts';
import { assertKimiRuntimeEnv, buildKimiRuntimeEnv } from '../../server/src/lib/kimi/env.ts';
import {
  assertResolvedEgressAddresses,
  isBlockedEgressIp,
  validateEgressTarget,
} from '../../server/src/lib/kimi/egressPolicy.ts';
import {
  assertUnixSocketPath,
  createKimiEgressProxy,
  MAX_UNIX_SOCKET_PATH_BYTES,
  parseConnectTarget,
} from '../../server/src/lib/kimi/egressProxy.ts';
import {
  cgroupPathFromProc,
  inspectKimiRuntimeHost,
} from '../../server/src/lib/kimi/runtimePreflight.ts';
import {
  buildKimiSandboxLaunch,
  KIMI_EGRESS_SOCKET_FILE,
  KIMI_SANDBOX_NODE,
  KIMI_SANDBOX_WORK_MCP,
  resolveVisibleProjectRoot,
  WORKSPACE_LOCAL_TOML_FILE,
  WORKSPACE_MASK_DIR,
} from '../../server/src/lib/kimi/sandbox.ts';

async function attachmentFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-kimi-attachments-'));
  const allowed = path.join(root, 'allowed');
  const staging = path.join(root, 'staging');
  const outside = path.join(root, 'outside');
  await Promise.all([allowed, staging, outside].map((dir) => fs.mkdir(dir)));
  t.after(async () => {
    // Успешный staging намеренно 0500; test-fixture возвращает write bit до
    // рекурсивной уборки корня независимо от порядка after hooks.
    for (const entry of await fs.readdir(staging).catch(() => [])) {
      await fs.chmod(path.join(staging, entry), 0o700).catch(() => {});
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, allowed, staging, outside };
}

test('attachment staging копирует только перечисленные regular files и становится read-only', async (t) => {
  const fixture = await attachmentFixture(t);
  const source = path.join(fixture.allowed, 'note.txt');
  await fs.writeFile(source, 'allowed');
  await fs.writeFile(path.join(fixture.allowed, 'not-listed.txt'), 'secret');
  const staged = await stageKimiAttachments({
    allowedRoot: fixture.allowed,
    stagingParent: fixture.staging,
    manifest: [{ id: 'one', sourcePath: source, name: 'note.txt' }],
  });
  t.after(staged.cleanup);
  assert.deepEqual(staged.files, [{ id: 'one', filename: '000-note.txt', sandboxPath: '/attachments/000-note.txt', size: 7 }]);
  assert.equal(await fs.readFile(path.join(staged.stagingDir, '000-note.txt'), 'utf8'), 'allowed');
  assert.equal((await fs.stat(staged.stagingDir)).mode & 0o777, 0o500);
  await assert.rejects(fs.access(path.join(staged.stagingDir, 'not-listed.txt')));
});

test('attachment boundary отклоняет outside-root, symlink, directory, traversal name и limits', async (t) => {
  const fixture = await attachmentFixture(t);
  const inside = path.join(fixture.allowed, 'inside.txt');
  const outside = path.join(fixture.outside, 'outside.txt');
  const link = path.join(fixture.allowed, 'link.txt');
  await fs.writeFile(inside, '12345');
  await fs.writeFile(outside, 'outside');
  await fs.symlink(outside, link);

  const run = (item, limits) => stageKimiAttachments({
    allowedRoot: fixture.allowed,
    stagingParent: fixture.staging,
    manifest: [item],
    limits,
  });
  await assert.rejects(run({ id: 'outside', sourcePath: outside }), { code: 'attachment_outside_root' });
  await assert.rejects(run({ id: 'link', sourcePath: link }), { code: 'attachment_symlink' });
  await assert.rejects(run({ id: 'dir', sourcePath: fixture.allowed }), { code: 'attachment_not_regular' });
  await assert.rejects(run({ id: 'name', sourcePath: inside, name: '../escape' }), { code: 'invalid_attachment_name' });
  await assert.rejects(run({ id: 'large', sourcePath: inside }, { maxFileBytes: 4 }), { code: 'attachment_file_limit' });
});

test('runtime env не наследует host credentials и proxy требует отдельной границы', () => {
  const env = buildKimiRuntimeEnv();
  assertKimiRuntimeEnv(env);
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'KIMI_API_KEY', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'NPM_TOKEN']) {
    assert.equal(key in env, false, key);
  }
  assert.throws(() => assertKimiRuntimeEnv({ ...env, OPENAI_API_KEY: 'secret' }), /forbidden_env/);
  assert.throws(() => assertKimiRuntimeEnv({ ...env, HTTPS_PROXY: 'http:\/\/proxy' }), /proxy_env_without/);
});

test('egress policy отклоняет IP literals, localhost/LAN/metadata и non-allowlisted redirects', () => {
  const options = { allowedHosts: ['api.kimi.example'], allowedPorts: [443] };
  assert.equal(validateEgressTarget('https://api.kimi.example/v1', options).host, 'api.kimi.example');
  for (const target of [
    'https://127.0.0.1/',
    'https://169.254.169.254/latest/meta-data',
    'https://localhost/',
    'https://other.example/',
    'http://api.kimi.example/',
  ]) assert.throws(() => validateEgressTarget(target, options));
  for (const address of [
    '127.0.0.1', '10.0.0.1', '100.64.0.1', '172.16.0.1', '192.168.1.1',
    '169.254.169.254', '198.18.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1',
  ]) {
    assert.equal(isBlockedEgressIp(address), true, address);
  }
  assert.throws(() => assertResolvedEgressAddresses(['203.0.113.2', '127.0.0.1']), /forbidden/);
});

test('CONNECT proxy допускает только точный host:443', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-kimi-proxy-'));
  const upstream = net.createServer((socket) => socket.pipe(socket));
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  const proxy = createKimiEgressProxy({
    socketPath: path.join(root, 'proxy.sock'),
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    connector: () => net.createConnection({ host: '127.0.0.1', port: upstreamPort }),
  });
  await proxy.start();
  t.after(async () => {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const request = (authority) => new Promise((resolve, reject) => {
    const socket = net.createConnection(proxy.socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    socket.on('data', (chunk) => {
      response += chunk;
      if (response.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(response);
      }
    });
    socket.once('error', reject);
  });
  assert.match(await request('api.kimi.com:443'), /^HTTP\/1\.1 200/);
  assert.match(await request('example.com:443'), /^HTTP\/1\.1 403/);
  assert.match(await request('api.kimi.com:80'), /^HTTP\/1\.1 403/);
  assert.throws(() => parseConnectTarget('GET https://api.kimi.com/ HTTP/1.1'), /proxy_connect_required/);
});

test('слишком длинный Unix socket path отклоняется до неясного EADDRINUSE', () => {
  const valid = `/${'a'.repeat(MAX_UNIX_SOCKET_PATH_BYTES - 1)}`;
  assert.equal(Buffer.byteLength(valid), MAX_UNIX_SOCKET_PATH_BYTES);
  assert.equal(assertUnixSocketPath(valid), valid);
  assert.throws(
    () => assertUnixSocketPath(`${valid}b`, 'control_socket'),
    /control_socket_path_too_long/,
  );
});

test('KS-DH sandbox закрывает control state и хранит trusted assets вне KIMI home', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-kimi-sandbox-'));
  const workspace = path.join(root, 'workspace');
  const safeExtra = path.join(root, 'safe-extra');
  const chatsDir = path.join(root, 'chats');
  const hostHome = path.join(root, 'host-home', '.kimi-code');
  const binDir = path.join(root, 'bin');
  const profile = path.join(root, 'state', 'chats', 'hash');
  const broker = path.join(root, 'state', 'broker');
  const egressDir = path.join(root, 'egress');
  await Promise.all([
    workspace, safeExtra, chatsDir, path.join(hostHome, 'credentials'), binDir,
    profile, broker, egressDir,
  ].map((dir) => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
  const kimiBin = path.join(binDir, 'kimi');
  await fs.writeFile(kimiBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(hostHome, 'credentials', 'kimi-code.json'), 'не читать', { mode: 0o600 });
  const proxy = createKimiEgressProxy({
    socketPath: path.join(egressDir, KIMI_EGRESS_SOCKET_FILE),
  });
  await proxy.start();
  t.after(async () => {
    await proxy.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const config = {
    kimiRuntimeHome: profile,
    kimiRuntimeBroker: broker,
    kimiBin,
    kimiHome: hostHome,
    chatsDir,
    chatBindingsDir: path.join(chatsDir, '.bindings'),
    rootDir: path.join(root, 'repo'),
    kimiBwrapBin: '/usr/bin/bwrap',
    kimiSystemdRunBin: '/usr/bin/systemd-run',
    kimiCaBundle: '/etc/ssl/certs/ca-certificates.crt',
  };

  config.dataHome = path.join(root, 'data');
  config.envPath = path.join(config.dataHome, '.env');
  await fs.mkdir(path.join(config.dataHome, 'state'), { recursive: true });
  await fs.writeFile(config.envPath, 'FAKE=1');

  const envFile = path.join(config.rootDir, '.env');
  await fs.mkdir(path.join(config.rootDir, 'server', '.state'), { recursive: true });
  await fs.writeFile(envFile, 'SECRET=1\n', { mode: 0o600 });
  const launch = await buildKimiSandboxLaunch({
    config,
    cwd: workspace,
    // Корень содержит chats/runtime/credentials: он больше не отбрасывается, а
    // монтируется с масками поверх control state. Сам control state (chatsDir)
    // как отдельный extra по-прежнему отклоняется — после масок он пуст.
    extraDirs: [root, safeExtra, chatsDir],
    egressSocketPath: proxy.socketPath,
    unit: 'grigdesk-kimi-test.service',
  });
  const pairs = launch.args.slice(0, -1).map((value, index) => [value, launch.args[index + 1]]);
  assert.equal(pairs.some(([a, b]) => a === '--ro-bind' && b === '/'), false);
  assert.equal(pairs.some(([a, b]) => a === '--bind' && b === '/'), false);
  assert.ok(launch.args.includes('--unshare-all'));
  assert.ok(launch.args.includes('CAP_SYS_ADMIN'));
  assert.ok(launch.args.includes('CAP_SETPCAP'));
  assert.ok(pairs.some(([a, b]) => a === profile && b === '/kimi-home'));
  assert.equal(pairs.some(([a, b]) => a === broker && b === '/kimi-home'), false);
  assert.ok(launch.args.some((value) => value.startsWith(path.join(broker, 'scripts'))));
  const wrapper = await fs.readFile(path.join(broker, 'scripts', 'run-kimi'), 'utf8');
  assert.match(wrapper, /UNIX-CONNECT:\/run\/grigdesk-egress\/e\.sock/);
  assert.doesNotMatch(wrapper, /UNIX-CONNECT:\/run\/grigdesk-egress\/proxy\.sock/);
  assert.equal(launch.args.includes(path.join(hostHome, 'config.toml')), false);
  assert.deepEqual(launch.rejectedExtraDirs, [{
    path: chatsDir,
    reason: 'kimi_workspace_mount_is_control_state',
  }]);
  // Широкий доверенный корень смонтирован, control state внутри — под пустыми ro-масками.
  assert.ok(pairs.some(([a, b]) => a === '--bind' && b === root));
  assert.ok(pairs.some(([a, b]) => a === '--bind' && b === safeExtra));
  const emptyDir = path.join(broker, 'empty', 'agents');
  const roMaskOver = (source, destination) => launch.args.some((value, index) => value === '--ro-bind'
    && launch.args[index + 1] === source && launch.args[index + 2] === destination);

  for (const masked of [
    config.dataHome,
    path.join(root, 'state'),
    chatsDir,
    hostHome,
    path.join(config.rootDir, 'server', '.state'),
  ]) {
    assert.ok(roMaskOver(emptyDir, masked), `ожидалась маска поверх ${masked}`);
  }
  assert.ok(roMaskOver(path.join(broker, 'empty', 'EMPTY'), envFile), 'ожидалась file-маска поверх .env');
  assert.ok(launch.maskedWorkspacePaths.includes(chatsDir));
  assert.ok(launch.maskedWorkspacePaths.includes(envFile));
  assert.equal(launch.maskedWorkspacePaths.includes(config.envPath), false);

  const buildAgain = () => buildKimiSandboxLaunch({
    config,
    cwd: workspace,
    extraDirs: [root, safeExtra, chatsDir],
    egressSocketPath: proxy.socketPath,
    unit: 'grigdesk-kimi-test.service',
  });

  config.envPath = path.join(root, 'outside.env');
  await fs.writeFile(config.envPath, 'FAKE=1');
  assert.ok((await buildAgain()).maskedWorkspacePaths.includes(config.envPath));
  await fs.rename(envFile, envFile + '.original');
  await fs.rename(path.join(config.rootDir, 'server/.state'), path.join(root, 'old-state'));
  await fs.symlink(path.join(config.dataHome, '.env'), envFile);
  await fs.symlink(path.join(config.dataHome, 'state'), path.join(config.rootDir, 'server/.state'));

  const linked = await buildAgain();

  assert.equal(linked.maskedWorkspacePaths.includes(envFile), false);
  assert.equal(linked.maskedWorkspacePaths.includes(path.join(config.rootDir, 'server/.state')), false);
  // Parity с codex --add-dir: дополнительные каталоги объявляются сессии
  // через server-owned local.toml внутри per-run каталога-маски, который заменяет
  // <projectRoot>/.kimi-code целиком (workspace без .git → projectRoot = cwd).
  const maskDir = path.join(egressDir, WORKSPACE_MASK_DIR);
  assert.ok(pairs.some(([a, b]) => a === maskDir && b === path.join(workspace, '.kimi-code')));
  const localToml = await fs.readFile(path.join(maskDir, WORKSPACE_LOCAL_TOML_FILE), 'utf8');
  assert.match(localToml, /\[workspace]/);
  assert.ok(localToml.includes(JSON.stringify(safeExtra)));
  assert.ok(localToml.includes(JSON.stringify(root)));
  assert.ok(!localToml.includes(JSON.stringify(chatsDir)));
  // Без дополнительных каталогов маска остаётся общей пустой, local.toml не создаётся.
  const plainLaunch = await buildKimiSandboxLaunch({
    config,
    cwd: workspace,
    egressSocketPath: proxy.socketPath,
    unit: 'grigdesk-kimi-plain.service',
  });
  const plainPairs = plainLaunch.args.slice(0, -1).map((value, index) => [value, plainLaunch.args[index + 1]]);
  assert.ok(plainPairs.some(([a, b]) => a === path.join(broker, 'empty', 'agents') && b === path.join(workspace, '.kimi-code')));
  assert.equal(plainPairs.some(([a]) => a === maskDir), false);
  const webControl = path.join(egressDir, 'c');
  const webMcp = path.join(egressDir, 'mcp.json');
  await fs.mkdir(webControl, { recursive: true });
  await fs.writeFile(webMcp, '{"mcpServers":{}}', { mode: 0o600 });
  const webLaunch = await buildKimiSandboxLaunch({
    config,
    cwd: workspace,
    egressSocketPath: proxy.socketPath,
    serverControlDir: webControl,
    serverMcpFile: webMcp,
    unit: 'grigdesk-kimi-web.service',
  });
  assert.ok(webLaunch.args.some((value, index) => value === '--bind'
    && webLaunch.args[index + 1] === webControl
    && webLaunch.args[index + 2] === '/run/grigdesk-control'));
  assert.ok(webLaunch.args.some((value, index) => value === '--ro-bind'
    && webLaunch.args[index + 1] === webMcp
    && webLaunch.args[index + 2] === '/kimi-home/mcp.json'));
  assert.deepEqual(webLaunch.args.slice(-6), [
    'web', '--port', '58627', '--host', '127.0.0.1', '--no-open',
  ]);
  assert.match(wrapper, /UNIX-LISTEN:\/run\/grigdesk-control\/s/);
  // Доверенный предок cwd с .git становится projectRoot kimi: маска с local.toml
  // подменяет .kimi-code предка (проектный local.toml предка в sandbox не виден),
  // а собственный .kimi-code cwd прячется за общей пустой маской.
  const ancestor = path.join(root, 'ancestor');
  const nestedCwd = path.join(ancestor, 'sub', 'cwd');
  await fs.mkdir(path.join(ancestor, '.git'), { recursive: true });
  await fs.mkdir(nestedCwd, { recursive: true });
  const nestedLaunch = await buildKimiSandboxLaunch({
    config,
    cwd: nestedCwd,
    extraDirs: [ancestor],
    egressSocketPath: proxy.socketPath,
    unit: 'grigdesk-kimi-nested.service',
  });
  const nestedPairs = nestedLaunch.args.slice(0, -1).map((value, index) => [value, nestedLaunch.args[index + 1]]);
  assert.ok(nestedPairs.some(([a, b]) => a === maskDir && b === path.join(ancestor, '.kimi-code')));
  assert.ok(nestedPairs.some(([a, b]) => a === path.join(broker, 'empty', 'agents') && b === path.join(nestedCwd, '.kimi-code')));
  const nestedToml = await fs.readFile(path.join(maskDir, WORKSPACE_LOCAL_TOML_FILE), 'utf8');
  assert.ok(nestedToml.includes(JSON.stringify(ancestor)));
  await assert.rejects(buildKimiSandboxLaunch({
    config,
    cwd: path.join(root, 'host-home'),
    egressSocketPath: proxy.socketPath,
    unit: 'grigdesk-kimi-broad.service',
  }), /kimi_workspace_mount_contains_control_state/);
});

test('рабочий MCP получает Node самого GrigDesk, а не хостовый /usr/bin/node', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-kimi-worknode-'));
  const workspace = path.join(root, 'workspace');
  const chatsDir = path.join(root, 'chats');
  const hostHome = path.join(root, 'host-home', '.kimi-code');
  const binDir = path.join(root, 'bin');
  const profile = path.join(root, 'state', 'chats', 'hash');
  const broker = path.join(root, 'state', 'broker');
  const egressDir = path.join(root, 'egress');
  const workDir = path.join(root, 'work');
  await Promise.all([
    workspace, chatsDir, path.join(hostHome, 'credentials'), binDir, profile, broker,
    egressDir, workDir,
  ].map((dir) => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
  const kimiBin = path.join(binDir, 'kimi');
  await fs.writeFile(kimiBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(hostHome, 'credentials', 'kimi-code.json'), 'не читать', { mode: 0o600 });
  const scriptPath = path.join(root, 'work-mcp.js');
  await fs.writeFile(scriptPath, '// bridge\n', { mode: 0o600 });

  const proxy = createKimiEgressProxy({
    socketPath: path.join(egressDir, KIMI_EGRESS_SOCKET_FILE),
  });
  await proxy.start();
  const workSocketPath = path.join(workDir, 'work.sock');
  const workServer = net.createServer();
  await new Promise((resolve) => { workServer.listen(workSocketPath, resolve); });
  t.after(async () => {
    await new Promise((resolve) => { workServer.close(resolve); });
    await proxy.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const launch = await buildKimiSandboxLaunch({
    config: {
      kimiRuntimeHome: profile,
      kimiRuntimeBroker: broker,
      kimiBin,
      kimiHome: hostHome,
      chatsDir,
      chatBindingsDir: path.join(chatsDir, '.bindings'),
      rootDir: path.join(root, 'repo'),
      kimiBwrapBin: '/usr/bin/bwrap',
      kimiSystemdRunBin: '/usr/bin/systemd-run',
      kimiCaBundle: '/etc/ssl/certs/ca-certificates.crt',
    },
    cwd: workspace,
    egressSocketPath: proxy.socketPath,
    workMcp: { socketPath: workSocketPath, scriptPath },
    unit: 'grigdesk-kimi-worknode.service',
  });

  const roBind = (source, destination) => launch.args.some((value, index) => value === '--ro-bind'
    && launch.args[index + 1] === source && launch.args[index + 2] === destination);
  assert.ok(roBind(await fs.realpath(scriptPath), KIMI_SANDBOX_WORK_MCP));
  // Именно исполняемый файл текущего процесса: хостового /usr/bin/node может не быть.
  assert.ok(roBind(await fs.realpath(process.execPath), KIMI_SANDBOX_NODE));
  assert.equal(launch.args.includes('/usr/bin/node'), false);
  // Снятие типов встроено в Node 22.18+: флагов в argv песочницы быть не должно.
  assert.equal(launch.args.some((value) => /strip-types|transform-types/.test(value)), false);
});

test('resolveVisibleProjectRoot повторяет findProjectRoot kimi по видимым каталогам', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-kimi-proot-'));
  const cwd = path.join(root, 'cwd');
  const ancestor = path.join(root, 'ancestor');
  const nested = path.join(ancestor, 'deep', 'cwd');
  await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
  await fs.mkdir(path.join(ancestor, '.git'), { recursive: true });
  await fs.mkdir(nested, { recursive: true });
  try {
    // .git в самом cwd wins независимо от extras.
    assert.equal(await resolveVisibleProjectRoot(cwd, [ancestor]), cwd);
    // Без .git в cwd берётся ближайший видимый предок с .git.
    assert.equal(await resolveVisibleProjectRoot(nested, [ancestor, root]), ancestor);
    // Нет видимого .git — fallback на cwd, как у kimi внутри sandbox.
    const plain = path.join(root, 'plain');
    await fs.mkdir(plain);
    assert.equal(await resolveVisibleProjectRoot(plain, []), plain);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runtime preflight fail closed: каждый обязательный gate влияет на решение', async () => {
  const yesRunner = async () => ({ stdout: 'bubblewrap 0.6.1\n', stderr: '' });
  const readFile = async (file) => {
    if (file === '/proc/self/cgroup') return '0::/delegated\n';
    if (file.endsWith('cgroup.controllers')) return 'cpu memory pids\n';
    throw new Error(file);
  };
  const access = async () => {};
  const base = {
    bubblewrap: { runner: yesRunner },
    cgroup: { readFile, access },
    egress: {},
  };
  const noEgress = await inspectKimiRuntimeHost(base);
  assert.equal(noEgress.decision, 'NO_GO');
  assert.equal(noEgress.checks.egressProxy.reason, 'egress_proxy_not_configured');
  assert.equal(cgroupPathFromProc('0::/delegated\n'), '/sys/fs/cgroup/delegated');
});
