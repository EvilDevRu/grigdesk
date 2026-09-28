import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { assertKimiRuntimeEnv, buildKimiRuntimeEnv } from './env.ts';
import { assertUnixSocketPath } from './egressProxy.ts';
import { ensureContainedKimiHome } from './profile.ts';

const execFileAsync = promisify(execFile);
const CREDENTIAL_FILE = 'kimi-code.json';
// Имя является частью границы между host proxy и bridge внутри net namespace.
// Оно намеренно короткое из-за лимита Linux sun_path и обязано совпадать с runtime.js.
export const KIMI_EGRESS_SOCKET_FILE = 'e.sock';

export const KIMI_SYSTEMD_LIMITS = Object.freeze({
  cpuQuota: '200%',
  memoryMax: '2147483648',
  tasksMax: '256',
  runtimeMax: '2h',
});

// `kimi acp` не принимает --add-dir (флаг есть только у TUI/`kimi -p`,
// registerAcpCommand его игнорирует), а ACP session/new не несёт additionalDirs —
// сессия читает дополнительные каталоги из <projectRoot>/.kimi-code/local.toml
// ([workspace] additional_dir). Поэтому на ход собирается per-run каталог-маска
// с одним server-owned local.toml, который подменяет <projectRoot>/.kimi-code целиком.
const WORKSPACE_MASK_DIR = 'workspace-mask';
const WORKSPACE_LOCAL_TOML_FILE = 'local.toml';

/**
 * Содержимое local.toml строится только из canonicalExtras (прошли boundary gate),
 * поэтому отклонённые каталоги сюда никогда не попадают. Проектный local.toml в
 * sandbox не виден: маска подменяет весь .kimi-code, а не подкладывается в него —
 * подменить содержимое проект не может.
 */
// Пути и бинари contained-профиля. Все поля приходят из config сервера, поэтому
// объявлено ровно то, что читает сборка запуска.
// Пути внутри песочницы: их знают и сборка монтирований, и объявление MCP-сервера
// сессии — иначе две копии литерала разъезжаются молча.
export const KIMI_SANDBOX_WORK_MCP = '/opt/cockpit/work-mcp.js';
export const KIMI_SANDBOX_NODE = '/opt/cockpit/node';
export const KIMI_SANDBOX_WORK_SOCKET = '/run/cockpit-work/work.sock';

export interface KimiSandboxConfig {
  kimiHome: string;
  kimiRuntimeHome: string;
  kimiRuntimeBroker?: string;
  kimiBin: string;
  kimiCaBundle?: string;
  kimiBwrapBin?: string;
  kimiSystemdRunBin?: string;
  chatsDir?: string;
  chatBindingsDir?: string;
  stateDir?: string;
  factoryControlDir?: string;
  rootDir?: string;
}

function buildWorkspaceLocalToml(extraDirs: readonly unknown[]): string {
  return `${[
    '# Сгенерировано Cockpit из дополнительных рабочих копий чата',
    '# и дополнительные worktree задачи). Не редактировать: пересоздаётся на каждый ход.',
    '[workspace]',
    `additional_dir = [${extraDirs.map((dir) => JSON.stringify(String(dir))).join(', ')}]`,
    '',
  ].join('\n')}`;
}

async function hasGitMarker(dir: string): Promise<boolean> {
  return !!(await fs.lstat(path.join(dir, '.git')).catch(() => null));
}

/**
 * Повторяет findProjectRoot самого kimi, но только по видимым в sandbox каталогам:
 * .git ищется от cwd вверх, а видимы там лишь сам cwd и extras-предки (их bind
 * приносит содержимое, включая .git); промежуточные --dir пусты. Без видимого
 * .git kimi останавливается на самом cwd. Если projectRoot — доверенный предок,
 * маска на его .kimi-code заодно закрывает проектный local.toml предка, который
 * иначе читался бы напрямую и мог объявить workspace-ом, например, /kimi-home.
 */
