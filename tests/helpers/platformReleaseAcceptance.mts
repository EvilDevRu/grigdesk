import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import type { TestContext } from 'node:test';

import { candidateKey } from '../../tools/platformCandidate.mts';
import { verifyDistributionArtifacts } from '../../tools/releaseArtifactVerification.mts';
import type { DistributionTrust } from '../../tools/releaseArtifactVerification.mts';
import { verifyInstallation, type VerificationScopeState } from '../../tools/verifyInstallation.mts';
import { updateProcessAlive } from '../../shared/node/installedServer.ts';
import { configureDarwinBuildProcessHelper } from '../../shared/node/processIdentity.ts';
import { readUpdateProcess } from '../../shared/node/updateProcessOwner.ts';
import { removePrivateTree } from '../../shared/node/files.ts';

export const execute = promisify(execFile);

type Mode = 'local' | 'remote' | 'server';

const corePath = '/usr/bin:/bin';
const reservedAcceptancePorts = new Set([8140, 8144]);

/**
 * Проверки читают identity только из verify job inputs. Каждый источник
 * использует independently pinned manifest digest.
 */
export function acceptanceInputs(platform: 'linux' | 'darwin') {
  const prefix = platform === 'darwin' ? 'MACOS_' : 'LINUX_';
  const take = (field: string) => process.env[prefix + field] ?? '';
  const { pem } = candidateKey(take('CANDIDATE_PUBLIC_KEY_B64'), take('CANDIDATE_PUBLIC_KEY_FINGERPRINT'));
  const commit = take('COMMIT');
  const candidate = take('CANDIDATE_DIR');
  const previous = take('PREVIOUS_DIR');
  const trust = (digest: string): DistributionTrust => {
    assert.match(digest, /^[a-f0-9]{64}$/u);

    return {
      purpose: 'candidate',
      publicKeyPem: pem,
      expectedCommit: commit,
      expectedManifestDigest: digest,
      requireHostPlatform: true,
    };
  };

  assert.equal(process.platform, platform);
  assert.equal(process.arch, platform === 'darwin' ? 'arm64' : 'x64');
  assert.match(commit, /^[a-f0-9]{40}$/u);
  assert.ok(path.isAbsolute(candidate) && path.isAbsolute(previous));

  return {
    candidate,
    previous,
    trust: trust(take('EXPECTED_MANIFEST_DIGEST')),
    prior: trust(take('PREVIOUS_MANIFEST_DIGEST')),
  };
}

type Inputs = ReturnType<typeof acceptanceInputs>;

/**
 * Файл результатов разрешён только в приватном каталоге текущего verify.
 * В него не пишутся URL, токены, содержимое D и абсолютные fixture paths.
 */
