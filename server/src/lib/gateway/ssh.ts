// SSH-транспорт визарда шлюза: системный `ssh`, без новых зависимостей.
//
// Почему не библиотека (`ssh2`) и не `sshpass`: у сервера восемь зависимостей всего, а
// `sshpass` в системе нет и тянуть его ради одного входа незачем. Пароль отдаётся штатным
// механизмом OpenSSH — `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force` (нужен OpenSSH ≥ 8.4,
// на мозге 8.9). Сам пароль в файл-помощник НЕ попадает: тот печатает переменную окружения.
//
// **Пароль используется РОВНО ОДИН РАЗ** — чтобы положить на VPS наш ed25519-ключ. Дальше
// всё идёт по ключу, и хранить пароль незачем: он живёт в памяти процесса на время установки.
//
// **Отпечаток хоста подтверждает человек.** Пароль root — это весь сервер, и молчаливый TOFU
// здесь означает «отдай пароль тому, кто первым ответил на этот адрес». Поэтому порядок такой:
// `scanHostKeys` показывает отпечаток → человек сверяет его с панелью хостера → визард
// передаёт подтверждённый отпечаток обратно, и только совпадение открывает вход паролем.
import { execFile, spawn } from 'node:child_process';
import type { ExecFileOptions } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CONNECT_TIMEOUT_S = 10;

export interface HostKeyFingerprint {
  bits: number;
  hash: string;
  type: string;
}

export interface ScannedHostKeys {
  lines: string[];
  fingerprints: HostKeyFingerprint[];
  primary: HostKeyFingerprint | undefined;
}

export interface GatewayKeypair {
  keyPath: string;
  pubPath: string;
  publicKey: string;
}

// Итог запуска `ssh`: код возврата, оба потока и признак срабатывания таймера.
// Обрыв по таймауту приходит тем же путём, что и обычный отказ, и различать их
// по одному только коду нельзя.
interface SshRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface RunSshOptions {
  input?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface InstallKeyRequest {
  gatewayDir: string;
  host: string;
  port?: number;
  user: string;
  password: string;
  publicKey: string;
  knownHosts: string;
}

export interface ExecScriptRequest {
  host: string;
  port?: number;
  user: string;
  keyPath: string;
  knownHosts: string;
  script: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  onData?: (text: string) => void;
}

export interface UploadFileRequest {
  host: string;
  port?: number;
  user: string;
  keyPath: string;
  knownHosts: string;
  remotePath: string;
  content: string;
  mode?: string;
}

/**
 * `execFile` не умеет опцию `input` (она есть только у синхронных API). Поэтому stdin
 * передаём явно через возвращённый ChildProcess. Иначе `ssh-keygen -lf -` ждёт EOF вечно,
 * а кнопка проверки VPS остаётся на «стучимся…» после успешного ответа сервера.
 */
function execFileWithInput(
  file: string,
  args: string[],
  input: string,
  options: ExecFileOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    // Ранний выход процесса может закрыть pipe до записи; callback выше всё равно принесёт
    // содержательную ошибку команды, а этот listener не даёт EPIPE стать uncaught exception.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

/** Отказ SSH с машинным кодом: визард обязан назвать следующий шаг, а не показать stderr. */
export class SshError extends Error {
  code: string;

  constructor(code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'SshError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * Каталог ключа, known_hosts и askpass визарда — `server/.state/gateway` (`config.gatewayDir`).
 * Свой, а не пользовательский `~/.ssh`: ключ шлюза не должен зависеть от того, что человек
 * когда-нибудь перегенерирует свой личный.
 */
async function ensureDir(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Ключ визарда. Не переиспользуем `~/.ssh/id_*` человека: у ключа шлюза своя судьба
 * (лежит в `authorized_keys` root-а VPS), и он не должен зависеть от того, что человек
 * когда-нибудь перегенерирует свой личный.
 */
export async function ensureKeypair(gatewayDir: string): Promise<GatewayKeypair> {
  const dir = await ensureDir(gatewayDir);
  const keyPath = path.join(dir, 'id_ed25519');
  const pubPath = `${keyPath}.pub`;
  try {
    const pub = await fs.readFile(pubPath, 'utf8');
    return { keyPath, pubPath, publicKey: pub.trim() };
  } catch {
    /* нет ключа — заводим */
  }
  await fs.rm(keyPath, { force: true });
  await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'cockpit-gateway-setup', '-f', keyPath]);
  await fs.chmod(keyPath, 0o600);
  const pub = await fs.readFile(pubPath, 'utf8');
  return { keyPath, pubPath, publicKey: pub.trim() };
}

/**
 * Ключи хоста и их отпечатки — до всякого входа.
 *
 * `ssh-keyscan` молчит про отказ кодом возврата (пустой вывод при недоступном хосте тоже 0),
 * поэтому решает наличие строк.
 */
export async function scanHostKeys(host: string, port = 22): Promise<ScannedHostKeys> {
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync(
      'ssh-keyscan',
      ['-T', String(CONNECT_TIMEOUT_S), '-p', String(port), '-t', 'ed25519,rsa,ecdsa', host],
      { timeout: (CONNECT_TIMEOUT_S + 5) * 1000 },
    ));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SshError('host_unreachable', `Не достучались до ${host}:${port} — ${reason}`);
  }
  const lines = String(stdout).split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (!lines.length) {
    throw new SshError('host_unreachable', `${host}:${port} не ответил на SSH. Сервер поднялся? Порт тот?`);
  }
  const fingerprints = await fingerprintHostKeys(stdout);
  // Показываем ed25519, если он есть: короче и его печатает большинство панелей хостеров.
  const primary = fingerprints.find((item) => item.type === 'ED25519') || fingerprints[0];
  return { lines, fingerprints, primary };
}

/** Вычислить отпечатки вывода ssh-keyscan, передав ключи ssh-keygen через настоящий stdin. */
export async function fingerprintHostKeys(hostKeys: string): Promise<HostKeyFingerprint[]> {
  const { stdout: fpOut } = await execFileWithInput(
    'ssh-keygen',
    ['-lf', '-'],
    hostKeys,
    { timeout: (CONNECT_TIMEOUT_S + 5) * 1000 },
  );
  const fingerprints = fpOut
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): HostKeyFingerprint | null => {
      const m = /^(\d+)\s+(\S+)\s+(.*)\s+\((\w+)\)$/.exec(line);

      return m ? { bits: Number(m[1]), hash: String(m[2]), type: String(m[4]) } : null;
    })
    .filter((item): item is HostKeyFingerprint => Boolean(item));

  return fingerprints;
}