async function resolveVisibleProjectRoot(
  cwdReal: string,
  canonicalExtras: readonly string[],
): Promise<string> {
  if (await hasGitMarker(cwdReal)) return cwdReal;
  const ancestors = canonicalExtras
    .filter((real) => real !== cwdReal && isWithin(real, cwdReal))
    .sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  for (const dir of ancestors) {
    if (await hasGitMarker(dir)) return dir;
  }
  return cwdReal;
}

const WRAPPER_SCRIPT = `#!/bin/sh
set -eu
umask 077
/usr/sbin/ip link set lo up
/usr/bin/setpriv --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all -- \
  /usr/bin/socat TCP-LISTEN:3128,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/cockpit-egress/${KIMI_EGRESS_SOCKET_FILE} &
bridge=$!
cleanup() {
  kill "$bridge" 2>/dev/null || true
  wait "$bridge" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM
/usr/bin/setpriv --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all -- \
  /opt/kimi/bin/kimi acp
`;

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function assertPrivateCredentialDir(
  kimiHome: unknown,
): Promise<{ credentialDir: string; credentialPath: string }> {
  const homeReal = await fs.realpath(String(kimiHome));
  const credentialDir = path.join(homeReal, 'credentials');
  const credentialPath = path.join(credentialDir, CREDENTIAL_FILE);
  const [dirInfo, fileInfo] = await Promise.all([fs.lstat(credentialDir), fs.lstat(credentialPath)]);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) throw new Error('kimi_credentials_dir_invalid');
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error('kimi_credentials_file_invalid');
  if (!isWithin(homeReal, await fs.realpath(credentialPath))) throw new Error('kimi_credentials_outside_home');
  if (typeof process.getuid === 'function' && (dirInfo.uid !== process.getuid() || fileInfo.uid !== process.getuid())) {
    throw new Error('kimi_credentials_wrong_owner');
  }
  if ((fileInfo.mode & 0o077) !== 0) throw new Error('kimi_credentials_permissions_too_open');
  return { credentialDir, credentialPath };
}

async function assertExecutable(file: unknown, code: string): Promise<string> {
  const real = await fs.realpath(String(file));
  const info = await fs.lstat(real);
  if (!info.isFile() || info.isSymbolicLink() || !(info.mode & 0o111)) throw new Error(code);
  return real;
}

async function atomicExecutable(file: string, content: string): Promise<void> {
  let current: string | null = null;
  try { current = await fs.readFile(file, 'utf8'); } catch { /* первый запуск */ }
  if (current !== content) {
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, content, { mode: 0o500 });
    await fs.rename(temporary, file);
  }
  await fs.chmod(file, 0o500);
}

async function ensureScripts(runtimeHome: string): Promise<{ wrapperPath: string }> {
  const scriptsDir = path.join(runtimeHome, 'scripts');
  await fs.mkdir(scriptsDir, { recursive: true, mode: 0o700 });
  const wrapperPath = path.join(scriptsDir, 'run-kimi');
  await atomicExecutable(wrapperPath, WRAPPER_SCRIPT);
  return { wrapperPath };
}

function parentDirs(target: string): string[] {
  const result: string[] = [];
  let current = path.dirname(target);
  while (current !== '/') {
    result.push(current);
    current = path.dirname(current);
  }
  return result.reverse();
}

function addMount(
  args: string[],
  kind: string,
  source: string,
  destination: string,
  madeDirs: Set<string>,
): void {
  for (const dir of parentDirs(destination)) {
    if (madeDirs.has(dir)) continue;
    args.push('--dir', dir);
    madeDirs.add(dir);
  }
  args.push(kind, source, destination);
  madeDirs.add(destination);
}