export async function writePlatformAcceptance(value: unknown) {
  const file = process.env.GRIGDESK_CANDIDATE_ACCEPTANCE_REPORT ?? '';

  assert.ok(path.isAbsolute(file));
  await fs.writeFile(file, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
}

/**
 * Номер loopback-порта выбирает ядро в одноразовом профиле.
 * После закрытия этот порт используется только fixture server.
 */
export async function freeAcceptancePort(): Promise<number> {
  const server = createServer();

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const port = server.address();

  server.close();
  await once(server, 'close');
  assert.ok(port && typeof port !== 'string');

  if (reservedAcceptancePorts.has(port.port)) {
    return freeAcceptancePort();
  }

  reservedAcceptancePorts.add(port.port);

  return port.port;
}

/**
 * Бounded readiness ловит переходы обычного server/desktop boot.
 * Ошибка последней попытки сохраняет реальную диагностику.
 */
export async function awaitAcceptance<T>(observe: () => Promise<T | null>, label: string,
  timeout = 120_000): Promise<T> {
  const period = Date.now() + timeout;
  let last: unknown;

  while (Date.now() < period) {
    try {
      const result = await observe();

      if (result !== null) {
        return result;
      }
    } catch (error) {
      last = error;
    }

    await pause(150);
  }

  throw new Error(label, { cause: last });
}

/**
 * Создаёт отдельные HOME, D, profile и paths с пробелами. Обе версии
 * устанавливаются одним штатным script и теми же флагами в этот профиль.
 */
export async function platformFixture(t: TestContext, mode: Mode) {
  const homeRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gd-release-')));
  const home = path.join(homeRoot, 'home');
  const dataHome = path.join(homeRoot, 'data');
  const root = path.join(homeRoot, 'Program= GrigDesk');
  const bin = path.join(homeRoot, 'User CLI');
  const units = path.join(homeRoot, 'Launch Agents');
  const profile = path.join(homeRoot, 'User Profile');
  const appDirectory = path.join(homeRoot, 'Applications');
  const port = await freeAcceptancePort();
  const mobilePort = await freeAcceptancePort();
  const debugPort = await freeAcceptancePort();
  const origin = 'http://127.0.0.1:' + port;
  const runtime = path.join(home, 'runtime');
  const env: NodeJS.ProcessEnv = {
    PATH: corePath,
    HOME: home,
    LANG: 'C.UTF-8',
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_DATA_HOME: path.join(home, 'share'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    TMPDIR: path.join(home, 'tmp'),
    ...(process.platform === 'linux' ? {
      DISPLAY: process.env.DISPLAY,
      XAUTHORITY: process.env.XAUTHORITY,
      APPIMAGE_EXTRACT_AND_RUN: '1',
      XDG_RUNTIME_DIR: runtime,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(runtime, 'absent-bus')}`,
    } : {}),
  };
  const execOptions = {
    cwd: home,
    env,
    timeout: 150_000,
    maxBuffer: 4 * 1024 * 1024,
  };

  for (const folder of [dataHome, home, profile, env.XDG_CONFIG_HOME!, env.XDG_DATA_HOME!,
    env.XDG_CACHE_HOME!, env.TMPDIR!, runtime]) {
    await fs.mkdir(folder, { mode: 0o700 });
  }

  await fs.writeFile(path.join(dataHome, '.env'),
    `GRIGDESK_PORT=${port}\nGRIGDESK_MOBILE_PORT=${mobilePort}\n`, { mode: 0o600 });

  const state = async (name: string) => JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
  const ctlFile = path.join(bin, 'grigdesk-ctl');
  const ctl = (argv: string[], overrides?: NodeJS.ProcessEnv) => execute(ctlFile, argv, {
    ...execOptions,
    env: overrides ? { ...env, ...overrides } : env,
  });
  let windowProcess: ReturnType<typeof spawn> | null = null;

  t.after(async () => {
    if (process.platform === 'darwin') {
      await configureDarwinBuildProcessHelper();
    }

    const marker = await state('update/desktop-boot.json').catch(() => null);
    const ownedDesktop = marker?.process;

    if (ownedDesktop?.pid && ownedDesktop.executable.startsWith(root + '/generations/')) {
      if (await updateProcessAlive(ownedDesktop)) {
        process.kill(ownedDesktop.pid, 'SIGTERM');

        await awaitAcceptance(async () => !await updateProcessAlive(ownedDesktop) || null,
          'candidate_desktop_cleanup_unconfirmed', 15_000);
      }
    }

    if (windowProcess?.pid && windowProcess.exitCode === null && windowProcess.signalCode === null) {
      windowProcess.kill('SIGTERM');
      await once(windowProcess, 'exit', { signal: AbortSignal.timeout(15_000) });
    }

    if (mode !== 'remote' && await fs.lstat(path.join(root, 'current.json')).catch(() => null)) {
      await ctl(['server', 'stop']);
    }

    await removePrivateTree(homeRoot);
  });

  /**
   * Сетевые инструменты fixture намеренно не передаются в alias.
   * Installer получает абсолютный source-dir и независимый HOME.
   */
  function install(directory: string, options: { dataHome?: string; root?: string } = {}) {
    return execute('/bin/sh', [path.join(directory, 'grigdesk-install'),
      '--yes', '--mode', mode, '--root', options.root ?? root,
      '--data-home', options.dataHome ?? dataHome, '--user-data', profile,
      '--bin-dir', bin, '--applications-dir', appDirectory, '--unit-dir', units,
      '--source-dir', directory], execOptions);
  }

  /**
   * Запрос использует только собственный CLI-token и localhost. Для теста
   * не требуются учётные данные внешнего провайдера.
   */
  async function api(route: string, data?: unknown, timeout = 5000) {
    const token = (await fs.readFile(path.join(dataHome, 'state/cli-token'), 'utf8')).trim();
    const response = await fetch(origin + route, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { 'X-GrigDesk-Token': token, 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
    });
    const body = await response.json();

    return { status: response.status, body };
  }

  /**
   * Debug port принадлежит созданному BrowserWindow и слушает loopback.
   * Вызовы через renderer идут по тому же origin, что кнопка обновления.
   */
  async function openWindow() {
    const log = await fs.open(path.join(homeRoot, 'window.log'), 'a', 0o600);

    try {
      windowProcess = spawn(path.join(bin, 'grigdesk'), [
        '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`,
      ], {
        cwd: home,
        env,
        stdio: ['ignore', log.fd, log.fd],
      });
      await once(windowProcess, 'spawn');
    } finally {
      await log.close();
    }

    return windowEndpoint();
  }

  /**
   * Probes the current main target after an app start or profile navigation.
   * A different renderer process must expose the same private shell API.
   */
  async function windowEndpoint() {
    return awaitAcceptance(async () => {
      const endpoint = 'http://127.0.0.1:' + debugPort + '/json/list';
      const targets = await (await fetch(endpoint, { signal: AbortSignal.timeout(1000) })).json() as {
        type: string;
        url: string;
        webSocketDebuggerUrl: string;
      }[];

      for (const target of targets) {
        if (target.type !== 'page' || !/^http:\/\/127\.0\.0\.1:\d+\//u.test(target.url)) {
          continue;
        }

        const read = await evaluateWindow(target.webSocketDebuggerUrl,
          "fetch('/__shell/state').then(r => r.json()).then(s => Boolean(s.applicationUpdate))");

        if (read === true) {
          return target.webSocketDebuggerUrl;
        }
      }

      return null;
    }, 'candidate_window_start_timeout');
  }

  /**
   * Waits for the exact child opened by this fixture.
   * Missing native Close evidence reaches the test as a deadline failure.
   */
  async function waitForWindowExit() {
    assert.ok(windowProcess);

    if (windowProcess.exitCode !== null) {
      return windowProcess.exitCode;
    }

    const [code] = await once(windowProcess, 'exit', { signal: AbortSignal.timeout(30_000) });

    return code;
  }

  /**
   * Привязывает native App Quit к тому же BrowserWindow, который открыл fixture.
   * Не выбирает приложение по имени или bundle identifier общего пользователя.
   */
  async function windowOwner() {
    assert.ok(windowProcess?.pid);

    const owner = await readUpdateProcess(windowProcess.pid);

    assert.ok(owner.executable.startsWith(path.join(root, 'generations') + path.sep));

    return owner;
  }

  return {
    homeRoot,
    home,
    dataHome,
    root,
    bin,
    units,
    profile,
    origin,
    env,
    install,
    state,
    ctl,
    api,
    openWindow,
    windowEndpoint,
    waitForWindowExit,
    windowOwner,
  };
}