/** Записать подтверждённые ключи хоста в собственный known_hosts визарда. */
export async function writeKnownHosts(gatewayDir: string, lines: string[]): Promise<string> {
  const dir = await ensureDir(gatewayDir);
  const file = path.join(dir, 'known_hosts');
  await fs.writeFile(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return file;
}

function baseOptions(knownHosts: string, port: number): string[] {
  return [
    '-p', String(port),
    '-o', `UserKnownHostsFile=${knownHosts}`,
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `ConnectTimeout=${CONNECT_TIMEOUT_S}`,
    '-o', 'ServerAliveInterval=15',
  ];
}

/**
 * Запустить `ssh` и дождаться конца, отдав `stdin` целиком.
 *
 * Не `execFile`: нужен собственный набор дескрипторов и окружение, а команду мы всё равно
 * подаём скриптом на stdin — так не приходится экранировать её для чужого shell.
 */
function runSsh(
  args: string[],
  { input = '', env = process.env, timeoutMs = 15 * 60_000 }: RunSshOptions = {},
): Promise<SshRun> {
  return new Promise((resolve) => {
    const child = spawn('ssh', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${e.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin?.end(input);
  });
}

/** Помощник для `SSH_ASKPASS`: печатает пароль из окружения, самого пароля в файле нет. */
async function ensureAskpass(gatewayDir: string): Promise<string> {
  const dir = await ensureDir(gatewayDir);
  const file = path.join(dir, 'askpass.sh');
  await fs.writeFile(file, '#!/bin/sh\nprintf %s "$COCKPIT_SSH_PASSWORD"\n', { mode: 0o700 });
  await fs.chmod(file, 0o700);
  return file;
}

/**
 * Положить наш публичный ключ в `authorized_keys` — единственное место, где нужен пароль.
 *
 * Идемпотентно: повторная установка не плодит строк (`grep -qxF`).
 */
export async function installPublicKey({
  gatewayDir, host, port = 22, user, password, publicKey, knownHosts,
}: InstallKeyRequest): Promise<boolean> {
  const askpass = await ensureAskpass(gatewayDir);
  const script = [
    'set -eu',
    'mkdir -p ~/.ssh && chmod 700 ~/.ssh',
    'touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys',
    `grep -qxF ${shellQuote(publicKey)} ~/.ssh/authorized_keys || printf '%s\\n' ${shellQuote(publicKey)} >> ~/.ssh/authorized_keys`,
    'echo COCKPIT_KEY_OK',
  ].join('\n');

  const res = await runSsh(
    [
      ...baseOptions(knownHosts, port),
      '-o', 'BatchMode=no',
      '-o', 'PreferredAuthentications=password,keyboard-interactive',
      '-o', 'PubkeyAuthentication=no',
      '-o', 'NumberOfPasswordPrompts=1',
      `${user}@${host}`,
      'bash -s',
    ],
    {
      input: script,
      timeoutMs: 60_000,
      env: {
        ...process.env,
        SSH_ASKPASS: askpass,
        SSH_ASKPASS_REQUIRE: 'force',
        COCKPIT_SSH_PASSWORD: password,
        DISPLAY: process.env.DISPLAY || ':0',
      },
    },
  );

  if (res.stdout.includes('COCKPIT_KEY_OK')) return true;
  if (/permission denied/i.test(res.stderr)) {
    throw new SshError(
      'ssh_password_rejected',
      `${user}@${host}: пароль не принят. Либо он неверен, либо хостер запретил вход паролем `
        + '(`PermitRootLogin prohibit-password`) — тогда ключ придётся положить через панель хостера.',
    );
  }
  throw new SshError('ssh_failed', `Не удалось установить ключ на ${host}: ${res.stderr.trim() || `код ${res.code}`}`);
}

/** Одинарные кавычки для shell: единственный безопасный способ протащить чужой текст. */
export function shellQuote(value: unknown): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Выполнить скрипт на сервере по ключу. Скрипт едет на stdin — экранировать нечего.
 *
 * `onData` получает вывод по мере поступления: bootstrap идёт минутами, и человек должен
 * видеть, что происходит, а не пустой экран.
 */
export async function execScript({
  host, port = 22, user, keyPath, knownHosts, script, env = {}, timeoutMs, onData,
}: ExecScriptRequest): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const prelude = Object.entries(env)
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join('\n');
  const args = [
    ...baseOptions(knownHosts, port),
    '-i', keyPath,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    `${user}@${host}`,
    'bash -s',
  ];
  const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs || 20 * 60_000);
  const pump = (stream: Readable | null, sink: (text: string) => void) => stream?.on(
    'data',
    (chunk) => {
      const text = String(chunk);
      sink(text);
      if (onData) onData(text);
    },
  );
  pump(child.stdout, (text) => { stdout += text; });
  pump(child.stderr, (text) => { stderr += text; });
  child.stdin?.end(`${prelude}\n${script}`);
  const code = await new Promise<number | null>((resolve) => {
    child.on('error', () => resolve(-1));
    child.on('close', (value) => resolve(value));
  });
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/** Проверить, пускает ли сервер по нашему ключу (тогда пароль не нужен вовсе — повтор установки). */
export async function keyWorks(
  { host, port = 22, user, keyPath, knownHosts }: Omit<ExecScriptRequest, 'script'>,
): Promise<boolean> {
  const res = await execScript({
    host, port, user, keyPath, knownHosts, script: 'echo COCKPIT_SSH_OK', timeoutMs: 30_000,
  });
  return res.stdout.includes('COCKPIT_SSH_OK');
}

/** Положить файл на сервер (содержимое едет на stdin, путь наш и постоянный). */
export async function uploadFile({
  host, port = 22, user, keyPath, knownHosts, remotePath, content, mode = '0700',
}: UploadFileRequest): Promise<boolean> {
  // Содержимое едет на stdin, а команда — аргументом: наоборот нельзя, stdin занят данными.
  const remote = `set -eu; cat > ${shellQuote(remotePath)}; chmod ${mode} ${shellQuote(remotePath)}`;
  const args = [
    ...baseOptions(knownHosts, port),
    '-i', keyPath,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    `${user}@${host}`,
    `bash -c ${shellQuote(remote)}`,
  ];
  const res = await runSsh(args, { input: content, timeoutMs: 120_000 });
  if (res.code !== 0) {
    throw new SshError('upload_failed', `Не удалось записать ${remotePath}: ${res.stderr.trim() || `код ${res.code}`}`);
  }
  return true;
}