async function canonicalDirectory(candidate: unknown, label: string): Promise<string> {
  // Отсутствующий путь и «файл вместо каталога» — один и тот же отказ и должны
  // называться одинаково: сырой ENOENT из realpath уезжал наружу мимо именованных
  // причин, и вызывающий не мог отличить битый cwd от поломки рантайма.
  let real: string;
  try {
    real = await fs.realpath(String(candidate));
  } catch (error) {
    throw new Error(`${label}_not_directory`, { cause: error });
  }
  if (!(await fs.stat(real)).isDirectory()) throw new Error(`${label}_not_directory`);
  return real;
}

/**
 * Server-owned control state: OAuth credentials, чужие токены (server/.state),
 * история чатов и session bindings, runtime/broker contained-профиля, control/state
 * каталоги маршрутов, .env репозитория. Эти пути нельзя отдавать в mount namespace
 * даже внутри доверенного каталога: прочитанное моделью попадает в контекст (а это
 * prompt к API), writable wrapper скриптов — инъекция в механику sandbox.
 */
function workspaceControlStatePaths(
  config: KimiSandboxConfig,
): { dirs: string[]; files: string[] } {
  const dirs = [
    config.kimiHome,
    config.kimiRuntimeHome,
    config.kimiRuntimeBroker,
    config.kimiRuntimeBroker ? path.dirname(config.kimiRuntimeBroker) : null,
    config.chatsDir,
    config.chatBindingsDir,
    config.stateDir,
    config.factoryControlDir,
    config.rootDir ? path.join(config.rootDir, 'server', '.state') : null,
  ].filter((value): value is string => Boolean(value)).map((value) => path.resolve(value));
  // Вложенные пути (chats/.bindings, broker внутри runtime home, runtime home
  // внутри factory state) маскирует ближайший перечисленный предок.
  const topLevel = dirs.filter((dir) => !dirs.some((other) => other !== dir && isWithin(other, dir)));
  const files = config.rootDir ? [path.join(config.rootDir, '.env')] : [];
  return { dirs: topLevel, files };
}

function workspaceMountBoundaryError(
  candidate: string,
  config: KimiSandboxConfig,
  { maskControlState = false } = {},
): string | null {
  const forbiddenRoots = ['/proc', '/sys', '/dev', '/run', '/etc', '/usr', '/var', '/tmp'];
  if (candidate === '/' || forbiddenRoots.some((root) => candidate === root)) {
    return 'kimi_workspace_mount_too_broad';
  }
  const { dirs } = workspaceControlStatePaths(config);
  if (dirs.some((secret) => isWithin(secret, candidate))) {
    // Сам control state (или его часть) монтировать бессмысленно: после масок
    // полезного содержимого там всё равно не останется.
    return 'kimi_workspace_mount_is_control_state';
  }
  if (!maskControlState && dirs.some((secret) => isWithin(candidate, secret))) {
    return 'kimi_workspace_mount_contains_control_state';
  }
  return null;
}

/**
 * Control-state пути, попавшие внутрь смонтированных extras. Широкий доверенный
 * каталог (например, родитель репозитория cockpit) не отклоняется: он монтируется
 * целиком, а эти пути прячутся пустым read-only mount-ом поверх.
 */
function workspaceControlStateMasks(
  canonicalExtras: readonly string[],
  config: KimiSandboxConfig,
): { dirs: string[]; files: string[] } {
  if (!canonicalExtras.length) return { dirs: [], files: [] };
  const { dirs, files } = workspaceControlStatePaths(config);
  const within = (target: string) => canonicalExtras.some((extra) => isWithin(extra, target));
  return { dirs: dirs.filter(within), files: files.filter(within) };
}

/**
 * Предпросмотр применяет те же запреты, что построение mount namespace.
 * Проверка ничего не монтирует и не создаёт runtime-каталоги исполнителя.
 */