/**
 * CDP используется только с debug URL собственного fixture window.
 * Каждое выражение имеет deadline и отдельное закрытие WebSocket.
 */
export async function evaluateWindow(endpoint: string, expression: string, wait = true) {
  assert.match(endpoint, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/page\//u);

  const socket = new WebSocket(endpoint);
  const timeout = AbortSignal.timeout(20_000);
  let abort: (() => void) | undefined;

  try {
    return await new Promise<unknown>((resolve, reject) => {
      abort = () => reject(new Error('candidate_window_protocol_timeout'));
      timeout.addEventListener('abort', abort, { once: true });
      socket.addEventListener('open', () => socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
        expression,
        returnByValue: true,
        awaitPromise: wait,
      },
      })), { once: true });
      socket.addEventListener('error', () => reject(new Error('candidate_window_protocol_error')),
      { once: true });
      socket.addEventListener('message', ({ data }) => {
        const response = JSON.parse(String(data));

        if (response.id === 1) {
          if (response.error || response.result?.exceptionDetails) {
            reject(new Error('candidate_window_evaluation_failed'));
          } else {
            resolve(response.result?.result?.value);
          }
        }
      });
    });
  } finally {
    if (abort) {
      timeout.removeEventListener('abort', abort);
    }

    socket.close();
  }
}

/**
 * Русские названия и публичные пути не влияют на проверку: все три режима
 * проходят общий verifier на фактических проверенных архивах B.
 */
export async function verifyAcceptanceModes(t: TestContext, input: Inputs) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'gd-modes-'));
  const state: { scope: VerificationScopeState } = { scope: 'idle' };

  t.after(async () => {
    if (state.scope === 'idle' || state.scope === 'clean') {
      await removePrivateTree(directory);
    } else {
      process.stderr.write(`Сохранена нативная приёмка ${directory}\n`);
    }
  });

  const reports = await verifyInstallation(input.candidate, input.trust.expectedCommit, {
    trust: input.trust,
    installRoot: directory,
    nativeTools: process.platform === 'darwin' ? process.env : undefined,
    onScopeState: (scope) => {
      state.scope = scope;
    },
  });

  assert.deepEqual(reports.map((report) => report.mode), ['local', 'remote', 'server']);

  return reports;
}

/**
 * Проверяет независимые signed identities двух комплектов до любых запусков.
 * Частные ключи ведомого кандидата в verifier отсутствуют.
 */
export async function verifyAcceptanceVersions(input: Inputs) {
  const a = await verifyDistributionArtifacts(input.previous, input.prior);
  const b = await verifyDistributionArtifacts(input.candidate, input.trust);

  assert.notEqual(a.envelope.payload.version, b.envelope.payload.version);
  assert.equal(a.envelope.payload.commit, b.envelope.payload.commit);
  assert.equal(a.envelope.payload.channel, 'dev');
  assert.equal(b.envelope.payload.channel, 'dev');

  return {
    previous: a.envelope.payload.version,
    current: b.envelope.payload.version,
  };
}