export function validateKimiWorkdir({ config, cwd, extraDirs }: {
  config: KimiSandboxConfig;
  cwd: string;
  extraDirs: string[];
}) {
  const error = workspaceMountBoundaryError(cwd, config);
  const reasons: Record<string, string> = {
    kimi_workspace_mount_too_broad: 'Слишком широкий системный каталог для рабочей папки Kimi.',
    kimi_workspace_mount_is_control_state: 'Каталог содержит служебное состояние Кокпита.',
    kimi_workspace_mount_contains_control_state: 'Рабочая папка включает служебное состояние Кокпита.',
  };
  const rejected: Array<{ path: string; reason: string; }> = [];
  const accepted: string[] = [];

  for (const dir of extraDirs) {
    const reason = workspaceMountBoundaryError(dir, config, { maskControlState: true });

    if (reason) {
      rejected.push({ path: dir, reason: reasons[reason] || reason });
    } else if (dir !== cwd && !isWithin(cwd, dir)) {
      accepted.push(dir);
    }
  }

  return {
    ...(error ? { error: reasons[error] || error } : {}),
    extraDirs: accepted,
    rejected,
  };
}

function assertWorkspaceMountBoundary(candidate: string, config: KimiSandboxConfig): void {
  const reason = workspaceMountBoundaryError(candidate, config);
  if (reason) throw new Error(reason);
}

/**
 * Строит fail-closed запуск: отдельные mount/pid/net namespaces, пустой root,
 * только явные рабочие каталоги и два Unix-сокета как host boundary.
 */
export async function buildKimiSandboxLaunch({
  config,
  cwd,
  extraDirs = [],
  attachmentDir,
  egressSocketPath,
  workMcp = null,
  unit = `cockpit-kimi-${randomUUID()}.service`,
}: {
  config: KimiSandboxConfig;
  cwd: unknown;
  extraDirs?: readonly unknown[];
  attachmentDir?: string;
  egressSocketPath: string;
  workMcp?: { socketPath: string; scriptPath: string } | null;
  unit?: string;
}) {
  await fs.mkdir(config.kimiRuntimeHome, { recursive: true, mode: 0o700 });
  const runtimeHome = await canonicalDirectory(config.kimiRuntimeHome, 'kimi_runtime_home');
  const cwdReal = await canonicalDirectory(cwd, 'kimi_cwd');
  assertWorkspaceMountBoundary(cwdReal, config);
  const kimiBin = await assertExecutable(config.kimiBin, 'kimi_bin_invalid');
  const siblingFd = path.join(path.dirname(kimiBin), 'fd');
  const fdBin = await assertExecutable(siblingFd, 'kimi_fd_invalid').catch(() => null);
  const { credentialDir } = await assertPrivateCredentialDir(config.kimiHome);
  if (config.kimiRuntimeBroker) await fs.mkdir(config.kimiRuntimeBroker, { recursive: true, mode: 0o700 });
  const brokerHome = config.kimiRuntimeBroker
    ? await canonicalDirectory(config.kimiRuntimeBroker, 'kimi_runtime_broker')
    : runtimeHome;
  const home = await ensureContainedKimiHome(runtimeHome, { trustedHome: brokerHome });
  const scripts = await ensureScripts(brokerHome);
  assertUnixSocketPath(egressSocketPath, 'egress_socket');
  const egressSocketReal = await fs.realpath(egressSocketPath);
  if (!(await fs.lstat(egressSocketReal)).isSocket()) throw new Error('kimi_egress_socket_invalid');
  if (path.basename(egressSocketReal) !== KIMI_EGRESS_SOCKET_FILE) {
    throw new Error('kimi_egress_socket_name_mismatch');
  }
  const egressDir = path.dirname(egressSocketReal);
  let workSocketDir = '';
  let workScript = '';
  let workNodeBin = '';
  if (workMcp) {
    const workSocket = await fs.realpath(workMcp.socketPath);
    if (!(await fs.lstat(workSocket)).isSocket()) throw new Error('kimi_work_socket_invalid');
    workSocketDir = path.dirname(workSocket);
    workScript = await fs.realpath(workMcp.scriptPath);
    if (!(await fs.lstat(workScript)).isFile()) throw new Error('kimi_work_mcp_invalid');
    // Рабочий MCP исполняет Node САМОГО кокпита. Хостовый /usr смонтирован read-only,
    // и `/usr/bin/node` в нём может отсутствовать вовсе (nvm, asdf, сборка из исходников):
    // тогда сервер молча не поднимался. Берём ровно тот бинарь, которым запущен сервер, —
    // снятие типов у него встроено, поэтому флаги в argv песочницы не нужны.
    workNodeBin = await fs.realpath(process.execPath);
    if (!(await fs.lstat(workNodeBin)).isFile()) throw new Error('kimi_work_node_invalid');
  }
  const certPath = await fs.realpath(config.kimiCaBundle || '/etc/ssl/certs/ca-certificates.crt');

  const env = assertKimiRuntimeEnv(buildKimiRuntimeEnv({ proxyUrl: 'http://127.0.0.1:3128' }), {
    proxyConfigured: true,
  });
  const bwrap = [
    '--unshare-all', '--die-with-parent', '--new-session', '--as-pid-1',
    // В новом user namespace uid 0 отображается на непривилегированного host uid.
    // Только wrapper сохраняет две namespace-local capability; перед Kimi они
    // безвозвратно снимаются через setpriv + no_new_privs.
    '--uid', '0', '--gid', '0',
    '--cap-drop', 'ALL',
    '--cap-add', 'CAP_NET_ADMIN', '--cap-add', 'CAP_SYS_ADMIN', '--cap-add', 'CAP_SETPCAP',
    '--hostname', 'cockpit-kimi', '--clearenv',
  ];
  for (const [key, value] of Object.entries(env)) bwrap.push('--setenv', key, value);
  const madeDirs = new Set(['/']);
  addMount(bwrap, '--ro-bind', '/usr', '/usr', madeDirs);
  for (const [link, target] of [
    ['/bin', 'usr/bin'], ['/sbin', 'usr/sbin'], ['/lib', 'usr/lib'], ['/lib64', 'usr/lib64'],
  ] as const) {
    bwrap.push('--symlink', target, link);
    madeDirs.add(link);
  }
  bwrap.push('--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp');
  madeDirs.add('/dev'); madeDirs.add('/proc'); madeDirs.add('/tmp');
  addMount(bwrap, '--ro-bind', certPath, '/etc/ssl/certs/ca-certificates.crt', madeDirs);
  addMount(bwrap, '--bind', runtimeHome, '/kimi-home', madeDirs);
  addMount(bwrap, '--ro-bind', home.configPath, '/kimi-home/config.toml', madeDirs);
  // Credentials остаются смонтированными на весь запуск: Kimi 0.31.1 перечитывает
  // OAuth-файл на каждый model request (OAuthManager.ensureFresh → storage.load),
  // поэтому прежний credential barrier (unmount перед первым ответом API) ломал
  // любой многошаговый ход ошибкой «Authentication required». От эксфильтрации
  // держит egress allowlist: наружу доступны только api/auth.kimi.com.
  addMount(bwrap, '--bind', credentialDir, '/kimi-home/credentials', madeDirs);
  for (const hidden of ['plugins', 'skills', 'agents']) {
    addMount(bwrap, '--ro-bind', path.join(brokerHome, 'empty', hidden), `/kimi-home/${hidden}`, madeDirs);
  }
  addMount(bwrap, '--ro-bind', home.emptyFile, '/kimi-home/SYSTEM.md', madeDirs);
  addMount(bwrap, '--ro-bind', home.emptyMcp, '/kimi-home/mcp.json', madeDirs);
  addMount(bwrap, '--ro-bind', egressDir, '/run/cockpit-egress', madeDirs);
  if (workMcp) {
    // Только каталог одного per-scope UDS и неизменяемый bridge; сетевой egress
    // contained Kimi этим не расширяется.
    addMount(bwrap, '--ro-bind', workSocketDir, '/run/cockpit-work', madeDirs);
    addMount(bwrap, '--ro-bind', workScript, KIMI_SANDBOX_WORK_MCP, madeDirs);
    addMount(bwrap, '--ro-bind', workNodeBin, KIMI_SANDBOX_NODE, madeDirs);
  }
  addMount(bwrap, '--ro-bind', scripts.wrapperPath, '/opt/cockpit/run-kimi', madeDirs);
  addMount(bwrap, '--ro-bind', kimiBin, '/opt/kimi/bin/kimi', madeDirs);
  if (fdBin) addMount(bwrap, '--ro-bind', fdBin, '/opt/kimi/bin/fd', madeDirs);

  const canonicalExtras: string[] = [];
  const rejectedExtraDirs: Array<{ path: string; reason: string }> = [];
  for (const dir of extraDirs) {
    const real = await canonicalDirectory(dir, 'kimi_extra_dir');
    const reason = workspaceMountBoundaryError(real, config, { maskControlState: true });
    if (reason) {
      // Дополнительный доверенный каталог — опциональная возможность, а не cwd.
      // Отклоняются только системные корни и сам control state: широкий каталог,
      // СОДЕРЖАЩИЙ server-owned state, монтируется, а state внутри маскируется ниже.
      // Сам cwd по-прежнему отклоняется выше без исключений.
      rejectedExtraDirs.push({ path: real, reason });
      continue;
    }
    if (real === cwdReal || isWithin(cwdReal, real) || canonicalExtras.includes(real)) continue;
    canonicalExtras.push(real);
  }
  // Сначала родители, затем более глубокие mount-ы; иначе поздний bind родителя
  // способен заслонить уже созданную границу cwd.
  canonicalExtras.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
  for (const real of canonicalExtras) {
    addMount(bwrap, '--bind', real, real, madeDirs);
  }
  // Control state внутри смонтированных extras прячется пустым read-only mount-ом:
  // ни прочитать токены в контекст, ни испортить session/bindings/wrapper модель
  // не может, а остальное содержимое доверенного каталога доступно целиком.
  const controlMasks = workspaceControlStateMasks(canonicalExtras, config);
  const maskedWorkspacePaths = [...controlMasks.dirs];
  for (const dir of controlMasks.dirs) {
    addMount(bwrap, '--ro-bind', path.join(brokerHome, 'empty', 'agents'), dir, madeDirs);
  }
  for (const file of controlMasks.files) {
    // Маскируем только существующий файл: bwrap создаёт отсутствующий destination
    // на хосте (pre-existing поведение, как с .kimi-code), лишний артефакт не нужен.
    if (await fs.lstat(file).catch(() => null)) {
      addMount(bwrap, '--ro-bind', home.emptyFile, file, madeDirs);
      maskedWorkspacePaths.push(file);
    }
  }
  addMount(bwrap, '--bind', cwdReal, cwdReal, madeDirs);
  // Project-local расширения не должны обходить server-owned профиль.
  let kimiCodeMask = path.join(brokerHome, 'empty', 'agents');
  let kimiCodeMaskRoot = cwdReal;
  if (canonicalExtras.length) {
    // Parity с codex --add-dir: каталоги уже смонтированы writable выше, но без
    // записи в workspace local.toml kimi их за workspace не считает и инструменты
    // вне cwd отклоняет. Маска — именно каталог с файлом внутри: ro-bind одиночного
    // файла поверх ro-маски bwrap отклоняет (EROFS на создании destination).
    // Каталог per-run: содержимое различается между чатами, общий brokerHome дал бы
    // гонку между ходами. Пустым extras эта маска не нужна — остаётся общий empty.
    kimiCodeMaskRoot = await resolveVisibleProjectRoot(cwdReal, canonicalExtras);
    kimiCodeMask = path.join(egressDir, WORKSPACE_MASK_DIR);
    await fs.mkdir(kimiCodeMask, { recursive: true, mode: 0o700 });
    // temp + rename: файл 0400, прямая перезапись в переиспользованном каталоге
    // упёрлась бы в EACCES; rename требует прав только на каталог.
    const localTomlPath = path.join(kimiCodeMask, WORKSPACE_LOCAL_TOML_FILE);
    const localTomlTemp = `${localTomlPath}.${process.pid}.tmp`;
    await fs.writeFile(localTomlTemp, buildWorkspaceLocalToml(canonicalExtras), { mode: 0o400 });
    await fs.rename(localTomlTemp, localTomlPath);
    await fs.chmod(localTomlPath, 0o400).catch(() => {});
  }
  if (kimiCodeMaskRoot !== cwdReal) {
    // projectRoot — доверенный предок: его .kimi-code заменяется маской с local.toml,
    // а собственный .kimi-code cwd по-прежнему прячется за общей пустой маской.
    addMount(bwrap, '--ro-bind', kimiCodeMask, path.join(kimiCodeMaskRoot, '.kimi-code'), madeDirs);
    addMount(bwrap, '--ro-bind', path.join(brokerHome, 'empty', 'agents'), path.join(cwdReal, '.kimi-code'), madeDirs);
  } else {
    addMount(bwrap, '--ro-bind', kimiCodeMask, path.join(cwdReal, '.kimi-code'), madeDirs);
  }
  addMount(bwrap, '--ro-bind', path.join(brokerHome, 'empty', 'agents'), path.join(cwdReal, '.agents'), madeDirs);
  if (attachmentDir) {
    const attachmentReal = await canonicalDirectory(attachmentDir, 'kimi_attachment_dir');
    addMount(bwrap, '--ro-bind', attachmentReal, '/attachments', madeDirs);
  } else {
    bwrap.push('--dir', '/attachments');
  }
  bwrap.push('--chdir', cwdReal, '/opt/cockpit/run-kimi');

  const systemd = [
    '--user', '--pipe', '--wait', '--collect', '--service-type=exec', `--unit=${unit}`,
    '-p', `CPUQuota=${KIMI_SYSTEMD_LIMITS.cpuQuota}`,
    '-p', `MemoryMax=${KIMI_SYSTEMD_LIMITS.memoryMax}`,
    '-p', 'MemorySwapMax=0',
    '-p', `TasksMax=${KIMI_SYSTEMD_LIMITS.tasksMax}`,
    '-p', 'KillMode=control-group',
    '-p', 'TimeoutStopSec=5s',
    '-p', `RuntimeMaxSec=${KIMI_SYSTEMD_LIMITS.runtimeMax}`,
    '-p', 'LimitCORE=0',
    config.kimiBwrapBin || '/usr/bin/bwrap',
    ...bwrap,
  ];
  return {
    command: config.kimiSystemdRunBin || '/usr/bin/systemd-run',
    args: systemd,
    unit,
    cwdReal,
    rejectedExtraDirs,
    maskedWorkspacePaths,
  };
}

export async function stopKimiUnit(unit: string, {
  systemctlBin = '/usr/bin/systemctl',
  runner = execFileAsync as unknown as (
    file: string,
    args: string[],
    options: { timeout: number },
  ) => Promise<unknown>,
} = {}): Promise<void> {
  if (!/^cockpit-kimi-[a-zA-Z0-9_.-]+\.service$/.test(unit || '')) throw new Error('invalid_kimi_unit');
  await runner(systemctlBin, ['--user', 'stop', unit], { timeout: 8_000 }).catch(() => {});
}

/** Только две адресные переменные host user-manager; в sandbox их всё равно стирает
 * `bwrap --clearenv`. Остальное окружение сервера systemd-run не наследует. */
export function kimiSystemdClientEnv(source: NodeJS.ProcessEnv = process.env) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const runtime = source.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  return {
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: source.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtime}/bus`,
  };
}

export {
  assertExecutable,
  assertPrivateCredentialDir,
  buildWorkspaceLocalToml,
  canonicalDirectory,
  resolveVisibleProjectRoot,
  WORKSPACE_LOCAL_TOML_FILE,
  WORKSPACE_MASK_DIR,
};
